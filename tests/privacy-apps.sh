#!/usr/bin/env bash
# Privacy between organisations, app by app (docs/teams.md "Every place people meet"): with privacy
# on, nobody finds, autocomplete-suggests, mentions, invites, shares with or hands anything to a
# person of another organisation, in any app, and people in two teams see both teams.
# Run it on the server: sudo tests/privacy-apps.sh
# It takes the server-change lock itself (never wrap it in flock; set NOURAX_LOCK_HELD=1 if you
# already hold the lock).
#
# Who looks (read only): the owner's kept demo accounts, with their "Demo sign-in" keys from
# /etc/nourax/demo/demo-accounts.txt (docs/teams.md "Demo accounts"):
#   demo-a01 Amina (Sales lead), demo-a06 Omar (Sales + Engineering) of Demo Alpha;
#   demo-b01 Karim (Marketing lead), demo-b06 Rania (Marketing + Support) of Demo Beta.
# The demo accounts only look: nothing here writes to them, so a leak can never change them.
#
# Who tries to share and hand things over (the write checks): three QA accounts in two QA
# organisations, made through the admin API, with their NoMail app passwords from /v1/provision:
#   qa-t6b-org-a: qa-t6b-4 (team qa-t6b-team-a1, lead), qa-t6b-2 (team qa-t6b-team-a1)
#   qa-t6b-org-b: qa-t6b-3 (team qa-t6b-team-b1)
# Each write check tries qa-t6b-3 (another organisation), an id that does not exist and, where it
# applies, org B's group; each is refused with 403 and changes nothing. A same-organisation try
# with qa-t6b-2 still works. The QA objects are kept for the next run, under the names below
# (qa-t6b-4's): a folder qa-t6b-privacy, a NoGantt project, a NoForms form, a NoBoard board with
# one list and card, a Photos album, a task list (calendar), and a folder qa-t6b-acl in the team
# folder; plus "QA t6b transfer" board and form passed to qa-t6b-2 and back. It deletes nothing.
# An object that an earlier leak reached (a project, form or album shared with org B, a folder with
# a rule for org B, a board handed to qa-t6b-3) is never used again: the test makes a new one with
# the same name (or "... 2", qa-t6b-acl-2), so every run starts from one that org B cannot see.
#
# Keys and app passwords are never printed. Exit 0 when every check passes.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_admin_key
need_nomail_key
take_lock

DEMO_KEYS=/etc/nourax/demo/demo-accounts.txt
OCS="https://${DRIVE_HOST}/ocs/v2.php"
WEB="https://${DRIVE_HOST}/index.php"
DECK="$WEB/apps/deck/api/v1.0"
GANTT="$OCS/apps/nc_gantt/api/v1"
FORMS="$OCS/apps/forms/api/v3"
ORG_A=qa-t6b-org-a
ORG_B=qa-t6b-org-b
TEAM_A=qa-t6b-team-a1
TEAM_B=qa-t6b-team-b1
QA1=qa-t6b-4 # org A, team A1 lead: tries to share and hand over (qa-t6b-1 is a local login-check account)
QA2=qa-t6b-2 # org A: the same-organisation control
QA3=qa-t6b-3 # org B: never reached
NOBODY=qa-t6b-99 # an id that does not exist
# What one demo organisation must never see of the other (ids, names, emails, groups).
BETA_NAMES=(demo-b01 demo-b06 demo-b12 "Karim (Marketing)" "Rania (Marketing + Support)" "Yusuf (Support)"
	demo-b01@demo-beta.invalid org:demo-beta team:demo-beta-marketing team:demo-beta-support "Demo Beta")
ALPHA_NAMES=(demo-a01 demo-a06 demo-a12 "Amina (Sales)" "Omar (Sales + Engineering)" "Jade (Engineering)"
	demo-a01@demo-alpha.invalid org:demo-alpha team:demo-alpha-sales team:demo-alpha-engineering "Demo Alpha")
QA_B_NAMES=("$QA3" "QA t6b 3" "$QA3@example.invalid" "org:$ORG_B" "team:$TEAM_B")

log "base URL: https://${DRIVE_HOST}"
[ "$(occ nourax_api:status </dev/null | jq -r .org_privacy)" = on ] \
	|| die "privacy between organisations is off: this test checks it on (docs/teams.md)"

# --- Helpers -------------------------------------------------------------------------------------

netrc_of() { # uid -> the netrc file with that person's key or app password
	case "$1" in
	demo-*) printf '%s/%s.netrc' "$T_OUT" "$1" ;;
	*) qa_netrc "$1" ;;
	esac
}
# A request as a person. Prints the HTTP status; the body is left in $T_OUT/r.
call() { # uid method url [curl options...]
	local uid="$1" method="$2" url="$3"
	shift 3
	refuse_owner "$url" "$@"
	curl -sS -g --netrc-file "$(netrc_of "$uid")" -X "$method" -H 'OCS-APIRequest: true' -H 'Accept: application/json' \
		-o "$T_OUT/r" -w '%{http_code}' "$@" "$url"
}
json() { # uid method url json-body
	call "$1" "$2" "$3" -H 'Content-Type: application/json' --data-binary "$4"
}
xml() { # uid method url depth xml-body
	call "$1" "$2" "$3" -H "Depth: $4" -H 'Content-Type: application/xml; charset=utf-8' --data-binary "$5"
}
uri() { jq -rn --arg s "$1" '$s | @uri'; }
# "yes" when the last answer names none of these.
names_none() {
	local n
	for n in "$@"; do
		if grep -qF -- "$n" "$T_OUT/r"; then
			echo "no: $n"
			return
		fi
	done
	echo yes
}
# The same, leaving out what the search term itself holds (a typed address comes back as itself).
names_none_but() { # term names...
	local term="$1" n
	shift
	for n in "$@"; do
		case "$term" in *"$n"*) continue ;; esac
		if grep -qF -- "$n" "$T_OUT/r"; then
			echo "no: $n"
			return
		fi
	done
	echo yes
}
# Takes the addresses (hrefs) out of the last answer: the address asked for holds the id.
drop_hrefs() { sed -i -e 's#<d:href>[^<]*</d:href>##g' "$T_OUT/r"; }
# "yes" when the last answer names this.
names() { grep -qF -- "$1" "$T_OUT/r" && echo yes || echo no; }
yes_no() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }
refused() { [ "$1" = 403 ] && echo yes || echo "no ($1)"; }
# The OCS status code of the last answer.
ocs_status() { jq -r '.ocs.meta.statuscode // "none"' "$T_OUT/r" 2>/dev/null || echo unreadable; }
version_or_1() { # path jq-path
	if [ "$(admin_api GET "$1")" = 200 ]; then jq -r "$2" "$T_OUT/body"; else echo 1; fi
}
put_ok() { # label status
	check "$1 -> 200" 200 "$2"
	check "$1: no failed step" yes "$(no_failed_steps)"
}

# --- Setup ---------------------------------------------------------------------------------------

# The demo keys, one netrc file each in this run's own folder (never printed).
[ -s "$DEMO_KEYS" ] || die "$DEMO_KEYS is missing - run sudo tests/demo-accounts.sh first"
while IFS=$'\t' read -r uid _ _ _ key; do
	case "$uid" in demo-[ab][0-9][0-9]) ;; *) continue ;; esac
	(umask 077 && printf 'machine %s login %s password %s\n' "$DRIVE_HOST" "$uid" "$key" > "$(netrc_of "$uid")")
