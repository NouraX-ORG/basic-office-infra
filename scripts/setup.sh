#!/usr/bin/env bash
# First install of Nourax Workspace on a bootstrapped server.
#   sudo scripts/setup.sh
# Needs .env filled in and the secrets from scripts/secrets.sh (init, admin, r2, tunnel).
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_root
load_env

for name in postgres_password redis_password onlyoffice_jwt_secret onlyoffice.env \
	nextcloud_admin_user nextcloud_admin_password r2_access_key_id r2_secret_access_key tunnel_token; do
	have_secret "$name" || die "secret $name is missing - see: sudo scripts/secrets.sh status"
done
[[ "$CF_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || die "CF_ACCOUNT_ID in .env does not look like an account id"

log "checking the compose file"
dc config --quiet

log "pulling images"
dc pull --quiet

log "starting database and cache"
dc up -d --wait db redis

log "starting Nextcloud - the first install writes to R2 and can take a few minutes"
dc up -d app
wait_for_nextcloud
occ status

log "starting cron, ONLYOFFICE and the tunnel"
dc up -d cron onlyoffice cloudflared

log "applying Nourax settings"
"$REPO_DIR/scripts/configure.sh"

# The admin password is only read at first install. Overwrite the stored copy so the real
# password no longer sits on the server's disk (compose still needs the file to exist).
openssl rand -hex 32 > "$(secret_path nextcloud_admin_password)"
log "the stored admin password file was overwritten (Nextcloud keeps only its hash)"

log "installing backup timers"
install -m 0644 "$REPO_DIR"/systemd/nourax-backup*.{service,timer} /etc/systemd/system/
systemctl daemon-reload
if have_secret backup_age_recipient && have_secret backup_r2_access_key_id; then
	systemctl enable --now nourax-backup.timer nourax-backup-files.timer
	log "backup timers enabled"
else
	log "backup timers NOT enabled yet: run secrets.sh age and backup-r2, then"
	log "  sudo systemctl enable --now nourax-backup.timer nourax-backup-files.timer"
fi

dc ps
log "setup done - open https://${DRIVE_HOST} and set up two-factor login for the admin account"
