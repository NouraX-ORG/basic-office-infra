#!/usr/bin/env bash
# Contract test for the admin API, part 2 (docs/teams.md): people (joins, moves, leaves), leaving
# the organisation, the reconcile call, the drift guard and the scheduled delete (switched off).
# Run it on the server: sudo tests/admin-people.sh   (after api-provision.sh and admin-api.sh)
#
# QA objects only (prefix qa-), never the owner's account:
#   organisations qa-t6-org-a and qa-t6-org-b; teams qa-t6-team-a1 ("QA t6 Team A1 Renamed"),
#   qa-t6-team-a2 ("QA t6 Team A2") in org A and qa-t6-team-b1 ("QA t6 Team B1") in org B;
#   people qa-t6-1 (A1 member, later moved to A2), qa-t6-2 (A1 lead), qa-t6-3 (B1, then leaves the
#   organisation and comes back) and qa-t6-4 (added to A1 with occ: the drift the API undoes).
# Logins are the people's newest NoMail app passwords from /v1/provision, in /etc/nourax/qa.
# It takes the server-change lock for its whole run (a few minutes), because it changes accounts
# and groups. It deletes only what it made itself: QA shares and locks, through the leave, and the
# public link it made on qa-t6-3's own file, once it has checked that the link works again.
# Safe to run again: versions are read first and counted on from there.
# Keys and passwords are never printed. Exit 0 when every check passes.
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
A1_NAME="QA t6 Team A1 Renamed"
A1_DAV="QA%20t6%20Team%20A1%20Renamed"
A2_NAME="QA t6 Team A2"
B1_NAME="QA t6 Team B1"
QA1=qa-t6-1
QA2=qa-t6-2
QA3=qa-t6-3
QA4=qa-t6-4
OCS="https://${DRIVE_HOST}/ocs/v2.php"
DECK="https://${DRIVE_HOST}/index.php/apps/deck/api/v1.0"

log "base URL: $API_BASE"
# Start from the stored state: the drift job takes out what earlier tests added with occ (for
# example qa-t6-5 from admin-api.sh), and its next run is then 15 minutes away, longer than this test.
log "drift job run now (next run in 15 minutes); last run $(drift_job_now)"

# --- Helpers -------------------------------------------------------------------------------------

# The stored version at a status path (0 when it is not there yet).
version_at() { # path jq-path
	if [ "$(admin_api GET "$1")" = 200 ]; then jq -r "$2" "$T_OUT/body"; else echo 0; fi
}
person_version() { version_at "/v1/admin/people/$1" .person.version; }

# The body of a person PUT.
person_body() { # email display-name org teams-json active version
	jq -cn --arg e "$1" --arg d "$2" --arg o "$3" --argjson t "$4" --argjson a "$5" --argjson v "$6" \
		'{email: $e, display_name: $d, org_id: $o, teams: $t, active: $a, version: $v}'
}
# A person PUT at the next version. Prints the HTTP status.
put_person() { # uid email display-name org teams-json active
	local v
	v=$(( $(person_version "$1") + 1 ))
	admin_api PUT "/v1/admin/people/$1" "$(person_body "$2" "$3" "$4" "$5" "$6" "$v")"
}
# A team PUT at the next version, with this name.
put_team() { # org team name
	local v
	v=$(( $(version_at "/v1/admin/orgs/$1/teams/$2" .team.version) + 1 ))
	admin_api PUT "/v1/admin/orgs/$1/teams/$2" "$(name_version "$3" "$v")"
}
team() { jq -cn --arg t "$1" --arg r "$2" '[{team_id: $t, role: $r}]'; }

# "ok" when the last answer is ok and these steps did not fail; else what failed.
steps_ok() { # step...
	# --args takes every word after the filter, so the body comes in on stdin.
	jq -r --args '. as $a | [$ARGS.positional[] as $s | (($a.steps[] | select(.step == $s) | .result) // "missing")
		| select(. == "failed" or . == "missing")] | if length == 0 and $a.ok == true then "ok" else "not ok: \(.)" end' \
		"$@" < "$T_OUT/body"
}
# The count of the leave step for this team, e.g. leave_count qa-t6-team-a1 group_shares_removed
leave_count() { jq -r --arg t "$1" --arg c "$2" '[.steps[] | select(.step == "leave" and .team_id == $t)][0].counts[$c]' "$T_OUT/body"; }