done < "$DEMO_KEYS"
for uid in demo-a01 demo-a06 demo-b01 demo-b06; do
	[ "$(propfind "$(netrc_of "$uid")" "$uid/" 0)" = 207 ] || die "$uid's demo key does not sign in - run sudo tests/demo-accounts.sh"
done

# The QA organisations, teams and people, through the admin API (the same version runs every
# step again, so the numbers do not keep growing).
for org in "$ORG_A:QA t6b Org A" "$ORG_B:QA t6b Org B"; do
	v="$(version_or_1 "/v1/admin/orgs/${org%%:*}" .org.version)"
	put_ok "PUT org ${org%%:*}" "$(admin_api PUT "/v1/admin/orgs/${org%%:*}" "$(name_version "${org#*:}" "$v")")"
done
for team in "$ORG_A/$TEAM_A:QA t6b Team A1" "$ORG_B/$TEAM_B:QA t6b Team B1"; do
	path="/v1/admin/orgs/${team%%/*}/teams/$(cut -d: -f1 <<<"${team#*/}")"
	v="$(version_or_1 "$path" .team.version)"
	put_ok "PUT team ${team%%:*}" "$(admin_api PUT "$path" "$(name_version "${team#*:}" "$v")")"
done
for person in "$QA1:QA t6b 4:$ORG_A:$TEAM_A:lead" "$QA2:QA t6b 2:$ORG_A:$TEAM_A:member" "$QA3:QA t6b 3:$ORG_B:$TEAM_B:member"; do
	IFS=: read -r uid name org team role <<<"$person"
	if [ "$(user_exists "$uid")" = yes ] && [ "$(occ user:info "$uid" --output=json </dev/null | jq -r .enabled)" != true ]; then
		log "enabling $uid (disabled by an earlier test round)"
		occ user:enable "$uid" </dev/null >/dev/null
	fi
	v="$(version_or_1 "/v1/admin/people/$uid" .person.version)"
	put_ok "PUT person $uid" "$(admin_api PUT "/v1/admin/people/$uid" "$(jq -cn --arg e "$uid@example.invalid" \
		--arg d "$name" --arg o "$org" --arg t "$team" --arg r "$role" --argjson v "$v" \
		'{email: $e, display_name: $d, org_id: $o, teams: [{team_id: $t, role: $r}], active: true, version: $v}')")"
	if ! { [ -s "$(qa_netrc "$uid")" ] && [ "$(propfind "$(qa_netrc "$uid")" "$uid/" 0)" = 207 ]; }; then
		check "provision $uid -> 200" 200 "$(provision "$uid" "$uid@example.invalid" "$name")"
		save_netrc "$(qa_netrc "$uid")"
	fi
	check "$uid signs in (PROPFIND 207)" 207 "$(propfind "$(qa_netrc "$uid")" "$uid/" 0)"
	occ user:setting "$uid" deck firstRun no </dev/null >/dev/null
done
admin_api GET "/v1/admin/orgs/$ORG_A/teams/$TEAM_A" >/dev/null
QA_FOLDER="$(jq -r '.team.folder.mount_point // empty' "$T_OUT/body")"
check "team A1 has a team folder, and $QA1 leads it" "yes yes" \
	"$([ -n "$QA_FOLDER" ] && echo yes || echo no) $(jq -r --arg u "$QA1" 'if (.team.folder.leads // []) | index($u) then "yes" else "no" end' "$T_OUT/body")"

# qa-t6b-4's own probe file (for comments, ONLYOFFICE mentions and the ownership transfer).
call "$QA1" MKCOL "$DAV_BASE/files/$QA1/qa-t6b-privacy" >/dev/null
for name in probe.txt transfer-me.txt; do
	code="$(printf 'qa-t6b-4 privacy probe\n' | call "$QA1" PUT "$DAV_BASE/files/$QA1/qa-t6b-privacy/$name" --data-binary @-)"
	check "$QA1 saves qa-t6b-privacy/$name (201 or 204)" yes "$([[ "$code" =~ ^20[14]$ ]] && echo yes || echo "no ($code)")"
done
fileid_of() { # uid path -> the file id
	xml "$1" PROPFIND "$DAV_BASE/files/$1/$2" 0 '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>' >/dev/null
	grep -o '<oc:fileid>[0-9]*' "$T_OUT/r" | head -n 1 | sed 's/<oc:fileid>//'
}
PROBE_ID="$(fileid_of "$QA1" qa-t6b-privacy/probe.txt)"
SALES_DOC_ID="$(fileid_of demo-a01 'Sales/Sales%20plan.docx')"
check "the probe file and the Sales plan have file ids" yes "$([ -n "$PROBE_ID" ] && [ -n "$SALES_DOC_ID" ] && echo yes || echo no)"

# === 1. People in two teams see both teams ========================================================

team_status() { admin_api GET "/v1/admin/orgs/$1/teams/$2" >/dev/null; jq -r "$3" "$T_OUT/body"; }
groups_found() { jq -r '[(.ocs.data.groups // [])[], (.ocs.data.exact.groups // [])[]] | map(.value.shareWith) | unique | join(" ")' "$T_OUT/r"; }
users_found() { jq -r '[(.ocs.data.users // [])[], (.ocs.data.exact.users // [])[]] | map(.value.shareWith) | unique | join(" ")' "$T_OUT/r"; }
sharee_groups() { # uid -> the groups the share dialog offers for "Team" and the organisation's name
	local org="$2" out=""
	call "$1" GET "$OCS/apps/files_sharing/api/v1/sharees?search=Team&itemType=file&perPage=200&lookup=false" >/dev/null
	out="$(groups_found)"
	call "$1" GET "$OCS/apps/files_sharing/api/v1/sharees?search=$(uri "$org")&itemType=file&perPage=200&lookup=false" >/dev/null
	printf '%s %s\n' "$out" "$(groups_found)" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ' | sed 's/ $//'
}
check "demo-a06 (two teams) is offered both teams and the organisation" \
	"org:demo-alpha team:demo-alpha-engineering team:demo-alpha-sales" "$(sharee_groups demo-a06 "Demo Alpha")"
check "demo-a01 (one team) is offered Sales and the organisation only" \
	"org:demo-alpha team:demo-alpha-sales" "$(sharee_groups demo-a01 "Demo Alpha")"
check "demo-b06 (two teams) is offered both teams and the organisation" \
	"org:demo-beta team:demo-beta-marketing team:demo-beta-support" "$(sharee_groups demo-b06 "Demo Beta")"
two_teams() { # uid org team1 team2 -> folders, calendars, boards and address books of both teams
	local uid="$1" org="$2" t1="$3" t2="$4" f1 f2 b1 b2 out=""
	f1="$(team_status "$org" "$t1" .team.folder.mount_point)"
	f2="$(team_status "$org" "$t2" .team.folder.mount_point)"
	b1="$(team_status "$org" "$t1" .team.board.id)"
	b2="$(team_status "$org" "$t2" .team.board.id)"
	call "$uid" PROPFIND "$DAV_BASE/files/$uid/" -H 'Depth: 1' >/dev/null
	out+="folders $(names "/files/$uid/$(uri "$f1")/")$(names "/files/$uid/$(uri "$f2")/")"
	# Calendars: the team calendars, and the boards' own calendars (one per board one can open).
	call "$uid" PROPFIND "$DAV_BASE/calendars/$uid/" -H 'Depth: 1' >/dev/null
	out+=" calendars $(names "team-${t1}_shared_by_nourax-teams")$(names "team-${t2}_shared_by_nourax-teams")"
	out+=" boards $(names "app-generated--deck--board-$b1/")$(names "app-generated--deck--board-$b2/")"
	call "$uid" PROPFIND "$DAV_BASE/addressbooks/users/$uid/" -H 'Depth: 1' >/dev/null
	out+=" books $(names "team-${t1}_shared_by_nourax-teams")$(names "team-${t2}_shared_by_nourax-teams")$(names "org-${org}_shared_by_nourax-teams")"
	echo "$out"
}
check "demo-a06 has both team folders, calendars, boards and books" \
	"folders yesyes calendars yesyes boards yesyes books yesyesyes" \
	"$(two_teams demo-a06 demo-alpha demo-alpha-sales demo-alpha-engineering)"
check "demo-a01 has Sales only (not Engineering)" \
	"folders yesno calendars yesno boards yesno books yesnoyes" \
	"$(two_teams demo-a01 demo-alpha demo-alpha-sales demo-alpha-engineering)"
check "demo-b06 has both team folders, calendars, boards and books" \
	"folders yesyes calendars yesyes boards yesyes books yesyesyes" \
	"$(two_teams demo-b06 demo-beta demo-beta-marketing demo-beta-support)"
check "demo-a06 finds demo-a01 (Sales) and demo-a12 (Engineering)" yes \
	"$(call demo-a06 GET "$OCS/apps/files_sharing/api/v1/sharees?search=demo-a&itemType=file&perPage=200&lookup=false" >/dev/null
		found=" $(users_found) "; [[ "$found" == *" demo-a01 "* && "$found" == *" demo-a12 "* ]] && echo yes || echo "no: $found")"

