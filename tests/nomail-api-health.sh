#!/usr/bin/env bash
# Contract test for GET /v1/health of the NoMail API (docs/nomail-api.md).
# Run it on the server, so the key is read from its secret file:
#   sudo tests/nomail-api-health.sh
# The key reaches curl through a pipe (curl -K -), never as an argument, and is never printed.
# The two wrong-key calls count as brute-force misses for this server's address; the right key
# clears them again. Exit 0 when every check passes.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/../scripts/lib.sh"
need_root
load_env

BASE="${NODRIVE_API_URL:-https://${DRIVE_HOST}/apps/nourax_api}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
fails=0

check() { # name expected actual
	if [ "$2" = "$3" ]; then
		log "PASS $1"
	else
		log "FAIL $1: expected '$2', got '$3'"
		fails=$((fails + 1))
	fi
}

# GET /v1/health with the curl config lines on stdin. Prints the HTTP status; the body is left in
# $OUT/body and the headers in $OUT/headers.
health() {
	curl -sS -K - -o "$OUT/body" -D "$OUT/headers" -w '%{http_code}' "$BASE/v1/health"
}

log "base URL: $BASE"

check "no key -> 401" 401 "$(printf '' | health)"
check "no key -> error unauthorized" unauthorized "$(jq -r .error "$OUT/body")"

wrong="$(openssl rand -hex 24)"
check "wrong key -> 401" 401 "$(printf 'header = "Authorization: Bearer %s"\n' "$wrong" | health)"

have_secret nodrive_api_key || die "nodrive_api_key is missing (sudo scripts/secrets.sh gen nodrive_api_key)"
key="$(cat "$(secret_path nodrive_api_key)")"
check "right key -> 200" 200 "$(printf 'header = "Authorization: Bearer %s"\n' "$key" | health)"
unset key
check "status ok" ok "$(jq -r .status "$OUT/body")"
check "clamav is ok or unavailable" yes "$(jq -r 'if .clamav == "ok" or .clamav == "unavailable" then "yes" else .clamav end' "$OUT/body")"
check "signatures is a date or null" yes "$(jq -r 'if .signatures == null or (.signatures | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")) then "yes" else .signatures end' "$OUT/body")"
check "not cached" yes "$(grep -qi '^cache-control:.*no-store' "$OUT/headers" && echo yes || echo no)"
check "JSON answer" yes "$(grep -qi '^content-type: application/json' "$OUT/headers" && echo yes || echo no)"
log "health: $(jq -c . "$OUT/body")"

[ "$fails" -eq 0 ] || die "$fails check(s) failed"
log "all health checks passed"
