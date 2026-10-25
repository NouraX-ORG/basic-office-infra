#!/usr/bin/env bash
# Privacy between organisations (docs/teams.md): people find, autocomplete and share only with
# people of their own organisation. Run it on the server: sudo tests/privacy.sh
# (after admin-api.sh, which makes the QA organisations and teams). It checks what the org privacy
# step (scripts/configure.d/60-org-privacy.sh) switched on, as two QA organisations see it:
#   org A (qa-t6-org-a): qa-t6-1 (team A2, the one who looks), qa-t6-2 (team A1, lead)
#   org B (qa-t6-org-b): qa-t6-3 and qa-t6-5 (team B1)
# Everything goes through the people's NoMail app passwords from /v1/provision (/etc/nourax/qa).
#
# PRIVACY_BASELINE=1 runs only the checks that read, for a "before" picture while the step is
# still off: there every FAIL is something the step closes. The checks that would make a share
# are skipped then, so nothing is shared across organisations. Exit 0 in that mode.
#
# It takes the server-change lock (it changes QA people through the admin API). It makes, and
# keeps: a folder qa-t6-privacy with two files in qa-t6-1's and qa-t6-3's own files, a calendar
# and an address book "qa-t6-privacy" and a board "QA t6 privacy" of qa-t6-1, and same-org
# shares of these with qa-t6-2. It deletes nothing. Safe to run again.
# Keys and passwords are never printed. Exit 0 when every check passes.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_admin_key
need_nomail_key
take_lock

BASELINE="${PRIVACY_BASELINE:-0}"
ORG_A=qa-t6-org-a
ORG_B=qa-t6-org-b
TEAM_A1=qa-t6-team-a1
TEAM_A2=qa-t6-team-a2
TEAM_B1=qa-t6-team-b1
QA1=qa-t6-1 # org A, the one who looks
QA2=qa-t6-2 # org A
QA3=qa-t6-3 # org B
QA5=qa-t6-5 # org B
OCS="https://${DRIVE_HOST}/ocs/v2.php"
DECK="https://${DRIVE_HOST}/index.php/apps/deck/api/v1.0"
# A word that is only in qa-t6-3's file, its name and its text.
WORD=zebrafinchqat6
skipped=0

log "base URL: $API_BASE (baseline mode: $BASELINE)"

# --- Helpers -------------------------------------------------------------------------------------

