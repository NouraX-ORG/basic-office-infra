#!/bin/sh
# Nextcloud image hook (pre-installation, pre-upgrade and before-starting): copy the Nourax settings
# file into Nextcloud's config folder. A direct bind mount into that folder would make Docker create
# it as root, and Nextcloud must be able to write there. Runs as www-data.
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu
src=/opt/nourax/config/zz-nourax.config.php
dst=/var/www/html/config/zz-nourax.config.php
if ! cmp -s "$src" "$dst" 2>/dev/null; then
	cp "$src" "$dst.tmp"
	mv -f "$dst.tmp" "$dst"
	echo "nourax: installed $dst"
fi
