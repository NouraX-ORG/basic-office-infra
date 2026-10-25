#!/usr/bin/env bash
# Apply all Nourax Workspace settings to a running Nextcloud. Safe to run again at any time.
#   sudo scripts/configure.sh
# Nourax Workspace is white-labelled: some apps that ship switched on are switched off, so it is a
# modified Nextcloud and must show no Nextcloud name or logo - see docs/branding.md.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_root
load_env

BRANDING=/opt/nourax/branding   # where compose.yaml mounts ./branding inside the container

# App id -> product name shown in the top bar.
APP_LABELS=(
	"files=NoDrive"
	"calendar=NoCalendar"
	"contacts=NoContacts"
	"deck=NoBoard"
	"onlyoffice=ONLYOFFICE"
)
# More labels in config/nextcloud/app-labels.d/*.conf: one "app=Name" per line, # starts a comment.
for f in "$REPO_DIR"/config/nextcloud/app-labels.d/*.conf; do
	[ -f "$f" ] || continue
	while IFS= read -r line || [ -n "$line" ]; do
		line="$(printf '%s' "${line%%#*}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
		[[ "$line" == ?*=?* ]] && APP_LABELS+=("$line")
	done < "$f"
done

log "background jobs and database housekeeping"
occ background:cron
occ db:add-missing-indices

log "apps (all from the Nextcloud app store)"
for app in calendar contacts deck onlyoffice theming_customcss; do
	if occ app:list --output=json | jq -e --arg a "$app" '.enabled[$a] != null' >/dev/null; then
		log "  $app already enabled"
	else
		occ app:install "$app" || occ app:enable "$app"
	fi
done

log "white label: switch off the upstream intro, news, survey, support, update and lookup apps"
# Also the Dashboard (NoDrive opens after login) and External Apps (not used, it only warns).
enabled="$(occ app:list --output=json | jq -r '.enabled | keys[]')"
for app in firstrunwizard nextcloud_announcements survey_client support updatenotification \
	lookup_server_connector dashboard weather_status app_api; do
	if ! printf '%s\n' "$enabled" | grep -qx "$app"; then
		log "  $app already off"
	elif ! occ app:disable "$app"; then
		# Some apps are "always enabled"; for the lookup connector 'lookup_server' => '' stops its calls.
		log "  $app is always on - left as it is"
	fi
done

log "thumbnails: JPEG quality 60 (default 80); the size limit is in zz-nourax.config.php"
occ config:app:set preview jpeg_quality --value=60

log "two-factor login required for admins"
occ app:enable twofactor_totp
occ twofactorauth:enforce --on --group=admin

log "trusted domains: ${DRIVE_HOST} and app (ONLYOFFICE calls back on http://app/)"
domains="$(occ config:system:get trusted_domains || true)"
index=$(printf '%s\n' "$domains" | grep -c . || true)
for d in "$DRIVE_HOST" app; do
	if ! printf '%s\n' "$domains" | grep -qx "$d"; then
		occ config:system:set trusted_domains "$index" --value="$d"
		index=$((index + 1))
	fi
done

log "ONLYOFFICE connector"
occ config:app:set onlyoffice DocumentServerUrl --value="https://${OFFICE_HOST}/"
occ config:app:set onlyoffice DocumentServerInternalUrl --value="http://onlyoffice/"
occ config:app:set onlyoffice StorageUrl --value="http://app/"
occ config:app:set onlyoffice jwt_header --value="AuthorizationJwt"
occ config:app:set onlyoffice verify_peer_off --value="false"
# Read from the secret file on the server; never typed or printed.
occ config:app:set onlyoffice jwt_secret --value="$(cat "$(secret_path onlyoffice_jwt_secret)")" --sensitive >/dev/null
occ onlyoffice:documentserver --check \
	|| log "WARNING: ONLYOFFICE check failed. It needs https://${OFFICE_HOST} reachable (Tunnel + DNS); run configure.sh again then."

log "theming: name, colours, logo"
occ theming:config name "Nourax Workspace"
# The product name is separate from the name; upstream it shows e.g. "Add to your Nextcloud".
occ config:app:set theming productName --value="Nourax Workspace"
occ theming:config slogan "Files, calendar, contacts, documents and boards"
occ theming:config url "https://nourax.io"
occ theming:config primary_color "#2563EB"
occ theming:config background_color "#0B1220"
occ theming:config background backgroundColor
occ theming:config logo "$BRANDING/nourax-logo.png"
occ theming:config logoheader "$BRANDING/nourax-logo.png"
occ theming:config favicon "$BRANDING/nourax-logo.png"
occ theming:config disable-user-theming no

log "theme CSS (Geist font, dark slate, product names)"
labels=""
for pair in "${APP_LABELS[@]}"; do
	app="${pair%%=*}"
	name="${pair#*=}"
	# Nextcloud 35 app menu: grid entries are links to /apps/<id>/ (12px labels, full size in the
	# compact list); the name beside the menu button belongs to the page's #content.app-<id>.
	item="a.app-item[href*=\"/apps/$app/\"] .app-item__label"
	current="body:has(#content.app-$app) .app-menu__current-app-name"
	labels+="$item, $current { font-size: 0; }"$'\n'
	labels+="$item::after { content: \"$name\"; font-size: 12px; }"$'\n'
	labels+="a.app-item--compact[href*=\"/apps/$app/\"] .app-item__label::after { font-size: var(--default-font-size); }"$'\n'
	labels+="$current::after { content: \"$name\"; font-size: var(--default-font-size); }"$'\n'
done
font_b64="$(base64 -w0 "$REPO_DIR/branding/fonts/Geist-latin.woff2")"
css="$(sed -e "s|__GEIST_WOFF2_BASE64__|$font_b64|" "$REPO_DIR/branding/custom.css")"
css="${css/__APP_LABELS__/$labels}"
# Not lazy: the app reads it with the legacy getAppValue(), which does not see lazy values.
# --no-interaction confirms the switch when an older run stored it as lazy.
occ config:app:set theming_customcss customcss --value="$css" --no-lazy --no-interaction >/dev/null
occ config:app:set theming_customcss cachebuster --value="$(date +%s)"

if have_secret oidc_client_id && have_secret oidc_client_secret; then
	log "unified sign-in: 'Log in with Nourax' through NoMail's Supabase Auth (OpenID Connect)"
	occ app:install user_oidc >/dev/null 2>&1 || occ app:enable user_oidc
	# The secret goes in through stdin into a temporary file, so it never shows in a process list.
	dc exec -T app sh -c 'umask 077; cat > /tmp/oidc_client_secret; chown www-data /tmp/oidc_client_secret' \
		< "$(secret_path oidc_client_secret)"
	occ user_oidc:provider Nourax \
		--clientid="$(cat "$(secret_path oidc_client_id)")" \
		--clientsecret-file=/tmp/oidc_client_secret \
		--discoveryuri="${SUPABASE_AUTH_URL}/.well-known/openid-configuration" \
		--scope="openid email profile" \
		--mapping-uid=sub --unique-uid=0 \
		--mapping-email=email --mapping-display-name=name
	dc exec -T app rm -f /tmp/oidc_client_secret
	# Keep the normal login form too: the emergency admin signs in without Supabase.
	occ config:app:set --type=string --value=1 user_oidc allow_multiple_user_backends
else
	log "unified sign-in not configured yet (run secrets.sh oidc when NoMail's OAuth client exists)"
fi

log "sharing: link shares allowed, uploads into public folders allowed for file drops"
occ config:app:set core shareapi_allow_links --value=yes
occ config:app:set core shareapi_allow_public_upload --value=yes

# Settings that belong to one feature live in scripts/configure.d/NN-name.sh, run in name order with
# the same helpers (occ, dc, log, secret_path). Each one must be safe to run again.
for f in "$REPO_DIR"/scripts/configure.d/*.sh; do
	[ -f "$f" ] || continue
	log "configure.d/$(basename "$f")"
	# shellcheck disable=SC1090
	. "$f"
done

occ status
log "configure done"
