#!/usr/bin/env bash
# Install the editor plugins that the ONLYOFFICE Docs image does not ship, at pinned versions.
#   sudo scripts/onlyoffice-plugins.sh
# Today that is only the official AI plugin, which adds the "AI Tools" tab. compose.yaml mounts
# the folder read-only into the editor, so it survives image updates. After changing the
# version below: run this script, then  sudo docker compose up -d --force-recreate onlyoffice
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_root
load_env

# A release of ONLYOFFICE's plugin marketplace: https://github.com/ONLYOFFICE/onlyoffice.github.io/releases
# The checksum is the digest GitHub lists for the ai.plugin asset of that release.
AI_RELEASE=v0.0.103   # AI plugin 3.2.3
AI_SHA256=f4b02a58ff22d69a14c9845933a576137a850848b6c442c10f206fdf2e53556a
AI_GUID='{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}'   # also the mount path in compose.yaml

PLUGINS_DIR="${ONLYOFFICE_PLUGINS_DIR:-/opt/nourax/onlyoffice-plugins}"
target="$PLUGINS_DIR/ai"
stamp="$PLUGINS_DIR/ai.release"

if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$AI_RELEASE $AI_SHA256" ]; then
	log "AI plugin $AI_RELEASE already installed"
	exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
log "downloading the AI plugin ($AI_RELEASE)"
curl -fsSL -o "$tmp/ai.plugin" \
	"https://github.com/ONLYOFFICE/onlyoffice.github.io/releases/download/$AI_RELEASE/ai.plugin"
echo "$AI_SHA256  $tmp/ai.plugin" | sha256sum -c --quiet - || die "checksum mismatch - nothing installed"
# A .plugin file is a zip; Python's extractor refuses absolute and ../ paths.
python3 -m zipfile -e "$tmp/ai.plugin" "$tmp/ai"
jq -e --arg g "asc.$AI_GUID" '.guid == $g' "$tmp/ai/config.json" >/dev/null \
	|| die "the download is not the AI plugin - nothing installed"
chmod -R u=rwX,go=rX "$tmp/ai"

# Replace the contents in place, so a running editor's bind mount keeps pointing at this folder.
install -d -m 0755 "$PLUGINS_DIR" "$target"
rsync -a --delete "$tmp/ai/" "$target/"
printf '%s %s\n' "$AI_RELEASE" "$AI_SHA256" > "$stamp"
log "AI plugin $(jq -r .version "$target/config.json") installed in $target"
