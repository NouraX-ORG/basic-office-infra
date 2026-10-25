#!/usr/bin/env bash
# How the owner signs in as a demo person (docs/teams.md#signing-in-as-a-demo-person), checked for
# every account in the owner's copy of the demo keys. Run it on the owner's PC (Git Bash), from the
# repo: the sign-in page is open only to the owner's address, so the server cannot test it.
#
#   tests/demo-signin.sh [keys-file]
#
# keys-file defaults to ../_private/nourax-workspace-demo-accounts.txt next to the checkout (one
# line per account: uid TAB name TAB organisation TAB teams TAB key; see tests/demo-accounts.sh).
#
# For each account:
# 1. The sign-in form refuses the key: "Log in with Nourax" accounts have no password, and the form
#    checks only passwords. The POST is sent back to /login, and that page's reason is
#    "invalidpassword" (not a failed CSRF or Origin check, so the request itself was right).
# 2. WebDAV PROPFIND of the person's home with the key answers 207.
# 3. The way in: GET /remote.php/webdav/ with the key (what the browser sends after its password
#    prompt) answers 200 and starts a session; with only that session's cookies, the OCS user call
#    names the person and /apps/files/ is that person's page.
# 4. "Log out" (the link in the person's own page) ends the session, and the key still answers 207.
# Once: /remote.php/webdav/ without a key answers 401 with a Basic prompt named "Nourax Workspace".
#
# It changes nothing on the server and deletes nothing. The keys go to curl only in netrc files
# and form files in a private temporary folder, removed at the end; nothing prints a key. Each
# run sends one refused sign-in per account (24); the sign-in page counts none of them against the
# owner's address (checked with occ security:bruteforce:attempts <address> login).
# Exit 0 when every check passes.
# SPDX-License-Identifier: AGPL-3.0-or-later

# shellcheck source=../scripts/lib.sh
. "$(dirname "$0")/../scripts/lib.sh"

KEYS_FILE="${1:-$REPO_DIR/../_private/nourax-workspace-demo-accounts.txt}"
[ -s "$KEYS_FILE" ] || die "no keys file at $KEYS_FILE (copy it from the server: docs/teams.md#demo-accounts)"
DRIVE_HOST="${DRIVE_HOST:-drive.nourax.org}"
BASE="https://$DRIVE_HOST"
# A normal browser, so the server answers as it does to the owner's browser.
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || die "python3 (or python) is needed to read JSON"

umask 077
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
# curl on Windows reads name@file and --netrc-file paths as Windows paths.
if command -v cygpath >/dev/null 2>&1; then T="$(cygpath -m "$T")"; fi

fails=0
check() { # name expected actual
	if [ "$2" = "$3" ]; then
		log "PASS $1"
	else
		log "FAIL $1: expected '$2', got '$3'"
		fails=$((fails + 1))
	fi
}
location() { tr -d '\r' < "$1" | awk 'tolower($1) == "location:" { print $2 }' | tail -n 1; }
request_token() { grep -o 'data-requesttoken="[^"]*"' "$1" | head -n 1 | sed 's/^data-requesttoken="//; s/"$//' || true; }
ocs_uid() { "$PY" -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["ocs"]["data"]["id"])' "$1" 2>/dev/null || echo none; }
# The sign-in page's error codes (its initial state core-loginErrors), as compact JSON.
login_errors() {
	"$PY" -I - "$1" <<'PY'
import base64, json, re, sys
text = open(sys.argv[1], encoding="utf-8").read()
found = re.search(r'id="initial-state-core-loginErrors" value="([^"]*)"', text)
print(json.dumps(json.loads(base64.b64decode(found.group(1))), separators=(",", ":")) if found else "none")
PY
}
# The "Log out" link of a signed-in page: the user menu's entry in the page's initial state.
logout_link() {
	"$PY" -I - "$1" <<'PY'
import base64, json, re, sys
text = open(sys.argv[1], encoding="utf-8").read()
for value in re.findall(r'id="initial-state-[^"]+" value="([^"]*)"', text):
	try:
		blob = json.dumps(json.loads(base64.b64decode(value)))
	except Exception:
		continue
	found = re.search(r'"href": "([^"]*(?:/logout|/sls)[^"]*)"', blob)
	if found:
		print(found.group(1))
		break
PY
}

code="$(curl -sS -A "$UA" -D "$T/h0" -o /dev/null -w '%{http_code}' "$BASE/remote.php/webdav/")"
check "/remote.php/webdav/ without a key -> 401" 401 "$code"
check "the browser's password prompt is for \"Nourax Workspace\"" yes \
	"$(tr -d '\r' < "$T/h0" | grep -qi '^www-authenticate: Basic realm="Nourax Workspace"' && echo yes || echo no)"

