#!/usr/bin/env bash
# Creates the QA accounts for lane G (NoGantt) of the MCP server's live tests: local accounts
# qa-t1-g-gantt-1 and qa-t1-g-gantt-3 in the QA group qa-t1-g-org-a ("organisation A"), and
# qa-t1-g-gantt-2 in qa-t1-g-org-b ("organisation B"). With privacy between organisations on, a
# person finds and shares only with people who share a group with them (docs/teams.md), so these
# two groups stand for two organisations. Each account gets an email address, Deck's firstRun=no
# (no default board) and an app password for the dev env file.
#
# Run it on the server from this PC, under the deploy lock, piped on stdin (the SSH options and the
# server address are in the shared brief, not in this public repo):
#   ssh <brief SSH options> nourax@<server> \
#     'cd /opt/nourax/basic-office-infra && sudo flock -w 1800 /run/nourax-deploy.lock bash -s' < mcp/test/live/gantt/qa-accounts.sh
#
# Passwords and app passwords stay in /etc/nourax/qa (root, directory 0700, files 0600). Only their
# lengths are printed. An account or group that already exists is left alone. Nothing is deleted.
# SPDX-License-Identifier: AGPL-3.0-or-later

cd /opt/nourax/basic-office-infra
# shellcheck disable=SC1091
. scripts/lib.sh
need_root
git pull -q --ff-only

umask 077
QA_DIR=/etc/nourax/qa
install -d -m 0700 "$QA_DIR"

ensure_group() { # gid display-name
	if occ group:info "$1" >/dev/null 2>&1 </dev/null; then
		log "group $1 already exists"
	else
		occ group:add --display-name "$2" "$1" </dev/null >/dev/null
		log "group $1 created"
	fi
}

ensure_user() { # uid display-name group
	local uid="$1" pass_file="$QA_DIR/$1.pass" app_file="$QA_DIR/$1.app"
	if occ user:info "$uid" >/dev/null 2>&1 </dev/null; then
		log "$uid already exists; left as it is"
	else
		openssl rand -base64 30 | tr -d '\n=' >"$pass_file"
		chmod 600 "$pass_file"
		# The password travels in the environment of docker compose, never on a command line.
		OC_PASS="$(cat "$pass_file")" dc exec -T -e OC_PASS -u www-data app \
			php occ user:add --password-from-env --display-name "$2" "$uid" </dev/null >/dev/null
		occ user:setting "$uid" settings email "$uid@example.invalid" </dev/null >/dev/null
		occ user:setting "$uid" deck firstRun no </dev/null >/dev/null
		OC_PASS="$(cat "$pass_file")" dc exec -T -e OC_PASS -u www-data app \
			php occ user:auth-tokens:add --password-from-env --name "qa mcp" "$uid" </dev/null | tail -n 1 | tr -d '\r\n' >"$app_file"
		chmod 600 "$app_file"
		[ -s "$app_file" ] || die "$uid: no app password was made"
		log "$uid created (password $(wc -c <"$pass_file") characters, app password $(wc -c <"$app_file") characters)"
	fi
	occ group:adduser "$3" "$uid" </dev/null >/dev/null
	log "$uid is in $3"
}

ensure_group qa-t1-g-org-a "QA t1 g organisation A"
ensure_group qa-t1-g-org-b "QA t1 g organisation B"
ensure_user qa-t1-g-gantt-1 "QA t1 g gantt 1" qa-t1-g-org-a
ensure_user qa-t1-g-gantt-2 "QA t1 g gantt 2" qa-t1-g-org-b
ensure_user qa-t1-g-gantt-3 "QA t1 g gantt 3" qa-t1-g-org-a