# A WebDAV or OCS call as a QA person. Prints the HTTP status; the body is left in $T_OUT/dav.
as() { # netrc-file method url [curl options...]
	local netrc="$1" method="$2" url="$3"
	shift 3
	curl -sS -g --netrc-file "$netrc" -X "$method" -o "$T_OUT/dav" -w '%{http_code}' "$@" "$url"
}
ocs() { # netrc-file method path [curl options...]
	local netrc="$1" method="$2" path="$3"
	shift 3
	as "$netrc" "$method" "$OCS$path" -H 'OCS-APIRequest: true' -H 'Accept: application/json' "$@"
}
fileid_of() { # netrc-file path-under-/files/
	as "$1" PROPFIND "$DAV_BASE/files/$2" -H 'Depth: 0' \
		--data-binary '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>' >/dev/null
	grep -o '<oc:fileid>[0-9]*' "$T_OUT/dav" | grep -o '[0-9]*$'
}
# One DAV property of a path, as the person sees it ("" when it is empty or not set). The server
# picks its own namespace prefix, so the property is matched by its name only.
dav_prop() { # netrc-file path-under-/files/ namespace-uri prop-name
	as "$1" PROPFIND "$DAV_BASE/files/$2" -H 'Depth: 0' \
		--data-binary "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\" xmlns:x=\"$3\"><d:prop><x:$4/></d:prop></d:propfind>" >/dev/null
	tr -d '\r\n' < "$T_OUT/dav" | grep -o "<[A-Za-z0-9]*:$4>[^<]*</" | head -n1 | sed 's|^<[^>]*>||; s|</$||'
}
# The cards (file names) of an address book, sorted, space-separated.
cards_of() { # netrc-file book-url
	as "$1" REPORT "$2/" -H 'Depth: 1' -H 'Content-Type: application/xml; charset=utf-8' \
		--data-binary '<?xml version="1.0"?><card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/></d:prop></card:addressbook-query>' >/dev/null
	grep -o '[^/]*\.vcf<' "$T_OUT/dav" | tr -d '<' | sort | tr '\n' ' ' | sed 's/ $//'
}
board_listed() { # netrc-file board-id
	as "$1" GET "$DECK/boards" -H 'OCS-APIRequest: true' -H 'Accept: application/json' >/dev/null
	jq -e --argjson id "$2" 'type == "array" and (map(.id) | index($id) != null)' "$T_OUT/dav" >/dev/null 2>&1 && echo yes || echo no
}
in_group() { # group uid
	occ group:list --output=json </dev/null | jq -e --arg g "$1" --arg u "$2" '(.[$g] // []) | index($u) != null' >/dev/null && echo yes || echo no
}
team_groups_of() { # uid -> its team:* groups, sorted
	occ user:info "$1" --output=json </dev/null | jq -r '[.groups[] | select(startswith("team:"))] | sort | join(" ")'
}
# Enables a QA account that something other than this API disabled (an earlier test), so the
# people API takes it over; an account the API itself disabled is left to the API.
enable_qa_account() { # uid
	[ "$(user_exists "$1")" = yes ] || return 0
	if [ "$(occ user:info "$1" --output=json </dev/null | jq -r .enabled)" = false ]; then
		if [ "$(admin_api GET "/v1/admin/people/$1")" != 200 ] || [ "$(jq -r .person.disabled_at "$T_OUT/body")" = null ]; then
			log "enabling $1 (disabled by an earlier test, not by the people API)"
			occ user:enable "$1" </dev/null >/dev/null
		fi
	fi
}
# Gives the QA person a fresh NoMail app password through /v1/provision and keeps it.
qa_login() { # uid display-name
	check "provision $1 -> 200" 200 "$(provision "$1" "$1@example.invalid" "$2")"
	save_netrc "$(qa_netrc "$1")"
	occ user:setting "$1" deck firstRun no </dev/null >/dev/null
}

NETRC1="$(qa_netrc "$QA1")"
NETRC2="$(qa_netrc "$QA2")"
NETRC3="$(qa_netrc "$QA3")"

# --- The teams, named for this test --------------------------------------------------------------
check "team A1 named \"$A1_NAME\" -> 200" 200 "$(put_team "$ORG_A" "$TEAM_A1" "$A1_NAME")"
check "team A2 named \"$A2_NAME\" -> 200" 200 "$(put_team "$ORG_A" "$TEAM_A2" "$A2_NAME")"
check "team B1 named \"$B1_NAME\" -> 200" 200 "$(put_team "$ORG_B" "$TEAM_B1" "$B1_NAME")"

