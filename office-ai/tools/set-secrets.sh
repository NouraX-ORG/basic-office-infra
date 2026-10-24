#!/usr/bin/env bash
# Give the relay the two values it reads from the server, piped from the server straight into
# Cloudflare: nothing is shown or saved on this computer. Run from a PC where wrangler is signed in:
#   office-ai/tools/set-secrets.sh nourax@<server> [ssh options, e.g. -i ~/.ssh/key]
# Run it again whenever the ONLYOFFICE secret changes. NIG_SERVICE_KEY is set together with NIG's
# SERVICE_KEY_OFFICE, from the NIG side (docs/office-ai.md).
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail
server="${1:?usage: set-secrets.sh <user@server> [ssh options]}"
shift
cd "$(dirname "$0")/.."
remote=/opt/nourax/basic-office-infra/scripts/office-ai-secret.sh

ssh "$@" "$server" "sudo $remote session-key" | npx wrangler secret put EDITOR_SESSION_KEY
ssh "$@" "$server" "sudo $remote instance-id" | npx wrangler secret put NEXTCLOUD_INSTANCE_ID
