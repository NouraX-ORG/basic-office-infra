#!/usr/bin/env bash
# Shared helpers for the tests in tests/. Source it; don't run it.
#
# The tests run on the server with sudo (sudo tests/<name>.sh), so keys come from the secret
# files in /etc/nourax/secrets. A key reaches curl as a config line on a pipe or a <(...) file,
# never as an argument, and nothing here prints a key or an app password.
#
# QA logins live in /etc/nourax/qa (root, 0700; files 0600):
#   <uid>.netrc  "machine <DRIVE_HOST> login <login> password <app password>", for curl --netrc-file
#   <uid>.pass   the login password of a local QA account
# SPDX-License-Identifier: AGPL-3.0-or-later

# shellcheck source=../scripts/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"
need_root
load_env

API_BASE="${NODRIVE_API_URL:-https://${DRIVE_HOST}/apps/nourax_api}"
DAV_BASE="https://${DRIVE_HOST}/remote.php/dav"
QA_DIR=/etc/nourax/qa
LOCK_FILE=/run/nourax-deploy.lock
# The owner's account. No test may ever send it to the API.
OWNER_UID=5224252b-4938-4a86-a276-54bbae5d5b49

T_OUT="$(mktemp -d)"
trap 'rm -rf "$T_OUT"' EXIT
fails=0

check() { # name expected actual
	if [ "$2" = "$3" ]; then
		log "PASS $1"
	else
		log "FAIL $1: expected '$2', got '$3'"
		fails=$((fails + 1))
	fi
}

finish() { # test-name
	[ "$fails" -eq 0 ] || die "$fails check(s) failed"
	log "all $1 checks passed"
}

# Takes the server-change lock for the rest of the test (QA accounts, files under /etc).
# Skipped when the caller already holds it and says so with NOURAX_LOCK_HELD=1.
take_lock() {
	[ "${NOURAX_LOCK_HELD:-0}" = 1 ] && return 0
	exec 9>"$LOCK_FILE"
	log "waiting for $LOCK_FILE"
	flock -w 1800 9 || die "could not take $LOCK_FILE"
	export NOURAX_LOCK_HELD=1
}

# Stops the test if any argument names the owner's account, in any case.
refuse_owner() {
	local arg
	for arg in "$@"; do
		case "${arg,,}" in
		*"$OWNER_UID"*) die "refusing to send the owner's account to the API" ;;
		esac
	done
}

# The curl config line with the NoMail API key, for curl -K <(nomail_auth).
nomail_auth() {
	printf 'header = "Authorization: Bearer %s"\n' "$(cat "$(secret_path nodrive_api_key)")"
}

need_nomail_key() {
	have_secret nodrive_api_key || die "nodrive_api_key is missing (sudo scripts/secrets.sh gen nodrive_api_key)"
}

# A NoMail API call with the key. Prints the HTTP status; the body is left in $T_OUT/body and the
# headers in $T_OUT/headers.
#   api METHOD /v1/path [curl options...]
api() {
	local method="$1" path="$2"
	shift 2
	refuse_owner "$@"
	curl -sS -X "$method" -K <(nomail_auth) -o "$T_OUT/body" -D "$T_OUT/headers" -w '%{http_code}' \
		"$@" "$API_BASE$path"
}

# The same without any Authorization header.
api_nokey() {
	local method="$1" path="$2"
	shift 2
	refuse_owner "$@"
	curl -sS -X "$method" -o "$T_OUT/body" -D "$T_OUT/headers" -w '%{http_code}' "$@" "$API_BASE$path"
}

# POST /v1/provision for one person, as NoMail sends it. Prints the HTTP status.
provision() { # user_id email display_name
	api POST /v1/provision -H 'Content-Type: application/json' \
		--data-binary "$(jq -cn --arg u "$1" --arg e "$2" --arg d "$3" '{user_id: $u, email: $e, display_name: $d}')"
}

# "yes" when the last answer had this header (case-insensitive name, value matched as a regex).
has_header() { # name value-regex
	grep -qiE "^$1: *$2" "$T_OUT/headers" && echo yes || echo no
}

qa_netrc() { printf '%s/%s.netrc' "$QA_DIR" "$1"; }

# Saves the login and app password of the last /v1/provision answer as a netrc file, 0600.
# An answer without them (an error) leaves the file as it was.
save_netrc() { # file
	if ! jq -e '(.login | type == "string") and (.app_password | type == "string")' "$T_OUT/body" >/dev/null 2>&1; then
		log "not saving $1: the last answer had no login and app password"
		return 0
	fi
	install -d -m 0700 "$QA_DIR"
	(
		umask 077
		jq -r --arg host "$DRIVE_HOST" '"machine \($host) login \(.login) password \(.app_password)"' \
			"$T_OUT/body" > "$1.new"
		mv -f "$1.new" "$1"
	)
}

# Waits until the next minute starts, so the API's per-minute counts begin again.
wait_next_minute() {
	local minute
	minute="$(date +%M)"
	while [ "$(date +%M)" = "$minute" ]; do sleep 1; done
}

# A WebDAV PROPFIND with a netrc file. Prints the HTTP status; the body is left in $T_OUT/dav.
propfind() { # netrc-file path-under-/files/ depth
	curl -sS -X PROPFIND --netrc-file "$1" -H "Depth: $3" -H 'Content-Type: application/xml; charset=utf-8' \
		--data-binary '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>' \
		-o "$T_OUT/dav" -w '%{http_code}' "$DAV_BASE/files/$2"
}

# "yes" when the account exists.
user_exists() {
	occ user:info "$1" --output=json </dev/null >/dev/null 2>&1 && echo yes || echo no
}