# --- Input rules ---------------------------------------------------------------------------------
bad_person() { # name uid body
	check "$1 -> 400" 400 "$(admin_api PUT "/v1/admin/people/$2" "$3")"
	check "$1 -> error invalid_request" invalid_request "$(jq -r .error "$T_OUT/body")"
}
bad_person "uid nodrive" nodrive "$(person_body x@example.invalid X "$ORG_A" '[]' true 1)"
bad_person "uid in capitals" QA-T6-1 "$(person_body x@example.invalid X "$ORG_A" '[]' true 1)"
bad_person "role boss" "$QA1" "$(person_body x@example.invalid X "$ORG_A" "$(team "$TEAM_A1" boss)" true 1)"
bad_person "active as a string" "$QA1" '{"email":"","display_name":"","org_id":"qa-t6-org-a","teams":[],"active":"yes","version":1}'
bad_person "a team twice" "$QA1" "$(person_body x@example.invalid X "$ORG_A" "[{\"team_id\":\"$TEAM_A1\",\"role\":\"member\"},{\"team_id\":\"$TEAM_A1\",\"role\":\"lead\"}]" true 1)"
check "unknown organisation -> 409 org_missing" "409 org_missing" \
	"$(admin_api PUT "/v1/admin/people/$QA1" "$(person_body x@example.invalid X qa-t6-org-none '[]' true 999)") $(jq -r .error "$T_OUT/body")"
check "a team of another organisation -> 409 team_in_other_org" "409 team_in_other_org" \
	"$(admin_api PUT "/v1/admin/people/$QA1" "$(person_body x@example.invalid X "$ORG_A" "$(team "$TEAM_B1" member)" true 999)") $(jq -r .error "$T_OUT/body")"
check "unknown person -> 404" 404 "$(admin_api GET /v1/admin/people/qa-t6-99)"

# --- Joins: qa-t6-1 member of A1, qa-t6-2 lead of A1, qa-t6-3 in B1 ---------------------------
enable_qa_account "$QA2"
enable_qa_account "$QA3"
check "PUT $QA1 (org A, A1 member) -> 200" 200 "$(put_person "$QA1" "$QA1@example.invalid" "QA t6 1" "$ORG_A" "$(team "$TEAM_A1" member)" true)"
check "$QA1: account, profile, org and teams ok" ok "$(steps_ok account profile org teams directories)"
check "PUT $QA2 (org A, A1 lead) -> 200" 200 "$(put_person "$QA2" "$QA2@example.invalid" "QA t6 2" "$ORG_A" "$(team "$TEAM_A1" lead)" true)"
check "$QA2: account, profile, org and teams ok" ok "$(steps_ok account profile org teams directories)"
check "PUT $QA3 (org B, B1 member) -> 200" 200 "$(put_person "$QA3" "$QA3@example.invalid" "QA t6 3" "$ORG_B" "$(team "$TEAM_B1" member)" true)"
check "$QA3: account, profile, org and teams ok" ok "$(steps_ok account profile org teams directories)"
same="$(cat "$T_OUT/request")"
check "the same PUT again -> 200" 200 "$(admin_api PUT "/v1/admin/people/$QA3" "$same")"
check "the same PUT again: every step unchanged" yes \
	"$(jq -e '[.steps[] | select(.result != "unchanged")] | length == 0' "$T_OUT/body" >/dev/null && echo yes || echo no)"
check "the next version -> 200" 200 "$(put_person "$QA3" "$QA3@example.invalid" "QA t6 3" "$ORG_B" "$(team "$TEAM_B1" member)" true)"
v3="$(person_version "$QA3")"
check "an older version -> applied false, stale_version" "200 false stale_version" \
	"$(admin_api PUT "/v1/admin/people/$QA3" "$(person_body "$QA3@example.invalid" "QA t6 3" "$ORG_B" '[]' true $((v3 - 1)))") $(jq -r '"\(.applied) \(.reason)"' "$T_OUT/body")"
qa_login "$QA1" "QA t6 1"
qa_login "$QA2" "QA t6 2"
qa_login "$QA3" "QA t6 3"

# --- What a member reaches -----------------------------------------------------------------------
check "$QA1 PROPFIND / -> 207" 207 "$(propfind "$NETRC1" "$QA1/" 1)"
check "$QA1 sees the folder \"$A1_NAME\"" yes "$(grep -q "/files/$QA1/$A1_DAV/<" "$T_OUT/dav" && echo yes || echo no)"
printf 'a file %s put in the team folder\n' "$QA1" > "$T_OUT/upload.txt"
check "$QA1 puts a file into the team folder -> 201 or 204" yes \
	"$(case "$(as "$NETRC1" PUT "$DAV_BASE/files/$QA1/$A1_DAV/qa-t6-1-upload.txt" --data-binary "@$T_OUT/upload.txt")" in 201 | 204) echo yes ;; *) echo no ;; esac)"
BOOKS="$DAV_BASE/addressbooks/users/$QA1"
as "$NETRC1" PROPFIND "$BOOKS/" -H 'Depth: 1' >/dev/null
check "$QA1's NoContacts lists the directory and the team book" "yes yes" \
	"$(grep -q "org-${ORG_A}_shared_by_nourax-teams/<" "$T_OUT/dav" && echo yes || echo no) $(grep -q "team-${TEAM_A1}_shared_by_nourax-teams/<" "$T_OUT/dav" && echo yes || echo no)"
# The team book is read-only for members: every write gets 403 (nourax_api's ReadOnlyBooksPlugin;
# the server alone answers 404) and nothing is written.
printf 'BEGIN:VCARD\r\nVERSION:4.0\r\nUID:qa-t6-write-test\r\nFN:Write test\r\nEND:VCARD\r\n' > "$T_OUT/new.vcf"
QA1_TEAM_BOOK="$BOOKS/team-${TEAM_A1}_shared_by_nourax-teams"
read_only_answer() { grep -q 'This address book is read-only' "$T_OUT/dav" && echo yes || echo no; }
check "$QA1 adds a card to the team book -> 403" 403 \
	"$(as "$NETRC1" PUT "$QA1_TEAM_BOOK/qa-t6-write-test.vcf" -H 'Content-Type: text/vcard' --data-binary "@$T_OUT/new.vcf")"
check "  the answer says the book is read-only" yes "$(read_only_answer)"
check "  and the card was not written (GET -> 404)" 404 "$(as "$NETRC1" GET "$QA1_TEAM_BOOK/qa-t6-write-test.vcf")"
check "$QA1 overwrites a card of the team book -> 403" 403 \
	"$(as "$NETRC1" PUT "$QA1_TEAM_BOOK/$QA1.vcf" -H 'Content-Type: text/vcard' --data-binary "@$T_OUT/new.vcf")"
check "  and the card is unchanged" "200 0" \
	"$(as "$NETRC1" GET "$QA1_TEAM_BOOK/$QA1.vcf") $(grep -c 'Write test' "$T_OUT/dav")"
check "$QA1 deletes a card of the team book -> 403" 403 "$(as "$NETRC1" DELETE "$QA1_TEAM_BOOK/$QA2.vcf")"
check "$QA1 changes a card's properties (PROPPATCH) -> 403" 403 \
	"$(as "$NETRC1" PROPPATCH "$QA1_TEAM_BOOK/$QA2.vcf" -H 'Content-Type: application/xml; charset=utf-8' \
		--data-binary '<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>Write test</d:displayname></d:prop></d:set></d:propertyupdate>')"
check "$QA1 renames the team book (PROPPATCH) -> 403" 403 \
	"$(as "$NETRC1" PROPPATCH "$QA1_TEAM_BOOK/" -H 'Content-Type: application/xml; charset=utf-8' \
		--data-binary '<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>Write test</d:displayname></d:prop></d:set></d:propertyupdate>')"
check "$QA1 moves a card out of the team book -> 403" 403 \
	"$(as "$NETRC1" MOVE "$QA1_TEAM_BOOK/$QA2.vcf" -H "Destination: $BOOKS/contacts/qa-t6-move-test.vcf")"
check "$QA1 copies a card into the team book -> 403" 403 \
	"$(as "$NETRC1" COPY "$QA1_TEAM_BOOK/$QA2.vcf" -H "Destination: $QA1_TEAM_BOOK/qa-t6-copy-test.vcf")"
check "$QA1 deletes the team book -> 403" 403 "$(as "$NETRC1" DELETE "$QA1_TEAM_BOOK/")"
check "the team book still holds the cards of $QA1 and $QA2, unchanged" "$QA1.vcf $QA2.vcf" "$(cards_of "$NETRC1" "$QA1_TEAM_BOOK")"
# A member sees the book's name with its owner after it: "Team: <name> (Nourax Teams)".
check "  and keeps its name" yes \
	"$(as "$NETRC1" PROPFIND "$QA1_TEAM_BOOK/" -H 'Depth: 0' -H 'Content-Type: application/xml; charset=utf-8' \
		--data-binary '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>' >/dev/null
	grep -q "<d:displayname>Team: $A1_NAME (Nourax Teams)</d:displayname>" "$T_OUT/dav" && echo yes || echo no)"
