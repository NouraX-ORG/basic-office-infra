#!/usr/bin/env bash
# Nightly backup: database + Nextcloud config, encrypted, uploaded to the R2 backups bucket.
#   sudo scripts/backup.sh
# Runs from nourax-backup.timer. Nextcloud is in maintenance mode for the few seconds the
# database dump takes, so the dump and the config match.
#
# Encryption: age, to the public key in $SECRETS_DIR/backup_age_recipient. The matching
# private key is NOT on the server (it stays on the owner's PC), so a stolen backup is unreadable.
# Without the database the files in R2 are anonymous blobs, so this backup matters most.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_root
load_env

have_secret backup_age_recipient || die "no backup public key - run: sudo scripts/secrets.sh age"
have_secret backup_r2_access_key_id || die "no backups-bucket key - run: sudo scripts/secrets.sh backup-r2"
RECIPIENT="$(cat "$(secret_path backup_age_recipient)")"

STAMP="$(date -u +%Y-%m-%dT%H%MZ)"
LOCAL_ROOT=/var/backups/nourax
WORK="$LOCAL_ROOT/$STAMP"
install -d -m 0700 "$LOCAL_ROOT" "$WORK"

maintenance_off() { occ maintenance:mode --off >/dev/null 2>&1 || log "WARNING: could not turn maintenance mode off"; }

log "backup $STAMP: maintenance mode on"
occ maintenance:mode --on >/dev/null
trap maintenance_off EXIT

log "dumping database"
dc exec -T db pg_dump -U nextcloud -d nextcloud -Fc | age -r "$RECIPIENT" > "$WORK/nextcloud-db.dump.age"

log "archiving config, custom_apps and themes"
dc exec -T app tar -C /var/www/html -cf - config custom_apps themes \
	| zstd -q -T0 | age -r "$RECIPIENT" > "$WORK/nextcloud-config.tar.zst.age"

maintenance_off
trap - EXIT
log "maintenance mode off"

{
	echo "stamp=$STAMP"
	echo "nextcloud_image=$NEXTCLOUD_IMAGE"
	echo "nextcloud_version=$(occ status --output=json | jq -r .versionstring)"
	echo "postgres_image=$POSTGRES_IMAGE"
	echo "onlyoffice_image=$ONLYOFFICE_IMAGE"
	echo "r2_bucket=$R2_BUCKET"
	(cd "$WORK" && sha256sum ./*.age)
} > "$WORK/manifest.txt"

for f in "$WORK"/*.age; do
	[ -s "$f" ] || die "backup file $(basename "$f") is empty - not uploading"
done

log "uploading to r2://$R2_BACKUP_BUCKET/backups/$STAMP/"
rclone_env
rclone copy "$WORK" "R2BACKUP:$R2_BACKUP_BUCKET/backups/$STAMP" --s3-no-check-bucket --retries 5
rclone check "$WORK" "R2BACKUP:$R2_BACKUP_BUCKET/backups/$STAMP" --one-way --size-only --s3-no-check-bucket

# Keep three days of local copies for quick restores.
find "$LOCAL_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +3 -exec rm -rf {} +

install -d -m 0755 /var/lib/nourax
echo "$STAMP" > /var/lib/nourax/last-backup
log "backup $STAMP done: $(du -sh "$WORK" | cut -f1)"