version_at() { # path jq-path -> the stored version (0 when it is not there)
	if [ "$(admin_api GET "$1")" = 200 ]; then jq -r "$2" "$T_OUT/body"; else echo 0; fi
}
# A person PUT at the next version. Prints the HTTP status.
put_person() { # uid display-name org team
	local v
	v=$(( $(version_at "/v1/admin/people/$1" .person.version) + 1 ))
	admin_api PUT "/v1/admin/people/$1" "$(jq -cn --arg e "$1@example.invalid" --arg d "$2" --arg o "$3" \
		--arg t "$4" --argjson v "$v" '{email: $e, display_name: $d, org_id: $o,
		teams: [{team_id: $t, role: "member"}], active: true, version: $v}')"
}
# A call as a QA person. Prints the HTTP status; the body is left in $T_OUT/dav.
as() { # netrc-file method url [curl options...]
	local netrc="$1" method="$2" url="$3"
	shift 3
	refuse_owner "$url" "$@"
	curl -sS -g --netrc-file "$netrc" -X "$method" -o "$T_OUT/dav" -w '%{http_code}' "$@" "$url"
}
ocs() { # netrc-file method path [curl options...]
	local netrc="$1" method="$2" path="$3"
	shift 3
	as "$netrc" "$method" "$OCS$path" -H 'OCS-APIRequest: true' -H 'Accept: application/json' "$@"
}
yes_no() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }
# The org:* and team:* groups of an account, sorted.
groups_of() { occ user:info "$1" --output=json </dev/null | jq -r '[.groups[] | select(startswith("org:") or startswith("team:"))] | sort | join(" ")'; }
enabled() { [ "$(occ user:info "$1" --output=json </dev/null | jq -r .enabled)" = true ]; }
# The enabled members of a group, sorted, one per line.
members_of() {
	occ group:list --output=json </dev/null | jq -r --arg g "$1" '(.[$g] // [])[]' | sort -u | while read -r uid; do
		if enabled "$uid"; then echo "$uid"; fi
	done
}
# The enabled accounts that share a group with $1 (not counting "admin"), and $1 itself.
reachable_from() {
	local g
	for g in $(occ user:info "$1" --output=json </dev/null | jq -r '.groups[] | select(. != "admin")'); do
		members_of "$g"
	done | sort -u
}
# The words of $1 without $2.
without() { local w; for w in $1; do [ "$w" = "$2" ] || printf '%s ' "$w"; done; }
# Enables a QA account that something other than the people API disabled (an earlier test), so
# the people API takes it over; an account the API itself disabled is left to the API.
enable_qa_account() { # uid
	[ "$(user_exists "$1")" = yes ] || return 0
	enabled "$1" && return 0
	if [ "$(admin_api GET "/v1/admin/people/$1")" != 200 ] || [ "$(jq -r .person.disabled_at "$T_OUT/body")" = null ]; then
		log "enabling $1 (disabled by an earlier test, not by the people API)"
		occ user:enable "$1" </dev/null >/dev/null
	fi
}
# "yes" when every word of $1 is one of the words of $2.
subset() { # words allowed-words
	local w
	for w in $1; do
		case " $2 " in *" $w "*) ;; *) echo no; return ;; esac
	done
	echo yes
}
# "yes" when the last body names none of these (uids or display names).
names_none() { # name...
	local n
	for n in "$@"; do
		grep -qF -- "$n" "$T_OUT/dav" && { echo no; return; }
	done
	echo yes
}
# A login that works, or a new one from /v1/provision (NoMail's own way).
ensure_login() { # uid display-name
	if [ -s "$(qa_netrc "$1")" ] && [ "$(propfind "$(qa_netrc "$1")" "$1/" 0)" = 207 ]; then
		return 0
	fi
	check "provision $1 -> 200" 200 "$(provision "$1" "$1@example.invalid" "$2")"
	save_netrc "$(qa_netrc "$1")"
}
# Skips a check that would share something across organisations while the step is off.
writes_allowed() {
	if [ "$BASELINE" = 1 ]; then
		skipped=$((skipped + 1))
		return 1
	fi
}

# --- Setup: two organisations, through the admin API ---------------------------------------------
for path in "/v1/admin/orgs/$ORG_A" "/v1/admin/orgs/$ORG_B" "/v1/admin/orgs/$ORG_A/teams/$TEAM_A1" \
	"/v1/admin/orgs/$ORG_A/teams/$TEAM_A2" "/v1/admin/orgs/$ORG_B/teams/$TEAM_B1"; do
	[ "$(admin_api GET "$path")" = 200 ] || die "$path is missing - run tests/admin-api.sh first"
done
for uid in "$QA1" "$QA2" "$QA3" "$QA5"; do enable_qa_account "$uid"; done
check "PUT $QA1 (org A, team A2) -> 200" 200 "$(put_person "$QA1" "QA t6 1" "$ORG_A" "$TEAM_A2")"
check "PUT $QA2 (org A, team A1) -> 200" 200 "$(put_person "$QA2" "QA t6 2" "$ORG_A" "$TEAM_A1")"
check "PUT $QA3 (org B, team B1, active) -> 200" 200 "$(put_person "$QA3" "QA t6 3" "$ORG_B" "$TEAM_B1")"
check "PUT $QA5 (org B, team B1) -> 200" 200 "$(put_person "$QA5" "QA t6 5" "$ORG_B" "$TEAM_B1")"
# Members added with occ by earlier tests (admin-api.sh adds qa-t6-5 to org A) are drift; the
# drift job takes them out again, so each person is in their own organisation only.
log "drift job run now; last run $(drift_job_now)"
check "$QA1 is in org A and team A2 only" "org:$ORG_A team:$TEAM_A2" "$(groups_of "$QA1")"
check "$QA2 is in org A and team A1 only" "org:$ORG_A team:$TEAM_A1" "$(groups_of "$QA2")"
check "$QA3 is in org B and team B1 only" "org:$ORG_B team:$TEAM_B1" "$(groups_of "$QA3")"
check "$QA5 is in org B and team B1 only" "org:$ORG_B team:$TEAM_B1" "$(groups_of "$QA5")"
# nourax_api's rule for calendar, address book and board shares, asked directly (it reads only).
if dc exec -T -u www-data app php < "$REPO_DIR/tests/org-privacy-rules.php" > "$T_OUT/rules" 2>&1; then
	log "PASS org privacy rule ($(grep -c '^PASS' "$T_OUT/rules") checks)"