# === 2. Finding people (the demo accounts look, both ways) =========================================

# Each check runs for Alpha looking at Beta and for Beta looking at Alpha.
for side in "demo-a01:demo-b:Karim:demo-b01:demo-b01@demo-beta.invalid:Karim (Marketing)" \
	"demo-b01:demo-a:Amina:demo-a01:demo-a01@demo-alpha.invalid:Amina (Sales)"; do
	IFS=: read -r me prefix first id email full <<<"$side"
	if [ "$me" = demo-a01 ]; then OTHER=("${BETA_NAMES[@]}"); MATE=demo-a02; MATE_FIRST=Ben; MATE_NAME="Ben (Sales)"; OTHER_ORG=demo-beta; OWN_ORG=demo-alpha
	else OTHER=("${ALPHA_NAMES[@]}"); MATE=demo-b02; MATE_FIRST=Lena; MATE_NAME="Lena (Marketing)"; OTHER_ORG=demo-alpha; OWN_ORG=demo-beta; fi

	# Core: the share dialog (files, and the calendar, board and principal kinds), recommendations,
	# autocomplete (@-mentions in comments and documents, board cards), the contacts menu (also the
	# people filter of the search box), hovercards and online status.
	for term in "$prefix" "$first" "$id" "$email" "$full" "team:$OTHER_ORG"; do
		for kind in file calendar deck principals; do
			call "$me" GET "$OCS/apps/files_sharing/api/v1/sharees?search=$(uri "$term")&itemType=$kind&perPage=200&lookup=false" >/dev/null
			# A typed address is offered back as itself (a link by email); nothing else may name them.
			check "$me sharees ($kind) \"$term\": nobody of the other organisation" "no people, no groups, no names" \
				"$([ -z "$(users_found)" ] && echo "no people" || echo "people $(users_found)"), $([ -z "$(groups_found)" ] && echo "no groups" || echo "groups $(groups_found)"), $(r="$(names_none_but "$term" "${OTHER[@]}")"; [ "$r" = yes ] && echo "no names" || echo "$r")"
		done
	done
	call "$me" GET "$OCS/apps/files_sharing/api/v1/sharees?search=$(uri "$MATE")&itemType=file&perPage=200&lookup=false" >/dev/null
	check "$me sharees \"$MATE\" finds $MATE (same organisation)" yes "$(case " $(users_found) " in *" $MATE "*) echo yes ;; *) echo no ;; esac)"
	call "$me" GET "$OCS/apps/files_sharing/api/v1/sharees_recommended?itemType=file" >/dev/null
	check "$me sharees_recommended: nobody of the other organisation" yes "$(names_none "${OTHER[@]}")"
	for kind in files comments deck-card; do
		for term in "$prefix" "$first" "$id"; do
			call "$me" GET "$OCS/core/autocomplete/get?search=$(uri "$term")&itemType=$kind&itemId=1&shareTypes[]=0&shareTypes[]=1&limit=50" >/dev/null
			check "$me autocomplete ($kind) \"$term\": nobody of the other organisation" yes "$(names_none "${OTHER[@]}")"
		done
	done
	for term in "$prefix" "$first" "$id" ""; do
		call "$me" POST "$WEB/contactsmenu/contacts" --data-urlencode "filter=$term" >/dev/null
		check "$me contacts menu \"$term\": nobody of the other organisation" yes "$(names_none "${OTHER[@]}")"
	done
	check "$me contacts menu: $id's card by id -> 404" 404 \
		"$(call "$me" POST "$WEB/contactsmenu/findOne" --data-urlencode shareType=0 --data-urlencode "shareWith=$id")"
	check "$me hovercard of $id -> 404" 404 "$(call "$me" GET "$OCS/hovercard/v1/$id")"
	check "$me hovercard of $MATE -> 200 (same organisation)" 200 "$(call "$me" GET "$OCS/hovercard/v1/$MATE")"
	call "$me" GET "$OCS/apps/user_status/api/v1/statuses?limit=100" >/dev/null
	check "$me online statuses: nobody of the other organisation" yes "$(names_none "${OTHER[@]}")"

	# The account API is open only to the owner's address, so it is asked inside the app
	# container (127.0.0.1), with the key on a pipe.
	code="$( (printf 'machine localhost login %s password %s\n' "$me" "$(awk -F'\t' -v u="$me" '$1 == u { print $5 }' "$DEMO_KEYS")") |
		dc exec -T app curl -sS --netrc-file /dev/stdin -H "Host: $DRIVE_HOST" -H 'OCS-APIRequest: true' -H 'Accept: application/json' \
			-o /dev/null -w '%{http_code}' "http://localhost/ocs/v2.php/cloud/users/$id")"
	check "$me account API for $id is refused ($code)" yes "$([[ "$code" =~ ^(403|404)$ ]] && echo yes || echo no)"

	# NoCalendar: attendee suggestions, the photo of an address, a contact group's members, the
	# principal search, and free/busy (the invite dialog's availability).
	for term in "$prefix" "$first" "$email"; do
		json "$me" POST "$WEB/apps/calendar/v1/autocompletion/attendee" "$(jq -cn --arg s "$term" '{search: $s}')" >/dev/null
		check "$me calendar attendees \"$term\": nobody of the other organisation" yes "$(names_none "${OTHER[@]}")"
	done
	json "$me" POST "$WEB/apps/calendar/v1/autocompletion/attendee" "$(jq -cn --arg s "$MATE_FIRST" '{search: $s}')" >/dev/null
	check "$me calendar attendees \"$MATE_FIRST\" finds $MATE_NAME (same organisation)" yes "$(names "$MATE_NAME")"
	check "$me calendar photo of $email: none" yes \
		"$(code="$(json "$me" POST "$WEB/apps/calendar/v1/autocompletion/photo" "$(jq -cn --arg s "$email" '{search: $s}')")"; [ "$code" = 404 ] && [ "$(names_none "${OTHER[@]}")" = yes ] && echo yes || echo "no ($code)")"
	json "$me" POST "$WEB/apps/calendar/v1/autocompletion/groupmembers" '{"groupName":"Marketing"}' >/dev/null
	check "$me calendar contact group members: nobody of the other organisation" yes "$(names_none "${OTHER[@]}")"
	for prop in '<d:displayname/>|'"$first" '<s:email-address/>|'"$email"; do
		xml "$me" REPORT "$DAV_BASE/principals/users/" 0 "<?xml version=\"1.0\"?><d:principal-property-search xmlns:d=\"DAV:\" xmlns:s=\"http://sabredav.org/ns\" test=\"anyof\"><d:property-search><d:prop>${prop%%|*}</d:prop><d:match>${prop#*|}</d:match></d:property-search><d:prop><d:displayname/></d:prop></d:principal-property-search>" >/dev/null
		check "$me principal search \"${prop#*|}\": nobody" yes "$(names_none "${OTHER[@]}")"
	done
	now="$(date -u +%Y%m%dT%H%M%SZ)"
	call "$me" POST "$DAV_BASE/calendars/$me/outbox/" -H 'Content-Type: text/calendar; charset=utf-8' --data-binary \
		"$(printf 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Nourax//privacy-apps//EN\r\nMETHOD:REQUEST\r\nBEGIN:VFREEBUSY\r\nUID:privacy-apps-%s\r\nDTSTAMP:%s\r\nDTSTART:%s\r\nDTEND:%s\r\nORGANIZER:mailto:%s\r\nATTENDEE:mailto:%s\r\nEND:VFREEBUSY\r\nEND:VCALENDAR\r\n' \
			"$now" "$now" "$now" "$(date -u -d '+7 days' +%Y%m%dT%H%M%SZ)" "$(occ user:info "$me" --output=json </dev/null | jq -r .email)" "$email")" >/dev/null
	check "$me free/busy of $email: not found, no times" "yes yes" \
		"$(names '3.7;') $(! grep -q 'FREEBUSY[;:]' "$T_OUT/r" && echo yes || echo no)"

	# The address of a person or a group: name, email address, groups and language, given only to
	# people of the same organisation (nourax_api's OrgPeoplePlugin).
	PRINCIPAL_PROPS='<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:nc="http://nextcloud.com/ns"><d:prop><d:displayname/><s:email-address/><c:calendar-user-address-set/><d:group-membership/><nc:language/></d:prop></d:propfind>'
	xml "$me" PROPFIND "$DAV_BASE/principals/users/$id/" 0 "$PRINCIPAL_PROPS" >/dev/null
	drop_hrefs
	check "$me reads $id's address: no name, email address or groups" yes "$(names_none "${OTHER[@]}")"
	xml "$me" PROPFIND "$DAV_BASE/principals/users/$MATE/" 0 "$PRINCIPAL_PROPS" >/dev/null
	check "$me reads $MATE's address: the name (same organisation)" yes "$(names "$MATE_NAME")"
	xml "$me" PROPFIND "$DAV_BASE/principals/groups/org%3A$OTHER_ORG/" 0 "$PRINCIPAL_PROPS" >/dev/null
	drop_hrefs
	check "$me reads the other organisation's group address: no name" yes "$(names_none "${OTHER[@]}")"
	xml "$me" PROPFIND "$DAV_BASE/principals/groups/org%3A$OWN_ORG/" 0 "$PRINCIPAL_PROPS" >/dev/null
	check "$me reads its own organisation's group address: the name" yes "$(names "$([ "$OWN_ORG" = demo-alpha ] && echo 'Demo Alpha' || echo 'Demo Beta')")"
	xml "$me" REPORT "$DAV_BASE/principals/users/$id/" 0 '<?xml version="1.0"?><d:expand-property xmlns:d="DAV:"><d:property name="group-membership"><d:property name="displayname"/></d:property><d:property name="displayname"/></d:expand-property>' >/dev/null
	drop_hrefs
	check "$me expand-property of $id: no names" yes "$(names_none "${OTHER[@]}")"
	xml "$me" PROPFIND "$DAV_BASE/principals/users/nourax-teams/" 0 "$PRINCIPAL_PROPS" >/dev/null
	check "$me reads the team calendars' owner (the service account): its name" yes "$(names 'Nourax Teams')"

	# NoContacts: the address books one has, the directory's cards, and the search.
	call "$me" PROPFIND "$DAV_BASE/addressbooks/users/$me/" -H 'Depth: 1' >/dev/null
	check "$me address books: own organisation's only, no system book" yes \
		"$(r="$(names_none "${OTHER[@]}" z-server-generated--system)"; [ "$r" = yes ] && names "org-${OWN_ORG}_shared_by_nourax-teams" || echo "$r")"
	xml "$me" REPORT "$DAV_BASE/addressbooks/users/$me/org-${OWN_ORG}_shared_by_nourax-teams/" 1 \
		'<?xml version="1.0"?><card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><card:address-data/></d:prop></card:addressbook-query>' >/dev/null
	check "$me directory: 12 cards, all of its own organisation" "12 yes" \
		"$(grep -c 'BEGIN:VCARD' "$T_OUT/r") $(names_none "${OTHER[@]}")"

	# ONLYOFFICE: the people list of the editor (mentions and protected ranges) and the names it
	# shows for account ids.
	if [ "$me" = demo-a01 ]; then
		for op in mention protect; do
			call "$me" GET "$WEB/apps/onlyoffice/ajax/users?fileId=$SALES_DOC_ID&operationType=$op&limit=100" >/dev/null
			check "$me ONLYOFFICE people list ($op): own organisation only" "yes yes" "$(names_none "${OTHER[@]}") $(names "$MATE_NAME")"
		done
	fi
	call "$me" GET "$WEB/apps/onlyoffice/ajax/userInfo?userIds=$(uri "[\"$id\",\"$MATE\"]")" >/dev/null
	check "$me ONLYOFFICE names for [$id, $MATE]: only $MATE_NAME" "yes yes" "$(names_none "${OTHER[@]}") $(names "$MATE_NAME")"

	# Team folders: the lead's people search for advanced permissions.
	folder="$(team_status "$OWN_ORG" "$([ "$OWN_ORG" = demo-alpha ] && echo demo-alpha-sales || echo demo-beta-marketing)" .team.folder.id)"
	for term in demo "$first" "$id"; do
		call "$me" GET "$WEB/apps/groupfolders/folders/$folder/search?search=$(uri "$term")" >/dev/null
		check "$me team folder people search \"$term\": nobody of the other organisation" yes "$(names_none "${OTHER[@]}")"
	done

	# Activity and the search box (every provider).
	call "$me" GET "$OCS/apps/activity/api/v2/activity/all?limit=200" >/dev/null
	check "$me activity: nobody of the other organisation" yes "$(names_none "${OTHER[@]}")"
	call "$me" GET "$OCS/search/providers" >/dev/null
	providers="$(jq -r '.ocs.data[].id' "$T_OUT/r" | tr '\n' ' ')"
	[ "$me" = demo-a01 ] && log "search providers: $providers"
	for provider in $providers; do
		for term in "$first" "$id" "$OTHER_ORG"; do
			call "$me" GET "$OCS/search/providers/$provider/search?term=$(uri "$term")&limit=25" >/dev/null
			check "$me search $provider \"$term\": nobody of the other organisation" yes "$(names_none "${OTHER[@]}")"
		done
	done

	# NoGantt's own people searches (project sharing, planning resources, the import's email
	# match).
	for term in "$prefix" "$first" "$id"; do
		call "$me" GET "$GANTT/sharees?search=$(uri "$term")" >/dev/null
		check "$me NoGantt sharees \"$term\": nobody" yes "$(names_none "${OTHER[@]}")"
		call "$me" GET "$GANTT/users/search?search=$(uri "$term")&include_self=true" >/dev/null
		check "$me NoGantt people search \"$term\": nobody" yes "$(names_none "${OTHER[@]}")"
	done
	call "$me" GET "$GANTT/users/by-email?email=$(uri "$email")" >/dev/null
	check "$me NoGantt email match $email: not_found" not_found "$(jq -r '.ocs.data.status' "$T_OUT/r")"
	call "$me" GET "$GANTT/users/by-email?email=$(uri "$MATE@$OWN_ORG.invalid")" >/dev/null
	check "$me NoGantt email match $MATE (same organisation): found" "found $MATE" "$(jq -r '"\(.ocs.data.status) \(.ocs.data.uid)"' "$T_OUT/r")"
