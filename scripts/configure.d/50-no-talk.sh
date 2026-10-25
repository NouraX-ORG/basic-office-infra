# No Talk: chat and video calls (the app "spreed") are not part of Nourax Workspace; the owner said
# so. If someone switches Talk on, from the Apps page or with occ, this step switches it off again
# and says so. It never installs or removes an app, so Talk's data, if there ever is any, stays.
# docs/apps.md, "No Talk".
# Sourced by scripts/configure.sh with its helpers (occ, log). Safe to run again.
# SPDX-License-Identifier: AGPL-3.0-or-later

nourax_no_talk() {
	local state
	# "enabled" also covers an app switched on for some groups only (app:list lists it as enabled).
	state="$(occ app:list --output=json | jq -r '
		if .enabled.spreed != null then "on"
		elif .disabled.spreed != null then "installed"
		else "absent" end')" || state=""
	case "$state" in
		on)
			log "  Talk (spreed) found - switching it off"
			occ app:disable spreed || true
			if occ app:list --output=json | jq -e '.enabled.spreed == null' >/dev/null; then
				log "  Talk (spreed) is off now"
			else
				log "  WARNING: Talk (spreed) is still on - switch it off: occ app:disable spreed"
			fi
			;;
		installed) log "  Talk (spreed) is off (installed, switched off)" ;;
		absent) log "  Talk (spreed) is off (not installed)" ;;
		*) log "  WARNING: the app list could not be read, so Talk was not checked - see: docker compose logs app" ;;
	esac
}

log "no chat and video calls (Talk)"
nourax_no_talk
