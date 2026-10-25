#!/usr/bin/env bash
# End-to-end test of the upload Worker (worker/, nodrive-upload), first without its live route.
# Run it on the owner's PC (Git Bash), from the repo, with a private scratch folder:
#
#   tests/worker-local.sh <scratch-dir>
#
# It starts the Worker with `wrangler dev` on http://127.0.0.1:8787 and sends what NoMail's page
# sends: a sealed ticket, POST /start, three chunk PUTs (50 MiB, 50 MiB, 20 MiB), GET /chunks and
# POST /finish. The local Worker writes into the live Drive as qa-t6-2. Then it reads the file back
# straight from the Drive (WebDAV PROPFIND and GET) and compares sizes and SHA-256 sums. It also
# checks CORS (mail.nourax.org yes, any other origin 403), tickets sealed with the wrong key or
# missing (401), bad chunk numbers and lengths (400), a name that is taken (409) and cancelling.
#
# Keys and passwords:
# - The Worker runs with a throwaway ticket key made here, in <scratch-dir>/upload-dev.env, loaded
#   with `wrangler dev --env-file`. The real key stays on the server and in the deployed Worker.
# - qa-t6-2's app password is copied from the server (/etc/nourax/qa/qa-t6-2.netrc, over SSH) into
#   <scratch-dir> and read from files only: curl gets it with --netrc-file, mint-ticket.mjs gets the
#   file path, and tickets reach curl as config files (-K). Nothing prints a key or a password.
#
# Through the live route (after the owner's yes for drive.nourax.org/nomail-upload/*), the same
# checks run against the deployed Worker:
#
#   WORKER_URL=https://drive.nourax.org/nomail-upload tests/worker-local.sh <scratch-dir>
#
# Then no wrangler dev is started, and the tickets must be sealed with the real key: it is piped
# from the server (sudo cat /etc/nourax/secrets/upload_ticket_key over SSH) straight into
# mint-ticket.mjs on stdin, never into a file. It stops at once while the route is not on.
#
# What it leaves: the uploaded file in qa-t6-2's /NoMail/Sent/<yyyy-mm>/ (worker-120m.bin, or
# worker-120m-live.bin through the route, or the name with -<time> when it is taken) and the login
# files in <scratch-dir>. The test data, tickets and keys it made are removed at the end. Exit 0
# when every check passes.
#
# Settings (environment): NOURAX_SSH (the ssh command for the server), QA_UID (default qa-t6-2),
# WORKER_URL (default the local Worker), WORKER_PORT (default 8787), DRIVE_URL (default
# https://drive.nourax.org).
# SPDX-License-Identifier: AGPL-3.0-or-later

# shellcheck source=../scripts/lib.sh
. "$(dirname "$0")/../scripts/lib.sh"

[ $# -eq 1 ] || die "usage: tests/worker-local.sh <scratch-dir>   (a private folder for keys and logins)"
S="$1"
NOURAX_SSH="${NOURAX_SSH:-ssh -i $HOME/.ssh/nourax_workspace_ed25519 -o BatchMode=yes -o IdentitiesOnly=yes nourax@57.129.185.78}"
QA_UID="${QA_UID:-qa-t6-2}"
PORT="${WORKER_PORT:-8787}"
DRIVE_URL="${DRIVE_URL:-https://drive.nourax.org}"
BASE="${WORKER_URL:-http://127.0.0.1:$PORT/nomail-upload}"
BASE="${BASE%/}"
case "$BASE" in
http://127.0.0.1:* | http://localhost:*) LIVE=no ;;
https://*/nomail-upload) LIVE=yes ;;
*) die "WORKER_URL must be https://<host>/nomail-upload (or leave it out for the local Worker)" ;;
esac
MAIL_ORIGIN=https://mail.nourax.org
MiB=$((1024 * 1024))
CHUNK=$((50 * MiB))
SIZE=$((120 * MiB)) # three chunks: 50 MiB, 50 MiB, 20 MiB
MONTH="$(date -u +%Y-%m)"
WRANGLER="$REPO_DIR/worker/node_modules/wrangler/bin/wrangler.js"
MINT="$REPO_DIR/worker/tools/mint-ticket.mjs"

