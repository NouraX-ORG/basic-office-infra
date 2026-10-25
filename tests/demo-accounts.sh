#!/usr/bin/env bash
# The owner's kept demo data (docs/teams.md#demo-accounts): two organisations, four teams of seven
# and 24 people, made through the admin API and signed with the admin key, exactly as NoMail would
# call it. KEPT: nothing disables or deletes these accounts, and no task may change them.
# Run it on the server:
#   sudo tests/demo-accounts.sh           make what is missing, put back what changed, then check
#   sudo tests/demo-accounts.sh --check   read only: check everything, change nothing
#
#   Demo Alpha (demo-alpha): Sales (demo-alpha-sales) = demo-a01..a07,
#                            Engineering (demo-alpha-engineering) = demo-a06..a12
#   Demo Beta (demo-beta):   Marketing (demo-beta-marketing) = demo-b01..b07,
#                            Support (demo-beta-support) = demo-b06..b12
# So a06, a07, b06 and b07 are in both teams of their organisation. The leads are a01 (Sales),
# a08 (Engineering), b01 (Marketing) and b08 (Support). Emails end in .invalid.
#
# Sign-in keys: every person gets one app password "Demo sign-in" (occ user:auth-tokens:add). The
# keys are written only to /etc/nourax/demo/demo-accounts.txt (root, folder 0700, file 0600), one
# line per person, no header:
#   uid TAB display name TAB organisation TAB teams ("Sales" or "Sales, Engineering") TAB key
# A key from that file that still signs in (WebDAV PROPFIND 207) is kept. A new key is made only
# when the file has none for that person or the server answers 401 to it. Each new key goes into
# the file at once. If a person ends up with more than one "Demo sign-in" app password (a run that
# stopped half way), the run says so and deletes nothing: removing one needs the owner's yes.
#
# Demo files, written over WebDAV by each team's lead only when they are missing, so the owner's
# changes are kept: "Welcome to <team>.md" and "<team> plan.docx" (made here with python3's
# zipfile) in each team folder, and "Ben's notes for George.md" in Ben's (demo-a02, Sales) own
# files, shared read-only with George (demo-a09, Engineering): same organisation, another team.
#
# It takes the server-change lock (not with --check). It deletes nothing and never prints a key;
# the netrc files curl reads the keys from live only in the test's own temporary folder.
# Exit 0 when every check passes.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_admin_key

MODE=make
case "${1-}" in
"") ;;
--check) MODE=check ;;
*) die "usage: sudo tests/demo-accounts.sh [--check]" ;;
esac

DEMO_DIR=/etc/nourax/demo
KEYS_FILE="$DEMO_DIR/demo-accounts.txt"
KEY_NAME="Demo sign-in"
OCS="https://${DRIVE_HOST}/ocs/v2.php"
SHARE_OWNER=demo-a02
SHARE_WITH=demo-a09
SHARE_FILE="Ben's notes for George.md"

# --- The data ------------------------------------------------------------------------------------

declare -A ORG_NAME=([demo-alpha]="Demo Alpha" [demo-beta]="Demo Beta")
ORG_IDS=(demo-alpha demo-beta)
# team id -> organisation, name, lead
TEAM_IDS=(demo-alpha-sales demo-alpha-engineering demo-beta-marketing demo-beta-support)
declare -A TEAM_ORG=([demo-alpha-sales]=demo-alpha [demo-alpha-engineering]=demo-alpha
	[demo-beta-marketing]=demo-beta [demo-beta-support]=demo-beta)
declare -A TEAM_NAME=([demo-alpha-sales]=Sales [demo-alpha-engineering]=Engineering
	[demo-beta-marketing]=Marketing [demo-beta-support]=Support)
declare -A TEAM_LEAD=([demo-alpha-sales]=demo-a01 [demo-alpha-engineering]=demo-a08
	[demo-beta-marketing]=demo-b01 [demo-beta-support]=demo-b08)
