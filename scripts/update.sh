#!/usr/bin/env bash
# Update Nextcloud to a new image tag, one major version at a time, with a backup first.
#   sudo scripts/update.sh nextcloud:35.0.3-apache     next patch release
#   sudo scripts/update.sh nextcloud:36.0.1-apache     next major (only from the newest 35.x)
#   sudo scripts/update.sh --apps                      update the store apps only
# Other images (Postgres minor, Redis, ONLYOFFICE, cloudflared): edit the tag in .env, then
#   sudo scripts/backup.sh && sudo docker compose pull && sudo docker compose up -d
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_root
load_env

after_update() {
	wait_for_nextcloud
	occ upgrade --no-interaction || true   # usually already done by the image on start
	occ app:update --all
	occ db:add-missing-indices
	occ db:add-missing-columns
	occ db:add-missing-primary-keys
	occ maintenance:repair --include-expensive
	occ status
}

if [ "${1:-}" = --apps ]; then
	occ app:update --all
	exit 0
fi

NEW="${1:?usage: update.sh nextcloud:<version>-apache | --apps}"
[[ "$NEW" =~ ^nextcloud:([0-9]+)\.([0-9]+)\.([0-9]+)-apache$ ]] || die "expected nextcloud:<major>.<minor>.<patch>-apache"
NEW_MAJOR="${BASH_REMATCH[1]}"
[[ "$NEXTCLOUD_IMAGE" =~ ^nextcloud:([0-9]+)\. ]] || die "cannot read the current major version from .env"
CUR_MAJOR="${BASH_REMATCH[1]}"

if [ "$NEW_MAJOR" -lt "$CUR_MAJOR" ]; then die "downgrades are not supported"; fi
if [ "$NEW_MAJOR" -gt $((CUR_MAJOR + 1)) ]; then
	die "Nextcloud can only move one major version at a time: $CUR_MAJOR -> $((CUR_MAJOR + 1)) first"
fi
docker manifest inspect "$NEW" >/dev/null 2>&1 || die "image $NEW does not exist"

log "backup before the update"
"$REPO_DIR/scripts/backup.sh"

log "switching $NEXTCLOUD_IMAGE -> $NEW"
sed -i "s|^NEXTCLOUD_IMAGE=.*|NEXTCLOUD_IMAGE=$NEW|" "$REPO_DIR/.env"
load_env
dc pull app cron
dc up -d app cron
after_update
# Major upgrades queue background migrations: run cron a few times as the upgrade guide says.
for _ in 1 2 3; do dc exec -T -u www-data app php -f /var/www/html/cron.php; done
log "update to $NEW done - also set NEXTCLOUD_IMAGE=$NEW in .env.example and commit it"
