#!/usr/bin/env bash
# Lane D (calendar and tasks) QA people for the MCP server's live tests (DESIGN 16.3, 17.6).
#
# Privacy between organisations is on (docs/teams.md), so QA people who invite each other need a
# shared organisation. They are made through the admin API, the only way to put people in an org:
# group: it refuses local password accounts (uid_not_oidc), which is why the local accounts
# qa-t1-26 and qa-t1-24 could only share the plain group qa-t1-26-24 (review fix round 2).
#   organisation qa-t1-d-calendar-tasks "QA t1 D calendar":
#     qa-t1-261 "QA t1 D one" (organises), qa-t1-262 "QA t1 D two" (invited),
#     qa-t1-263 "QA t1 D three" (a third person on the same invitations)
# qa-t1-30 (the design's isolation target, in no organisation) stays outside it.
# Each person gets an app password named "qa mcp" in /etc/nourax/qa/<uid>.app (root, 0600) for
# the dev env file. Only lengths and step results are printed; no key or password is.
# A person who already has an .app file is left as it is; any other existing account stops the
# script, so nobody else's account is ever taken over. Nothing is deleted.
#
# Run it from this PC under the deploy lock, piped on stdin (the SSH options and the server
# address are in the shared brief, not in this public repo):
#   ssh <brief SSH options> nourax@<server> \
#     'cd /opt/nourax/basic-office-infra && sudo flock -w 1800 /run/nourax-deploy.lock bash -s' \
#     < mcp/test/live/calendar/qa-setup.sh
# Every command that could read stdin gets </dev/null, so the piped script is never swallowed.
# SPDX-License-Identifier: AGPL-3.0-or-later

cd /opt/nourax/basic-office-infra
git pull -q --ff-only </dev/null
export NOURAX_LOCK_HELD=1
# shellcheck source=../../../../tests/lib.sh
. tests/lib.sh
need_admin_key

ORG=qa-t1-d-calendar-tasks

# Makes an organisation when it is missing (version 1). An existing one is left alone.
ensure_named() { # path name
	local code
	code="$(admin_api GET "$1" </dev/null)"
	if [ "$code" = 200 ]; then
		log "$1 exists; left as it is"
		return 0
	fi
	[ "$code" = 404 ] || die "GET $1 answered $code"
	code="$(admin_api PUT "$1" "$(name_version "$2" 1)" </dev/null)"
	[ "$code" = 200 ] || die "PUT $1 answered $code"
	log "$1 created: $(jq -c '[.steps[] | {step, result}]' "$T_OUT/body")"
}

# Makes a person in the organisation and an app password for them.
ensure_person() { # uid display-name
	local uid="$1" name="$2" app_file="$QA_DIR/$1.app" code
	if [ -s "$app_file" ]; then
		log "$uid already has an app password; left as it is"
		return 0
	fi
	[ "$(user_exists "$uid")" = no ] || die "$uid exists but is not one of this lane's people; stopping"
	code="$(admin_api PUT "/v1/admin/people/$uid" "$(jq -cn --arg e "$uid@example.invalid" --arg d "$name" \
		--arg o "$ORG" '{email: $e, display_name: $d, org_id: $o, teams: [], active: true, version: 1}')" </dev/null)"
	[ "$code" = 200 ] || die "PUT people/$uid answered $code: $(jq -c '{error}' "$T_OUT/body" 2>/dev/null)"
	log "$uid created: $(jq -c '[.steps[] | {step, result}]' "$T_OUT/body")"
	install -d -m 0700 "$QA_DIR"
	(
		umask 077
		# A "Log in with Nourax" account has no login password, so this app password has none either,
		# like the ones Login Flow v2 makes for these accounts. The last output line is the password.
		occ user:auth-tokens:add --name "qa mcp" "$uid" </dev/null | tail -n 1 | tr -d '\r\n' >"$app_file"
	)
	chmod 600 "$app_file"
	[ "$(wc -c <"$app_file")" -ge 40 ] || die "$uid: no app password was made"
	log "$uid app password made ($(wc -c <"$app_file") characters)"
}

ensure_named "/v1/admin/orgs/$ORG" "QA t1 D calendar"
ensure_person qa-t1-261 "QA t1 D one"
ensure_person qa-t1-262 "QA t1 D two"
ensure_person qa-t1-263 "QA t1 D three"

for uid in qa-t1-261 qa-t1-262 qa-t1-263 qa-t1-30; do
	log "$uid: $(occ user:info "$uid" --output=json </dev/null | jq -c '{enabled, groups}')"
done