[ "$LIVE" = yes ] || [ -f "$WRANGLER" ] || die "run 'npm ci' in worker/ first"
case "$QA_UID" in qa-t6-*) ;; *) die "QA_UID must be a qa-t6-N account" ;; esac
command -v node >/dev/null || die "node is missing"

umask 077
mkdir -p "$S"
chmod 0700 "$S"
T="$(mktemp -d "$S/run.XXXXXX")"
dev_pid=""
fails=0

# Native Windows programs (node, curl from mingw) need C:/... paths; elsewhere this changes nothing.
native() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

stop_dev() {
	[ -n "$dev_pid" ] || return 0
	if [ -r "/proc/$dev_pid/winpid" ] && command -v taskkill >/dev/null; then
		# Git Bash: end node and its workerd child together.
		taskkill //F //T //PID "$(cat "/proc/$dev_pid/winpid")" >/dev/null 2>&1 || true
	else
		kill "$dev_pid" 2>/dev/null || true
	fi
	wait "$dev_pid" 2>/dev/null || true
	dev_pid=""
}
cleanup() {
	stop_dev
	# Only what this run made: test data, tickets, the throwaway keys. The logins stay in $S.
	rm -rf "$T"
}
trap cleanup EXIT

check() { # name expected actual
	if [ "$2" = "$3" ]; then
		log "PASS $1"
	else
		log "FAIL $1: expected '$2', got '$3'"
		fails=$((fails + 1))
	fi
}

# Prints a JavaScript expression over the JSON on stdin (as j); empty when it is not JSON.
jget() { # expression < file
	node -e '
let j;
try { j = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch { process.exit(0); }
let v;
try { v = new Function("j", "return (" + process.argv[1] + ");")(j); } catch { process.exit(0); }
process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
' "$1"
}

# "yes" when the last answer had this header (name case-insensitive, value as a regex).
has_header() { grep -qiE "^$1: *$2"$'\r'"?$" "$T/headers" && echo yes || echo no; }

# One call to the Worker, as NoMail's page makes it (Origin: mail.nourax.org). Prints the
# status; the body is left in $T/body and the headers in $T/headers.
#   up METHOD ROUTE TICKET-CONFIG|- [curl options...]
up() {
	local method="$1" route="$2" ticket="$3"
	shift 3
	local auth=()
	[ "$ticket" = - ] || auth=(-K "$(native "$ticket")")
	curl -sS -X "$method" "${auth[@]}" -H "Origin: $MAIL_ORIGIN" -H 'Expect:' \
		-o "$(native "$T/body")" -D "$(native "$T/headers")" -w '%{http_code}' "$@" "$BASE$route"
}

# A WebDAV call straight to the Drive as the QA account. Prints the status; the body goes to
# $DAV_OUT (default $T/dav).
dav() { # METHOD path-under-the-user's-files [curl options...]
	local method="$1" path="$2"
	shift 2
	curl -sS -X "$method" --netrc-file "$(native "$S/$QA_UID.netrc")" -o "$(native "${DAV_OUT:-$T/dav}")" \
		-w '%{http_code}' "$@" "$DRIVE_URL/remote.php/dav/files/$QA_UID$path"
}
PROPFIND_BODY='<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:getcontentlength/><oc:fileid/></d:prop></d:propfind>'
dav_prop() { grep -oE "<d:$1>[^<]*" "$T/dav" | head -1 | sed 's/^<[^>]*>//'; }
oc_prop() { grep -oE "<oc:$1>[^<]*" "$T/dav" | head -1 | sed 's/^<[^>]*>//'; }

# Seals a ticket and writes it as a curl config line (header = "X-Upload-Ticket: ..."). KEY is a
# key file, or "server" for the real key, piped from the server into mint-ticket.mjs on stdin.
#   ticket KEY DRIVE-PATH SIZE OUT-FILE
ticket() {
	local mint=(node "$(native "$MINT")")
	if [ "$1" = server ]; then
		$NOURAX_SSH 'sudo cat /etc/nourax/secrets/upload_ticket_key' | MSYS_NO_PATHCONV=1 "${mint[@]}" - \
			"$QA_UID" "$QA_LOGIN" "$(native "$S/$QA_UID.pass")" "$2" "$3" "$CHUNK" > "$T/ticket.raw"
	else
		MSYS_NO_PATHCONV=1 "${mint[@]}" "$(native "$1")" \
			"$QA_UID" "$QA_LOGIN" "$(native "$S/$QA_UID.pass")" "$2" "$3" "$CHUNK" > "$T/ticket.raw"
	fi
	[ -s "$T/ticket.raw" ] || die "could not seal a ticket"
	printf 'header = "X-Upload-Ticket: %s"\n' "$(cat "$T/ticket.raw")" > "$4"
	rm -f "$T/ticket.raw"
}

# --- The QA login, copied from the server into the scratch folder -----------------------------
$NOURAX_SSH "sudo cat /etc/nourax/qa/$QA_UID.netrc" > "$S/$QA_UID.netrc.new" \
	|| die "could not read /etc/nourax/qa/$QA_UID.netrc on the server"
mv -f "$S/$QA_UID.netrc.new" "$S/$QA_UID.netrc"
QA_LOGIN="$(awk '{for (i = 1; i < NF; i++) if ($i == "login") { print $(i + 1); exit }}' "$S/$QA_UID.netrc")"
awk '{for (i = 1; i < NF; i++) if ($i == "password") { printf "%s", $(i + 1); exit }}' "$S/$QA_UID.netrc" > "$S/$QA_UID.pass"
[ -n "$QA_LOGIN" ] && [ -s "$S/$QA_UID.pass" ] || die "the netrc file of $QA_UID has no login or password"
check "$QA_UID app password works on the Drive (PROPFIND /NoMail)" 207 \
	"$(dav PROPFIND /NoMail -H 'Depth: 0' -H 'Content-Type: application/xml' --data-binary "$PROPFIND_BODY")"

# --- The Worker: the live route, or a local one with a throwaway key ----------------------------
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))' > "$T/wrong-key"
if [ "$LIVE" = yes ]; then
	live="$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $MAIL_ORIGIN" "$BASE/health")"
	[ "$live" = 200 ] || die "$BASE/health answers $live: the route is not on yet (an owner-yes step)"
	KEY=server
	log "testing the live Worker at $BASE (tickets sealed with the real key from the server)"
