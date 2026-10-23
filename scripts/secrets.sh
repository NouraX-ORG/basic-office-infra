#!/usr/bin/env bash
# Create and update the secret files in $SECRETS_DIR (default /etc/nourax/secrets).
# Values are typed or pasted at hidden prompts on the server - never into chat, git or logs.
#
#   sudo scripts/secrets.sh init        generate database, Redis and ONLYOFFICE secrets
#   sudo scripts/secrets.sh admin       set the first admin account (name + password)
#   sudo scripts/secrets.sh r2          R2 key for the file bucket (Access Key ID + Secret)
#   sudo scripts/secrets.sh backup-r2   R2 key for the backups bucket
#   sudo scripts/secrets.sh tunnel      Cloudflare Tunnel token
#   sudo scripts/secrets.sh age         public key (age1...) that backups are encrypted to
#   sudo scripts/secrets.sh oidc        "Log in with Nourax" OAuth client (from NoMail's Supabase)
#   sudo scripts/secrets.sh status      show which secrets exist (never their values)
#
# The directory is root-only (0700). Files inside are 0644 because the containers read them
# as non-root users (www-data, redis, cloudflared) through Docker bind mounts.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_root
SECRETS_DIR="${SECRETS_DIR:-/etc/nourax/secrets}"
[ -f "$REPO_DIR/.env" ] && load_env
install -d -m 0700 -o root -g root "$SECRETS_DIR"

write_secret() { # name value
	local file
	file="$(secret_path "$1")"
	umask 022
	printf '%s' "$2" > "$file.tmp"
	chmod 0644 "$file.tmp"
	mv -f "$file.tmp" "$file"
	log "saved $1 (${#2} characters)"
}

random_secret() { openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-48; }

ask_hidden() { # prompt -> value on stdout (prompt goes to the terminal)
	local value
	IFS= read -r -s -p "$1: " value </dev/tty
	printf '\n' >/dev/tty
	value="${value//$'\r'/}"
	value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
	[ -n "$value" ] || die "empty value - nothing saved"
	printf '%s' "$value"
}

case "${1:-status}" in
	init)
		for name in postgres_password redis_password; do
			if have_secret "$name"; then log "$name already exists - kept"; else write_secret "$name" "$(random_secret)"; fi
		done
		if have_secret onlyoffice_jwt_secret; then
			log "onlyoffice_jwt_secret already exists - kept"
		else
			write_secret onlyoffice_jwt_secret "$(random_secret)"
		fi
		write_secret onlyoffice.env "JWT_SECRET=$(cat "$(secret_path onlyoffice_jwt_secret)")"
		;;
	admin)
		IFS= read -r -p "Admin account name (letters and digits, e.g. hammad): " user </dev/tty
		[[ "$user" =~ ^[a-z][a-z0-9._-]{2,31}$ ]] || die "use 3-32 lowercase letters, digits, . _ or -"
		pass1="$(ask_hidden "Admin password (at least 12 characters, hidden)")"
		pass2="$(ask_hidden "Same password again")"
		[ "$pass1" = "$pass2" ] || die "the two passwords differ - nothing saved"
		[ "${#pass1}" -ge 12 ] || die "password is shorter than 12 characters"
		write_secret nextcloud_admin_user "$user"
		write_secret nextcloud_admin_password "$pass1"
		;;
	r2 | backup-r2)
		# Assign first: a failed prompt then stops the script instead of saving an empty value.
		prefix=""; label="file"
		[ "$1" = backup-r2 ] && { prefix="backup_"; label="backups"; }
		key_id="$(ask_hidden "R2 Access Key ID for the $label bucket (hidden)")"
		[ "${#key_id}" -eq 32 ] || die "an R2 Access Key ID is 32 characters; got ${#key_id}"
		key_secret="$(ask_hidden "R2 Secret Access Key for the $label bucket (hidden)")"
		[ "${#key_secret}" -eq 64 ] || die "an R2 Secret Access Key is 64 characters; got ${#key_secret}"
		write_secret "${prefix}r2_access_key_id" "$key_id"
		write_secret "${prefix}r2_secret_access_key" "$key_secret"
		;;
	tunnel)
		raw="$(ask_hidden "Cloudflare Tunnel token, or the whole install command that contains it (hidden)")"
		# The dashboard shows e.g. "docker run ... --token eyJh..."; keep only the token itself.
		token="$(printf '%s' "$raw" | grep -oE 'eyJ[A-Za-z0-9+/=_-]{50,}' | head -n1 || true)"
		[ "${#token}" -gt 100 ] || die "no tunnel token found in what was pasted"
		write_secret tunnel_token "$token"
		;;
	oidc)
		# "Log in with Nourax": the OAuth client NoMail's Supabase project issues for NoDrive.
		IFS= read -r -p "OAuth Client ID for NoDrive (visible): " client_id </dev/tty
		[ -n "$client_id" ] || die "empty client id - nothing saved"
		client_secret="$(ask_hidden "OAuth Client Secret for NoDrive (hidden)")"
		write_secret oidc_client_id "$client_id"
		write_secret oidc_client_secret "$client_secret"
		;;
	age)
		IFS= read -r -p "Backup public key (starts with age1): " key </dev/tty
		[[ "$key" =~ ^age1[0-9a-z]{58}$ ]] || die "not an age public key"
		write_secret backup_age_recipient "$key"
		;;
	status)
		printf '%-30s %s\n' SECRET STATE
		for name in postgres_password redis_password onlyoffice_jwt_secret onlyoffice.env \
			nextcloud_admin_user nextcloud_admin_password r2_access_key_id r2_secret_access_key \
			backup_r2_access_key_id backup_r2_secret_access_key tunnel_token backup_age_recipient \
			oidc_client_id oidc_client_secret; do
			if have_secret "$name"; then printf '%-30s set\n' "$name"; else printf '%-30s MISSING\n' "$name"; fi
		done
		;;
	*)
		die "unknown command: $1 (see the top of this file)"
		;;
esac
