# Extra apps from the app store: team folders, and later the other apps of this set. What each one
# is for and how to use it: docs/apps.md.
# Sourced by scripts/configure.sh with its helpers (occ, dc, log). Safe to run again.
# SPDX-License-Identifier: AGPL-3.0-or-later

# nourax_app ID PINNED
# Installs and enables an app-store app when it is not enabled yet, then logs "ID VERSION".
# occ can't pick a version: it installs the newest release the app store offers for this server
# version (after the store's signature check). PINNED is the release this repo was tested with, so
# another version is logged as a WARNING to look at, never changed here. It never fails the run.
nourax_app() {
	local id="$1" pinned="$2" have
	have="$(occ app:list --output=json | jq -r --arg a "$id" '.enabled[$a] // empty')" || have=""
	if [ -z "$have" ]; then
		log "  installing $id"
		if ! { occ app:install "$id" || occ app:enable "$id"; }; then
			log "  WARNING: $id could not be installed or enabled - see: docker compose logs app"
			return 0
		fi
		have="$(occ app:list --output=json | jq -r --arg a "$id" '.enabled[$a] // empty')" || have=""
	fi
	if [ "$have" = "$pinned" ]; then
		log "  $id $have"
	else
		log "  WARNING: $id is ${have:-not enabled}, pinned $pinned"
	fi
}

# Team folders: folders that belong to a group, not to one person. Every member sees the folder at
# the top of their NoDrive and the files stay when someone leaves. Nothing is set here: advanced
# permissions stay off and there is no quota, unless one is set per folder. The folders for real
# teams are made through the app's API or occ (docs/apps.md, "Team folders").
log "team folders (groupfolders)"
nourax_app groupfolders 23.0.1

# NoTasks, NoNotes, NoForms. Their app-menu names are in config/nextcloud/app-labels.d/50-apps.conf;
# their texts are reworded by the branding sweep (20-branding.sh, and the nourax_branding app as soon
# as an app is switched on or updated). Nothing is set here: each app keeps its own defaults.
# - Tasks: to-do lists. They are calendars with tasks (CalDAV VTODO), so they sync to phones like
#   NoCalendar and are kept in the database.
# - Notes: Markdown notes, kept as .md files in each person's NoDrive folder "Notes", so they are
#   in the backups and are virus-scanned and searchable like any other file.
# - Forms: forms and surveys; questions and answers are kept in the database.
log "NoTasks, NoNotes, NoForms (tasks, notes, forms)"
nourax_app tasks 0.18.1
nourax_app notes 6.1.0
nourax_app forms 5.4.1

# What the three apps show that the text sweep can't reach, because it is in their browser code:
# - NoNotes: "Mobile apps" (on the empty-notes page and in the settings) shows store badges for the
#   upstream's phone apps; one link has the upstream name in its address. There are no Nourax phone
#   apps for notes yet, so the badges, that settings section and its menu entry are hidden. The
#   section has no id of its own in the app, so its menu entry links to "#settings-section_undefined".
# - NoNotes: the marker of a note in a shared folder is drawn in the upstream blue; Nourax cobalt.
# - All three: the colour picker (for example the colour of a NoTasks list) offers a swatch named
#   "Nextcloud blue" in the upstream blue; it is hidden. NoTasks lists start in Nourax cobalt anyway
#   (the theme colour).
# configure.sh writes the theme CSS fresh before this file runs; drop an older copy of the block
# anyway, so running this file on its own does not add it twice.
log "  hide the upstream phone-app badges and colour in NoTasks, NoNotes, NoForms"
apps_css_block='/* NouraxApps50:start - NoTasks, NoNotes, NoForms (scripts/configure.d/50-apps.sh) */
body:has(#content.app-notes) .help-mobile,
body:has(#content.app-notes) .app-settings-section:has(.help-mobile),
body:has(#content.app-notes) li:has(> a.navigation-list__link[href="#settings-section_undefined"]) { display: none !important; }
body:has(#content.app-notes) [fill="#0082c9" i] { fill: #2563EB !important; }
body:has(#content.app-tasks) .color-picker__simple-color-circle[style*="rgb(0, 130, 201)"],
body:has(#content.app-notes) .color-picker__simple-color-circle[style*="rgb(0, 130, 201)"],
body:has(#content.app-forms) .color-picker__simple-color-circle[style*="rgb(0, 130, 201)"] { display: none !important; }
/* NouraxApps50:end */'
apps_css="$(occ config:app:get theming_customcss customcss || true)"
apps_css="$(printf '%s\n' "$apps_css" | sed '/\/\* NouraxApps50:start/,/\/\* NouraxApps50:end \*\//d')"
occ config:app:set theming_customcss customcss --value="$apps_css"$'\n'"$apps_css_block" \
	--no-lazy --no-interaction >/dev/null
occ config:app:set theming_customcss cachebuster --value="$(date +%s)"
unset apps_css apps_css_block
