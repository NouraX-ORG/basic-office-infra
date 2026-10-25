#!/usr/bin/env bash
# Contract test for the admin API, part 1 (docs/teams.md): request signing, audit, organisations
# and teams. Run it on the server: sudo tests/admin-api.sh
#
# QA objects only (prefix qa-), never the owner's account:
#   organisations qa-t6-org-a ("QA t6 Org A") and qa-t6-org-b ("QA t6 Org B")
#   teams qa-t6-team-a1 and qa-t6-team-a2 (both "Sales", in org A) and qa-t6-team-b1 ("Sales", org B)
#   qa-t6-5 (made here through /v1/provision) is put into org A and team A1 with occ, to check
#   cards and what a member can reach. Its app password is in /etc/nourax/qa/qa-t6-5.netrc. That
#   occ change is real drift, so org A and team A1 list it in their "drift" until the drift job
#   (every 15 minutes) takes qa-t6-5 out again; org B and teams A2 and B1 show "drift": [].
#   (Part 1 used qa-t6-1 here; the people API of part 2 now owns qa-t6-1, see admin-people.sh.)
# It takes the server-change lock for its whole run (about a minute), because it changes groups.
# Nothing is deleted. Safe to run again: versions are read first and counted on from there.
# The admin key is never printed or passed as an argument. Exit 0 when every check passes.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_admin_key
need_nomail_key
take_lock

ORG_A=qa-t6-org-a
ORG_B=qa-t6-org-b
TEAM_A1=qa-t6-team-a1
TEAM_A2=qa-t6-team-a2
TEAM_B1=qa-t6-team-b1
QA1=qa-t6-5
NETRC1="$(qa_netrc "$QA1")"

log "base URL: $API_BASE"

# The stored version of an org or team (0 when it is not there yet).
version_of() { # path
	if [ "$(admin_api GET "$1")" = 200 ]; then
		jq -r '(.org // .team).version' "$T_OUT/body"
	else
		echo 0
	fi
}

# --- Signing -----------------------------------------------------------------------------------
check "no signature -> 401" 401 "$(api_nokey GET /v1/admin/audit?limit=1)"
check "no signature -> error unauthorized" unauthorized "$(jq -r .error "$T_OUT/body")"
check "NoMail key instead of a signature -> 401" 401 "$(api GET /v1/admin/audit?limit=1)"
check "spoiled signature -> 401" 401 "$(SIGN_BAD=1 admin_api GET /v1/admin/audit?limit=1)"
check "signature for another path -> 401" 401 "$(SIGN_PATH=/v1/admin/audit?limit=2 admin_api GET /v1/admin/audit?limit=1)"
check "unknown key id -> 401" 401 "$(SIGN_KEY_ID=admin-9 admin_api GET /v1/admin/audit?limit=1)"
check "short nonce -> 401" 401 "$(SIGN_NONCE=short admin_api GET /v1/admin/audit?limit=1)"
old_ts=$(( $(date +%s) - 360 ))
check "timestamp 6 minutes old -> 401" 401 "$(SIGN_TS="$old_ts" admin_api GET /v1/admin/audit?limit=1)"
check "timestamp 6 minutes old -> error stale_timestamp" stale_timestamp "$(jq -r .error "$T_OUT/body")"
new_ts=$(( $(date +%s) + 360 ))
check "timestamp 6 minutes ahead -> error stale_timestamp" stale_timestamp \
	"$(SIGN_TS="$new_ts" admin_api GET /v1/admin/audit?limit=1 >/dev/null; jq -r .error "$T_OUT/body")"
check "signed call -> 200" 200 "$(admin_api GET /v1/admin/audit?limit=1)"
check "not cached" yes "$(has_header Cache-Control '.*no-store')"
check "the same request again -> 401" 401 "$(admin_send GET /v1/admin/audit?limit=1)"
check "the same request again -> error replayed" replayed "$(jq -r .error "$T_OUT/body")"
check "pretty URL and index.php URL both work" 200 \
	"$(API_BASE="https://${DRIVE_HOST}/index.php/apps/nourax_api" admin_api GET /v1/admin/audit?limit=1)"