# uid first-name team-id...
PEOPLE_TABLE='
demo-a01 Amina  demo-alpha-sales
demo-a02 Ben    demo-alpha-sales
demo-a03 Chloe  demo-alpha-sales
demo-a04 Daniel demo-alpha-sales
demo-a05 Elif   demo-alpha-sales
demo-a06 Omar   demo-alpha-sales demo-alpha-engineering
demo-a07 Priya  demo-alpha-sales demo-alpha-engineering
demo-a08 Farah  demo-alpha-engineering
demo-a09 George demo-alpha-engineering
demo-a10 Hana   demo-alpha-engineering
demo-a11 Ivan   demo-alpha-engineering
demo-a12 Jade   demo-alpha-engineering
demo-b01 Karim  demo-beta-marketing
demo-b02 Lena   demo-beta-marketing
demo-b03 Mateo  demo-beta-marketing
demo-b04 Nadia  demo-beta-marketing
demo-b05 Oscar  demo-beta-marketing
demo-b06 Rania  demo-beta-marketing demo-beta-support
demo-b07 Sami   demo-beta-marketing demo-beta-support
demo-b08 Tara   demo-beta-support
demo-b09 Umar   demo-beta-support
demo-b10 Vera   demo-beta-support
demo-b11 Wes    demo-beta-support
demo-b12 Yusuf  demo-beta-support
'
UIDS=()
declare -A FIRST=() P_TEAMS=() P_ORG=()
while read -r uid first teams; do
	[ -n "$uid" ] || continue
	UIDS+=("$uid")
	FIRST[$uid]="$first"
	P_TEAMS[$uid]="$teams"
	P_ORG[$uid]="${TEAM_ORG[${teams%% *}]}"
done <<<"$PEOPLE_TABLE"
[ "${#UIDS[@]}" -eq 24 ] || die "the people table has ${#UIDS[@]} rows, not 24"

display_name() { # uid -> "Omar (Sales + Engineering)"
	local out="" t
	for t in ${P_TEAMS[$1]}; do out+="${out:+ + }${TEAM_NAME[$t]}"; done
	printf '%s (%s)' "${FIRST[$1]}" "$out"
}
team_names() { # uid -> "Sales, Engineering"
	local out="" t
	for t in ${P_TEAMS[$1]}; do out+="${out:+, }${TEAM_NAME[$t]}"; done
	printf '%s' "$out"
}
email_of() { printf '%s@%s.invalid' "$1" "${P_ORG[$1]}"; }
members_of() { # team-id -> uids, one per line
	local uid
	for uid in "${UIDS[@]}"; do
		case " ${P_TEAMS[$uid]} " in *" $1 "*) printf '%s\n' "$uid" ;; esac
	done
}

# --- Helpers -------------------------------------------------------------------------------------

# The stored version at a status path, or 1 when it is not there yet (an equal version runs every
# step again, so the numbers do not keep growing).
version_or_1() { # path jq-path
	local status
	status="$(admin_api GET "$1")"
	case "$status" in
	200) jq -r "$2" "$T_OUT/body" ;;
	404) echo 1 ;;
	*) die "GET $1 answered $status" ;;
	esac
}

# Checks the last PUT answer: 200, ok, applied, no failed step.
put_ok() { # label status
	check "$1 -> 200" 200 "$2"
	check "$1: ok, applied, no failed step" "true true yes" \
		"$(jq -r '"\(.ok) \(.applied)"' "$T_OUT/body") $(no_failed_steps)"
}

declare -A KEY=()
netrc_of() { printf '%s/%s.netrc' "$T_OUT" "$1"; }
write_netrc() { # uid (the key comes from KEY, never from an argument)
	(umask 077 && printf 'machine %s login %s password %s\n' "$DRIVE_HOST" "$1" "${KEY[$1]}" > "$(netrc_of "$1")")
}
key_status() { # uid -> the HTTP status of a PROPFIND of the person's home with their key
	write_netrc "$1"
	propfind "$(netrc_of "$1")" "$1/" 0
}
demo_tokens() { # uid -> the number of "Demo sign-in" app passwords
	occ user:auth-tokens:list "$1" --output=json </dev/null | jq --arg n "$KEY_NAME" '[.[] | select(.name == $n)] | length'
}

# Writes the keys file from KEY: every person that has a key, in table order, through a new file
# that is then moved into place. Only root can read it.
save_keys() {
	local uid
	install -d -m 0700 -o root -g root "$DEMO_DIR"
	(
		umask 077
		for uid in "${UIDS[@]}"; do
			[ -n "${KEY[$uid]-}" ] || continue
			printf '%s\t%s\t%s\t%s\t%s\n' "$uid" "$(display_name "$uid")" "${ORG_NAME[${P_ORG[$uid]}]}" "$(team_names "$uid")" "${KEY[$uid]}"
		done > "$KEYS_FILE.new"
		chown root:root "$KEYS_FILE.new"
		chmod 0600 "$KEYS_FILE.new"
		mv -f "$KEYS_FILE.new" "$KEYS_FILE"
	)
}
load_keys() {
	local uid name org teams key
	[ -f "$KEYS_FILE" ] || return 0
	while IFS=$'\t' read -r uid name org teams key; do
		if [ -n "$uid" ] && [ -n "${FIRST[$uid]-}" ] && [ -n "$key" ]; then
			KEY[$uid]="$key"
		fi
	done < "$KEYS_FILE"
}

