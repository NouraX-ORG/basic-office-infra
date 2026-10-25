#!/usr/bin/env bash
# Contract test for POST /v1/provision of the NoMail API (docs/nomail-api.md).
# Run it on the server: sudo tests/api-provision.sh
#
# It uses only QA ids, never the owner's account:
#   qa-t6-1  a "Log in with Nourax" account made by the API; its newest app password is kept in
#            /etc/nourax/qa/qa-t6-1.netrc for the other contract tests (U1-U5)
#   qa-t6-2  made by the API, then disabled: the API must refuse it and leave it disabled
#   qa-t6-9  a local (password) account: the API must refuse it; disabled, as it never signs in
# It takes the server-change lock (/run/nourax-deploy.lock) for its whole run, two to three
# minutes, because it adds and disables QA accounts and writes under /etc/nourax/qa. The last
# check fills the provision limit for a minute, so it then waits for the next minute.
# Keys and app passwords are never printed: only lengths, hashes compared in place, and statuses.
# Safe to run again (qa-t6-1 then answers created:false). Exit 0 when every check passes.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_nomail_key
take_lock

QA1=qa-t6-1
QA2=qa-t6-2
QA_LOCAL=qa-t6-9
NETRC1="$(qa_netrc "$QA1")"

log "base URL: $API_BASE"

# --- Input rules, checked inside the app container without a web request ---------------------
if dc exec -T app php < "$REPO_DIR/tests/provision-request.php" > "$T_OUT/unit"; then
	log "PASS input rules ($(grep -c '^PASS' "$T_OUT/unit") checks)"
else
	grep -v '^PASS' "$T_OUT/unit" || true
	check "input rules" passed failed
fi

# --- Key and headers -------------------------------------------------------------------------
check "no key -> 401" 401 "$(api_nokey POST /v1/provision -H 'Content-Type: application/json' --data-binary '{}')"
check "no key -> error unauthorized" unauthorized "$(jq -r .error "$T_OUT/body")"
# A run just before this one may have used up this minute's provisions (the last check below).
if [ "$(api POST /v1/provision -H 'Content-Type: application/json' --data-binary '{}')" = 429 ]; then
	log "the provision limit is used up this minute; waiting for the next one"
	wait_next_minute
fi

# --- A new account ---------------------------------------------------------------------------
existed="$(user_exists "$QA1")"
expected_created="$([ "$existed" = yes ] && echo false || echo true)"
check "provision $QA1 -> 200" 200 "$(provision "$QA1" "$QA1@example.invalid" "QA t6 1")"
check "created is $expected_created" "$expected_created" "$(jq -r .created "$T_OUT/body")"
check "uid is $QA1" "$QA1" "$(jq -r .uid "$T_OUT/body")"
check "login is $QA1" "$QA1" "$(jq -r .login "$T_OUT/body")"
check "app_password has 72 characters" 72 "$(jq -r '.app_password | length' "$T_OUT/body")"
# NoMail's validCredentials (supabase/functions/_shared/drive.ts): a uid the upload Worker accepts,
# a login without ':' or control characters, a password of 1-512 characters without them.
check "answer passes NoMail's validCredentials" true "$(jq -r '
	(.uid | type == "string" and test("^[A-Za-z0-9._@-]{1,64}$"))
	and (.login | type == "string" and length > 0 and length <= 256 and (contains(":") | not) and (test("[[:cntrl:]]") | not))
	and (.app_password | type == "string" and length > 0 and length <= 512 and (test("[[:cntrl:]]") | not))
	and (.created | type == "boolean")' "$T_OUT/body")"
check "not cached" yes "$(has_header Cache-Control '.*no-store')"
check "JSON answer" yes "$(has_header Content-Type 'application/json')"
first_hash="$(jq -r .app_password "$T_OUT/body" | sha256sum)"
save_netrc "$T_OUT/first.netrc"

info="$(occ user:info "$QA1" --output=json </dev/null)"
check "backend is user_oidc" user_oidc "$(jq -r .backend <<<"$info")"
check "display name" "QA t6 1" "$(jq -r .display_name <<<"$info")"
check "email" "$QA1@example.invalid" "$(jq -r .email <<<"$info")"

check "PROPFIND /NoMail/ (Depth 1) -> 207" 207 "$(propfind "$T_OUT/first.netrc" "$QA1/NoMail/" 1)"
for sub in Sent Received Images; do
	check "/NoMail/ lists $sub/" yes "$(grep -q "/remote.php/dav/files/$QA1/NoMail/$sub/<" "$T_OUT/dav" && echo yes || echo no)"
done