head -c 2100000 /dev/zero | tr '\0' 'a' > "$T_OUT/big"
check "body over 2 MB -> 413" 413 "$(admin_api PUT "/v1/admin/orgs/$ORG_A" "$(cat "$T_OUT/big")")"
check "body over 2 MB -> error too_large" too_large "$(jq -r .error "$T_OUT/body")"

# --- Input rules -------------------------------------------------------------------------------
bad() { # name path body
	check "$1 -> 400" 400 "$(admin_api PUT "$2" "$3")"
	check "$1 -> error invalid_request" invalid_request "$(jq -r .error "$T_OUT/body")"
}
bad "org id nodrive" /v1/admin/orgs/nodrive "$(name_version X 1)"
bad "org id in capitals" /v1/admin/orgs/QA-T6-ORG-A "$(name_version X 1)"
bad "version 0" "/v1/admin/orgs/$ORG_A" "$(name_version X 0)"
bad "version as a string" "/v1/admin/orgs/$ORG_A" '{"name":"X","version":"1"}'
bad "empty name" "/v1/admin/orgs/$ORG_A" "$(name_version '  ' 1)"
bad "name over 255 characters" "/v1/admin/orgs/$ORG_A" "$(name_version "$(printf 'n%.0s' $(seq 1 256))" 1)"
bad "a query on a PUT" "/v1/admin/orgs/$ORG_A?x=1" "$(name_version X 1)"
check "audit limit 501 -> 400" 400 "$(admin_api GET /v1/admin/audit?limit=501)"
# Paths the router does not know answer a JSON 404, never the web server's HTML page.
json_404() { # name http-status
	check "$1 -> 404" 404 "$2"
	check "$1 -> JSON error not_found" "not_found yes" \
		"$(jq -r .error "$T_OUT/body" 2>/dev/null) $(has_header Content-Type 'application/json')"
}
json_404 "trailing slash (signed GET)" "$(admin_api GET "/v1/admin/orgs/$ORG_A/")"
json_404 "trailing slash (signed PUT)" "$(admin_api PUT "/v1/admin/orgs/$ORG_A/" "$(name_version X 1)")"
json_404 "dot segments" "$(api_nokey GET "/v1/admin/orgs/../orgs/$ORG_A" --path-as-is)"
json_404 "unknown path" "$(api_nokey GET /v1/admin/nothing-here)"
json_404 "unknown method" "$(api_nokey DELETE "/v1/admin/orgs/$ORG_A")"
check "status of an unknown org -> 404" 404 "$(admin_api GET /v1/admin/orgs/qa-t6-org-none)"
check "team in an unknown org -> 409" 409 "$(admin_api PUT /v1/admin/orgs/qa-t6-org-none/teams/qa-t6-team-none "$(name_version X 1)")"
check "team in an unknown org -> error org_missing" org_missing "$(jq -r .error "$T_OUT/body")"

# --- Organisations -----------------------------------------------------------------------------
va="$(version_of "/v1/admin/orgs/$ORG_A")"
v=$((va + 1))
check "PUT org A v$v -> 200" 200 "$(admin_api PUT "/v1/admin/orgs/$ORG_A" "$(name_version "QA t6 Org A" "$v")")"
check "org A: ok and applied" "true true" "$(jq -r '"\(.ok) \(.applied)"' "$T_OUT/body")"
check "org A: the steps" "record group directory directory_share cards team_cards" "$(jq -r '[.steps[].step] | join(" ")' "$T_OUT/body")"
check "org A: no failed step" yes "$(no_failed_steps)"
check "org A: group org:$ORG_A" yes "$(occ group:list --output=json </dev/null | jq -e --arg g "org:$ORG_A" 'has($g)' >/dev/null && echo yes || echo no)"
check "PUT org A again -> 200" 200 "$(admin_api PUT "/v1/admin/orgs/$ORG_A" "$(name_version "QA t6 Org A" "$v")")"
check "org A again: every step unchanged" yes \
	"$(jq -e '[.steps[] | select(.step != "cards" and .step != "team_cards" and .result != "unchanged")] | length == 0' "$T_OUT/body" >/dev/null && echo yes || echo no)"

