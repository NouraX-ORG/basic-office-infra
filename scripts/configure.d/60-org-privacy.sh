# Privacy between organisations: people find, autocomplete and share only with people of their
# own organisation (the org:{org_id} group the admin API keeps), never across organisations.
# See docs/teams.md "Privacy between organisations".
#
# These are server-wide switches: sharing between two accounts with no organisation or team in
# common stops, also for accounts in no organisation (being in "admin" together never counts).
# So this step is OFF until it is switched on once, on purpose:
#   sudo bash -c '. scripts/lib.sh; load_env; ORG_PRIVACY=on . scripts/configure.d/60-org-privacy.sh'
# From then on every scripts/configure.sh run keeps it on: the switch is stored in the app
# setting nourax_api org_privacy_step. To undo it (the server's defaults come back, and the
# federation and circles apps are enabled again, as they were on 2026-10-25):
#   sudo bash -c '. scripts/lib.sh; load_env; ORG_PRIVACY=off . scripts/configure.d/60-org-privacy.sh'
#
# Sourced by scripts/configure.sh with its helpers (occ, dc, log, secret_path, have_secret).
# Safe to run again. Nothing needs a restart: every setting is read on the next request.
# SPDX-License-Identifier: AGPL-3.0-or-later

log "Org privacy: find and share only within one's own organisation"

# Sets an app setting only when it differs, so a second run changes nothing.
org_privacy_set() { # app key value
	if [ "$(occ config:app:get "$1" "$2" 2>/dev/null || true)" != "$3" ]; then
		occ config:app:set "$1" "$2" --value="$3" >/dev/null
		log "  $1 $2 = $3"
	fi
}

# Enables or disables an app only when needed.
org_privacy_app() { # enable|disable app
	local enabled
	enabled="$(occ app:list --output=json | jq -r --arg a "$2" 'if .enabled[$a] != null then "yes" else "no" end')"
	if [ "$1" = disable ] && [ "$enabled" = yes ]; then
		occ app:disable "$2"
	elif [ "$1" = enable ] && [ "$enabled" = no ]; then
		occ app:enable "$2"
	else
		log "  $2 already ${1}d"
	fi
}

org_privacy_step="$(occ config:app:get nourax_api org_privacy_step 2>/dev/null || true)"
case "${ORG_PRIVACY:-}" in
on | off) org_privacy_step="$ORG_PRIVACY" ;;
"") ;;
*) die "ORG_PRIVACY must be on or off, not '${ORG_PRIVACY}'" ;;
esac

if [ "$org_privacy_step" = on ]; then
	# Sharing: only with people who share a group (an organisation or a team) and only with
	# one's own groups. "admin" holds the owner and the emergency admin; being in it together
	# never counts.
	org_privacy_set core shareapi_only_share_with_group_members yes
	org_privacy_set core shareapi_only_share_with_group_members_exclude_group_list '["admin"]'
	# Finding people (share dialog, autocomplete, @-mentions, calendar invitees, the contacts
	# menu): suggestions come from one's own groups only ...
	org_privacy_set core shareapi_allow_share_dialog_user_enumeration yes
	org_privacy_set core shareapi_restrict_user_enumeration_to_group yes
	org_privacy_set core shareapi_restrict_user_enumeration_to_phone no
	# ... and typing someone's exact name, email address or account id from another
	# organisation finds nobody either.
	org_privacy_set core shareapi_restrict_user_enumeration_full_match no
	org_privacy_set core shareapi_restrict_user_enumeration_full_match_user_id no
	org_privacy_set core shareapi_restrict_user_enumeration_full_match_email no
	org_privacy_set core shareapi_restrict_user_enumeration_full_match_displayname no

	# No shares with or from other servers, and no public lookup directory. (The keys live in
	# the files_sharing app; the federatedfilesharing app reads them there.) There were no
	# federated shares and no trusted servers on 2026-10-25.
	org_privacy_set files_sharing outgoing_server2server_share_enabled no
	org_privacy_set files_sharing incoming_server2server_share_enabled no
	org_privacy_set files_sharing outgoing_server2server_group_share_enabled no
	org_privacy_set files_sharing incoming_server2server_group_share_enabled no
	org_privacy_set files_sharing lookupServerEnabled no
	org_privacy_set files_sharing lookupServerUploadEnabled no

	# The "Accounts" address book of every account on the server is not offered to anyone; each
	# organisation has its own directory (docs/teams.md).
	# (A boolean setting reads back as 0 or 1.)
	case "$(occ config:app:get dav system_addressbook_exposed 2>/dev/null || true)" in
	0 | false) ;;
	*)
		occ config:app:set dav system_addressbook_exposed --type=boolean --value=false >/dev/null
		log "  dav system_addressbook_exposed = false"
		;;
	esac
	# No public profile pages (/u/<uid>).
	if [ "$(occ config:system:get profile.enabled 2>/dev/null || true)" != false ]; then
		occ config:system:set profile.enabled --type=boolean --value=false >/dev/null
		log "  profile.enabled = false"
	fi

	# Trusted servers (federation) are not used. The Teams app (circles) lets anyone add any
	# account to a team and finds every account on the server, whatever the settings above say
	# (tested on 2026-10-25), so it is off too; team folders, boards and the team address books
	# do not need it.
	org_privacy_app disable federation
	org_privacy_app disable circles

	org_privacy_set nourax_api org_privacy_step on
	log "  org privacy: on (nourax_api: $(occ nourax_api:status | jq -r .org_privacy))"
elif [ "$org_privacy_step" = off ] && [ "${ORG_PRIVACY:-}" = off ]; then
	# Undo: the server's own defaults.
	org_privacy_set core shareapi_only_share_with_group_members no
	org_privacy_set core shareapi_only_share_with_group_members_exclude_group_list '[]'
	org_privacy_set core shareapi_allow_share_dialog_user_enumeration yes
	org_privacy_set core shareapi_restrict_user_enumeration_to_group no
	org_privacy_set core shareapi_restrict_user_enumeration_to_phone no
	org_privacy_set core shareapi_restrict_user_enumeration_full_match yes
	org_privacy_set core shareapi_restrict_user_enumeration_full_match_user_id yes
	org_privacy_set core shareapi_restrict_user_enumeration_full_match_email yes
	org_privacy_set core shareapi_restrict_user_enumeration_full_match_displayname yes
	org_privacy_set files_sharing outgoing_server2server_share_enabled yes
	org_privacy_set files_sharing incoming_server2server_share_enabled yes
	org_privacy_set files_sharing outgoing_server2server_group_share_enabled no
	org_privacy_set files_sharing incoming_server2server_group_share_enabled no
	org_privacy_set files_sharing lookupServerEnabled no
	org_privacy_set files_sharing lookupServerUploadEnabled no
	occ config:app:set dav system_addressbook_exposed --type=boolean --value=true >/dev/null
	occ config:system:set profile.enabled --type=boolean --value=true >/dev/null
	org_privacy_app enable federation
	org_privacy_app enable circles
	org_privacy_set nourax_api org_privacy_step off
	log "  org privacy: off (undone; nourax_api: $(occ nourax_api:status | jq -r .org_privacy))"
else
	log "  org privacy is not switched on - see the top of $(basename "${BASH_SOURCE[0]}") to switch it on"
fi

unset org_privacy_step
unset -f org_privacy_set org_privacy_app