# A WebDAV address in a person's files, each part of the path encoded.
dav_of() { # uid path
	printf '%s/files/%s/%s' "$DAV_BASE" "$1" "$(jq -rn --arg p "$2" '$p | split("/") | map(@uri) | join("/")')"
}
# HEAD of a path in a person's files with their key. Prints the HTTP status.
dav_head() { # uid path
	curl -sS -I --netrc-file "$(netrc_of "$1")" -o /dev/null -w '%{http_code}' "$(dav_of "$1" "$2")"
}
# PUT of a local file to a path in a person's files, only when the path is missing.
put_if_missing() { # label uid path local-file content-type
	local status
	status="$(dav_head "$2" "$3")"
	if [ "$status" = 404 ]; then
		check "$1 written" 201 "$(curl -sS -X PUT --netrc-file "$(netrc_of "$2")" -H "Content-Type: $5" \
			--data-binary "@$4" -o /dev/null -w '%{http_code}' "$(dav_of "$2" "$3")")"
	else
		check "$1 already there, kept" 200 "$status"
	fi
}

# A minimal Word document (.docx): a title and some lines, with python3's zipfile only.
make_docx() { # out-file title line...
	python3 -I - "$@" <<'PY'
import sys
import zipfile
from xml.sax.saxutils import escape

out, title, *lines = sys.argv[1:]
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
def para(text, size=None, bold=False):
	props = ("<w:b/>" if bold else "") + ('<w:sz w:val="%d"/>' % size if size else "")
	run_props = "<w:rPr>%s</w:rPr>" % props if props else ""
	return '<w:p><w:r>%s<w:t xml:space="preserve">%s</w:t></w:r></w:p>' % (run_props, escape(text))
body = para(title, 40, True) + "".join(para(line) for line in lines)
parts = {
	"[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
		'<Default Extension="xml" ContentType="application/xml"/>'
		'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
		'</Types>',
	"_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
		'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
		'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
		'</Relationships>',
	"word/document.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
		'<w:document xmlns:w="%s"><w:body>%s<w:sectPr/></w:body></w:document>' % (W, body),
}
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as docx:
	for name, text in parts.items():
		docx.writestr(zipfile.ZipInfo(name, (2026, 10, 25, 0, 0, 0)), text.encode("utf-8"), zipfile.ZIP_DEFLATED)
PY
}

# The welcome note of a team, as Markdown.
welcome_note() { # team-id
	local team="$1" uid lead="${TEAM_LEAD[$1]}" name="${TEAM_NAME[$1]}" org="${ORG_NAME[${TEAM_ORG[$1]}]}"
	printf '# Welcome to %s\n\n' "$name"
	printf 'This is **demo data** of Nourax Workspace: the team "%s" of the organisation "%s".\n' "$name" "$org"
	printf 'Nobody here is a real person, and these accounts are kept for showing how teams work.\n\n'
	printf '## Who is in the team\n\n'
	while read -r uid; do
		if [ "$uid" = "$lead" ]; then
			printf -- '- %s, team lead\n' "$(display_name "$uid")"
		else
			printf -- '- %s\n' "$(display_name "$uid")"
		fi
	done < <(members_of "$team")
	printf '\n## What to try\n\n'
	printf -- '- Share a file from your own files and type a colleague'"'"'s name: you find the people of %s.\n' "$org"
	printf -- '- Try a name from the other demo organisation: you never find them. Privacy between organisations is on.\n'
	printf -- '- People in two teams see both team folders, calendars and boards.\n'
	printf -- '- Open "%s plan.docx" to edit it with ONLYOFFICE, together with a colleague.\n' "$name"
	printf -- '- The calendar "Team: %s" and the board "Team: %s" belong to the whole team.\n' "$name" "$name"
}

# --- 1. The id rules -----------------------------------------------------------------------------