# Runs the drift job (nourax_api DriftReconcile, every 15 minutes) now, so its next run is 15
# minutes away. Call it right before a test changes an org:* or team:* group with occ on purpose:
# otherwise the cron container may run the job in the middle of the test and put the group back
# before the test has looked (it did, at 06:20:01 on 2026-10-25). Prints the job's new last run.
drift_job_now() {
	local id
	id="$(occ background-job:list --class 'OCA\NouraxApi\BackgroundJob\DriftReconcile' --output=json </dev/null | jq -r '.[0].id // empty')"
	[ -n "$id" ] || die "the DriftReconcile job is not registered (is nourax_api enabled?)"
	occ background-job:execute "$id" --force-execute </dev/null >/dev/null
	occ background-job:list --class 'OCA\NouraxApi\BackgroundJob\DriftReconcile' --output=json </dev/null | jq -r '.[0].last_run'
}

# Makes a local (password) QA account if it is missing. The password is random, kept in
# $QA_DIR/<uid>.pass and handed to occ through the environment (OC_PASS), never as an argument.
qa_local_user() { # uid display-name
	[ "$(user_exists "$1")" = yes ] && return 0
	local pass_file="$QA_DIR/$1.pass"
	install -d -m 0700 "$QA_DIR"
	[ -s "$pass_file" ] || (umask 077 && openssl rand -base64 30 | tr -d '\n' > "$pass_file")
	(
		OC_PASS="$(cat "$pass_file")"
		export OC_PASS
		dc exec -T -e OC_PASS -u www-data app php occ user:add --password-from-env \
			--display-name "$2" "$1" </dev/null >/dev/null
	)
}

# --- The admin API (docs/teams.md) -------------------------------------------------------------
# Admin requests are signed with the admin key (HMAC-SHA256, see lib/Http/HmacAuth.php). The key
# is read by python3 from its secret file, never passed as an argument; only the one-time
# signature headers go to curl, as a config file in $T_OUT.

need_admin_key() {
	have_secret nodrive_admin_api_key || die "nodrive_admin_api_key is missing (sudo scripts/secrets.sh gen nodrive_admin_api_key)"
}

# Writes curl config lines with the four signature headers for one request.
# Overrides for the refusal tests: SIGN_TS (timestamp), SIGN_NONCE, SIGN_KEY_ID, SIGN_PATH (sign
# another path than the one requested), SIGN_BAD=1 (spoil the signature).
#   admin_headers METHOD PATH BODY-FILE > config
admin_headers() {
	SIGN_METHOD="$1" SIGN_REQ_PATH="${SIGN_PATH:-$2}" SIGN_BODY_FILE="$3" \
	SIGN_KEY_FILE="$(secret_path nodrive_admin_api_key)" python3 -I -c '
import hashlib, hmac, os, secrets, time
with open(os.environ["SIGN_KEY_FILE"], "rb") as f:
	key = f.read().strip(b" \t\n\r\0\x0b")
with open(os.environ["SIGN_BODY_FILE"], "rb") as f:
	body = f.read()
ts = os.environ.get("SIGN_TS") or str(int(time.time()))
nonce = os.environ.get("SIGN_NONCE") or secrets.token_urlsafe(24)
key_id = os.environ.get("SIGN_KEY_ID", "admin-1")
canonical = "\n".join(["NOURAX-ADMIN-V1", os.environ["SIGN_METHOD"].upper(), os.environ["SIGN_REQ_PATH"],
	ts, nonce, hashlib.sha256(body).hexdigest()]).encode()
sig = hmac.new(key, canonical, hashlib.sha256).hexdigest()
if os.environ.get("SIGN_BAD") == "1":
	sig = ("0" if sig[0] != "0" else "1") + sig[1:]
for name, value in (("X-Nourax-Key-Id", key_id), ("X-Nourax-Timestamp", ts),
		("X-Nourax-Nonce", nonce), ("X-Nourax-Signature", sig)):
	print("header = \"%s: %s\"" % (name, value))
'
}

# A signed admin API call. Prints the HTTP status; the body is left in $T_OUT/body, the headers
# in $T_OUT/headers and the signature headers used in $T_OUT/signed (to replay them).
#   admin_api METHOD /v1/admin/... [JSON-BODY]
admin_api() {
	local method="$1" path="$2" body="${3-}"
	refuse_owner "$path" "$body"
	printf '%s' "$body" > "$T_OUT/request"
	admin_headers "$method" "$path" "$T_OUT/request" > "$T_OUT/signed"
	admin_send "$method" "$path"
}

# Sends the last signed request again, as it is (for the replay test).
#   admin_send METHOD PATH
admin_send() {
	local data=()
	[ -s "$T_OUT/request" ] && data=(-H 'Content-Type: application/json' --data-binary "@$T_OUT/request")
	curl -sS -g -X "$1" -K "$T_OUT/signed" "${data[@]}" -o "$T_OUT/body" -D "$T_OUT/headers" \
		-w '%{http_code}' "$API_BASE$2"
}

# The JSON body {"name","version"} of an organisation or team PUT.
name_version() { jq -cn --arg n "$1" --argjson v "$2" '{name: $n, version: $v}'; }

# The result of one step in the last admin answer, e.g. step_result team_folder -> created
step_result() { jq -r --arg s "$1" '.steps[] | select(.step == $s) | .result' "$T_OUT/body"; }

# "yes" when no step of the last admin answer failed.
no_failed_steps() { jq -e '[.steps[] | select(.result == "failed")] | length == 0' "$T_OUT/body" >/dev/null && echo yes || echo no; }
