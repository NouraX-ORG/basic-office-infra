# Privacy between organisations: people find, autocomplete and share only with people of their
# own organisation (the org:{org_id} group the admin API keeps), never across organisations.
# See docs/teams.md "Privacy between organisations".
#
# The list of settings and apps it switches lives in one place, the nourax_api app
# (lib/Service/OrgPrivacySwitch.php). This step only calls its command,
#   occ nourax_api:org-privacy on|off --by=configure
# which the admin page "Nourax Workspace" (Privacy between organisations: On / Off) uses too.
#
# These are server-wide switches: sharing between two accounts with no organisation or team in
# common stops, also for accounts in no organisation (being in "admin" together never counts;
# "admin" holds only the emergency admin nodrive). So this step is OFF until it is switched on
# once, on purpose:
#   sudo bash -c '. scripts/lib.sh; load_env; ORG_PRIVACY=on . scripts/configure.d/60-org-privacy.sh'
# From then on every scripts/configure.sh run keeps it on: the switch is stored in the app
# setting nourax_api org_privacy_step (the admin page and the command store it too). To undo it
# (the server's defaults come back, and the federation and circles apps are enabled again, as
# they were on 2026-10-25):
#   sudo bash -c '. scripts/lib.sh; load_env; ORG_PRIVACY=off . scripts/configure.d/60-org-privacy.sh'
# With ORG_PRIVACY_DRY_RUN=1 it only logs what it would change.
#
# Sourced by scripts/configure.sh with its helpers (occ, dc, log, secret_path, have_secret).
# Safe to run again. Nothing needs a restart: every setting is read on the next request.
# SPDX-License-Identifier: AGPL-3.0-or-later

log "Org privacy: find and share only within one's own organisation"

org_privacy_step="$(occ config:app:get nourax_api org_privacy_step 2>/dev/null </dev/null || true)"
case "${ORG_PRIVACY:-}" in
on | off) org_privacy_want="$ORG_PRIVACY" ;;
"")
	# A plain configure.sh run keeps it on once it is on, and changes nothing otherwise.
	org_privacy_want=""
	if [ "$org_privacy_step" = on ]; then
		org_privacy_want=on
	fi
	;;
*) die "ORG_PRIVACY must be on or off, not '${ORG_PRIVACY}'" ;;
esac

if [ -n "$org_privacy_want" ]; then
	# Read the whole list first: with pipefail, grep -q stopping early would fail the pipe.
	org_privacy_cmds="$(occ list nourax_api --raw 2>/dev/null </dev/null || true)"
	grep -q '^nourax_api:org-privacy ' <<<"$org_privacy_cmds" ||
		die "occ nourax_api:org-privacy is missing - is the nourax_api app enabled? (60-nomail-api.sh)"
	org_privacy_args=("$org_privacy_want" --by=configure)
	org_privacy_mark=""
	if [ "${ORG_PRIVACY_DRY_RUN:-0}" = 1 ]; then
		org_privacy_args+=(--dry-run)
		org_privacy_mark="(dry run) "
	fi
	if ! org_privacy_out="$(occ nourax_api:org-privacy "${org_privacy_args[@]}" </dev/null)"; then
		die "org privacy: switching $org_privacy_want failed: $(jq -r '"\(.error): \(.message)"' <<<"$org_privacy_out" 2>/dev/null || echo "$org_privacy_out")"
	fi
	while IFS= read -r org_privacy_line; do
		log "  ${org_privacy_mark}${org_privacy_line}"
	done < <(jq -r '.changed[]' <<<"$org_privacy_out")
	log "  org privacy: $(jq -r '"\(.state) (\(.result))"' <<<"$org_privacy_out"); nourax_api: $(occ nourax_api:status </dev/null | jq -r .org_privacy)"
	unset org_privacy_cmds org_privacy_args org_privacy_mark org_privacy_out org_privacy_line
else
	log "  org privacy is not switched on - see the top of $(basename "${BASH_SOURCE[0]}") to switch it on"
fi

unset org_privacy_step org_privacy_want