log "id rules (tests/admin-ids.php in the app container)"
if dc exec -T app php < "$REPO_DIR/tests/admin-ids.php" > "$T_OUT/ids" 2>&1; then
	check "id rules: admin-ids.php passes" yes yes
else
	sed 's/^/  /' "$T_OUT/ids" | grep -v '^  PASS' || true
	check "id rules: admin-ids.php passes" yes no
fi

load_keys

if [ "$MODE" = make ]; then
	take_lock

	# --- 2. Organisations, teams and people, through the admin API --------------------------------
	for org in "${ORG_IDS[@]}"; do
		v="$(version_or_1 "/v1/admin/orgs/$org" .org.version)"
		put_ok "PUT org $org v$v" "$(admin_api PUT "/v1/admin/orgs/$org" "$(name_version "${ORG_NAME[$org]}" "$v")")"
	done
	for team in "${TEAM_IDS[@]}"; do
		org="${TEAM_ORG[$team]}"
		v="$(version_or_1 "/v1/admin/orgs/$org/teams/$team" .team.version)"
		put_ok "PUT team $team v$v" "$(admin_api PUT "/v1/admin/orgs/$org/teams/$team" "$(name_version "${TEAM_NAME[$team]}" "$v")")"
	done
	for uid in "${UIDS[@]}"; do
		teams_json="$(for t in ${P_TEAMS[$uid]}; do
			jq -cn --arg t "$t" --arg r "$([ "${TEAM_LEAD[$t]}" = "$uid" ] && echo lead || echo member)" '{team_id: $t, role: $r}'
		done | jq -cs .)"
		v="$(version_or_1 "/v1/admin/people/$uid" .person.version)"
		body="$(jq -cn --arg e "$(email_of "$uid")" --arg d "$(display_name "$uid")" --arg o "${P_ORG[$uid]}" \
			--argjson t "$teams_json" --argjson v "$v" \
			'{email: $e, display_name: $d, org_id: $o, teams: $t, active: true, version: $v}')"
		put_ok "PUT person $uid v$v" "$(admin_api PUT "/v1/admin/people/$uid" "$body")"
	done

	# --- 3. One "Demo sign-in" app password each --------------------------------------------------
	for uid in "${UIDS[@]}"; do
		if [ -n "${KEY[$uid]-}" ]; then
			status="$(key_status "$uid")"
			case "$status" in
			207) log "$uid: the key in $KEYS_FILE signs in, kept"; continue ;;
			401) log "$uid: the key in $KEYS_FILE is refused (401), making a new one" ;;
			*) die "$uid: PROPFIND with the stored key answered $status; not making a new key (try again later)" ;;
			esac
		fi
		key="$(occ user:auth-tokens:add --no-interaction --name "$KEY_NAME" "$uid" </dev/null | tail -n 1 | tr -d '\r')"
		[[ "$key" =~ ^[A-Za-z0-9]{72}$ ]] || die "$uid: occ user:auth-tokens:add gave no app password"
		KEY[$uid]="$key"
		unset key
		save_keys
		log "$uid: new \"$KEY_NAME\" app password made and saved in $KEYS_FILE"
	done
	save_keys

	# --- 4. Demo files and one share --------------------------------------------------------------
	for uid in "${UIDS[@]}"; do write_netrc "$uid"; done
	for team in "${TEAM_IDS[@]}"; do
		org="${TEAM_ORG[$team]}"
		lead="${TEAM_LEAD[$team]}"
		name="${TEAM_NAME[$team]}"
		status="$(admin_api GET "/v1/admin/orgs/$org/teams/$team")"
		check "GET team $team -> 200" 200 "$status"
		folder="$(jq -r '.team.folder.mount_point // empty' "$T_OUT/body")"
		[ -n "$folder" ] || die "team $team has no folder"
		welcome_note "$team" > "$T_OUT/welcome.md"
		put_if_missing "$folder/Welcome to $name.md" "$lead" "$folder/Welcome to $name.md" "$T_OUT/welcome.md" "text/markdown"
		make_docx "$T_OUT/plan.docx" "$name plan" \
			"Demo document of the team $name in ${ORG_NAME[$org]}. Everyone in the team can edit it." \
			"Goal 1: agree this plan together." \
			"Goal 2: edit this document with a colleague at the same time."
		put_if_missing "$folder/$name plan.docx" "$lead" "$folder/$name plan.docx" "$T_OUT/plan.docx" \
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	done

	printf '# Notes for George\n\nHi George, these are my notes from the Sales side. Read only: only I can change them.\n\nBen (Sales)\n' \
		> "$T_OUT/notes.md"
	put_if_missing "$SHARE_OWNER: $SHARE_FILE" "$SHARE_OWNER" "$SHARE_FILE" "$T_OUT/notes.md" "text/markdown"
	curl -sS -G --netrc-file "$(netrc_of "$SHARE_OWNER")" -H 'OCS-APIRequest: true' -H 'Accept: application/json' \
		--data-urlencode "path=/$SHARE_FILE" -o "$T_OUT/shares.json" "$OCS/apps/files_sharing/api/v1/shares"
	if [ "$(jq --arg w "$SHARE_WITH" '[.ocs.data[]? | select(.share_type == 0 and .share_with == $w)] | length' "$T_OUT/shares.json")" -gt 0 ]; then
		log "the share of \"$SHARE_FILE\" with $SHARE_WITH is already there, kept"
	else
		check "share \"$SHARE_FILE\" read-only with $SHARE_WITH -> 200" 200 "$(curl -sS -X POST \
			--netrc-file "$(netrc_of "$SHARE_OWNER")" -H 'OCS-APIRequest: true' -H 'Accept: application/json' \
			--data-urlencode "path=/$SHARE_FILE" --data-urlencode shareType=0 --data-urlencode "shareWith=$SHARE_WITH" \
			--data-urlencode permissions=1 -o "$T_OUT/share.json" -w '%{http_code}' "$OCS/apps/files_sharing/api/v1/shares")"
	fi

	# The checks below make about 30 admin calls; start them in a new minute (120 a minute at most).
	wait_next_minute
