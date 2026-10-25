#!/usr/bin/env bash
# Contract test for POST /v1/scan and the ClamAV part of GET /v1/health (docs/nomail-api.md).
# Run it ON THE SERVER only: sudo tests/api-scan.sh
# Windows Defender on the owner's PC quarantines the EICAR test file, so the EICAR string is put
# together in memory here, from two halves, and piped to curl. It is never written to a file.
#
# What it checks:
#   - the INSTREAM exchange against a fake clamd (tests/clamd-instream.php, in the app container);
#   - ClamAV is up: it waits up to 90 minutes for the clamav service, then gives up as BLOCKED
#     (exit 2) with what it saw;
#   - health: clamav ok, signatures at most 2 days old;
#   - through Cloudflare: no key 401, EICAR infected, 5 MiB of random bytes clean, a body of
#     exactly 99,614,720 bytes (the limit) clean within 45 seconds;
#   - straight to the app container (Cloudflare itself refuses bodies over 100 MB): 96 MiB and
#     one byte over the limit give 413 too_large; a 96 MiB chunked body (no Content-Length)
#     gives 413 while it streams;
#   - 4 scans at once: at most 2 run, the others get 429 scanner_busy with Retry-After: 30;
#   - no stored copy: no new filecache row of a test size, no new file over 1 MiB in the data
#     folder, no temporary file left in the app or clamav container, no file name and no EICAR
#     bytes in the server log;
#   - the audit rows (clean, infected, too_large), never a body;
#   - under the server-change lock: clamav_host=clamav-missing gives scan 503 and health ok with
#     clamav unavailable; the setting is put back and a scan is clean again.
# The key reaches curl as a config line on a <(...) pipe, never as an argument, and is never
# printed. Random test files live in a temporary folder on the host and are removed at the end.
# Exit 0 when every check passes, 2 when ClamAV never came up (BLOCKED).
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_nomail_key

MAX=99614720           # 95 MiB, NoMail's MAX_SCAN_BYTES
OVER=100663296         # 96 MiB
START="$(date -u +%s)"
APP_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$(dc ps -q app)" | awk '{print $1}')"
DIRECT="http://$APP_IP/apps/nourax_api"

# The EICAR test string (68 bytes), from two halves so this file never holds it whole.
eicar() { printf '%s%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EIC' 'AR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'; }

# POST /v1/scan with the body on stdin (--data-binary @-) or from a file (-T FILE, streamed).
# Prints "<status> <seconds>"; the body is left in $T_OUT/body and the headers in $T_OUT/headers.
#   scan URL-BASE NAME [curl options...]
scan() {
	local base="$1" name="$2"
	shift 2
	curl -sS -X POST -K <(nomail_auth) -H 'Content-Type: application/octet-stream' \
		-H "X-File-Name: $name" -H "Host: $DRIVE_HOST" -o "$T_OUT/body" -D "$T_OUT/headers" \
		-w '%{http_code} %{time_total}' "$@" "$base/v1/scan"
}
status_of() { printf '%s' "${1%% *}"; }

sql() { dc exec -T db psql -U nextcloud -d nextcloud -tAc "$1" </dev/null | tr -d '[:space:]'; }
TEST_SIZES="5242880, $MAX, $((MAX + 1)), $OVER"
fc_total() { sql "select count(*) from oc_filecache"; }
fc_test_sizes() { sql "select count(*) from oc_filecache where size in ($TEST_SIZES)"; }

log "base URL: $API_BASE (straight to the app container: $DIRECT)"

# --- The INSTREAM exchange, against a fake clamd ---------------------------------------------
if dc exec -T app php < "$REPO_DIR/tests/clamd-instream.php" > "$T_OUT/unit"; then
	log "PASS INSTREAM exchange ($(grep -c '^PASS' "$T_OUT/unit") checks)"
else
	grep -v '^PASS' "$T_OUT/unit" || true
	check "INSTREAM exchange" passed failed
fi

# --- Wait for ClamAV (Task 5's clamav service) -------------------------------------------------
clamav_ok() {
	[ "$(api GET /v1/health)" = 200 ] && [ "$(jq -r .clamav "$T_OUT/body")" = ok ]
}
if ! clamav_ok; then
	log "clamav is not ready yet; waiting up to 90 minutes"
	for _ in $(seq 1 180); do
		clamav_ok && break
		sleep 30
	done
fi
if ! clamav_ok; then
	log "BLOCKED: ClamAV did not come up within 90 minutes"
	dc ps clamav || true
	log "health: $(jq -c . "$T_OUT/body" 2>/dev/null || cat "$T_OUT/body")"
	exit 2