# Someone who cannot see the book still gets the server's own 404, so no book is revealed.
check "$QA3 (org B) writes into team A1's book -> 404" 404 \
	"$(as "$NETRC3" PUT "$DAV_BASE/addressbooks/users/nourax-teams/team-${TEAM_A1}/qa-t6-write-test.vcf" -H 'Content-Type: text/vcard' --data-binary "@$T_OUT/new.vcf")"
admin_api GET "/v1/admin/orgs/$ORG_A/teams/$TEAM_A1" >/dev/null
BOARD_A1="$(jq -r .team.board.id "$T_OUT/body")"
check "the team's leads: folder and board" "$QA2 $QA2" "$(jq -r '.team | "\(.folder.leads | join(",")) \(.board.leads | join(","))"' "$T_OUT/body")"
as "$NETRC1" GET "$DECK/boards" -H 'OCS-APIRequest: true' -H 'Accept: application/json' >/dev/null
check "$QA1's NoBoard lists \"Team: $A1_NAME\"" yes \
	"$(jq -e --arg t "Team: $A1_NAME" 'map(.title) | index($t) != null' "$T_OUT/dav" >/dev/null 2>&1 && echo yes || echo no)"
TEAM_BOOK="$DAV_BASE/addressbooks/users/$QA2/team-${TEAM_A1}_shared_by_nourax-teams"
check "the team book holds exactly the cards of $QA1 and $QA2" "$QA1.vcf $QA2.vcf" "$(cards_of "$NETRC2" "$TEAM_BOOK")"
check "the lead may manage the folder's advanced permissions" 1 "$(dav_prop "$NETRC2" "$QA2/$A1_DAV/" http://nextcloud.org/ns acl-can-manage)"
check "a member may not" 0 "$(v="$(dav_prop "$NETRC1" "$QA1/$A1_DAV/" http://nextcloud.org/ns acl-can-manage)"; echo "${v:-0}")"

# --- Before leaving: a public link, a group share, a lock and an open document ----------------
check "$QA1: a public link on the team file -> 200" 200 \
	"$(ocs "$NETRC1" POST /apps/files_sharing/api/v1/shares --data-urlencode "path=/$A1_NAME/qa-t6-1-upload.txt" --data-urlencode shareType=3)"
T1="$(jq -r .ocs.data.token "$T_OUT/dav")"
check "the link works -> 200" 200 "$(curl -sS -o /dev/null -w '%{http_code}' "https://${DRIVE_HOST}/s/$T1")"
printf 'my own file\n' > "$T_OUT/own.txt"
as "$NETRC1" PUT "$DAV_BASE/files/$QA1/qa-t6-1-own.txt" --data-binary "@$T_OUT/own.txt" >/dev/null
check "$QA1: a group share of an own file to team:$TEAM_A1 -> 200" 200 \
	"$(ocs "$NETRC1" POST /apps/files_sharing/api/v1/shares --data-urlencode path=/qa-t6-1-own.txt --data-urlencode shareType=1 --data-urlencode "shareWith=team:$TEAM_A1")"
FILE_ID="$(fileid_of "$NETRC1" "$QA1/$A1_DAV/qa-t6-1-upload.txt")"
check "$QA1 locks the team file -> 200" 200 "$(ocs "$NETRC1" PUT "/apps/files_lock/lock/$FILE_ID")"
check "the lead sees the lock" 1 "$(dav_prop "$NETRC2" "$QA2/$A1_DAV/qa-t6-1-upload.txt" http://nextcloud.org/ns lock)"
# A small document in the team folder, opened for editing once, so ONLYOFFICE has a key for it.
python3 -I - "$T_OUT/doc.docx" <<'PY'
import sys, zipfile
parts = {
	"[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
	"_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
	"word/document.xml": '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>QA t6 team document</w:t></w:r></w:p></w:body></w:document>',
}
with zipfile.ZipFile(sys.argv[1], "w") as z:
	for name, data in parts.items():
		z.writestr(name, data)
PY
as "$NETRC1" PUT "$DAV_BASE/files/$QA1/$A1_DAV/qa-t6-team-doc.docx" --data-binary "@$T_OUT/doc.docx" >/dev/null
DOC_ID="$(fileid_of "$NETRC1" "$QA1/$A1_DAV/qa-t6-team-doc.docx")"
check "$QA1 opens the team document's editor settings -> 200" 200 "$(ocs "$NETRC1" GET "/apps/onlyoffice/api/v1/config/$DOC_ID")"

# --- Leaving the team ----------------------------------------------------------------------------
check "PUT $QA1 with teams [] -> 200" 200 "$(put_person "$QA1" "$QA1@example.invalid" "QA t6 1" "$ORG_A" '[]' true)"
check "leave step ok" updated "$(jq -r --arg t "$TEAM_A1" '[.steps[] | select(.step == "leave" and .team_id == $t)][0].result' "$T_OUT/body")"
check "leave: group_shares_removed 1" 1 "$(leave_count "$TEAM_A1" group_shares_removed)"
check "leave: team_file_shares_removed 1" 1 "$(leave_count "$TEAM_A1" team_file_shares_removed)"
check "leave: locks_released 1" 1 "$(leave_count "$TEAM_A1" locks_released)"
check "leave: onlyoffice_drop sent at least 1" yes "$([ "$(jq -r --arg t "$TEAM_A1" '[.steps[] | select(.step == "leave" and .team_id == $t)][0].counts.onlyoffice_drop.sent' "$T_OUT/body")" -ge 1 ] && echo yes || echo no)"
check "leave: ONLYOFFICE answered 0 or 1 only (never 6, a bad signature)" yes \
	"$(jq -e --arg t "$TEAM_A1" '[.steps[] | select(.step == "leave" and .team_id == $t)][0].counts.onlyoffice_drop.codes | keys | all(. == "0" or . == "1")' "$T_OUT/body" >/dev/null && echo yes || echo no)"
log "leave counts: $(jq -c --arg t "$TEAM_A1" '[.steps[] | select(.step == "leave" and .team_id == $t)][0].counts' "$T_OUT/body")"
check "right after: $QA1's PROPFIND of the team folder -> 404" 404 "$(propfind "$NETRC1" "$QA1/$A1_DAV/" 0)"
check "right after: the public link -> 404" 404 "$(curl -sS -o /dev/null -w '%{http_code}' "https://${DRIVE_HOST}/s/$T1")"
check "right after: the lock is gone" 0 "$(v="$(dav_prop "$NETRC2" "$QA2/$A1_DAV/qa-t6-1-upload.txt" http://nextcloud.org/ns lock)"; echo "${v:-0}")"
check "right after: the board is not listed for $QA1" no "$(board_listed "$NETRC1" "$BOARD_A1")"
check "right after: the board itself -> 403 or 404" yes \
	"$(case "$(as "$NETRC1" GET "$DECK/boards/$BOARD_A1" -H 'OCS-APIRequest: true' -H 'Accept: application/json')" in 403 | 404) echo yes ;; *) echo no ;; esac)"
check "right after: the team book holds only $QA2's card" "$QA2.vcf" "$(cards_of "$NETRC2" "$TEAM_BOOK")"
check "right after: $QA1's write to the A1 team book -> 404 (no longer theirs to see)" 404 \
	"$(as "$NETRC1" PUT "$QA1_TEAM_BOOK/qa-t6-write-test.vcf" -H 'Content-Type: text/vcard' --data-binary "@$T_OUT/new.vcf")"
check "the file $QA1 put in the team folder stays (the lead sees it) -> 207" 207 "$(propfind "$NETRC2" "$QA2/$A1_DAV/qa-t6-1-upload.txt" 0)"

# --- A move between teams, and an email change ---------------------------------------------------
check "PUT team A2 -> 200" 200 "$(put_team "$ORG_A" "$TEAM_A2" "$A2_NAME")"
check "move $QA1 into team A2 -> 200" 200 "$(put_person "$QA1" "$QA1@example.invalid" "QA t6 1" "$ORG_A" "$(team "$TEAM_A2" member)" true)"
check "$QA1 is only in team:$TEAM_A2" "team:$TEAM_A2" "$(team_groups_of "$QA1")"
check "email change for $QA1 -> 200" 200 "$(put_person "$QA1" "qa-t6-1-new@example.invalid" "QA t6 1" "$ORG_A" "$(team "$TEAM_A2" member)" true)"
check "the profile step changed the email" updated "$(step_result profile)"
info="$(occ user:info "$QA1" --output=json </dev/null)"
check "the uid stays $QA1, occ shows the new email" "$QA1 qa-t6-1-new@example.invalid" "$(jq -r '"\(.user_id) \(.email)"' <<<"$info")"
as "$NETRC2" GET "$DAV_BASE/addressbooks/users/$QA2/org-${ORG_A}_shared_by_nourax-teams/$QA1.vcf" -H 'Accept: text/vcard; version=4.0' >/dev/null
check "the directory card shows the new email" yes "$(grep -qi '^EMAIL.*:qa-t6-1-new@example.invalid' "$T_OUT/dav" && echo yes || echo no)"
check "email back -> 200" 200 "$(put_person "$QA1" "$QA1@example.invalid" "QA t6 1" "$ORG_A" "$(team "$TEAM_A2" member)" true)"

# --- The last member leaves: the team is archived, never deleted ---------------------------------
check "a public link on an own file of $QA3 -> 200" 200 "$(
	printf 'qa-t6-3 own file\n' > "$T_OUT/own3.txt"
	as "$NETRC3" PUT "$DAV_BASE/files/$QA3/qa-t6-3-own.txt" --data-binary "@$T_OUT/own3.txt" >/dev/null
	ocs "$NETRC3" POST /apps/files_sharing/api/v1/shares --data-urlencode path=/qa-t6-3-own.txt --data-urlencode shareType=3)"
T3="$(jq -r .ocs.data.token "$T_OUT/dav")"
S3="$(jq -r .ocs.data.id "$T_OUT/dav")"
check "$QA3 leaves B1, its last member -> 200" 200 "$(put_person "$QA3" "$QA3@example.invalid" "QA t6 3" "$ORG_B" '[]' true)"
check "the leave archived B1" true "$(leave_count "$TEAM_B1" archived)"
check "groupfolders lists \"$B1_NAME (archived)\"" yes \
	"$(occ groupfolders:list --output=json </dev/null | jq -e --arg m "$B1_NAME (archived)" 'map(.mountPoint) | index($m) != null' >/dev/null && echo yes || echo no)"
check "team B1 status: archived, folder and group still there" "true true true" \
	"$(admin_api GET "/v1/admin/orgs/$ORG_B/teams/$TEAM_B1" >/dev/null; jq -r '.team | "\(.archived) \(.folder.exists) \(.group.exists)"' "$T_OUT/body")"

# --- Leaving the organisation (active false), and coming back ------------------------------------
check "PUT $QA3 active false -> 200" 200 "$(put_person "$QA3" "$QA3@example.invalid" "QA t6 3" "$ORG_B" '[]' false)"
check "$QA3: the disable step ok" ok "$(steps_ok account org disable directories)"
check "$QA3 is disabled" false "$(occ user:info "$QA3" --output=json </dev/null | jq -r .enabled)"
# The disable step revokes every app password (only a remote-wipe token would stay), so the old
# NoMail app password gets 401 everywhere. With the account only disabled, WebDAV would answer 503
# (the server's DisabledUserException), which NoMail and sync clients read as a server fault.
check "the disable step revoked $QA3's app password(s)" yes \
	"$([ "$(jq -r '[.steps[] | select(.step == "disable")][0].app_passwords_revoked // 0' "$T_OUT/body")" -ge 1 ] && echo yes || echo no)"
check "$QA3 has no session or app password left" 0 \
	"$(occ user:auth-tokens:list "$QA3" --output=json </dev/null | jq '[.[] | select(.type != 2)] | length')"
check "$QA3's old app password on WebDAV -> 401" 401 "$(propfind "$NETRC3" "$QA3/" 0)"
check "$QA3's old app password on OCS -> 401" 401 "$(ocs "$NETRC3" GET /cloud/user)"
check "/v1/provision for $QA3 -> 409 account_disabled" "409 account_disabled" \
	"$(provision "$QA3" "$QA3@example.invalid" "QA t6 3") $(jq -r .error "$T_OUT/body")"
check "$QA3's public link -> 404" 404 "$(curl -sS -o /dev/null -w '%{http_code}' "https://${DRIVE_HOST}/s/$T3")"
check "$QA3 is in no organisation or team group" "" \
	"$(occ user:info "$QA3" --output=json </dev/null | jq -r '[.groups[] | select(startswith("org:") or startswith("team:"))] | join(" ")')"
admin_api GET "/v1/admin/people/$QA3" >/dev/null
delete_after="$(jq -r .person.delete_after "$T_OUT/body")"
days="$(( ( $(date -d "$delete_after" +%s) - $(date +%s) ) / 86400 ))"
check "status: delete_after about 30 days ahead" yes "$([ "$days" -ge 29 ] && [ "$days" -le 30 ] && echo yes || echo "no ($delete_after)")"
check "the scheduled delete is off" off "$(occ config:app:get nourax_api scheduled_delete </dev/null)"
job_id="$(occ background-job:list --class 'OCA\NouraxApi\BackgroundJob\LeaverDeletion' --output=json </dev/null | jq -r '.[0].id')"
occ background-job:execute "$job_id" --force-execute </dev/null >/dev/null
check "the delete job ran switched off" off "$(occ config:app:get nourax_api leaver_deletion_last_run </dev/null | jq -r .mode)"
check "the delete job left $QA3 in place" yes "$(user_exists "$QA3")"

check "PUT $QA3 active true, back in B1 -> 200" 200 "$(put_person "$QA3" "$QA3@example.invalid" "QA t6 3" "$ORG_B" "$(team "$TEAM_B1" member)" true)"
check "$QA3: enabled again" "updated true" "$(step_result account) $(occ user:info "$QA3" --output=json </dev/null | jq -r .enabled)"
check "B1 is back from the archive" "false $B1_NAME" \
	"$(admin_api GET "/v1/admin/orgs/$ORG_B/teams/$TEAM_B1" >/dev/null; jq -r '.team | "\(.archived) \(.folder.mount_point)"' "$T_OUT/body")"
check "status: delete_after cleared" null "$(admin_api GET "/v1/admin/people/$QA3" >/dev/null; jq -r .person.delete_after "$T_OUT/body")"
qa_login "$QA3" "QA t6 3"
# The disable hid the person's public links on their own files; it did not remove them, so they
# work again now (docs/teams.md). The test then removes the one link it made.
check "$QA3's public link on an own file works again -> 200" 200 "$(curl -sS -o /dev/null -w '%{http_code}' "https://${DRIVE_HOST}/s/$T3")"
check "$QA3 removes that test link -> 200" 200 "$(ocs "$NETRC3" DELETE "/apps/files_sharing/api/v1/shares/$S3")"
check "  and it is gone -> 404" 404 "$(curl -sS -o /dev/null -w '%{http_code}' "https://${DRIVE_HOST}/s/$T3")"

# --- Drift: a person added outside the API is taken out again ------------------------------------
check "provision $QA4 -> 200" 200 "$(provision "$QA4" "$QA4@example.invalid" "QA t6 4")"
# The drift job would take qa-t6-4 out again on its own; run it first, so its next run is 15
# minutes away and the reconcile call below is the one that finds and fixes the drift.
log "drift job run now (next run in 15 minutes); last run $(drift_job_now)"
occ group:adduser "team:$TEAM_A1" "$QA4" </dev/null >/dev/null
check "right after occ group:adduser: $QA4 is in team:$TEAM_A1" yes "$(in_group "team:$TEAM_A1" "$QA4")"
check "status of team A1 lists the occ change as drift" yes \
	"$(admin_api GET "/v1/admin/orgs/$ORG_A/teams/$TEAM_A1" >/dev/null; jq -e --arg u "$QA4" '.team.drift | any(.kind == "member_added" and .user_id == $u)' "$T_OUT/body" >/dev/null && echo yes || echo no)"
reconcile_body() { # dry-run
	jq -cn --argjson dry "$1" \
		--arg a1 "$TEAM_A1" --arg n1 "$A1_NAME" --argjson v1 "$(version_at "/v1/admin/orgs/$ORG_A/teams/$TEAM_A1" .team.version)" \
		--arg a2 "$TEAM_A2" --arg n2 "$A2_NAME" --argjson v2 "$(version_at "/v1/admin/orgs/$ORG_A/teams/$TEAM_A2" .team.version)" \
		--arg p1 "$QA1" --argjson pv1 "$(person_version "$QA1")" --arg p2 "$QA2" --argjson pv2 "$(person_version "$QA2")" \
		--arg org "$ORG_A" '{dry_run: $dry,
		teams: [{team_id: $a1, name: $n1, version: $v1}, {team_id: $a2, name: $n2, version: $v2}],
		people: [
			{user_id: $p1, email: "\($p1)@example.invalid", display_name: "QA t6 1", org_id: $org, teams: [{team_id: $a2, role: "member"}], active: true, version: $pv1},
			{user_id: $p2, email: "\($p2)@example.invalid", display_name: "QA t6 2", org_id: $org, teams: [{team_id: $a1, role: "lead"}], active: true, version: $pv2}]}'
}
check "reconcile org A, dry run -> 200" 200 "$(admin_api POST "/v1/admin/orgs/$ORG_A/reconcile" "$(reconcile_body true)")"
check "dry run reports extra_member $QA4 in team:$TEAM_A1" yes \
	"$(jq -e --arg g "team:$TEAM_A1" --arg u "$QA4" '.drift_found | any(.kind == "extra_member" and .group == $g and .user_id == $u)' "$T_OUT/body" >/dev/null && echo yes || echo no)"