else
	grep -v '^PASS' "$T_OUT/rules" || true
	check "org privacy rule" passed failed
fi
ensure_login "$QA1" "QA t6 1"
ensure_login "$QA3" "QA t6 3"
N1="$(qa_netrc "$QA1")"
N3="$(qa_netrc "$QA3")"
occ user:setting "$QA1" deck firstRun no </dev/null >/dev/null

# Who qa-t6-1 may find: the enabled people who share a group with it, and its own groups.
SELF_AND_PEERS="$(reachable_from "$QA1" | tr '\n' ' ')"
PEERS="$(without "$SELF_AND_PEERS" "$QA1")"
OWN_GROUPS="org:$ORG_A team:$TEAM_A2"
log "people qa-t6-1 may find: ${PEERS:-none}"
check "$QA2 is one of them" yes "$(subset "$QA2" "$PEERS")"
check "$QA3 and $QA5 are not" "no no" "$(subset "$QA3" "$PEERS") $(subset "$QA5" "$PEERS")"

# Files for the search and share checks: a file with the word in qa-t6-3's own files, and a file
# qa-t6-1 tries to share.
as "$N3" MKCOL "$DAV_BASE/files/$QA3/qa-t6-privacy" >/dev/null
check "$QA3 saves a file with the word -> 201 or 204" yes "$(code="$(printf 'Only org B may find this: %s\n' "$WORD" |
	as "$N3" PUT "$DAV_BASE/files/$QA3/qa-t6-privacy/$WORD.txt" --data-binary @-)"; [[ "$code" =~ ^20[14]$ ]] && echo yes || echo "no ($code)")"
as "$N1" MKCOL "$DAV_BASE/files/$QA1/qa-t6-privacy" >/dev/null
check "$QA1 saves a file to share -> 201 or 204" yes "$(code="$(printf 'qa-t6-1 shares this\n' |
	as "$N1" PUT "$DAV_BASE/files/$QA1/qa-t6-privacy/share-me.txt" --data-binary @-)"; [[ "$code" =~ ^20[14]$ ]] && echo yes || echo "no ($code)")"

# --- The settings the step switched on -----------------------------------------------------------
setting() { occ config:app:get "$1" "$2" </dev/null 2>/dev/null || echo unset; }
check "core: share only with group members" yes "$(setting core shareapi_only_share_with_group_members)"
check "core: the admin group never counts" '["admin"]' "$(setting core shareapi_only_share_with_group_members_exclude_group_list)"
check "core: suggestions only from one's own groups" "yes yes no" \
	"$(setting core shareapi_allow_share_dialog_user_enumeration) $(setting core shareapi_restrict_user_enumeration_to_group) $(setting core shareapi_restrict_user_enumeration_to_phone)"
check "core: no exact-match finds (name, email, id)" "no no no no" \
	"$(setting core shareapi_restrict_user_enumeration_full_match) $(setting core shareapi_restrict_user_enumeration_full_match_user_id) $(setting core shareapi_restrict_user_enumeration_full_match_email) $(setting core shareapi_restrict_user_enumeration_full_match_displayname)"
# The federation keys live in the files_sharing app (FederatedShareProvider reads them there).
check "files_sharing outgoing_server2server_share_enabled -> no" no "$(setting files_sharing outgoing_server2server_share_enabled)"
check "files_sharing: no incoming, no group federation, no lookup server" "no no no no no" \
	"$(setting files_sharing incoming_server2server_share_enabled) $(setting files_sharing outgoing_server2server_group_share_enabled) $(setting files_sharing incoming_server2server_group_share_enabled) $(setting files_sharing lookupServerEnabled) $(setting files_sharing lookupServerUploadEnabled)"