check "rename org A (v$((v + 1))) -> 200" 200 "$(admin_api PUT "/v1/admin/orgs/$ORG_A" "$(name_version "QA t6 Org A renamed" $((v + 1)))")"
check "rename: group updated" updated "$(step_result group)"
check "rename: directory updated" updated "$(step_result directory)"
check "older version v$v -> 200" 200 "$(admin_api PUT "/v1/admin/orgs/$ORG_A" "$(name_version "QA t6 Org A" "$v")")"
check "older version: applied false, stale_version, version sent, version stored" "false stale_version $v $((v + 1))" \
	"$(jq -r '"\(.applied) \(.reason) \(.version) \(.current_version)"' "$T_OUT/body")"
check "name back (v$((v + 2))) -> 200" 200 "$(admin_api PUT "/v1/admin/orgs/$ORG_A" "$(name_version "QA t6 Org A" $((v + 2)))")"
check "GET org A -> 200" 200 "$(admin_api GET "/v1/admin/orgs/$ORG_A")"
check "org A status" "QA t6 Org A $((v + 2)) true QA t6 Org A true Directory: QA t6 Org A true" \
	"$(jq -r '.org | "\(.name) \(.version) \(.group.exists) \(.group.display_name) \(.directory.exists) \(.directory.display_name) \(.directory.shared_read_only)"' "$T_OUT/body")"

vb="$(version_of "/v1/admin/orgs/$ORG_B")"
check "PUT org B -> 200" 200 "$(admin_api PUT "/v1/admin/orgs/$ORG_B" "$(name_version "QA t6 Org B" $((vb + 1)))")"

# The open drift rows in a status answer, compact JSON ("null" when the field is missing).
drift_of() { # path
	admin_api GET "$1" >/dev/null
	jq -c '(.org // .team).drift' "$T_OUT/body"
}
# "yes" when the status at this path lists an open member_added row for this uid.
drift_lists_added() { # path uid
	admin_api GET "$1" >/dev/null
	jq -e --arg u "$2" '(.org // .team).drift
		| any(.kind == "member_added" and .user_id == $u)
		and all(keys == ["at", "id", "kind", "user_id"])' "$T_OUT/body" >/dev/null && echo yes || echo no
}
check "org B (changed only through the API): drift []" "[]" "$(drift_of "/v1/admin/orgs/$ORG_B")"

# --- Teams ---------------------------------------------------------------------------------------
put_team() { # org team name version
	admin_api PUT "/v1/admin/orgs/$1/teams/$2" "$(name_version "$3" "$4")"
}
folder_of() { # org team -> mount point
	admin_api GET "/v1/admin/orgs/$1/teams/$2" >/dev/null
	jq -r '.team.folder.mount_point' "$T_OUT/body"
}

v1="$(( $(version_of "/v1/admin/orgs/$ORG_A/teams/$TEAM_A1") + 1 ))"
check "PUT team A1 Sales -> 200" 200 "$(put_team "$ORG_A" "$TEAM_A1" Sales "$v1")"
check "team A1: the steps" "record group team_folder addressbook addressbook_share cards calendar calendar_share board board_share" \
	"$(jq -r '[.steps[].step] | join(" ")' "$T_OUT/body")"
check "team A1: no failed step" yes "$(no_failed_steps)"
v2="$(( $(version_of "/v1/admin/orgs/$ORG_A/teams/$TEAM_A2") + 1 ))"
check "PUT team A2 Sales -> 200" 200 "$(put_team "$ORG_A" "$TEAM_A2" Sales "$v2")"
check "team A2: no failed step" yes "$(no_failed_steps)"
vb1="$(( $(version_of "/v1/admin/orgs/$ORG_B/teams/$TEAM_B1") + 1 ))"
check "PUT team B1 Sales (org B) -> 200" 200 "$(put_team "$ORG_B" "$TEAM_B1" Sales "$vb1")"
check "team A1 folder is Sales" Sales "$(folder_of "$ORG_A" "$TEAM_A1")"
check "team A2 folder is Sales 2 (same org, same name)" "Sales 2" "$(folder_of "$ORG_A" "$TEAM_A2")"
check "team B1 folder is Sales (another org)" Sales "$(folder_of "$ORG_B" "$TEAM_B1")"
check "team A2 (changed only through the API): drift []" "[]" "$(drift_of "/v1/admin/orgs/$ORG_A/teams/$TEAM_A2")"
check "team B1 (changed only through the API): drift []" "[]" "$(drift_of "/v1/admin/orgs/$ORG_B/teams/$TEAM_B1")"
check "team A1 under org B -> 409" 409 "$(put_team "$ORG_B" "$TEAM_A1" Sales 99)"
check "team A1 under org B -> error team_in_other_org" team_in_other_org "$(jq -r .error "$T_OUT/body")"
check "team A1 status under org B -> 404" 404 "$(admin_api GET "/v1/admin/orgs/$ORG_B/teams/$TEAM_A1")"