done

# === 3. Sharing and handing over (the QA accounts try; nothing may reach org B) ===================

# --- NoGantt: project shares and planning resources ---
# No org B id in a list of shares (the last answer): an object an earlier leak reached is never
# used again, so every run starts from one that org B cannot see.
no_org_b() { jq -e --arg p "$QA3" --arg g "org:$ORG_B" --arg f "$1" '[.. | objects | .[$f]? | select(. == $p or . == $g)] | length == 0' "$T_OUT/r" >/dev/null; }
call "$QA1" GET "$GANTT/projects" >/dev/null
project=""
for pid in $(jq -r --arg u "$QA1" '.ocs.data[]? | select(.title == "QA t6b privacy" and .owner_id == $u) | .id' "$T_OUT/r"); do
	call "$QA1" GET "$GANTT/projects/$pid/shares" >/dev/null
	if no_org_b principal_id; then project="$pid"; break; fi
done
if [ -z "$project" ]; then
	check "$QA1 makes the NoGantt project (201)" yes \
		"$(code="$(json "$QA1" POST "$GANTT/projects" '{"title":"QA t6b privacy","color":"#2563EB"}')"; [[ "$code" =~ ^20[01]$ ]] && echo yes || echo "no ($code)")"
	project="$(jq -r '.ocs.data.id // empty' "$T_OUT/r")"