check "dav: the system address book is not exposed" yes "$(case "$(setting dav system_addressbook_exposed)" in 0 | false) echo yes ;; *) echo no ;; esac)"
check "profile.enabled -> false" false "$(occ config:system:get profile.enabled </dev/null 2>/dev/null || echo unset)"
occ app:list --output=json </dev/null > "$T_OUT/apps"
check "app list: federation disabled" yes "$(yes_no jq -e '.enabled.federation == null and .disabled.federation != null' "$T_OUT/apps")"
check "app list: circles (Teams) disabled" yes "$(yes_no jq -e '.enabled.circles == null and .disabled.circles != null' "$T_OUT/apps")"
check "nourax_api: org privacy on" on "$(occ nourax_api:status </dev/null | jq -r .org_privacy)"
check "the org privacy step is switched on" on "$(setting nourax_api org_privacy_step)"
check "capabilities: no outgoing or incoming federation" "false false" \
	"$(ocs "$N1" GET /cloud/capabilities >/dev/null; jq -r '.ocs.data.capabilities.files_sharing.federation | "\(.outgoing) \(.incoming)"' "$T_OUT/dav")"

# --- Finding people: the share dialog ------------------------------------------------------------
sharees() { # search -> body in $T_OUT/dav
	ocs "$N1" GET "/apps/files_sharing/api/v1/sharees?search=$(jq -rn --arg s "$1" '$s | @uri')&itemType=file&format=json&perPage=200"
}
users_found() { jq -r '[(.ocs.data.users // [])[], (.ocs.data.exact.users // [])[]] | map(.value.shareWith) | unique | join(" ")' "$T_OUT/dav"; }
groups_found() { jq -r '[(.ocs.data.groups // [])[], (.ocs.data.exact.groups // [])[]] | map(.value.shareWith) | unique | join(" ")' "$T_OUT/dav"; }
users_count() { jq -r '[(.ocs.data.users // [])[], (.ocs.data.exact.users // [])[]] | length' "$T_OUT/dav"; }
check "sharees search \"qa-t6\" -> 200" 200 "$(sharees qa-t6)"
found="$(users_found)"
log "sharees found: people [$found], groups [$(groups_found)]"
check "sharees \"qa-t6\": $QA2 is found" yes "$(subset "$QA2" "$found")"
check "sharees \"qa-t6\": only people of org A" yes "$(subset "$found" "$PEERS")"
check "sharees \"qa-t6\": only qa-t6-1's own groups" yes "$(subset "$(groups_found)" "$OWN_GROUPS")"
check "sharees \"qa-t6\": nothing of org B (people, names, groups)" yes "$(names_none "$QA3" "$QA5" "QA t6 3" "QA t6 5" "org:$ORG_B" "team:$TEAM_B1")"
check "sharees exact id \"$QA3\" -> 200" 200 "$(sharees "$QA3")"
check "sharees exact id: nobody, and the id is nowhere" "0 yes" "$(users_count) $(names_none "$QA3" "QA t6 3")"
check "sharees exact email of $QA3 -> 200" 200 "$(sharees "$QA3@example.invalid")"
# Any typed address is offered as "share by email" (a link sent by mail); that offer is only
# the typed text, so it must not carry the person's name or account.
check "sharees exact email: no account, no name; only the typed address" "0 yes yes" \
	"$(users_count) $(names_none "QA t6 3" "\"$QA3\"") $(yes_no jq -e --arg e "$QA3@example.invalid" '[(.ocs.data.emails // [])[], (.ocs.data.exact.emails // [])[]] | all(.label == $e and .value.shareWith == $e)' "$T_OUT/dav")"
check "sharees exact name \"QA t6 3\" -> 200" 200 "$(sharees "QA t6 3")"
check "sharees exact name: nobody" "0 yes" "$(users_count) $(names_none "$QA3")"

