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