else
	node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))' > "$T/test-key"
	printf 'UPLOAD_TICKET_KEY=%s\n' "$(cat "$T/test-key")" > "$T/upload-dev.env"
	KEY="$T/test-key"
	if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then
		die "something already listens on port $PORT (set WORKER_PORT)"
	fi
	node "$(native "$WRANGLER")" dev --cwd "$(native "$REPO_DIR/worker")" --env-file "$(native "$T/upload-dev.env")" \
		--ip 127.0.0.1 --port "$PORT" --show-interactive-dev-session=false > "$T/wrangler-dev.log" 2>&1 &
	dev_pid=$!
	for _ in $(seq 1 90); do
		curl -s -o /dev/null --max-time 2 "$BASE/health" && break
		kill -0 "$dev_pid" 2>/dev/null || { tail -20 "$T/wrangler-dev.log" >&2; die "wrangler dev stopped"; }
		sleep 1
	done
	curl -s -o /dev/null --max-time 2 "$BASE/health" || { tail -20 "$T/wrangler-dev.log" >&2; die "wrangler dev did not start"; }
	log "wrangler dev is up on $BASE (throwaway key)"
fi

# --- The destination: /NoMail/Sent/<yyyy-mm>/worker-120m[-live].bin, or with -<time> if taken ---
NAME=worker-120m.bin
[ "$LIVE" = no ] || NAME=worker-120m-live.bin
if [ "$(dav PROPFIND "/NoMail/Sent/$MONTH/$NAME" -H 'Depth: 0' --data-binary "$PROPFIND_BODY")" = 207 ]; then
	log "$NAME is already there from an earlier run"
	NAME="${NAME%.bin}-$(date -u +%Y%m%d%H%M%S).bin"
