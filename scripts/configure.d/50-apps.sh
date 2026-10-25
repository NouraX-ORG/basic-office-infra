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

# NoForms and privacy between organisations (scripts/configure.d/60-org-privacy.sh, docs/teams.md).
# Two NoForms options reach every account on the server, across organisations: "show to all
# accounts" lists a form in everyone's NoForms, and "all accounts may open it" lets anyone signed in
# fill it in (tested on 2026-10-25: a form of qa-t5-1 showed up for qa-t5-3, who shares no group with
# qa-t5-1). While org privacy is on, both options are off, so a form reaches only the people, groups
# and teams it is shared with, and whoever has its public link. Forms that already use them stop
# reaching everyone at once. While org privacy is off nothing is changed here; to give the options
# back: occ config:app:set forms allowPermitAll --value=true --type=boolean (and allowShowToAll).
if [ "$(occ config:app:get nourax_api org_privacy_step 2>/dev/null || true)" = on ]; then
	for forms_key in allowPermitAll allowShowToAll; do
		# occ prints a stored boolean false as 0.
		case "$(occ config:app:get forms "$forms_key" 2>/dev/null || true)" in
			0 | false) ;;
			*) occ config:app:set forms "$forms_key" --value=false --type=boolean >/dev/null ;;
		esac
		log "  NoForms $forms_key = false (org privacy is on)"
	done
	unset forms_key
else
	log "  NoForms 'all accounts' options left as they are (org privacy is off)"
fi

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

# Retention and automatic tagging. Both work with collaborative tags (system tags), and their rules
# are made in Administration settings, "Flow", or through their admin APIs. They are installed with
# NO rules: a retention rule deletes files, and which files get which tag is the owner's choice, so
# every rule needs the owner's yes. Example rules with their exact API bodies: docs/apps.md,
# "Retention" and "Automatic tagging".
# - files_retention: deletes files that carry a given tag once they are a given age (counted from
#   when they were uploaded or from their last change). Deleted files go to the trash bin first.
# - files_automatedtagging: gives a file a tag when it is uploaded or changed and matches a rule
#   (folder, file type, size, name and so on). It deletes nothing.
log "retention and automatic tagging (files_retention, files_automatedtagging), no rules here"
nourax_app files_retention 6.0.0
nourax_app files_automatedtagging 6.0.1