# --- Finding people: autocomplete (@-mentions, comments) -----------------------------------------
check "autocomplete \"qa\" -> 200" 200 "$(ocs "$N1" GET "/core/autocomplete/get?search=qa&itemType=files&itemId=1&shareTypes[]=0&shareTypes[]=1&limit=100")"
found="$(jq -r '[.ocs.data[].id] | unique | join(" ")' "$T_OUT/dav")"
log "autocomplete found: [$found]"
check "autocomplete: $QA2 is found" yes "$(subset "$QA2" "$found")"
check "autocomplete: only org A people and qa-t6-1's groups" yes "$(subset "$found" "$PEERS $OWN_GROUPS")"
check "autocomplete: nothing of org B" yes "$(names_none "$QA3" "$QA5" "QA t6 3" "org:$ORG_B")"

# --- Finding people: the contacts menu -----------------------------------------------------------
contacts_menu() { as "$N1" POST "https://${DRIVE_HOST}/index.php/contactsmenu/$1" -H 'OCS-APIRequest: true' "${@:2}"; }
check "contacts menu \"qa-t6\" -> 200" 200 "$(contacts_menu contacts --data-urlencode filter=qa-t6)"
check "contacts menu: QA t6 2 is listed" yes "$(yes_no grep -qF 'QA t6 2' "$T_OUT/dav")"
check "contacts menu: nobody of org B" yes "$(names_none "QA t6 3" "QA t6 5" "$QA3@" "$QA5@")"
check "contacts menu: $QA3's card by id -> 404" 404 "$(contacts_menu findOne --data-urlencode shareType=0 --data-urlencode "shareWith=$QA3")"

# --- Address books and DAV principals ------------------------------------------------------------
check "address book list -> 207" 207 "$(as "$N1" PROPFIND "$DAV_BASE/addressbooks/users/$QA1/" -H 'Depth: 1')"
check "the system address book is not offered (z-server-generated--system)" yes "$(names_none z-server-generated--system)"
# The account ids of the cards in the last DAV answer: <uid>.vcf in the directories,
# <backend>:<uid>.vcf (the colon may come as %3A) in the system book.
card_uids() { grep -o '[^/]*\.vcf<' "$T_OUT/dav" | sed 's/%3[Aa]/:/g; s/\.vcf<$//; s/^[^:]*://' | sort -u | tr '\n' ' ' | sed 's/ $//'; }
as "$N1" REPORT "$DAV_BASE/addressbooks/users/$QA1/org-${ORG_A}_shared_by_nourax-teams/" -H 'Depth: 1' \
	-H 'Content-Type: application/xml; charset=utf-8' --data-binary \
	'<?xml version="1.0"?><card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/></d:prop></card:addressbook-query>' >/dev/null
check "org A directory: one card per enabled member of org A, nobody else" \
	"$(members_of "org:$ORG_A" | tr '\n' ' ' | sed 's/ $//')" "$(card_uids)"
# The system book itself, at its own address: if it answers, only people who share a group.
code="$(as "$N1" PROPFIND "$DAV_BASE/addressbooks/system/system/system/" -H 'Depth: 1')"
if [ "$code" = 207 ]; then
	system_cards="$(card_uids)"
	# Counts only: the book may list accounts that are not QA accounts.
	log "system book at its own address: $(wc -w <<<"$system_cards") card(s), $(for u in $system_cards; do [ "$(subset "$u" "$SELF_AND_PEERS")" = yes ] || echo "$u"; done | wc -l) outside org A"
	check "the system book at its own address: only org A people" yes "$(subset "$system_cards" "$SELF_AND_PEERS")"
else
	check "the system book at its own address is refused ($code)" yes "$([[ "$code" =~ ^40[34]$ ]] && echo yes || echo no)"
fi
principal_search() { # property-xml match
	as "$N1" REPORT "$DAV_BASE/principals/users/" -H 'Depth: 0' -H 'Content-Type: application/xml; charset=utf-8' \
		--data-binary "<?xml version=\"1.0\"?><d:principal-property-search xmlns:d=\"DAV:\" xmlns:s=\"http://sabredav.org/ns\" test=\"anyof\"><d:property-search><d:prop>$1</d:prop><d:match>$2</d:match></d:property-search><d:prop><d:displayname/></d:prop></d:principal-property-search>"
}
check "principal search displayname \"QA t6\" -> 207" 207 "$(principal_search '<d:displayname/>' 'QA t6')"
found="$(grep -o 'principals/users/[^/<]*' "$T_OUT/dav" | sed 's|principals/users/||' | sort -u | tr '\n' ' ')"
log "principals found: [$found]"
check "principal search: $QA2 is found" yes "$(subset "$QA2" "$found")"
check "principal search: only org A people" yes "$(subset "$found" "$SELF_AND_PEERS")"
check "principal search by $QA3's email -> 207" 207 "$(principal_search '<s:email-address/>' "$QA3@example.invalid")"
check "principal search by email: nobody" yes "$(names_none "principals/users/$QA3")"