check "dry run changed nothing" yes "$(in_group "team:$TEAM_A1" "$QA4")"
check "reconcile org A -> 200" 200 "$(admin_api POST "/v1/admin/orgs/$ORG_A/reconcile" "$(reconcile_body false)")"
check "reconcile fixed the extra member, nothing left" "yes []" \
	"$(jq -e --arg u "$QA4" '.drift_fixed | any(.kind == "extra_member" and .user_id == $u)' "$T_OUT/body" >/dev/null && echo yes || echo no) $(jq -c .drift_left "$T_OUT/body")"
check "occ group:list: $QA4 is out of team:$TEAM_A1" no "$(in_group "team:$TEAM_A1" "$QA4")"
check "the drift rows of team A1 are closed" "[]" "$(admin_api GET "/v1/admin/orgs/$ORG_A/teams/$TEAM_A1" >/dev/null; jq -c .team.drift "$T_OUT/body")"

# The drift job's work, run now: a member removed outside the API is put back.
occ group:removeuser "team:$TEAM_A1" "$QA2" </dev/null >/dev/null
occ nourax_api:reconcile "$ORG_A" </dev/null > "$T_OUT/reconcile.json" || true
check "occ nourax_api:reconcile put $QA2 back into team:$TEAM_A1" yes "$(in_group "team:$TEAM_A1" "$QA2")"
check "  and reported it as missing_member, fixed" yes \
	"$(jq -e --arg o "$ORG_A" --arg u "$QA2" '.orgs[$o].fixed | any(.kind == "missing_member" and .user_id == $u)' "$T_OUT/reconcile.json" >/dev/null && echo yes || echo no)"