fi
check "the NoGantt project is there" yes "$([ -n "$project" ] && echo yes || echo no)"
gantt_shares() { call "$QA1" GET "$GANTT/projects/$project/shares" >/dev/null; jq -r --arg u "$1" '[.ocs.data[]? | select(.principal_id == $u)] | length' "$T_OUT/r"; }
before="$(gantt_shares "$QA3")"
check "NoGantt share with $QA3 (org B) -> 403" yes "$(refused "$(json "$QA1" POST "$GANTT/projects/$project/shares" "$(jq -cn --arg p "$QA3" '{principal_id: $p, principal_type: "user", permission: "viewer"}')")")"
check "NoGantt: the refusal says why" yes "$(names 'only allowed with people of your organisation')"
check "NoGantt: not shared with $QA3 by that try" "$before" "$(gantt_shares "$QA3")"
check "NoGantt share with an id that does not exist -> 403 (the same answer)" yes "$(refused "$(json "$QA1" POST "$GANTT/projects/$project/shares" "$(jq -cn --arg p "$NOBODY" '{principal_id: $p, principal_type: "user", permission: "viewer"}')")")"
check "NoGantt share with the group org:$ORG_B is refused" yes \
	"$(code="$(json "$QA1" POST "$GANTT/projects/$project/shares" "$(jq -cn --arg p "org:$ORG_B" '{principal_id: $p, principal_type: "group", permission: "viewer"}')")"; [[ "$code" =~ ^40[03]$ ]] && echo yes || echo "no ($code)")"
check "NoGantt share with $QA2 (org A) -> 200 or 201" yes \
	"$(code="$(json "$QA1" POST "$GANTT/projects/$project/shares" "$(jq -cn --arg p "$QA2" '{principal_id: $p, principal_type: "user", permission: "viewer"}')")"; [[ "$code" =~ ^20[01]$ ]] && echo yes || echo "no ($code)")"
call "$QA3" GET "$GANTT/projects" >/dev/null
check "$QA3 does not see the project" yes "$(yes_no jq -e --argjson p "$project" '[.ocs.data[]? | select(.id == $p)] | length == 0' "$T_OUT/r")"
gantt_resources() { call "$QA1" GET "$GANTT/resources" >/dev/null; jq -r --arg u "$1" '[.ocs.data[]? | select(.uid == $u)] | length' "$T_OUT/r"; }
before="$(gantt_resources "$QA3")"
check "NoGantt resource for $QA3 (org B) -> 403" yes "$(refused "$(json "$QA1" POST "$GANTT/resources" "$(jq -cn --arg u "$QA3" '{name: "QA t6b probe", uid: $u, type: "person"}')")")"
check "NoGantt resource: no name of $QA3 in the answer" yes "$(names_none "${QA_B_NAMES[@]}")"
check "NoGantt resource for an id that does not exist -> 403" yes "$(refused "$(json "$QA1" POST "$GANTT/resources" "$(jq -cn --arg u "$NOBODY" '{name: "QA t6b probe", uid: $u, type: "person"}')")")"
if [ "$(gantt_resources "$QA2")" = 0 ]; then
	check "NoGantt resource for $QA2 (org A) -> 201" 201 "$(json "$QA1" POST "$GANTT/resources" "$(jq -cn --arg u "$QA2" '{name: "QA t6b 2", uid: $u, type: "person"}')")"
fi
call "$QA1" GET "$GANTT/resources" >/dev/null
resource="$(jq -r --arg u "$QA2" '[.ocs.data[]? | select(.uid == $u)][0].id // empty' "$T_OUT/r")"
check "NoGantt resource for $QA2 is there" yes "$([ -n "$resource" ] && echo yes || echo no)"
check "NoGantt resource changed to $QA3 (org B) -> 403" yes "$(refused "$(json "$QA1" PUT "$GANTT/resources/$resource" "$(jq -cn --arg u "$QA3" '{uid: $u}')")")"
check "NoGantt: no resource stands for $QA3 after those tries" "$before" "$(gantt_resources "$QA3")"

# --- NoForms: shares and a new owner ---
forms_owned() { call "$QA1" GET "$FORMS/forms?type=owned" >/dev/null; jq -r --arg t "$1" '.ocs.data[]? | select(.title == $t) | .id' "$T_OUT/r"; }
form_of() { # title -> a form of the lead (QA1) with that title that org B has no share of, made when missing
	local id
	for id in $(forms_owned "$1"); do
		call "$QA1" GET "$FORMS/forms/$id" >/dev/null
		if no_org_b shareWith; then echo "$id"; return; fi
	done
	json "$QA1" POST "$FORMS/forms" '{}' >/dev/null
	id="$(jq -r '.ocs.data.id // empty' "$T_OUT/r")"
	[ -n "$id" ] && json "$QA1" PATCH "$FORMS/forms/$id" "$(jq -cn --arg t "$1" '{keyValuePairs: {title: $t}}')" >/dev/null
	echo "$id"
}
form="$(form_of "QA t6b privacy")"
check "the NoForms form is there" yes "$([ -n "$form" ] && echo yes || echo no)"
form_shares() { call "$QA1" GET "$FORMS/forms/$form" >/dev/null; jq -r --arg w "$1" '[.ocs.data.shares[]? | select(.shareWith == $w)] | length' "$T_OUT/r"; }
before="$(form_shares "$QA3") $(form_shares "org:$ORG_B")"
new_form_share() { json "$QA1" POST "$FORMS/forms/$form/shares" "$(jq -cn --argjson t "$1" --arg w "$2" '{shareType: $t, shareWith: $w, permissions: ["submit"]}')"; }
check "NoForms share with $QA3 (org B) -> 403" yes "$(refused "$(new_form_share 0 "$QA3")")"
check "NoForms share with an id that does not exist -> 403 (the same answer)" yes "$(refused "$(new_form_share 0 "$NOBODY")")"
check "NoForms share with the group org:$ORG_B -> 403" yes "$(refused "$(new_form_share 1 "org:$ORG_B")")"
check "NoForms: not shared with org B by those tries" "$before" "$(form_shares "$QA3") $(form_shares "org:$ORG_B")"
if [ "$(form_shares "$QA2")" = 0 ]; then
	check "NoForms share with $QA2 (org A) -> 201" yes "$(code="$(new_form_share 0 "$QA2")"; [[ "$code" =~ ^20[01]$ ]] && echo yes || echo "no ($code)")"
