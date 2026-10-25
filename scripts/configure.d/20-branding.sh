# Nourax branding: the nourax_branding app (nextcloud-apps/nourax_branding). It puts NoMail in the
# app menu of every signed-in person, right after NoBoard, and opens it in a new tab.
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
