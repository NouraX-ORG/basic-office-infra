# NoMail API and the admin-only organisations and teams API: the nourax_api app
# (nextcloud-apps/nourax_api), served at https://${DRIVE_HOST}/apps/nourax_api/v1/...
# See docs/nomail-api.md.
#
# Sourced by scripts/configure.sh with its helpers (occ, dc, log, secret_path, have_secret).
# To run only this step on the server:
#   sudo bash -c '. scripts/lib.sh; load_env; . scripts/configure.d/60-nomail-api.sh'
# Safe to run again. The keys are made beforehand with:
#   sudo scripts/secrets.sh gen nodrive_api_key
#   sudo scripts/secrets.sh gen nodrive_admin_api_key
# SPDX-License-Identifier: AGPL-3.0-or-later

log "NoMail API: the Nourax API app"
if occ app:list --output=json | jq -e '.enabled.nourax_api != null' >/dev/null; then
	log "  nourax_api already enabled"
else
	occ app:enable nourax_api
fi

# Accounts are made for the "Log in with Nourax" provider, so a later sign-in lands in them.
occ config:app:set nourax_api oidc_provider --value=Nourax

# Team Folders for the teams API (the same ensure as the add-on apps step).
if occ app:list --output=json | jq -e '.enabled.groupfolders != null' >/dev/null; then
	log "  groupfolders already enabled"
else
	occ app:install groupfolders || occ app:enable groupfolders
fi

# The keys go in over stdin, from the secret files, so they are never on a command line.
# The app keeps only the SHA-256 of the NoMail key, and the admin key encrypted.
nomail_api_key() { # kind secret-name
	if have_secret "$2"; then
		occ nourax_api:secret "$1" < "$(secret_path "$2")"
	else
		log "  $2 is missing - make it with: sudo scripts/secrets.sh gen $2"
	fi
}
nomail_api_key api_key nodrive_api_key
nomail_api_key admin_key nodrive_admin_api_key
unset -f nomail_api_key

# The hidden service account "nourax-teams" that owns the organisation directories and the team
# address books, calendars and boards (docs/teams.md). --check signs in with its app password
# over the compose network, as the team board calls do.
if ! occ nourax_api:service-account --check; then
	log "  WARNING: the teams service account is not ready - the admin API's team steps will fail"
fi