# --- Search ----------------------------------------------------------------------------------------
search() { ocs "$1" GET "/search/providers/$2/search?term=$(jq -rn --arg s "$3" '$s | @uri')&limit=25"; }
entries() { jq -r '.ocs.data.entries | length' "$T_OUT/dav"; }
check "$QA3 finds its own file (files search) -> 200" 200 "$(search "$N3" files "$WORD")"
check "$QA3 finds its own file: at least one entry" yes "$([ "$(entries)" -ge 1 ] && echo yes || echo no)"
check "$QA1 searches files for the word -> 200" 200 "$(search "$N1" files "$WORD")"
check "$QA1 files search: no entries" 0 "$(entries)"
code="$(search "$N1" fulltextsearch "$WORD")"
if [ "$code" = 200 ]; then
	check "$QA1 search inside files: no entries" 0 "$(entries)"
else
	log "search inside files answered $code (the provider is not there): skipped"
fi
check "$QA1 contacts search \"QA t6 2\" finds the org A card" yes "$(search "$N1" contacts "QA t6 2" >/dev/null; [ "$(entries)" -ge 1 ] && echo yes || echo no)"
check "$QA1 contacts search \"QA t6 3\": no entries" 0 "$(search "$N1" contacts "QA t6 3" >/dev/null; entries)"
check "$QA1 contacts search \"$QA5\": no entries" 0 "$(search "$N1" contacts "$QA5" >/dev/null; entries)"
ocs "$N1" GET /search/providers >/dev/null
check "no Teams (circles) search provider" yes "$(yes_no jq -e '[.ocs.data[].id] | index("circles") == null' "$T_OUT/dav")"

# --- Profiles and the Teams app --------------------------------------------------------------------
check "profile page of $QA3 -> 404" 404 "$(as "$N1" GET "https://${DRIVE_HOST}/u/$QA3")"
check "profile page of qa-t6-1 itself -> 404 (profiles are off)" 404 "$(as "$N1" GET "https://${DRIVE_HOST}/u/$QA1")"
check "profile API for $QA3 is refused" yes "$(code="$(ocs "$N1" GET "/profile/$QA3")"; [ "$code" != 200 ] && echo yes || echo "no ($code)")"
code="$(ocs "$N1" GET "/apps/circles/search?term=qa-t6")"
check "Teams member search is gone ($code)" yes "$([ "$code" != 200 ] && echo yes || echo no)"
check "Teams member search names nobody of org B" yes "$(names_none "$QA3" "QA t6 3")"

# --- Sharing files -------------------------------------------------------------------------------
share() { # shareType shareWith -> status; body in $T_OUT/dav
	ocs "$N1" POST /apps/files_sharing/api/v1/shares --data-urlencode path=/qa-t6-privacy/share-me.txt \
		--data-urlencode "shareType=$1" --data-urlencode "shareWith=$2" --data-urlencode permissions=1
}
message() { jq -r '.ocs.meta.message // ""' "$T_OUT/dav"; }
refused() { [[ "$1" =~ ^40[034]$ ]] && echo yes || echo "no ($1)"; }
if writes_allowed; then
	code="$(share 0 "$QA3")"
	check "share with $QA3 (org B) is refused" yes "$(refused "$code")"
	check "the refusal says why" yes "$(message | grep -qi 'only allowed with group members' && echo yes || echo "no: $(message)")"
	code="$(share 1 "org:$ORG_B")"
	check "share with the group org:$ORG_B is refused" yes "$(refused "$code")"
	check "the refusal says why" yes "$(message | grep -qi 'within your own groups' && echo yes || echo "no: $(message)")"
	code="$(share 6 "$QA3@${DRIVE_HOST}")"
	check "federated share (type 6) is refused" yes "$(refused "$code")"
	# The same organisation still works: an existing share with qa-t6-2 counts (run again).
	ocs "$N1" GET "/apps/files_sharing/api/v1/shares?path=/qa-t6-privacy/share-me.txt" >/dev/null
	if jq -e --arg u "$QA2" '.ocs.data | any(.share_type == 0 and .share_with == $u)' "$T_OUT/dav" >/dev/null; then
		check "share with $QA2 (org A) is there" yes yes
	else
		check "share with $QA2 (org A) -> 200" 200 "$(share 0 "$QA2")"
	fi
	ocs "$N1" GET "/apps/files_sharing/api/v1/shares?path=/qa-t6-privacy/share-me.txt" >/dev/null
	check "the file is shared with nobody of org B and no other server" yes \
		"$(yes_no jq -e --arg u "$QA3" --arg g "org:$ORG_B" '.ocs.data | all(.share_with != $u and .share_with != $g and .share_type != 6)' "$T_OUT/dav")"