fi
check "NoForms owner -> $QA3 (org B) -> 403" yes "$(refused "$(json "$QA1" PATCH "$FORMS/forms/$form" "$(jq -cn --arg u "$QA3" '{keyValuePairs: {ownerId: $u}}')")")"
check "NoForms owner -> an id that does not exist -> 403" yes "$(refused "$(json "$QA1" PATCH "$FORMS/forms/$form" "$(jq -cn --arg u "$NOBODY" '{keyValuePairs: {ownerId: $u}}')")")"
check "NoForms: $QA1 still owns the form" yes "$(forms_owned "QA t6b privacy" | grep -qx -- "$form" && echo yes || echo no)"
privacy_form="$form"
form="$(form_of "QA t6b transfer")"
check "NoForms owner -> $QA2 (org A) -> 200" 200 "$(json "$QA1" PATCH "$FORMS/forms/$form" "$(jq -cn --arg u "$QA2" '{keyValuePairs: {ownerId: $u}}')")"
check "NoForms: $QA2 gives it back -> 200" 200 "$(json "$QA2" PATCH "$FORMS/forms/$form" "$(jq -cn --arg u "$QA1" '{keyValuePairs: {ownerId: $u}}')")"
# Stored as booleans (50-apps.sh): occ prints false as 0.
check "NoForms: no form for everyone on the server" "off off" \
	"$(for key in allowPermitAll allowShowToAll; do v="$(occ config:app:get forms "$key" </dev/null 2>/dev/null || echo unset)"; case "$v" in 0 | false) printf 'off ' ;; *) printf '%s ' "$v" ;; esac; done | sed 's/ $//')"
call "$QA3" GET "$FORMS/forms?type=shared" >/dev/null
check "$QA3's shared forms: neither of $QA1's" yes \
	"$(yes_no jq -e --argjson a "$privacy_form" --argjson b "$form" '[.ocs.data[]? | select(.id == $a or .id == $b)] | length == 0' "$T_OUT/r")"

# --- NoBoard: a new owner, board imports and card people ---
boards_of() { call "$1" GET "$DECK/boards" >/dev/null; jq -r --arg t "$2" --arg u "$1" '[.[]? | select(.title == $t and .owner.uid == $u and .deletedAt == 0)][0].id // empty' "$T_OUT/r"; }
board_of() { # title -> a board of the lead (QA1), made when missing
	local id
	id="$(boards_of "$QA1" "$1")"
	if [ -z "$id" ]; then
		json "$QA1" POST "$DECK/boards" "$(jq -cn --arg t "$1" '{title: $t, color: "2563eb"}')" >/dev/null
		id="$(jq -r '.id // empty' "$T_OUT/r")"
	fi
	echo "$id"
}
board="$(board_of "QA t6b privacy")"
check "the board is there" yes "$([ -n "$board" ] && echo yes || echo no)"
transfer_board() { json "$1" PUT "$WEB/apps/deck/boards/$2/transferOwner" "$(jq -cn --arg u "$3" '{newOwner: $u}')"; }
check "board owner -> $QA3 (org B) -> 403" yes "$(refused "$(transfer_board "$QA1" "$board" "$QA3")")"
check "board owner -> an id that does not exist -> 403" yes "$(refused "$(transfer_board "$QA1" "$board" "$NOBODY")")"
check "$QA1 still owns the board" "$board" "$(boards_of "$QA1" "QA t6b privacy")"
moving="$(board_of "QA t6b transfer")"
check "board owner -> $QA2 (org A) -> 200" 200 "$(transfer_board "$QA1" "$moving" "$QA2")"
check "board: $QA2 gives it back -> 200" 200 "$(transfer_board "$QA2" "$moving" "$QA1")"
# A card on the board: only the board's people can be assigned (Deck's own rule).
call "$QA1" GET "$DECK/boards/$board/stacks" >/dev/null
stack="$(jq -r '[.[]? | select(.title == "QA t6b")][0].id // empty' "$T_OUT/r")"
if [ -z "$stack" ]; then
	json "$QA1" POST "$DECK/boards/$board/stacks" '{"title":"QA t6b","order":0}' >/dev/null
	stack="$(jq -r '.id // empty' "$T_OUT/r")"
fi
call "$QA1" GET "$DECK/boards/$board/stacks/$stack" >/dev/null
card="$(jq -r '[.cards[]? | select(.title == "QA t6b card")][0].id // empty' "$T_OUT/r")"
if [ -z "$card" ]; then
	json "$QA1" POST "$DECK/boards/$board/stacks/$stack/cards" '{"title":"QA t6b card","type":"plain","order":0}' >/dev/null
	card="$(jq -r '.id // empty' "$T_OUT/r")"
fi
check "card people: $QA3 (org B) is refused" yes \
	"$(code="$(json "$QA1" PUT "$DECK/boards/$board/stacks/$stack/cards/$card/assignUser" "$(jq -cn --arg u "$QA3" '{userId: $u}')")"; [[ "$code" =~ ^40[03]$ ]] && echo yes || echo "no ($code)")"
# Imports name people and groups that Deck writes as they are (BoardImportService). The config must
# be a JSON object for Deck ({} arrives as an empty list, which its schema refuses with 409).
import_json() { # acl-type participant
	jq -cn --arg o "$QA1" --argjson t "$1" --arg p "$2" '{system: "DeckJson", config: {owner: $o}, data: {boards: [{title: "QA t6b import", owner: $o,
		color: "2563eb", archived: false, deletedAt: 0, lastModified: 0, labels: [], stacks: [],
		acl: [{type: $t, participant: {primaryKey: $p, uid: $p, type: $t}, permissionEdit: false, permissionShare: false, permissionManage: false}]}]}}'
}
imports() { call "$1" GET "$DECK/boards" >/dev/null; jq -r '[.[]? | select(.title == "QA t6b import")] | length' "$T_OUT/r"; }
before="$(imports "$QA3")"
check "board import shared with $QA3 (org B) -> 403" yes "$(refused "$(json "$QA1" POST "$DECK/boards/import" "$(import_json 0 "$QA3")")")"
check "board import shared with the group org:$ORG_B -> 403" yes "$(refused "$(json "$QA1" POST "$DECK/boards/import" "$(import_json 1 "org:$ORG_B")")")"
check "board import mapping an account to $QA3 (uidRelation) -> 403" yes \
	"$(refused "$(json "$QA1" POST "$DECK/boards/import" "$(import_json 0 someone | jq -c --arg u "$QA3" '.config.uidRelation = {someone: $u}')")")"