# --- The same call again: same account, new password, old one revoked ------------------------
check "second provision -> 200" 200 "$(provision "$QA1" "$QA1@example.invalid" "QA t6 1")"
check "second: created false" false "$(jq -r .created "$T_OUT/body")"
check "second: uid unchanged" "$QA1" "$(jq -r .uid "$T_OUT/body")"
check "second: a different password" yes "$([ "$(jq -r .app_password "$T_OUT/body" | sha256sum)" != "$first_hash" ] && echo yes || echo no)"
save_netrc "$NETRC1"
# The old password first: the new one's successful login then clears this miss for the account.
check "old password -> 401" 401 "$(propfind "$T_OUT/first.netrc" "$QA1/" 0)"
check "new password -> 207" 207 "$(propfind "$NETRC1" "$QA1/" 0)"
check "exactly one app password named NoMail" 1 \
	"$(occ user:auth-tokens:list "$QA1" --output=json </dev/null | jq '[.[] | select(.name == "NoMail")] | length')"

# --- Refused requests ------------------------------------------------------------------------
bad_request() { # name json
	check "$1 -> 400" 400 "$(api POST /v1/provision -H 'Content-Type: application/json' --data-binary "$2")"
	check "$1 -> error invalid_request" invalid_request "$(jq -r .error "$T_OUT/body")"
}
bad_request "user_id nodrive" '{"user_id":"nodrive","email":"x@example.invalid","display_name":"x"}'
bad_request "user_id admin" '{"user_id":"admin","email":"x@example.invalid","display_name":"x"}'
bad_request "uppercase UUID" '{"user_id":"A1B2C3D4-E5F6-4789-ABCD-EF0123456789","email":"x@example.invalid","display_name":"x"}'
bad_request "user_id with a newline" "$(jq -cn --arg u $'qa-t6-1\n' '{user_id: $u, email: "x@example.invalid", display_name: "x"}')"
bad_request "missing email" '{"user_id":"qa-t6-1","display_name":"QA t6 1"}'
bad_request "email that is no address" '{"user_id":"qa-t6-1","email":"not an address","display_name":"QA t6 1"}'
bad_request "not JSON" 'user_id=qa-t6-1'
check "nodrive has no NoMail app password" 0 \
	"$(occ user:auth-tokens:list nodrive --output=json </dev/null | jq '[.[] | select(.name == "NoMail")] | length')"

head -c 20000 /dev/zero | tr '\0' 'a' > "$T_OUT/big"
check "body over 16 KB -> 413" 413 "$(api POST /v1/provision -H 'Content-Type: application/json' --data-binary "@$T_OUT/big")"
check "body over 16 KB -> error too_large" too_large "$(jq -r .error "$T_OUT/body")"

# A local account with the same kind of id is never turned into a NoMail account.
qa_local_user "$QA_LOCAL" "QA t6 9"
occ user:disable "$QA_LOCAL" </dev/null >/dev/null
check "local account $QA_LOCAL -> 409" 409 "$(provision "$QA_LOCAL" "$QA_LOCAL@example.invalid" "QA t6 9")"
check "local account -> error uid_not_oidc" uid_not_oidc "$(jq -r .error "$T_OUT/body")"

# A disabled account stays disabled.
if [ "$(user_exists "$QA2")" = no ]; then
	check "provision $QA2 -> 200" 200 "$(provision "$QA2" "$QA2@example.invalid" "QA t6 2")"
fi
occ user:disable "$QA2" </dev/null >/dev/null
check "disabled $QA2 -> 409" 409 "$(provision "$QA2" "$QA2@example.invalid" "QA t6 2")"
check "disabled -> error account_disabled" account_disabled "$(jq -r .error "$T_OUT/body")"
check "$QA2 is still disabled" false "$(occ user:info "$QA2" --output=json </dev/null | jq -r .enabled)"

# --- Rate limit: 60 provisions a minute for all callers together -----------------------------
# Refused bodies count too, so this makes no accounts or passwords. Start early in a minute so
# all 70 calls fall in the same counting window.
while [ "$(date +%-S)" -gt 20 ]; do sleep 1; done
limited=0
retry_after=no
for _ in $(seq 1 70); do
	code="$(api POST /v1/provision -H 'Content-Type: application/json' --data-binary '{}')"
	if [ "$code" = 429 ]; then
		limited=$((limited + 1))
		[ "$(has_header Retry-After '[0-9]+')" = yes ] && retry_after=yes
	fi
done
log "70 calls in one minute: $limited answered 429"
check "70 calls in a minute -> some 429" yes "$([ "$limited" -gt 0 ] && echo yes || echo no)"
check "429 carries Retry-After" yes "$retry_after"
log "waiting for the next minute, so real provisions are not refused"
wait_next_minute

finish provision