fi

# --- Sharing calendars and address books (nourax_api's DAV check) ---------------------------------
dav_share() { # collection-url href [read-write]
	local rw=""
	[ "${3:-}" = rw ] && rw='<o:read-write/>'
	as "$N1" POST "$1" -H 'Content-Type: application/xml; charset=utf-8' --data-binary \
		"<?xml version=\"1.0\" encoding=\"utf-8\"?><o:share xmlns:d=\"DAV:\" xmlns:o=\"http://owncloud.org/ns\"><o:set><d:href>$2</d:href>$rw</o:set></o:share>"
}
invitees() { # collection-url -> the hrefs it is shared with
	as "$N1" PROPFIND "$1" -H 'Depth: 0' -H 'Content-Type: application/xml; charset=utf-8' --data-binary \
		'<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:o="http://owncloud.org/ns"><d:prop><o:invite/></d:prop></d:propfind>' >/dev/null
	grep -o 'principal:principals/[^<]*' "$T_OUT/dav" | sort -u | tr '\n' ' '
}
CAL="$DAV_BASE/calendars/$QA1/qa-t6-privacy/"
BOOK="$DAV_BASE/addressbooks/users/$QA1/qa-t6-privacy/"
if writes_allowed; then
	code="$(as "$N1" MKCALENDAR "$CAL" -H 'Content-Type: application/xml; charset=utf-8' --data-binary \
		'<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>qa-t6-privacy</d:displayname></d:prop></d:set></c:mkcalendar>')"
	check "$QA1 has a calendar qa-t6-privacy (201 new, 405 there)" yes "$([[ "$code" =~ ^(201|405)$ ]] && echo yes || echo "no ($code)")"
	code="$(as "$N1" MKCOL "$BOOK" -H 'Content-Type: application/xml; charset=utf-8' --data-binary \
		'<?xml version="1.0"?><d:mkcol xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:set><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>qa-t6-privacy</d:displayname></d:prop></d:set></d:mkcol>')"
	check "$QA1 has an address book qa-t6-privacy (201 new, 405 there)" yes "$([[ "$code" =~ ^(201|405)$ ]] && echo yes || echo "no ($code)")"
	for kind in calendar "address book"; do
		url="$CAL"
		[ "$kind" = "address book" ] && url="$BOOK"
		check "share the $kind with $QA3 (org B) -> 403" 403 "$(dav_share "$url" "principal:principals/users/$QA3" rw)"
		check "the refusal says why" yes "$(yes_no grep -qF 'only allowed with people of your organisation' "$T_OUT/dav")"
		check "share the $kind with $QA3 by email -> 403" 403 "$(dav_share "$url" "mailto:$QA3@example.invalid")"
		check "share the $kind with the group org:$ORG_B -> 403" 403 "$(dav_share "$url" "principal:principals/groups/org%3A$ORG_B")"
		check "share the $kind with $QA2 (org A) -> 200" 200 "$(dav_share "$url" "principal:principals/users/$QA2")"
		shared="$(invitees "$url")"
		check "the $kind is shared with $QA2" yes "$(case "$shared" in *"principals/users/$QA2 "*) echo yes ;; *) echo "no: $shared" ;; esac)"
		check "the $kind is shared with nobody of org B" yes "$(case "$shared" in *"$QA3"* | *"$ORG_B"*) echo "no: $shared" ;; *) echo yes ;; esac)"
	done