check "PUT team A1 again -> 200" 200 "$(put_team "$ORG_A" "$TEAM_A1" Sales "$v1")"
check "team A1 again: every step unchanged" yes \
	"$(jq -e '[.steps[] | select(.result != "unchanged")] | length == 0' "$T_OUT/body" >/dev/null && echo yes || echo no)"

admin_api GET "/v1/admin/orgs/$ORG_A/teams/$TEAM_A1" >/dev/null
ids_before="$(jq -c '.team | [.folder.id, .addressbook.id, .calendar.id, .board.id]' "$T_OUT/body")"
check "rename team A1 (v$((v1 + 1))) -> 200" 200 "$(put_team "$ORG_A" "$TEAM_A1" "Sales EMEA" $((v1 + 1)))"
check "rename: no failed step" yes "$(no_failed_steps)"
check "rename: group, folder, book, calendar, board updated" "updated updated updated updated updated" \
	"$(for s in group team_folder addressbook calendar board; do step_result "$s"; done | tr '\n' ' ' | sed 's/ $//')"
check "GET team A1 -> 200" 200 "$(admin_api GET "/v1/admin/orgs/$ORG_A/teams/$TEAM_A1")"
check "renamed everywhere" "Team: Sales EMEA|Sales EMEA|Team: Sales EMEA|Team: Sales EMEA|Team: Sales EMEA" \
	"$(jq -r '.team | [.group.display_name, .folder.mount_point, .addressbook.display_name, .calendar.display_name, .board.title] | join("|")' "$T_OUT/body")"
check "rename kept every id" "$ids_before" "$(jq -c '.team | [.folder.id, .addressbook.id, .calendar.id, .board.id]' "$T_OUT/body")"
check "team A1 shares" "31 true true true true" \
	"$(jq -r --arg g "team:$TEAM_A1" '.team | "\(.folder.groups[$g]) \(.folder.acl) \(.addressbook.shared_read_only) \(.calendar.shared_read_write) \(.board.shared_edit)"' "$T_OUT/body")"
check "name back (v$((v1 + 2))) -> 200" 200 "$(put_team "$ORG_A" "$TEAM_A1" Sales $((v1 + 2)))"
check "team A1 folder is Sales again" Sales "$(folder_of "$ORG_A" "$TEAM_A1")"
check "team A2 folder stayed Sales 2" "Sales 2" "$(folder_of "$ORG_A" "$TEAM_A2")"

# --- One call per object at a time ---------------------------------------------------------------
# Three calls for the same team at the same time, each with its own files. A team call takes
# about 250 ms, so they overlap: the one that gets the lock works, the others get 423 busy.
for i in 1 2 3; do
	mkdir -p "$T_OUT/p$i"
	( T_OUT="$T_OUT/p$i"; put_team "$ORG_A" "$TEAM_A1" Sales $((v1 + 2)) > "$T_OUT/code"
		jq -r '.error // "none"' "$T_OUT/body" > "$T_OUT/error" ) &