fi
DEST="/NoMail/Sent/$MONTH/$NAME"
log "destination: $QA_UID:$DEST ($SIZE bytes)"

# --- Test data and tickets ----------------------------------------------------------------------
head -c "$SIZE" /dev/urandom > "$T/data.bin"
split -b "$CHUNK" -d -a 1 "$T/data.bin" "$T/chunk."
SENT_SHA="$(sha256sum "$T/data.bin" | cut -d' ' -f1)"
log "test data: $(wc -c < "$T/data.bin") bytes, sha256 $SENT_SHA; chunks $(wc -c "$T"/chunk.? | awk '$2 != "total" {printf "%s ", $1}')"
ticket "$KEY" "$DEST" "$SIZE" "$T/ticket.curl"
ticket "$T/wrong-key" "$DEST" "$SIZE" "$T/wrong.curl"
ticket "$KEY" "/NoMail/Sent/$MONTH/worker-cancel.bin" 1048576 "$T/cancel.curl"

# --- CORS and tickets ------------------------------------------------------------------------
check "GET /health -> 200" 200 "$(up GET /health -)"
check "health says ok" ok "$(jget j.status < "$T/body")"
check "health has ACAO mail.nourax.org" yes "$(has_header Access-Control-Allow-Origin "$MAIL_ORIGIN")"
check "preflight from mail.nourax.org -> 204" 204 "$(up OPTIONS /chunks/1 - \
	-H 'Access-Control-Request-Method: PUT' -H 'Access-Control-Request-Headers: x-upload-ticket')"
check "preflight has ACAO mail.nourax.org" yes "$(has_header Access-Control-Allow-Origin "$MAIL_ORIGIN")"
check "preflight allows X-Upload-Ticket" yes "$(has_header Access-Control-Allow-Headers '.*X-Upload-Ticket.*')"
check "preflight allows PUT" yes "$(has_header Access-Control-Allow-Methods '.*PUT.*')"
status="$(curl -sS -X OPTIONS -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: PUT' \
	-o "$(native "$T/body")" -D "$(native "$T/headers")" -w '%{http_code}' "$BASE/chunks/1")"
check "preflight from https://evil.example -> 403" 403 "$status"
check "evil.example gets origin_not_allowed" origin_not_allowed "$(jget j.error.code < "$T/body")"
check "evil.example gets no ACAO" no "$(has_header Access-Control-Allow-Origin '.*')"
check "POST /start with no ticket -> 401" 401 "$(up POST /start -)"
check "no ticket gets bad_ticket" bad_ticket "$(jget j.error.code < "$T/body")"
check "POST /start with a ticket sealed with the wrong key -> 401" 401 "$(up POST /start "$T/wrong.curl")"
check "wrong key gets bad_ticket" bad_ticket "$(jget j.error.code < "$T/body")"

# --- The upload ------------------------------------------------------------------------------
check "POST /start -> 201" 201 "$(up POST /start "$T/ticket.curl")"
check "start says 3 chunks" 3 "$(jget j.chunks < "$T/body")"
check "start says chunk size $CHUNK" "$CHUNK" "$(jget j.chunkSize < "$T/body")"
check "start has ACAO mail.nourax.org" yes "$(has_header Access-Control-Allow-Origin "$MAIL_ORIGIN")"
head -c 1024 "$T/data.bin" > "$T/small.bin"
check "PUT /chunks/4 (there are 3) -> 400" 400 "$(up PUT /chunks/4 "$T/ticket.curl" -T "$(native "$T/small.bin")")"
check "chunk 4 gets bad_chunk_number" bad_chunk_number "$(jget j.error.code < "$T/body")"
check "PUT /chunks/1 with 1024 bytes -> 400" 400 "$(up PUT /chunks/1 "$T/ticket.curl" -T "$(native "$T/small.bin")")"
check "short chunk gets bad_chunk_length" bad_chunk_length "$(jget j.error.code < "$T/body")"
for n in 1 2 3; do
	part="$T/chunk.$((n - 1))"
	started=$SECONDS
	status="$(up PUT "/chunks/$n" "$T/ticket.curl" -T "$(native "$part")")"
	check "PUT /chunks/$n ($(wc -c < "$part") bytes) -> 201" 201 "$status"
	[ "$status" = 201 ] || log "  the Worker said: $(jget 'j.error.code + " - " + j.error.message' < "$T/body")"
	check "chunk $n size in the answer" "$(wc -c < "$part")" "$(jget j.size < "$T/body")"
	log "chunk $n took $((SECONDS - started)) s"
