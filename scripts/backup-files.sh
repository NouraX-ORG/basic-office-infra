#!/usr/bin/env bash
# Weekly mirror of the R2 file bucket into the backups bucket.
#   sudo scripts/backup-files.sh
# files/current/ mirrors the live bucket. Anything the mirror would delete or overwrite is moved
# to files/removed/<stamp>/ instead, and a lifecycle rule clears those after 60 days.
# This protects file contents against an emptied or damaged primary bucket. Day-to-day
# mistakes are covered first by Nextcloud's own trash bin and version history.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_root
load_env
rclone_env

STAMP="$(date -u +%Y-%m-%dT%H%MZ)"
log "mirroring r2://$R2_BUCKET to r2://$R2_BACKUP_BUCKET/files/current"
rclone sync "R2PRIMARY:$R2_BUCKET" "R2BACKUP:$R2_BACKUP_BUCKET/files/current" \
	--backup-dir "R2BACKUP:$R2_BACKUP_BUCKET/files/removed/$STAMP" \
	--s3-no-check-bucket --fast-list --transfers 8 --checkers 16 --retries 5 --stats-one-line --stats 5m
install -d -m 0755 /var/lib/nourax
echo "$STAMP" > /var/lib/nourax/last-file-mirror
log "file mirror $STAMP done"
