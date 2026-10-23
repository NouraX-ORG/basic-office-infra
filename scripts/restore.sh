#!/usr/bin/env bash
# Restore the database and Nextcloud config from one backup set.
#   sudo scripts/restore.sh <stamp> <age-identity-file>
# <stamp> is a folder name under r2://<backups bucket>/backups/ (see: scripts/restore.sh list).
# <age-identity-file> is the backup PRIVATE key. Copy it to the server only for the restore
# (e.g. into /root), and delete it afterwards: shred -u /root/age-identity.txt
#
# File contents are not touched: they stay in the R2 file bucket and the restored database
# points at them again. Files uploaded after the backup was taken are orphaned in R2.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_root
load_env
rclone_env

if [ "${1:-}" = list ]; then
	rclone lsf "R2BACKUP:$R2_BACKUP_BUCKET/backups/" --dirs-only --s3-no-check-bucket
	exit 0
fi

STAMP="${1:?usage: restore.sh <stamp>|list <age-identity-file>}"
IDENTITY="${2:?usage: restore.sh <stamp> <age-identity-file>}"
[ -r "$IDENTITY" ] || die "cannot read $IDENTITY"

WORK="/var/backups/nourax/restore-$STAMP"
install -d -m 0700 "$WORK"
log "downloading backup $STAMP"
rclone copy "R2BACKUP:$R2_BACKUP_BUCKET/backups/$STAMP" "$WORK" --s3-no-check-bucket
(cd "$WORK" && sed -n '/\.age$/p' manifest.txt | sha256sum -c -) || die "checksum mismatch - backup damaged"
grep '^nextcloud_image=' "$WORK/manifest.txt"
log "current image: $NEXTCLOUD_IMAGE (restore needs the same Nextcloud major version)"

read -r -p "This REPLACES the live database and config with backup $STAMP. Type RESTORE to continue: " answer </dev/tty
[ "$answer" = RESTORE ] || die "cancelled"

log "stopping Nextcloud (web and cron)"
dc stop app cron

log "restoring config"
age -d -i "$IDENTITY" "$WORK/nextcloud-config.tar.zst.age" | zstd -d -q \
	| dc run --rm --no-deps -T --entrypoint sh app -c 'tar -C /var/www/html -xf - && chown -R www-data:www-data /var/www/html/config /var/www/html/custom_apps /var/www/html/themes'

log "restoring database"
dc exec -T db psql -U nextcloud -d postgres -v ON_ERROR_STOP=1 \
	-c 'DROP DATABASE IF EXISTS nextcloud WITH (FORCE);' \
	-c 'CREATE DATABASE nextcloud OWNER nextcloud;'
age -d -i "$IDENTITY" "$WORK/nextcloud-db.dump.age" \
	| dc exec -T db pg_restore -U nextcloud -d nextcloud --no-owner --exit-on-error

log "starting Nextcloud"
dc up -d app cron
wait_for_nextcloud
occ maintenance:mode --off || true
# Tells desktop and phone apps that server data went back in time, so they re-check files.
occ maintenance:data-fingerprint
occ status
log "restore of $STAMP done - delete the private key file now: shred -u $IDENTITY"