fi

# --- 5. Checks (both modes; reading only) --------------------------------------------------------

for uid in "${UIDS[@]}"; do
	if [ -n "${KEY[$uid]-}" ]; then write_netrc "$uid"; fi
done

for org in "${ORG_IDS[@]}"; do
	check "GET org $org -> 200" 200 "$(admin_api GET "/v1/admin/orgs/$org")"
	check "$org: name, group with 12 members" "${ORG_NAME[$org]} true 12" \
		"$(jq -r '"\(.org.name) \(.org.group.exists) \(.org.group.members)"' "$T_OUT/body")"
done
for team in "${TEAM_IDS[@]}"; do
	lead="${TEAM_LEAD[$team]}"
	check "GET team $team -> 200" 200 "$(admin_api GET "/v1/admin/orgs/${TEAM_ORG[$team]}/teams/$team")"
	check "$team: name, not archived, 7 members" "${TEAM_NAME[$team]} false 7" \
		"$(jq -r '"\(.team.name) \(.team.archived) \(.team.group.members)"' "$T_OUT/body")"
	check "$team: folder lead $lead" "[\"$lead\"]" "$(jq -c '.team.folder.leads' "$T_OUT/body")"
	check "$team: board lead $lead" "[\"$lead\"]" "$(jq -c '.team.board.leads' "$T_OUT/body")"
done

for uid in "${UIDS[@]}"; do
	want_groups="$( { echo "org:${P_ORG[$uid]}"; for t in ${P_TEAMS[$uid]}; do echo "team:$t"; done; } | sort | jq -Rsc 'split("\n") | map(select(. != ""))')"
	occ user:info "$uid" --output=json </dev/null > "$T_OUT/info.json" 2>/dev/null || echo '{}' > "$T_OUT/info.json"
	check "$uid: enabled, user_oidc, name, email" "true user_oidc $(display_name "$uid") $(email_of "$uid")" \
		"$(jq -r '"\(.enabled) \(.backend) \(.display_name) \(.email)"' "$T_OUT/info.json")"
	check "$uid: groups" "$want_groups" \
		"$(jq -c '[.groups[]? | select(startswith("org:") or startswith("team:"))] | sort' "$T_OUT/info.json")"
	check "GET person $uid -> 200" 200 "$(admin_api GET "/v1/admin/people/$uid")"
	check "$uid: active, in sync, no drift" "true true []" \
		"$(jq -r '"\(.person.active) \(.person.in_sync) \(.person.drift | tostring)"' "$T_OUT/body")"
	if [ -n "${KEY[$uid]-}" ]; then
		check "$uid: the key signs in (PROPFIND 207)" 207 "$(propfind "$(netrc_of "$uid")" "$uid/" 0)"
	else
		check "$uid: has a key in $KEYS_FILE" yes no
	fi
	n="$(demo_tokens "$uid")"
	if [ "$n" -gt 1 ]; then
		log "WARN $uid has $n \"$KEY_NAME\" app passwords (a run stopped half way); only the one in $KEYS_FILE is used. Removing the others needs the owner's yes."
	fi
	check "$uid: has a \"$KEY_NAME\" app password" yes "$([ "$n" -ge 1 ] && echo yes || echo no)"
