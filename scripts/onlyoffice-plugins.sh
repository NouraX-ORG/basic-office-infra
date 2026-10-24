#!/usr/bin/env bash
# Install the editor plugins that the ONLYOFFICE Docs image does not ship, at pinned versions.
#   sudo scripts/onlyoffice-plugins.sh
# Today that is only the official AI plugin, which adds the "AI Tools" tab, patched to use Nourax AI
# only (scripts/patch-ai-plugin.py with config/onlyoffice/ai-plugin-settings.json). compose.yaml
# mounts the folder read-only into the editor, so it survives image updates. Run this script again
# after changing the version below, the patch or the settings.
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
settings="$REPO_DIR/config/onlyoffice/ai-plugin-settings.json"
patch_id="nourax-$(cat "$REPO_DIR/scripts/patch-ai-plugin.py" "$settings" | sha256sum | cut -c1-16)"

if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$AI_RELEASE $AI_SHA256 $patch_id" ]; then
	log "AI plugin $AI_RELEASE ($patch_id) already installed"
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
python3 -I "$REPO_DIR/scripts/patch-ai-plugin.py" "$tmp/ai" "$settings" || die "patch failed - nothing installed"
chmod -R u=rwX,go=rX "$tmp/ai"

# Replace the contents in place, so a running editor's bind mount keeps pointing at this folder.
install -d -m 0755 "$PLUGINS_DIR" "$target"
rsync -a --delete "$tmp/ai/" "$target/"
printf '%s %s %s\n' "$AI_RELEASE" "$AI_SHA256" "$patch_id" > "$stamp"
log "AI plugin $(jq -r .version "$target/config.json") ($patch_id) installed in $target"

# The editor serves plugin files with a one-year cache under a versioned path. A new cache tag
# gives them new addresses, so browsers and Cloudflare fetch the new files (the container also
# does this on every start).
if [ -n "$(dc ps -q --status running onlyoffice 2>/dev/null)" ]; then
	dc exec -T onlyoffice documentserver-flush-cache.sh </dev/null
	log "editor cache tag renewed"
fi