done
wait
codes="$(for i in 1 2 3; do cat "$T_OUT/p$i/code"; echo; done | sort | tr '\n' ' ')"
log "three calls at once answered: $codes"
check "three calls at once: one works (200)" yes "$(grep -q '200' <<<"$codes" && echo yes || echo no)"
check "three calls at once: another gets 423" yes "$(grep -q '423' <<<"$codes" && echo yes || echo no)"
check "three calls at once: only 200 and 423" yes "$(grep -qvE '^(200 |423 )+$' <<<"$codes" && echo no || echo yes)"
check "423 says busy" yes "$(for i in 1 2 3; do [ "$(cat "$T_OUT/p$i/code")" != 423 ] || cat "$T_OUT/p$i/error"; done | grep -qv '^busy$' && echo no || echo yes)"

# --- Members: cards and access (qa-t6-5, put in with occ: a change made outside the API) ---------
# The number of enabled members of a group, as the cards count them.
enabled_members() { # group
	local n=0 uid
	for uid in $(occ group:list --output=json </dev/null | jq -r --arg g "$1" '(.[$g] // [])[]'); do
		[ "$(occ user:info "$uid" --output=json </dev/null | jq -r .enabled)" = true ] && n=$((n + 1))
	done
	echo "$n"
}
check "provision $QA1 -> 200" 200 "$(provision "$QA1" "$QA1@example.invalid" "QA t6 5")"
save_netrc "$NETRC1"
if [ ! -s "$NETRC1" ]; then
	check "$NETRC1 exists" yes no