fi

# --- Sharing boards (nourax_api's Deck check) -------------------------------------------------------
if writes_allowed; then
	as "$N1" GET "$DECK/boards" -H 'OCS-APIRequest: true' -H 'Accept: application/json' >/dev/null
	board="$(jq -r --arg u "$QA1" '[.[] | select(.title == "QA t6 privacy" and .owner.uid == $u and .deletedAt == 0)][0].id // empty' "$T_OUT/dav")"
	if [ -z "$board" ]; then
		check "$QA1 makes a board \"QA t6 privacy\" -> 200" 200 "$(as "$N1" POST "$DECK/boards" -H 'OCS-APIRequest: true' \
			-H 'Content-Type: application/json' --data-binary '{"title":"QA t6 privacy","color":"2563EB"}')"
		board="$(jq -r '.id // empty' "$T_OUT/dav")"
	fi
	if [ -z "$board" ]; then
		check "the board is there" yes no
	else
		acl() { # url type participant
			as "$N1" POST "$1" -H 'OCS-APIRequest: true' -H 'Accept: application/json' -H 'Content-Type: application/json' \
				--data-binary "$(jq -cn --argjson t "$2" --arg p "$3" '{type: $t, participant: $p, permissionEdit: true, permissionShare: false, permissionManage: false}')"
		}
		check "board share with $QA3 (REST API) -> 403" 403 "$(acl "$DECK/boards/$board/acl" 0 "$QA3")"
		check "the refusal says why" yes "$(yes_no grep -qF 'only allowed with people of your organisation' "$T_OUT/dav")"
		check "board share with $QA3 (OCS API) -> 403" 403 "$(acl "$OCS/apps/deck/api/v1.0/boards/$board/acl" 0 "$QA3")"
		check "board share with the group org:$ORG_B -> 403" 403 "$(acl "$DECK/boards/$board/acl" 1 "org:$ORG_B")"
		as "$N1" GET "$DECK/boards/$board" -H 'OCS-APIRequest: true' -H 'Accept: application/json' >/dev/null
		if jq -e --arg u "$QA2" '.acl | any(.type == 0 and .participant.uid == $u)' "$T_OUT/dav" >/dev/null; then
			check "board share with $QA2 (org A) is there" yes yes
		else
			check "board share with $QA2 (org A) -> 200" 200 "$(acl "$DECK/boards/$board/acl" 0 "$QA2")"
		fi
		as "$N1" GET "$DECK/boards/$board" -H 'OCS-APIRequest: true' -H 'Accept: application/json' >/dev/null
		check "the board is shared with nobody of org B" yes \
			"$(yes_no jq -e --arg u "$QA3" --arg g "org:$ORG_B" '.acl | all(.participant.uid != $u and .participant.uid != $g)' "$T_OUT/dav")"
	fi
fi

# --- The admin API still shares team things (as its service account) -----------------------------
# The same version again runs every step again, so the shares are checked as the step has them.
admin_api GET "/v1/admin/orgs/$ORG_A/teams/$TEAM_A2" >/dev/null
same="$(jq -c '{name: .team.name, version: .team.version}' "$T_OUT/body")"
check "PUT team A2 again (same version) -> 200" 200 "$(admin_api PUT "/v1/admin/orgs/$ORG_A/teams/$TEAM_A2" "$same")"
check "team A2: no step failed" yes "$(no_failed_steps)"
admin_api GET "/v1/admin/orgs/$ORG_A/teams/$TEAM_A2" >/dev/null
check "team A2: book, calendar and board shared with the team" "true true true" \
	"$(jq -r '.team | "\(.addressbook.shared_read_only) \(.calendar.shared_read_write) \(.board.shared_edit)"' "$T_OUT/body")"

if [ "$BASELINE" = 1 ]; then
	log "BASELINE: $fails check(s) failed and $skipped group(s) of share checks were skipped - expected while the org privacy step is off"
	exit 0
fi
finish privacy