done
check "GET /chunks -> 200" 200 "$(up GET /chunks "$T/ticket.curl")"
check "GET /chunks lists 1, 2, 3 with their sizes" "1:$CHUNK,2:$CHUNK,3:$((SIZE - 2 * CHUNK))" \
	"$(jget 'j.received.map((c) => c.n + ":" + c.size).join(",")' < "$T/body")"
started=$SECONDS
check "POST /finish -> 201" 201 "$(up POST /finish "$T/ticket.curl")"
log "finish took $((SECONDS - started)) s"
FILE_ID="$(jget j.fileId < "$T/body")"
check "finish gives a numeric fileId" yes "$([[ "$FILE_ID" =~ ^[0-9]+$ ]] && echo yes || echo no)"
check "finish gives size $SIZE" "$SIZE" "$(jget j.size < "$T/body")"
check "finish gives the path" "$DEST" "$(jget j.path < "$T/body")"
log "finish: fileId $FILE_ID, etag $(jget j.etag < "$T/body"), type $(jget j.contentType < "$T/body")"
check "POST /start again for the same name -> 409" 409 "$(up POST /start "$T/ticket.curl")"
check "the taken name gets exists" exists "$(jget j.error.code < "$T/body")"

# --- Cancelling an upload (only the session this test starts) ----------------------------------
check "POST /start (cancel test) -> 201" 201 "$(up POST /start "$T/cancel.curl")"
check "DELETE / -> 204" 204 "$(up DELETE / "$T/cancel.curl")"
check "GET /chunks after cancel -> 404" 404 "$(up GET /chunks "$T/cancel.curl")"
check "cancelled upload gets upload_not_found" upload_not_found "$(jget j.error.code < "$T/body")"

stop_dev

# --- Read it back straight from the Drive --------------------------------------------------------
check "PROPFIND $DEST -> 207" 207 "$(dav PROPFIND "$DEST" -H 'Depth: 0' -H 'Content-Type: application/xml' \
	--data-binary "$PROPFIND_BODY")"
check "getcontentlength is $SIZE" "$SIZE" "$(dav_prop getcontentlength)"
check "fileid matches the Worker's answer" "$FILE_ID" "$(oc_prop fileid)"
check "GET $DEST -> 200" 200 "$(DAV_OUT="$T/download.bin" dav GET "$DEST")"
GOT_SHA="$( (sha256sum "$T/download.bin" 2>/dev/null || true) | cut -d' ' -f1)"
log "sent sha256 $SENT_SHA"
log "got  sha256 $GOT_SHA"
check "sha256 of the download equals the sha256 sent" "$SENT_SHA" "$GOT_SHA"
check "cancelled upload left no file" 404 "$(dav PROPFIND "/NoMail/Sent/$MONTH/worker-cancel.bin" -H 'Depth: 0' \
	--data-binary "$PROPFIND_BODY")"

# --- For the record: is the live route on? (an owner-yes step; not a check) --------------------
if [ "$LIVE" = no ]; then
	live="$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $MAIL_ORIGIN" "$DRIVE_URL/nomail-upload/health")"
	if [ "$live" = 404 ]; then
		log "live route: none ($DRIVE_URL/nomail-upload/health answers 404 from the Drive)"
	else
		log "live route: $DRIVE_URL/nomail-upload/health answers $live"
	fi
fi

[ "$fails" -eq 0 ] || die "$fails check(s) failed"
log "all worker-local checks passed ($([ "$LIVE" = yes ] && echo "live route" || echo "local Worker"))"
