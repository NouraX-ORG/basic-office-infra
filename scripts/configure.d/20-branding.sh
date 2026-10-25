# Nourax branding: the nourax_branding app (nextcloud-apps/nourax_branding). It puts NoMail in the
# app menu of every signed-in person, right after NoBoard, and opens it in a new tab.
# Then it switches off the leftover upstream apps that show the upstream name, hides the App store
# tile of the app menu, hides the upstream's app download links, sends help links to our own help
# page, puts our example contact in place for new accounts, counts the calendars still in the upstream
# blue, and runs the text sweep of every translation (see docs/branding.md).
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

# The upstream's desktop and mobile apps: without these settings Nextcloud links its own download page
# and app stores (the "Install Client" button of welcome e-mails, the theme's syncClientUrl) and puts
# its iOS app banner (<meta name="apple-itunes-app">) on every page. An empty value hides each of them.
# When the NoDrive apps ship (handoffs/2026-10-25-workspace-to-nodrive-clients.md), set our own
# addresses here instead (customclient_ios_appid is the App Store id, a number).
log "branding: hide the upstream desktop and mobile app links until the NoDrive apps ship"
for branding_key in customclient_desktop customclient_android customclient_ios customclient_fdroid customclient_ios_appid; do
	occ config:system:set "$branding_key" --value ''
done
unset branding_key

# Help links (Security, Sharing and the other settings pages; /settings/help) open the help page of
# the nourax_branding app instead of the upstream manual: Nextcloud builds each one as
# <docBaseUrl>/server/<version>/go.php?to=<topic>, and the app answers every address below /help.
# Undo: occ config:app:delete theming docBaseUrl
log "branding: help links open https://${DRIVE_HOST}/apps/nourax_branding/help"
occ config:app:set theming docBaseUrl --value="https://${DRIVE_HOST}/apps/nourax_branding/help" >/dev/null

# The example contact every new account finds (and NoContacts opens) on its first visit: the dav
# app's own card, "Leon Green", has the upstream's website. This puts the Nourax copy in place as the
# dav app's default contact: the same card with its website on example.com, the reserved example
# address its e-mail already uses. A card an admin chose (Administration > Groupware > Example
# content) is kept if it does not name the upstream. Cards that accounts got before are people's data
# and stay; to list them: occ nourax_branding:example-contact --existing --all (--apply changes them).
# Undo: Administration > Groupware > Example content > reset to the default contact.
log "branding: the Nourax example contact for new accounts (NoContacts)"
if ! occ nourax_branding:example-contact; then
	log "WARNING: the example contact was not put in place - run: occ nourax_branding:example-contact"
fi

# New calendars and task lists in the upstream blue get the site's colour from the nourax_branding app
# (NoTasks makes a person's first list in that blue). Older ones are people's data; this only counts
# them. To change them: occ nourax_branding:calendar-colours --all --apply (or --user UID --apply).
log "branding: calendars and task lists in the upstream blue"
if ! occ nourax_branding:calendar-colours --all | tail -n 1; then
	log "WARNING: could not list the calendars in the upstream blue"
fi

# Text sweep: the upstream name in the translations of core and every enabled app, in every language
# (scripts/branding-sweep.sh). Apps that later steps switch on are swept by the nourax_branding app as
# soon as they are switched on. A failure is a loud warning and not a stop, so the steps after this
# one still run; scripts/check-branding.sh is the real check.
log "branding: text sweep of every translation"
if ! bash "$REPO_DIR/scripts/branding-sweep.sh"; then
	log "WARNING: the text sweep did not finish cleanly - see the lines above, then run: sudo scripts/branding-sweep.sh --report"
fi