done

# The keys file: 24 lines of 5 fields, each key 72 letters and digits; only root can read it.
check "$KEYS_FILE: owner, group and mode" "root root 600" "$(stat -c '%U %G %a' "$KEYS_FILE" 2>/dev/null || echo missing)"
check "$DEMO_DIR: owner and mode" "root 700" "$(stat -c '%U %a' "$DEMO_DIR" 2>/dev/null || echo missing)"
check "$KEYS_FILE: 24 lines of 5 fields with a 72-character key" "24 24" \
	"$(awk -F'\t' 'END { print NR, ok + 0 } NF == 5 && $5 ~ /^[A-Za-z0-9]+$/ && length($5) == 72 { ok++ }' "$KEYS_FILE" 2>/dev/null || echo missing)"
check "$KEYS_FILE: uid, name, organisation and teams as in the table" yes "$(
	ok=yes
	while IFS=$'\t' read -r uid name org teams _; do
		[ -n "${FIRST[$uid]-}" ] && [ "$name" = "$(display_name "$uid")" ] && [ "$org" = "${ORG_NAME[${P_ORG[$uid]}]}" ] \
			&& [ "$teams" = "$(team_names "$uid")" ] || ok=no
	done < "$KEYS_FILE"
	echo "$ok")"

# The demo files and the share.
for team in "${TEAM_IDS[@]}"; do
	lead="${TEAM_LEAD[$team]}"
	name="${TEAM_NAME[$team]}"
	admin_api GET "/v1/admin/orgs/${TEAM_ORG[$team]}/teams/$team" >/dev/null
	folder="$(jq -r '.team.folder.mount_point // "-"' "$T_OUT/body")"
	check "$folder/Welcome to $name.md is there" 200 "$(dav_head "$lead" "$folder/Welcome to $name.md")"
	check "$folder/$name plan.docx is there" 200 "$(dav_head "$lead" "$folder/$name plan.docx")"
done
check "$SHARE_WITH sees \"$SHARE_FILE\"" 200 "$(dav_head "$SHARE_WITH" "$SHARE_FILE")"
curl -sS -G --netrc-file "$(netrc_of "$SHARE_OWNER")" -H 'OCS-APIRequest: true' -H 'Accept: application/json' \
	--data-urlencode "path=/$SHARE_FILE" -o "$T_OUT/shares.json" "$OCS/apps/files_sharing/api/v1/shares"
check "$SHARE_OWNER shares \"$SHARE_FILE\" read-only with $SHARE_WITH" 1 \
	"$(jq --arg w "$SHARE_WITH" '[.ocs.data[]? | select(.share_type == 0 and .share_with == $w and .permissions == 1)] | length' "$T_OUT/shares.json")"

# A first look at privacy (the full sweep is tests/privacy-apps.sh): Amina finds Omar of her own
# organisation, and nobody of Demo Beta.
sharees() { # uid search -> the uids the share dialog offers
	curl -sS -G --netrc-file "$(netrc_of "$1")" -H 'OCS-APIRequest: true' -H 'Accept: application/json' \
		--data-urlencode "search=$2" --data-urlencode itemType=file --data-urlencode perPage=50 \
		"$OCS/apps/files_sharing/api/v1/sharees" \
		| jq -r '[.ocs.data.exact.users[]?, .ocs.data.users[]?] | map(.value.shareWith) | unique | join(" ")'
}
check "demo-a01 finds Omar (demo-a06) of Demo Alpha" demo-a06 "$(sharees demo-a01 Omar)"
check "demo-a01 finds nobody of Demo Beta (Karim)" "" "$(sharees demo-a01 Karim)"
check "demo-b01 finds nobody of Demo Alpha (Amina)" "" "$(sharees demo-b01 Amina)"

finish "demo-accounts ($MODE)"
