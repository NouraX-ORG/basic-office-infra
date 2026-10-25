# Nourax branding: the nourax_branding app (nextcloud-apps/nourax_branding). It puts NoMail in the
# app menu of every signed-in person, right after NoBoard, and opens it in a new tab.
# Then it switches off the leftover upstream apps that show the upstream name, and hides the App store
# tile of the app menu (see docs/branding.md).
# Sourced by scripts/configure.sh with its helpers (occ, dc, log, secret_path, have_secret).
# To run only this step on the server:
#   sudo bash -c '. scripts/lib.sh; load_env; . scripts/configure.d/20-branding.sh'
# Safe to run again.
# SPDX-License-Identifier: AGPL-3.0-or-later

log "branding: the Nourax branding app"
if occ app:list --output=json | jq -e '.enabled.nourax_branding != null' >/dev/null; then
	log "  nourax_branding already enabled"
else
	occ app:enable nourax_branding
fi

# NoMail opens https://mail.nourax.org/ unless NOMAIL_URL in .env names another https address. A value
# set once stays after NOMAIL_URL is taken out of .env; set it back to https://mail.nourax.org/ instead.
if [ -n "${NOMAIL_URL:-}" ]; then
	occ config:app:set nourax_branding nomail_url --type=string --value="$NOMAIL_URL" >/dev/null
fi
nomail_url="$(occ config:app:get nourax_branding nomail_url 2>/dev/null || echo 'https://mail.nourax.org/ (the default)')"
log "  NoMail in the app menu: $nomail_url"
unset nomail_url

# Leftover upstream apps that do nothing for Nourax and show the upstream name or links:
# - office: the "Office" entry in the app menu, an overview page of the upstream suite. The owner
#   approved switching it off.
# - privacy: Personal settings > Privacy, with the upstream's mission text, the User Data Manifesto and
#   links to the upstream website and blog. It keeps no user data and no other app needs it. Its old
#   address, /settings/user/privacy, then sends people to the first Personal settings page (the
#   nourax_branding app does that for any Personal settings address with nothing on it).
# Switching an app off keeps its data, and an upgrade does not switch it back on. docs/branding.md says
# why every other app stays.
log "branding: switch off the leftover Office overview and Privacy pages"
branding_enabled="$(occ app:list --output=json | jq -r '.enabled | keys[]')"
for branding_app in office privacy; do
	if printf '%s\n' "$branding_enabled" | grep -qx "$branding_app"; then
		occ app:disable "$branding_app"
	else
		log "  $branding_app already off"
	fi
done
unset branding_enabled branding_app

# The app menu of people who are not admins ends with an "App store" tile that opens the upstream app
# store website. Nextcloud 35 shows it while the core setting appstore_link_shown is unset. Setting it
# to false hides only that tile: admins still install and update apps from Administration > Apps.
log "branding: hide the App store tile in the app menu of people who are not admins"
occ config:app:set core appstore_link_shown --type=boolean --value=false >/dev/null
