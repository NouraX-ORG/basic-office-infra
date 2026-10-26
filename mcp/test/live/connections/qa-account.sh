#!/usr/bin/env bash
# Creates lane F's QA account for the MCP server's live tests of the /connections pages:
# qa-t1-f-connections-docs-1, a local account (dev mode's QA picker takes only lower-case QA ids,
# core's QA_UID_RE). It gets an email address, Deck's firstRun=no (no default board) and an app
# password for the dev env file. It needs no group: the connections pages never search for people.
# The name doesn't follow the brief's qa-t<task>-<n> pattern (DESIGN 16.3 gave lane F qa-t1-28). It
# was made once in fix round 1 and is kept, disabled between live runs; it is on the owner's deletion
# list (DESIGN 20, item 6) next to qa-t1-21 to qa-t1-30.
#
# Run it on the server from this PC, under the deploy lock, piped on stdin (the SSH options and the
# server address are in the shared brief, not in this public repo):
#   ssh <brief SSH options> nourax@<server> \
#     'cd /opt/nourax/basic-office-infra && sudo flock -w 1800 /run/nourax-deploy.lock bash -s' < mcp/test/live/connections/qa-account.sh
#
# The password and the app password stay in /etc/nourax/qa (root, directory 0700, files 0600). Only
# their lengths are printed. An account that already exists is left alone. Nothing is deleted.
# SPDX-License-Identifier: AGPL-3.0-or-later

cd /opt/nourax/basic-office-infra
# shellcheck disable=SC1091
. scripts/lib.sh
need_root
git pull -q --ff-only

umask 077
QA_DIR=/etc/nourax/qa
install -d -m 0700 "$QA_DIR"

ensure_user() { # uid display-name
	local uid="$1" pass_file="$QA_DIR/$1.pass" app_file="$QA_DIR/$1.app"
	if occ user:info "$uid" >/dev/null 2>&1 </dev/null; then
		log "$uid already exists; left as it is"
		return 0
	fi
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
}

ensure_user qa-t1-f-connections-docs-1 "QA t1 F connections docs 1"