else
	# The drift job takes this member out again; run it first, so its next run is 15 minutes
	# away and it cannot do that in the middle of the checks below.
	log "drift job run now (next run in 15 minutes); last run $(drift_job_now)"
	occ group:adduser "org:$ORG_A" "$QA1" </dev/null >/dev/null
	occ group:adduser "team:$TEAM_A1" "$QA1" </dev/null >/dev/null
	check "PUT team A1 with a member -> 200" 200 "$(put_team "$ORG_A" "$TEAM_A1" Sales $((v1 + 2)))"
	check "team cards: one per enabled member" "$(enabled_members "team:$TEAM_A1") card(s)" "$(jq -r '.steps[] | select(.step == "cards") | .detail' "$T_OUT/body" | cut -d' ' -f1-2)"
	check "PUT org A with a member -> 200" 200 "$(admin_api PUT "/v1/admin/orgs/$ORG_A" "$(name_version "QA t6 Org A" $((v + 2)))")"
	check "directory cards: one per enabled member" "$(enabled_members "org:$ORG_A") card(s)" "$(jq -r '.steps[] | select(.step == "cards") | .detail' "$T_OUT/body" | cut -d' ' -f1-2)"
	# The occ group:adduser above is a change made outside the API, so both groups list it as
	# open drift (noted on the first run; adding an existing member again notes nothing).
	check "team A1 drift lists the occ member_added of $QA1" yes "$(drift_lists_added "/v1/admin/orgs/$ORG_A/teams/$TEAM_A1" "$QA1")"
	check "org A drift lists the occ member_added of $QA1" yes "$(drift_lists_added "/v1/admin/orgs/$ORG_A" "$QA1")"
	check "team A2 still drift [] (the member went to A1 only)" "[]" "$(drift_of "/v1/admin/orgs/$ORG_A/teams/$TEAM_A2")"

	book="$DAV_BASE/addressbooks/users/$QA1/team-${TEAM_A1}_shared_by_nourax-teams"
	curl -sS --netrc-file "$NETRC1" -X PROPFIND -H 'Depth: 1' -o "$T_OUT/books" "$DAV_BASE/addressbooks/users/$QA1/"
	check "member's NoContacts lists the team book and the directory" "yes yes" \
		"$(grep -q "team-${TEAM_A1}_shared_by_nourax-teams/<" "$T_OUT/books" && echo yes || echo no) $(grep -q "org-${ORG_A}_shared_by_nourax-teams/<" "$T_OUT/books" && echo yes || echo no)"
	# The server keeps the card as vCard 4.0 and hands out 3.0 unless 4.0 is asked for.
	code="$(curl -sS --netrc-file "$NETRC1" -H 'Accept: text/vcard; version=4.0' -o "$T_OUT/vcf" -w '%{http_code}' "$book/$QA1.vcf")"
	check "member reads their card in the team address book -> 200" 200 "$code"
	check "the card is vCard 4.0 with UID nourax-$QA1" "yes yes" \
		"$(grep -q '^VERSION:4.0' "$T_OUT/vcf" && echo yes || echo no) $(grep -q "^UID:nourax-$QA1" "$T_OUT/vcf" && echo yes || echo no)"
	check "the card names the organisation" yes "$(grep -q '^ORG:QA t6 Org A' "$T_OUT/vcf" && echo yes || echo no)"
	printf 'BEGIN:VCARD\r\nVERSION:4.0\r\nUID:qa-t6-write-test\r\nFN:Write test\r\nEND:VCARD\r\n' > "$T_OUT/new.vcf"
	# A read-only shared book is not offered for writing at all (404), and nothing is stored.
	code="$(curl -sS --netrc-file "$NETRC1" -X PUT -H 'Content-Type: text/vcard' --data-binary "@$T_OUT/new.vcf" \
		-o /dev/null -w '%{http_code}' "$book/qa-t6-write-test.vcf")"
	check "member cannot write to the team address book (403 or 404)" yes "$(case "$code" in 403 | 404) echo yes ;; *) echo "no ($code)" ;; esac)"
	check "the card was not stored -> 404" 404 "$(curl -sS --netrc-file "$NETRC1" -o /dev/null -w '%{http_code}' "$book/qa-t6-write-test.vcf")"
	code="$(curl -sS --netrc-file "$NETRC1" -o /dev/null -w '%{http_code}' \
		"$DAV_BASE/addressbooks/users/$QA1/org-${ORG_A}_shared_by_nourax-teams/$QA1.vcf")"
	check "member reads the organisation directory -> 200" 200 "$code"
	check "member sees the team calendar -> 207" 207 \
		"$(curl -sS --netrc-file "$NETRC1" -X PROPFIND -H 'Depth: 0' -o /dev/null -w '%{http_code}' \
			"$DAV_BASE/calendars/$QA1/team-${TEAM_A1}_shared_by_nourax-teams/")"
	check "member sees the team folder -> 207" 207 "$(propfind "$NETRC1" "$QA1/Sales/" 0)"
	check "member does not see team A2's folder -> 404" 404 "$(propfind "$NETRC1" "$QA1/Sales%202/" 0)"
	board_id="$(admin_api GET "/v1/admin/orgs/$ORG_A/teams/$TEAM_A1" >/dev/null; jq -r .team.board.id "$T_OUT/body")"
	# Deck makes a welcome board on a person's first visit; the QA account does not need one.
	occ user:setting "$QA1" deck firstRun no </dev/null >/dev/null
	curl -sS --netrc-file "$NETRC1" -H 'OCS-APIRequest: true' -H 'Accept: application/json' -o "$T_OUT/boards" \
		"https://${DRIVE_HOST}/index.php/apps/deck/api/v1.0/boards"
	check "member sees the team board" yes "$(jq -e --argjson id "$board_id" 'map(.id) | index($id) != null' "$T_OUT/boards" >/dev/null && echo yes || echo no)"
fi

# --- Audit ---------------------------------------------------------------------------------------
check "GET audit for team A1 -> 200" 200 "$(admin_api GET "/v1/admin/audit?limit=5&target=team:$TEAM_A1")"
check "audit rows name the team" yes "$(jq -e --arg t "team:$TEAM_A1" '.rows | length > 0 and all(.target == $t)' "$T_OUT/body" >/dev/null && echo yes || echo no)"
check "audit rows hold no body" yes "$(jq -e '.rows | all(has("body") | not) and all(has("name") | not)' "$T_OUT/body" >/dev/null && echo yes || echo no)"
check "the busy call is audited as 423" yes "$(admin_api GET "/v1/admin/audit?limit=50&target=team:$TEAM_A1" >/dev/null
	jq -e '.rows | any(.http_status == 423 and .result == "busy")' "$T_OUT/body" >/dev/null && echo yes || echo no)"

# --- Never an MCP tool ---------------------------------------------------------------------------
check "the MCP server never calls the admin API" no "$(grep -rqs 'v1/admin' "$REPO_DIR/mcp" && echo yes || echo no)"

finish admin-api
