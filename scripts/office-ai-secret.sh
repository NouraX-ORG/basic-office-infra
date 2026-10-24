#!/usr/bin/env bash
# Print one value the Nourax AI relay (office-ai/) needs, for piping straight into
# `wrangler secret put` - see office-ai/tools/set-secrets.sh. Refuses to print to a terminal.
#   sudo scripts/office-ai-secret.sh session-key   # the key ONLYOFFICE signs editor sessions with
#   sudo scripts/office-ai-secret.sh instance-id   # Nextcloud's instanceid
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_root
load_env

[ -t 1 ] && die "refusing to print a secret to a terminal - pipe it into wrangler secret put"

case "${1:-}" in
	session-key)
		# Document Server 10 signs editor sessions with HMAC-SHA256(session secret, "editor-session")
		# as hex, not with the secret itself, so the relay never holds the secret.
		dc exec -T onlyoffice cat /etc/onlyoffice/documentserver/local.json </dev/null | python3 -I -c '
import hashlib, hmac, json, sys
secret = json.load(sys.stdin)["services"]["CoAuthoring"]["secret"]["session"]["string"]
sys.stdout.write(hmac.new(secret.encode(), b"editor-session", hashlib.sha256).hexdigest())'
		;;
	instance-id)
		occ config:system:get instanceid </dev/null | tr -d '\n'
		;;
	*)
		die "usage: office-ai-secret.sh session-key|instance-id"
		;;
esac