check "board upload (the web import) shared with $QA3 -> 403" yes \
	"$(refused "$(import_json 0 "$QA3" | jq -c .data | call "$QA1" POST "$WEB/apps/deck/boards/import" -F 'file=@-;filename=board.json;type=application/json')")"
card_import() { # field-of-the-card json -> an import with one list and one card holding it
	import_json 0 "$QA1" | jq -c --argjson f "$1" '.data.boards[0].stacks = [{id: 1, title: "QA t6b", order: 0, lastModified: 0,
		cards: [{id: 1, title: "QA t6b card", description: "", lastModified: 0, lastEditor: null, createdAt: 0, archived: false,
			order: 0, duedate: null} + $f]}]'
}
check "board import with a card for $QA3 (org B) -> 403" yes \
	"$(refused "$(json "$QA1" POST "$DECK/boards/import" "$(card_import "$(jq -cn --arg u "$QA3" '{assignedUsers: [{participant: {primaryKey: $u, uid: $u, type: 0}}]}')")")")"
check "board import with a comment by $QA3 (org B) -> 403" yes \
	"$(refused "$(json "$QA1" POST "$DECK/boards/import" "$(card_import "$(jq -cn --arg u "$QA3" '{comments: [{id: 1, actorType: "users", actorId: $u, message: "QA t6b", creationDateTime: "2026-10-25T12:00:00+00:00"}]}')")")")"
check "board imports: $QA3 got no board from those tries" "$before" "$(imports "$QA3")"
if [ "$(boards_of "$QA1" "QA t6b import (same organisation)")" = "" ]; then
	check "board import shared with $QA2 (org A) -> 200" 200 \
		"$(json "$QA1" POST "$DECK/boards/import" "$(import_json 0 "$QA2" | jq -c '.data.boards[0].title = "QA t6b import (same organisation)"')")"
fi

# --- NoDrive: asking someone to take over one's files ---
transfer_files() { json "$QA1" POST "$OCS/apps/files/api/v1/transferownership" "$(jq -cn --arg r "$1" '{recipient: $r, path: "/qa-t6b-privacy/transfer-me.txt"}')"; }
notifications_from() { # uid app -> the notifications of that app for that person
	call "$1" GET "$OCS/apps/notifications/api/v2/notifications" >/dev/null
	jq -r --arg a "$2" '[.ocs.data[]? | select(.app == $a)] | length' "$T_OUT/r"
}
before="$(notifications_from "$QA3" files)"
check "file ownership transfer to $QA3 (org B) -> 403" yes "$(refused "$(transfer_files "$QA3")")"
check "file ownership transfer to an id that does not exist -> 403" yes "$(refused "$(transfer_files "$NOBODY")")"
check "$QA3 got no transfer request from those tries" "$before" "$(notifications_from "$QA3" files)"
if [ "$(notifications_from "$QA2" files)" = 0 ]; then
	check "file ownership transfer to $QA2 (org A) -> 200 (asked, not accepted)" 200 "$(transfer_files "$QA2")"
fi

# --- Photos: album collaborators ---
collaborators() { # -> the album's collaborators as JSON [{id, type}]
	xml "$QA1" PROPFIND "$ALBUM" 0 '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:prop><nc:collaborators/></d:prop></d:propfind>' >/dev/null
	python3 -I - "$T_OUT/r" <<'PY'
import json, sys, xml.etree.ElementTree as ET
ns = {"d": "DAV:", "nc": "http://nextcloud.org/ns"}
out = []
for c in ET.parse(sys.argv[1]).getroot().iter("{http://nextcloud.org/ns}collaborator"):
	# Photos writes id, label and type without a namespace.
	out.append({"id": c.findtext("id") or c.findtext("nc:id", "", ns), "type": int(c.findtext("type") or c.findtext("nc:type", "0", ns) or 0)})
print(json.dumps(out))
PY
}
set_collaborators() { # json-list (Photos replaces the whole list with it)
	xml "$QA1" PROPPATCH "$ALBUM" 0 "<?xml version=\"1.0\"?><d:propertyupdate xmlns:d=\"DAV:\" xmlns:nc=\"http://nextcloud.org/ns\"><d:set><d:prop><nc:collaborators>$1</nc:collaborators></d:prop></d:set></d:propertyupdate>"
}
# The first of "QA t6b privacy", "QA t6b privacy 2", ... that has nobody of org B.
for ALBUM_NAME in "QA t6b privacy" "QA t6b privacy 2" "QA t6b privacy 3" "QA t6b privacy 4"; do
	ALBUM="$DAV_BASE/photos/$QA1/albums/$(uri "$ALBUM_NAME")"
	code="$(call "$QA1" MKCOL "$ALBUM")"
	current="$(collaborators)"
	if ! jq -e --arg p "$QA3" --arg g "org:$ORG_B" 'any(.id == $p or .id == $g)' <<<"$current" >/dev/null; then break; fi
done
check "$QA1 has the album \"$ALBUM_NAME\" (201 new, 405 there)" yes "$([[ "$code" =~ ^(201|405)$ ]] && echo yes || echo "no ($code)")"
if ! jq -e --arg u "$QA2" 'any(.id == $u and .type == 0)' <<<"$current" >/dev/null; then
	code="$(set_collaborators "$(jq -c --arg u "$QA2" '. + [{id: $u, type: 0}]' <<<"$current")")"
	check "album shared with $QA2 (org A) -> 207, accepted" "207 no" "$code $(grep -q 'HTTP/1.1 [45]' "$T_OUT/r" && echo yes || echo no)"
	current="$(collaborators)"
fi
check "album shared with $QA3 (org B) -> 403" yes "$(refused "$(set_collaborators "$(jq -c --arg u "$QA3" '. + [{id: $u, type: 0}]' <<<"$current")")")"
check "album shared with the group org:$ORG_B -> 403" yes "$(refused "$(set_collaborators "$(jq -c --arg g "org:$ORG_B" '. + [{id: $g, type: 1}]' <<<"$current")")")"
check "the album's collaborators are as before those tries" "$current" "$(collaborators)"

# --- Team folders: a lead's advanced permissions ---
# The first of qa-t6b-acl, qa-t6b-acl-2, ... whose rules name nobody of org B (an earlier leak's
# rules are kept, and a rule the folder has is not checked again).
for ACL_NAME in qa-t6b-acl qa-t6b-acl-2 qa-t6b-acl-3 qa-t6b-acl-4; do
	ACL_DIR="$DAV_BASE/files/$QA1/$(uri "$QA_FOLDER")/$ACL_NAME"
	call "$QA1" MKCOL "$ACL_DIR" >/dev/null
	call "$QA1" PROPFIND "$ACL_DIR" -H 'Depth: 0' --data-binary '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:prop><nc:acl-list/></d:prop></d:propfind>' >/dev/null
	if ! grep -qE "<nc:acl-mapping-id>($QA3|org:$ORG_B)<" "$T_OUT/r"; then break; fi
