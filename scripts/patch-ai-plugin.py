#!/usr/bin/env python3
# Make the official ONLYOFFICE AI plugin use Nourax AI only. Called by onlyoffice-plugins.sh on the
# freshly unpacked plugin:  python3 -I patch-ai-plugin.py <plugin dir> <settings json>
#
# The plugin has a "server settings" mode: given settings, it hides its Settings button and every
# key field, and sends all requests to the settings' proxy with the editor's session token. We give
# it config/onlyoffice/ai-plugin-settings.json (the Nourax relay, models and actions) and
# switch off the two things that could still open the AI configuration window or ask for an image
# model. Each change must find its anchor exactly once, so a new plugin release fails loudly here
# instead of half-applying. The plugin is AGPL-3.0; this patch is published in this repository.
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import pathlib
import sys

plugin, settings_file = map(pathlib.Path, sys.argv[1:3])
settings = json.loads(settings_file.read_text(encoding="utf-8"))
# The plugin reads the settings as a JSON string; this one is safe to embed in a JS string literal.
settings_js = json.dumps(json.dumps(settings, separators=(",", ":")))

PATCHES = [
	(
		"scripts/code.js",
		"\t// Check server settings\n\tif (window.Asc.plugin.info.aiPluginSettings) {",
		"\t// Nourax Workspace: always use Nourax AI through the Nourax relay (no keys in the browser).\n"
		f"\twindow.Asc.plugin.info.aiPluginSettings = {settings_js};\n"
		"\t// Check server settings\n\tif (window.Asc.plugin.info.aiPluginSettings) {",
	),
	(
		"scripts/code.js",
		"function onOpenSettingsModal() {\n",
		"function onOpenSettingsModal() {\n\t// Nourax Workspace: the AI settings are fixed on the server.\n\tif (AI.serverSettings)\n\t\treturn;\n",
	),
	(
		"scripts/engine/register.js",
		"\tif (true)\n\t{\n\t\tlet buttonImages = new Asc.ButtonContextMenu(buttonMain);",
		"\t// Nourax Workspace: no image models, so no Image menu.\n\tif (!AI.serverSettings)\n\t{\n\t\tlet buttonImages = new Asc.ButtonContextMenu(buttonMain);",
	),
]

for name, anchor, replacement in PATCHES:
	path = plugin / name
	# newline="" keeps the file's own line endings, so only the patched lines change.
	with open(path, encoding="utf-8", newline="") as f:
		text = f.read()
	found = text.count(anchor)
	if found != 1:
		sys.exit(f"patch-ai-plugin: expected one match in {name}, found {found} - plugin changed, nothing installed")
	with open(path, "w", encoding="utf-8", newline="") as f:
		f.write(text.replace(anchor, replacement))

print(f"patch-ai-plugin: {len(PATCHES)} changes applied")