check "$QA2 status: in sync, no open drift" "true []" \
	"$(admin_api GET "/v1/admin/people/$QA2" >/dev/null; jq -c -r '"\(.person.in_sync) \(.person.drift)"' "$T_OUT/body")"

# --- One call per person at a time ---------------------------------------------------------------
v2="$(person_version "$QA2")"
body="$(person_body "$QA2@example.invalid" "QA t6 2" "$ORG_A" "$(team "$TEAM_A1" lead)" true "$v2")"
for i in 1 2 3; do
	mkdir -p "$T_OUT/p$i"
	( T_OUT="$T_OUT/p$i"; admin_api PUT "/v1/admin/people/$QA2" "$body" > "$T_OUT/code"
		jq -r '.error // "none"' "$T_OUT/body" > "$T_OUT/error" ) &
done
wait
codes="$(for i in 1 2 3; do cat "$T_OUT/p$i/code"; echo; done | sort | tr '\n' ' ')"
log "three PUTs for $QA2 at once answered: $codes"
check "three PUTs at once: one works (200)" yes "$(grep -q '200' <<<"$codes" && echo yes || echo no)"
check "three PUTs at once: another gets 423 busy" yes "$(grep -q '423' <<<"$codes" && echo yes || echo no)"

# --- Audit ---------------------------------------------------------------------------------------
check "the people calls are audited by uid, with no body" yes "$(admin_api GET "/v1/admin/audit?limit=50&target=$QA1" >/dev/null
	jq -e '([.rows[] | select(.route == "PUT /v1/admin/people/{user_id}")] | length > 0) and (.rows | all(has("body") | not))' "$T_OUT/body" >/dev/null && echo yes || echo no)"

finish admin-people