done
log "team folder rules are tried on $ACL_NAME"
acl_rules() { # -> the folder's own rules, as <nc:acl> elements
	xml "$QA1" PROPFIND "$ACL_DIR" 0 '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:prop><nc:acl-list/></d:prop></d:propfind>' >/dev/null
	python3 -I - "$T_OUT/r" <<'PY'
import sys, xml.etree.ElementTree as ET
n = "{http://nextcloud.org/ns}"
for acl in ET.parse(sys.argv[1]).getroot().iter(n + "acl"):
	f = {k: acl.findtext(n + k, "") for k in ("acl-mapping-type", "acl-mapping-id", "acl-mask", "acl-permissions")}
	print("<nc:acl>" + "".join("<nc:%s>%s</nc:%s>" % (k, v, k) for k, v in f.items()) + "</nc:acl>", end="")
PY
}
acl_rule() { printf '<nc:acl><nc:acl-mapping-type>%s</nc:acl-mapping-type><nc:acl-mapping-id>%s</nc:acl-mapping-id><nc:acl-mask>1</nc:acl-mask><nc:acl-permissions>1</nc:acl-permissions></nc:acl>' "$1" "$2"; }
set_rules() {
	xml "$QA1" PROPPATCH "$ACL_DIR" 0 "<?xml version=\"1.0\"?><d:propertyupdate xmlns:d=\"DAV:\" xmlns:nc=\"http://nextcloud.org/ns\"><d:set><d:prop><nc:acl-list>$1</nc:acl-list></d:prop></d:set></d:propertyupdate>"
}
rules="$(acl_rules)"
if [[ "$rules" != *"<nc:acl-mapping-id>$QA2<"* ]]; then
	code="$(set_rules "$rules$(acl_rule user "$QA2")")"
	check "team folder rule for $QA2 (org A) -> 207, accepted" "207 no" "$code $(grep -q 'HTTP/1.1 [45]' "$T_OUT/r" && echo yes || echo no)"
	rules="$(acl_rules)"
fi
check "team folder rule for $QA3 (org B) -> 403" yes "$(refused "$(set_rules "$rules$(acl_rule user "$QA3")")")"
check "team folder rule for the group org:$ORG_B -> 403" yes "$(refused "$(set_rules "$rules$(acl_rule group "org:$ORG_B")")")"
check "the folder's rules are as before those tries" "$rules" "$(acl_rules)"

# --- NoTasks (a task list is a calendar) and NoCalendar invitations ---
TASKS="$DAV_BASE/calendars/$QA1/qa-t6b-tasks/"
code="$(xml "$QA1" MKCALENDAR "$TASKS" 0 '<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>QA t6b tasks</d:displayname><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>')"
check "$QA1 has a task list (201 new, 405 there)" yes "$([[ "$code" =~ ^(201|405)$ ]] && echo yes || echo "no ($code)")"
dav_share() { # href
	xml "$QA1" POST "$TASKS" 0 "<?xml version=\"1.0\" encoding=\"utf-8\"?><o:share xmlns:d=\"DAV:\" xmlns:o=\"http://owncloud.org/ns\"><o:set><d:href>$1</d:href></o:set></o:share>"
}
check "task list shared with $QA3 (org B) -> 403" 403 "$(dav_share "principal:principals/users/$QA3")"
check "task list shared with $QA3 by email -> 403" 403 "$(dav_share "mailto:$QA3@example.invalid")"
check "task list shared with $QA2 (org A) -> 200" 200 "$(dav_share "principal:principals/users/$QA2")"
# An invitation to someone of another organisation is an email invitation (to their address),
# never a delivery to their calendar.
EVENTS="$DAV_BASE/calendars/$QA1/qa-t6b-events/"
code="$(xml "$QA1" MKCALENDAR "$EVENTS" 0 '<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>QA t6b events</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>')"
check "$QA1 has a calendar (201 new, 405 there)" yes "$([[ "$code" =~ ^(201|405)$ ]] && echo yes || echo "no ($code)")"
uid="qa-t6b-invite-$(date -u +%Y%m%d)"
check "$QA1 saves an event that invites $QA3 (201 or 204)" yes "$(code="$(printf 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Nourax//privacy-apps//EN\r\nBEGIN:VEVENT\r\nUID:%s\r\nDTSTAMP:%s\r\nDTSTART:%s\r\nDTEND:%s\r\nSUMMARY:QA t6b invitation\r\nORGANIZER:mailto:%s@example.invalid\r\nATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:%s@example.invalid\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n' \
	"$uid" "$(date -u +%Y%m%dT%H%M%SZ)" "$(date -u -d '+2 days' +%Y%m%dT100000Z)" "$(date -u -d '+2 days' +%Y%m%dT110000Z)" "$QA1" "$QA3" |
	call "$QA1" PUT "$EVENTS$uid.ics" -H 'Content-Type: text/calendar; charset=utf-8' --data-binary @-)"; [[ "$code" =~ ^20[14]$ ]] && echo yes || echo "no ($code)")"
call "$QA3" PROPFIND "$DAV_BASE/calendars/$QA3/inbox/" -H 'Depth: 1' >/dev/null
check "$QA3's calendar inbox has no invitation from $QA1" yes "$(names_none "$uid")"

# --- Mentions: comments and the ONLYOFFICE editor ---
COMMENTS="$DAV_BASE/comments/files/$PROBE_ID"
call "$QA1" REPORT "$COMMENTS" -H 'Content-Type: application/xml' --data-binary '<?xml version="1.0"?><oc:filter-comments xmlns:oc="http://owncloud.org/ns"><oc:limit>100</oc:limit><oc:offset>0</oc:offset></oc:filter-comments>' >/dev/null
if ! grep -qF "@$QA3 privacy probe" "$T_OUT/r"; then
	check "$QA1 comments \"@$QA3\" on its own file -> 201" 201 \
		"$(json "$QA1" POST "$COMMENTS" "$(jq -cn --arg m "@$QA3 privacy probe" '{actorType: "users", verb: "comment", message: $m, objectType: "files"}')")"
fi
call "$QA1" REPORT "$COMMENTS" -H 'Content-Type: application/xml' --data-binary '<?xml version="1.0"?><oc:filter-comments xmlns:oc="http://owncloud.org/ns"><oc:limit>100</oc:limit><oc:offset>0</oc:offset></oc:filter-comments>' >/dev/null
check "the comment shows no name for @$QA3" yes "$(names_none "QA t6b 3")"
# The search box and the activity stream show a comment as its author wrote it; how they name
# the people in it is in docs/teams.md "Known limits".
call "$QA1" GET "$OCS/apps/activity/api/v2/activity/all?limit=50" >/dev/null
log "$QA1's own activity names @$QA3 by name: $(grep -qF "QA t6b 3" "$T_OUT/r" && echo yes || echo no) (an id the author typed; see Known limits)"
check "$QA3 got no mention notification" 0 "$(notifications_from "$QA3" comments)"
before="$(notifications_from "$QA3" onlyoffice)"
json "$QA1" POST "$WEB/apps/onlyoffice/ajax/mention" "$(jq -cn --argjson f "$PROBE_ID" --arg e "$QA3@example.invalid" '{fileId: $f, anchor: "{}", comment: ("+" + $e + " privacy probe"), emails: [$e]}')" >/dev/null
check "ONLYOFFICE mention of $QA3: no notification" "$before" "$(notifications_from "$QA3" onlyoffice)"
call "$QA1" GET "$OCS/apps/files_sharing/api/v1/shares?path=/qa-t6b-privacy/probe.txt" >/dev/null
check "ONLYOFFICE mention of $QA3: the file is not shared with $QA3" yes "$(yes_no jq -e --arg u "$QA3" '[.ocs.data[]? | select(.share_with == $u)] | length == 0' "$T_OUT/r")"
call "$QA3" GET "$WEB/apps/notes/api/v1/notes" >/dev/null
check "$QA3's notes: none of org A's" yes "$(names_none "$QA1" "QA t6b 4")"

finish privacy-apps
