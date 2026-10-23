#!/usr/bin/env bash
# Shared helpers for the Nourax Workspace scripts. Source it; don't run it.
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die()  { log "ERROR: $*" >&2; exit 1; }

need_root() { [ "$(id -u)" -eq 0 ] || die "run this with sudo"; }

load_env() {
	[ -f "$REPO_DIR/.env" ] || die ".env is missing - copy .env.example to .env and fill it in"
	set -a
	# shellcheck disable=SC1091
	. "$REPO_DIR/.env"
	set +a
	: "${SECRETS_DIR:?SECRETS_DIR is not set in .env}"
}

dc()  { docker compose --project-directory "$REPO_DIR" "$@"; }
occ() { dc exec -T -u www-data app php occ "$@"; }

secret_path() { printf '%s/%s' "$SECRETS_DIR" "$1"; }
have_secret() { [ -s "$(secret_path "$1")" ]; }

# Wait until Nextcloud reports installed=true (first start can take several minutes).
wait_for_nextcloud() {
	local tries=0
	until occ status --output=json 2>/dev/null | grep -q '"installed":true'; do
		tries=$((tries + 1))
		[ "$tries" -le 90 ] || die "Nextcloud did not finish starting - check: docker compose logs app"
		sleep 10
	done
}

# rclone remotes are defined through environment variables, so no config file holds keys.
rclone_env() {
	export RCLONE_CONFIG_R2PRIMARY_TYPE=s3
	export RCLONE_CONFIG_R2PRIMARY_PROVIDER=Cloudflare
	export RCLONE_CONFIG_R2PRIMARY_ENDPOINT="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com"
	export RCLONE_CONFIG_R2PRIMARY_ACCESS_KEY_ID="$(cat "$(secret_path r2_access_key_id)")"
	export RCLONE_CONFIG_R2PRIMARY_SECRET_ACCESS_KEY="$(cat "$(secret_path r2_secret_access_key)")"
	export RCLONE_CONFIG_R2PRIMARY_NO_CHECK_BUCKET=true
	export RCLONE_CONFIG_R2BACKUP_TYPE=s3
	export RCLONE_CONFIG_R2BACKUP_PROVIDER=Cloudflare
	export RCLONE_CONFIG_R2BACKUP_ENDPOINT="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com"
	export RCLONE_CONFIG_R2BACKUP_ACCESS_KEY_ID="$(cat "$(secret_path backup_r2_access_key_id)")"
	export RCLONE_CONFIG_R2BACKUP_SECRET_ACCESS_KEY="$(cat "$(secret_path backup_r2_secret_access_key)")"
	export RCLONE_CONFIG_R2BACKUP_NO_CHECK_BUCKET=true
}
