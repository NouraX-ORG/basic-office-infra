#!/usr/bin/env bash
# The end of a Task 6 test round: the QA organisations' teams are left archived through the admin
# API, and the QA accounts are disabled. Nothing is deleted (deleting QA accounts, files or
# organisations needs the owner's yes). Run it on the server:
#   sudo tests/qa-wrapup.sh             archive and disable
#   sudo tests/qa-wrapup.sh --enable    enable qa-t6-1 to qa-t6-5 again, before the next test run
#
# Archive: every organisation whose group is org:qa-t6* gets a reconcile with an empty state,
#   POST /v1/admin/orgs/{org_id}/reconcile {"teams":[],"people":[]}
# so its people leave its teams and its group (a normal "leave": shares to the team and links on
# team files go, files stay), and every team is archived: the folder becomes "<name> (archived)",
# the board is archived, the group, folder, files, address book and calendar stay. The people
# are not disabled by the API (only "active": false does that); this script disables them with
# occ user:disable instead, so the 30-day hold and the scheduled delete never apply to them.
# Disable: every account qa-t6-<number> that is still enabled (qa-t6-8 and qa-t6-9 already are).
#
# The tests themselves put everything back: their PUTs bring the teams out of the archive.
# Because occ, not the API, disabled the accounts, the people API refuses them (409
# account_disabled) until --enable has run.
# It takes the server-change lock for its whole run. Exit 0 when every check passes.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
take_lock

ENABLE_AGAIN=(qa-t6-1 qa-t6-2 qa-t6-3 qa-t6-4 qa-t6-5)

enabled_of() { # uid -> true | false | missing
	occ user:info "$1" --output=json </dev/null 2>/dev/null | jq -r '.enabled' 2>/dev/null || echo missing
}

if [ "${1-}" = "--enable" ]; then
	for uid in "${ENABLE_AGAIN[@]}"; do
		[ "$(user_exists "$uid")" = yes ] || continue
		occ user:enable "$uid" </dev/null >/dev/null
		check "$uid enabled" true "$(enabled_of "$uid")"
	done
	finish qa-wrapup-enable
	exit 0
fi
[ $# -eq 0 ] || die "usage: sudo tests/qa-wrapup.sh [--enable]"

need_admin_key

# 1. Archive the QA organisations' teams through the API.
mapfile -t orgs < <(occ group:list --output=json </dev/null | jq -r 'keys[] | select(startswith("org:qa-t6")) | ltrimstr("org:")')
log "QA organisations: ${orgs[*]:-none}"
for org in "${orgs[@]}"; do
	refuse_owner "$org"
	status="$(admin_api POST "/v1/admin/orgs/$org/reconcile" '{"teams":[],"people":[]}')"
	check "$org reconcile with an empty state answers 200" 200 "$status"
	check "$org reconcile ok" true "$(jq -r '.ok' "$T_OUT/body")"
	log "$org drift fixed: $(jq -c '[.drift_fixed[] | "\(.kind) \(.group) \(.user_id // "")"]' "$T_OUT/body")"

	status="$(admin_api GET "/v1/admin/orgs/$org")"
	check "$org status 200" 200 "$status"
	check "$org group kept" true "$(jq -r '.org.group.exists' "$T_OUT/body")"
	check "$org group has no members" 0 "$(jq -r '.org.group.members' "$T_OUT/body")"
	check "$org every team archived" true "$(jq -r '[.org.teams[].archived] | all' "$T_OUT/body")"
	mapfile -t teams < <(jq -r '.org.teams[].team_id' "$T_OUT/body")
	for team in "${teams[@]}"; do
		status="$(admin_api GET "/v1/admin/orgs/$org/teams/$team")"
		check "$team status 200" 200 "$status"
		check "$team folder kept" true "$(jq -r '.team.folder.exists' "$T_OUT/body")"
		check "$team group kept, no members" "true 0" "$(jq -r '"\(.team.group.exists) \(.team.group.members)"' "$T_OUT/body")"
		log "$team: folder \"$(jq -r '.team.folder.mount_point' "$T_OUT/body")\", board archived $(jq -r '.team.board.archived' "$T_OUT/body")"
	done
done

# 2. Disable every QA account of Task 6.
mapfile -t accounts < <(occ user:list --output=json </dev/null | jq -r 'keys[] | select(test("^qa-t6-[0-9]+$"))')
log "QA accounts: ${accounts[*]:-none}"
for uid in "${accounts[@]}"; do
	refuse_owner "$uid"
	if [ "$(enabled_of "$uid")" = true ]; then
		occ user:disable "$uid" </dev/null >/dev/null
	fi
	check "$uid disabled" false "$(enabled_of "$uid")"
done

finish qa-wrapup