n=0
while IFS=$'\t' read -r uid name _ _ key; do
	[ -n "$uid" ] || continue
	case "$uid" in demo-[a-z0-9-]*) ;; *) die "not a demo account in $KEYS_FILE: $uid" ;; esac
	n=$((n + 1))
	rm -f "$T"/jar* "$T"/h*
	printf '%s' "$key" > "$T/key"
	printf 'machine %s login %s password %s\n' "$DRIVE_HOST" "$uid" "$key" > "$T/netrc"
	unset key

	# 1. The sign-in form, with its CSRF token, cookies and Origin, as a browser sends it.
	curl -sS -A "$UA" -c "$T/jar1" -b "$T/jar1" -o "$T/login.html" "$BASE/login"
	token="$(request_token "$T/login.html")"
	curl -sS -A "$UA" -c "$T/jar1" -b "$T/jar1" -H "Origin: $BASE" -D "$T/h1" -o /dev/null \
		--data-urlencode "user=$uid" --data-urlencode "password@$T/key" --data-urlencode "requesttoken=$token" \
		--data-urlencode timezone=Europe/London --data-urlencode timezone_offset=0 "$BASE/login"
	where="$(location "$T/h1")"
	check "$uid ($name): the sign-in form refuses the key" "/login yes" \
		"${where%%\?*} $([ -n "$token" ] && echo yes || echo no-token)"
	# The reason, from the page it is sent back to: a wrong password (not the CSRF or Origin check).
	curl -sS -A "$UA" -c "$T/jar1" -b "$T/jar1" -o "$T/login2.html" "$BASE$where"
	check "$uid: the form's reason is a wrong password" '["invalidpassword"]' "$(login_errors "$T/login2.html")"

	# 2. WebDAV with the key.
	check "$uid: PROPFIND with the key -> 207" 207 "$(curl -sS -X PROPFIND --netrc-file "$T/netrc" -H 'Depth: 0' \
		-o /dev/null -w '%{http_code}' "$BASE/remote.php/dav/files/$uid/")"

	# 3. The way in: the key on the WebDAV address starts a session; then only the cookies.
	check "$uid: /remote.php/webdav/ with the key -> 200" 200 "$(curl -sS -A "$UA" --netrc-file "$T/netrc" \
		-c "$T/jar2" -o /dev/null -w '%{http_code}' "$BASE/remote.php/webdav/")"
	curl -sS -A "$UA" -b "$T/jar2" -c "$T/jar2" -H 'OCS-APIRequest: true' -o "$T/me.json" \
		"$BASE/ocs/v2.php/cloud/user?format=json"
	check "$uid: with the session cookies, the OCS user call names $uid" "$uid" "$(ocs_uid "$T/me.json")"
	code="$(curl -sS -A "$UA" -b "$T/jar2" -c "$T/jar2" -o "$T/files.html" -w '%{http_code}' "$BASE/apps/files/")"
	check "$uid: /apps/files/ with the session cookies is $uid's page" "200 yes" \
		"$code $(grep -q "data-user=\"$uid\"" "$T/files.html" && echo yes || echo no)"

	# 4. Log out with the page's own link; the session ends, the key stays.
	link="$(logout_link "$T/files.html")"
	check "$uid: the page has a Log out link on this host" yes "$(case "$link" in "$BASE"/*) echo yes ;; *) echo no ;; esac)"
	if [ -n "$link" ]; then
		curl -sS -A "$UA" -b "$T/jar2" -c "$T/jar2" -o /dev/null "$link"
	fi
	check "$uid: after Log out the session cookies are signed out" 401 "$(curl -sS -A "$UA" -b "$T/jar2" \
		-H 'OCS-APIRequest: true' -o /dev/null -w '%{http_code}' "$BASE/ocs/v2.php/cloud/user?format=json")"
	check "$uid: after Log out the key still answers 207" 207 "$(curl -sS -X PROPFIND --netrc-file "$T/netrc" \
		-H 'Depth: 0' -o /dev/null -w '%{http_code}' "$BASE/remote.php/dav/files/$uid/")"
done < "$KEYS_FILE"
rm -f "$T/key" "$T/netrc"
check "accounts in the keys file" 24 "$n"

[ "$fails" -eq 0 ] || die "$fails check(s) failed"
log "all demo-signin checks passed"