fi

# --- Health ------------------------------------------------------------------------------------
check "health -> 200" 200 "$(api GET /v1/health)"
check "health status ok" ok "$(jq -r .status "$T_OUT/body")"
check "health clamav ok" ok "$(jq -r .clamav "$T_OUT/body")"
sig="$(jq -r .signatures "$T_OUT/body")"
age=$(( ( $(date -u +%s) - $(date -u -d "$sig" +%s 2>/dev/null || echo 0) ) / 86400 ))
check "signatures ($sig) at most 2 days old" yes "$([ "$age" -le 2 ] && echo yes || echo no)"
log "health: $(jq -c . "$T_OUT/body")"

# --- "No stored copy": the picture before ------------------------------------------------------
fc_before="$(fc_total)"
fc_sizes_before="$(fc_test_sizes)"

# --- Through Cloudflare --------------------------------------------------------------------------
check "no key -> 401" 401 "$(printf 'x' | api_nokey POST /v1/scan --data-binary @-)"
check "GET /v1/scan -> 404" 404 "$(api GET /v1/scan)"

r="$(eicar | scan "$API_BASE" eicar.txt --data-binary @-)"
check "EICAR -> 200" 200 "$(status_of "$r")"
check "EICAR -> infected" infected "$(jq -r .status "$T_OUT/body")"
check "EICAR signature names EICAR" yes "$(jq -r '.signature | test("eicar"; "i") | if . then "yes" else "no" end' "$T_OUT/body")"
log "EICAR: $(jq -c . "$T_OUT/body") in ${r#* } s"

r="$(head -c 5M /dev/urandom | scan "$API_BASE" random-5m.bin --data-binary @-)"
check "5 MiB random -> 200" 200 "$(status_of "$r")"
check "5 MiB random -> clean" clean "$(jq -r .status "$T_OUT/body")"
check "the answer is not cached" yes "$(has_header cache-control '.*no-store')"
log "5 MiB: $(jq -c . "$T_OUT/body") in ${r#* } s"

F_MAX="$T_OUT/max.bin"
F_OVER="$T_OUT/over.bin"
head -c "$OVER" /dev/urandom > "$F_OVER"
head -c "$MAX" "$F_OVER" > "$F_MAX"
r="$(scan "$API_BASE" "limit 95 MiB.bin" -T "$F_MAX")"
check "exactly $MAX bytes through Cloudflare -> 200" 200 "$(status_of "$r")"
check "exactly $MAX bytes -> clean" clean "$(jq -r .status "$T_OUT/body")"
check "exactly $MAX bytes within 45 s (${r#* } s)" yes "$(awk -v t="${r#* }" 'BEGIN { print (t < 45) ? "yes" : "no" }')"
log "95 MiB through Cloudflare: $(jq -c . "$T_OUT/body") in ${r#* } s"

# --- Straight to the app container (past Cloudflare's 100 MB cap) -------------------------------
r="$(scan "$DIRECT" over.bin -T "$F_OVER")"
check "96 MiB -> 413" 413 "$(status_of "$r")"
check "96 MiB -> too_large with max_bytes" "too_large $MAX" "$(jq -r '"\(.error) \(.max_bytes)"' "$T_OUT/body")"
log "96 MiB: $(jq -c . "$T_OUT/body") in ${r#* } s"

r="$(head -c $((MAX + 1)) "$F_OVER" | scan "$DIRECT" one-over.bin --data-binary @-)"
check "one byte over the limit -> 413" 413 "$(status_of "$r")"

r="$(scan "$DIRECT" chunked.bin -T "$F_OVER" -H 'Transfer-Encoding: chunked')"
check "96 MiB chunked (no Content-Length) -> 413 while streaming" 413 "$(status_of "$r")"
check "chunked -> too_large" too_large "$(jq -r .error "$T_OUT/body")"
log "96 MiB chunked: $(jq -c . "$T_OUT/body") in ${r#* } s"

# --- 4 scans at once ------------------------------------------------------------------------------
for i in 1 2 3 4; do
	curl -sS -X POST -K <(nomail_auth) -H 'Content-Type: application/octet-stream' -H "X-File-Name: parallel-$i.bin" \
		-H "Host: $DRIVE_HOST" -T "$F_MAX" -o "$T_OUT/p$i.body" -D "$T_OUT/p$i.headers" \
		-w '%{http_code}' "$DIRECT/v1/scan" > "$T_OUT/p$i.status" &
done
wait
ok=0
busy=0
retry=0
for i in 1 2 3 4; do
	case "$(cat "$T_OUT/p$i.status")" in
	200) [ "$(jq -r .status "$T_OUT/p$i.body")" = clean ] && ok=$((ok + 1)) ;;
	429)
		[ "$(jq -r .error "$T_OUT/p$i.body")" = scanner_busy ] && busy=$((busy + 1))
		grep -qiE '^retry-after: *30' "$T_OUT/p$i.headers" && retry=$((retry + 1))
		;;
	esac
