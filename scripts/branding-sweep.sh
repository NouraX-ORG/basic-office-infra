#!/usr/bin/env bash
# Text sweep: rewrite the upstream name in the translations of core, lib and every enabled app, in
# every language (also "en", which has no translation file of its own), for the server and for the
# browser. "Nourax Workspace" for the site, "NoDrive" for files; ONLYOFFICE keeps its name.
#   sudo scripts/branding-sweep.sh [--report] [--dry-run] [--app ID]...
# The options go to occ nourax_branding:sweep. Safe to run again: a second run writes nothing.
#
# How it works (docs/branding.md): Nextcloud reads translation overrides from the theme folder
# themes/nourax, which 'theme' => 'nourax' switches on. The nourax_branding app builds them from the
# installed translation files with the rules in nextcloud-apps/nourax_branding/sweep/. It also sweeps
# an app by itself as soon as the app is switched on or updated, and its background job looks every
# 15 minutes for a new server version, new apps or new rules, so this script is only needed after
# changing the rules (or to see the report).
# Called by scripts/configure.d/20-branding.sh. Undo: occ config:system:delete theme (the theme
# folder then does nothing; nothing is deleted).
# Check: sudo scripts/check-branding.sh /etc/nourax/qa/qa-t3-1.netrc --server --only l10n
# SPDX-License-Identifier: AGPL-3.0-or-later

# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"
need_root
load_env

THEME=nourax
BRANDING=/opt/nourax/branding   # where compose.yaml mounts ./branding inside the container
THEME_DIR="/var/www/html/themes/$THEME"

sweep_args=()
# Files kept in the repo for the theme folder (branding/theme: pictures, page templates), copied as
# they are. When they change, browsers must fetch them again: --bump raises the cache buster.
if [ -d "$REPO_DIR/branding/theme" ]; then
	theme_sum="$(cd "$REPO_DIR/branding/theme" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum | sha256sum | cut -d' ' -f1)"
	copied_sum="$(dc exec -T -u www-data app sh -c "cat $THEME_DIR/.branding-theme.sha256 2>/dev/null" || true)"
	if [ "$theme_sum" != "$copied_sum" ]; then
		log "branding sweep: copying branding/theme into the theme folder"
		dc exec -T -u www-data app sh -c "mkdir -p $THEME_DIR && cp -R $BRANDING/theme/. $THEME_DIR/ && printf '%s' '$theme_sum' > $THEME_DIR/.branding-theme.sha256"
		sweep_args+=(--bump)
	else
		log "branding sweep: branding/theme already in the theme folder"
	fi
fi

current_theme="$(occ config:system:get theme 2>/dev/null || true)"
if [ "$current_theme" != "$THEME" ]; then
	log "branding sweep: switching on the theme folder '$THEME' (was '${current_theme:-none}')"
	occ config:system:set theme --value="$THEME"
	sweep_args+=(--bump)
fi

log "branding sweep: translations"
occ nourax_branding:sweep "${sweep_args[@]}" "$@"
