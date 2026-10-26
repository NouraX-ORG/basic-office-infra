#!/usr/bin/env bash
# Lane B (sharing and contacts) QA people for the MCP server's live tests (DESIGN 16.3, 17.6).
#
# Privacy between organisations is on (docs/teams.md), so QA people who must find and share with
# each other need a shared organisation or team. They are made through the admin API, the only
# way to put people in an org: or team: group (the API refuses local password accounts, and its
# QA user ids look like qa-t<task>-<n>):
#   organisation qa-t1-b-org-1 "QA t1 B Org 1", team qa-t1-b-team-1 "QA t1 B Team":
#     qa-t1-211 "QA t1 B one" (the lane's account) and qa-t1-212 "QA t1 B two" (the second person)
#   organisation qa-t1-b-org-2 "QA t1 B Org 2":
#     qa-t1-213 "QA t1 B three" (another organisation: it must stay out of reach of the other two)
# Each person gets an app password named "qa mcp" in /etc/nourax/qa/<uid>.app (root, 0600) for
# the dev env file. Only lengths and step results are printed; no key or password is.
# A person who already has an .app file is left as it is; any other existing account stops the
# script, so nobody else's account is ever taken over. Nothing is deleted.
#
# Run it from this PC under the deploy lock, piped on stdin (the SSH options and the server
# address are in the shared brief, not in this public repo):
#   ssh <brief SSH options> nourax@<server> \
#     'cd /opt/nourax/basic-office-infra && sudo flock -w 1800 /run/nourax-deploy.lock bash -s' \
#     < mcp/test/live/sharing/qa-setup.sh
# Every command that could read stdin gets </dev/null, so the piped script is never swallowed.
# SPDX-License-Identifier: AGPL-3.0-or-later

cd /opt/nourax/basic-office-infra
git pull -q --ff-only </dev/null
export NOURAX_LOCK_HELD=1
# shellcheck source=../../../../tests/lib.sh
. tests/lib.sh
need_admin_key

ORG1=qa-t1-b-org-1
ORG2=qa-t1-b-org-2
TEAM1=qa-t1-b-team-1

# Makes an organisation or team when it is missing (version 1). An existing one is left alone.
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

# Makes a person in an organisation (and a team, when given) and an app password for them.
ensure_person() { # uid display-name org [team]
	local uid="$1" name="$2" org="$3" team="${4:-}" app_file="$QA_DIR/$1.app" code teams
	if [ -s "$app_file" ]; then
		log "$uid already has an app password; left as it is"
		return 0
	fi
	[ "$(user_exists "$uid")" = no ] || die "$uid exists but is not one of this lane's people; stopping"
	if [ -n "$team" ]; then
		teams="$(jq -cn --arg t "$team" '[{team_id: $t, role: "member"}]')"
	else
		teams='[]'
	fi
	code="$(admin_api PUT "/v1/admin/people/$uid" "$(jq -cn --arg e "$uid@example.invalid" --arg d "$name" \
		--arg o "$org" --argjson t "$teams" '{email: $e, display_name: $d, org_id: $o, teams: $t, active: true, version: 1}')" </dev/null)"
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

ensure_named "/v1/admin/orgs/$ORG1" "QA t1 B Org 1"
ensure_named "/v1/admin/orgs/$ORG2" "QA t1 B Org 2"
ensure_named "/v1/admin/orgs/$ORG1/teams/$TEAM1" "QA t1 B Team"
ensure_person qa-t1-211 "QA t1 B one" "$ORG1" "$TEAM1"
ensure_person qa-t1-212 "QA t1 B two" "$ORG1" "$TEAM1"
ensure_person qa-t1-213 "QA t1 B three" "$ORG2"

for uid in qa-t1-211 qa-t1-212 qa-t1-213; do
	log "$uid groups: $(occ user:info "$uid" --output=json </dev/null | jq -c '.groups')"
done