done
log "4 at once: $ok clean, $busy scanner_busy ($(cat "$T_OUT"/p?.status | tr '\n' ' '))"
check "4 at once: 2 run (clean)" 2 "$ok"
check "4 at once: 2 get 429 scanner_busy" 2 "$busy"
check "the 429s carry Retry-After: 30" "$busy" "$retry"

# --- No stored copy --------------------------------------------------------------------------------
fc_after="$(fc_total)"
check "no new filecache row of a test size" "$fc_sizes_before" "$(fc_test_sizes)"
if [ "$fc_before" = "$fc_after" ]; then
	log "PASS filecache rows unchanged ($fc_after)"
else
	log "NOTE filecache rows $fc_before -> $fc_after: other tasks work on this server at the same time; none of the new rows has a test size (checked above)"
fi
check "no new file over 1 MiB in the data folder" 0 "$(dc exec -T app find /var/www/html/data -type f -newermt "@$START" -size +1M ! -name '*.log' </dev/null | wc -l)"
check "no PHP upload file left in the app container" 0 "$(dc exec -T app find /tmp -maxdepth 1 -type f -name 'php*' -newermt "@$START" -size +1M </dev/null | wc -l)"
check "no clamd temporary file left" 0 "$(dc exec -T clamav find /tmp -type f -newermt "@$START" -size +1M </dev/null | wc -l)"
# File names go to the debug log only (the server logs warnings and up); bytes never do.
check "no test file name in the server log" 0 "$(dc exec -T app grep -c -F -e 'parallel-1.bin' -e 'limit 95 MiB.bin' /var/www/html/data/nextcloud.log </dev/null || true)"
check "no EICAR bytes in the server log" 0 "$(dc exec -T app grep -c -F 'ANTIVIRUS-TEST' /var/www/html/data/nextcloud.log </dev/null || true)"

# --- The audit ------------------------------------------------------------------------------------
audit="$(dc exec -T db psql -U nextcloud -d nextcloud -tAc \
	"select string_agg(distinct result, ',' order by result) from oc_nourax_api_audit where route = 'POST /v1/scan' and at >= $START" </dev/null | tr -d '[:space:]')"
check "audit rows for clean, infected, scanner_busy and too_large" yes \
	"$(for r in clean infected scanner_busy too_large; do case ",$audit," in *",$r,"*) ;; *) echo no; exit ;; esac; done; echo yes)"
log "audit results since the start: $audit"

# --- ClamAV missing (under the lock, because it changes a setting) -------------------------------
take_lock
orig_host="$(occ config:app:get nourax_api clamav_host </dev/null 2>/dev/null || true)"
restore_host() {
	occ config:app:set nourax_api clamav_host --value="${orig_host:-clamav}" </dev/null >/dev/null
}
trap 'restore_host; rm -rf "$T_OUT"' EXIT
occ config:app:set nourax_api clamav_host --value=clamav-missing </dev/null >/dev/null
sleep 4 # each web worker keeps app settings for up to 3 seconds
r="$(printf 'hello' | scan "$API_BASE" missing.txt --data-binary @-)"
check "clamav missing: scan -> 503" 503 "$(status_of "$r")"
check "clamav missing: scanner_unavailable" scanner_unavailable "$(jq -r .error "$T_OUT/body")"
check "clamav missing: health -> 200" 200 "$(api GET /v1/health)"
check "clamav missing: health status still ok" "ok unavailable null" "$(jq -r '"\(.status) \(.clamav) \(.signatures)"' "$T_OUT/body")"
restore_host
trap 'rm -rf "$T_OUT"' EXIT
sleep 4
check "clamav_host put back (${orig_host:-clamav})" "${orig_host:-clamav}" "$(occ config:app:get nourax_api clamav_host </dev/null)"
r="$(head -c 1M /dev/urandom | scan "$API_BASE" back.bin --data-binary @-)"
check "put back: scan -> 200" 200 "$(status_of "$r")"
check "put back: clean" clean "$(jq -r .status "$T_OUT/body")"
check "put back: health clamav ok" ok "$( [ "$(api GET /v1/health)" = 200 ] && jq -r .clamav "$T_OUT/body")"

finish scan
