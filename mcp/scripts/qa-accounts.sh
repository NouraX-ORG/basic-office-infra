#!/usr/bin/env bash
# Creates the Task 1 QA accounts for the MCP server's live tests (DESIGN 16.3): local accounts
# qa-t1-21 to qa-t1-30, each with an email address (calendar scheduling needs one) and an app
# password for the dev env file. Every account except qa-t1-27 also gets Deck's firstRun=no, so no
# default board is made (qa-t1-27 keeps it, to test the brand mapping).
#
# Run it on the server from this PC, under the deploy lock, piped on stdin (the SSH options and the
# server address are in the shared brief, not in this public repo):
#   ssh <brief SSH options> nourax@<server> \
#     'cd /opt/nourax/basic-office-infra && sudo flock -w 1800 /run/nourax-deploy.lock bash -s' < mcp/scripts/qa-accounts.sh
#
# Passwords and app passwords stay in /etc/nourax/qa (root, directory 0700, files 0600). Only their
# lengths are printed. An account that already exists is left alone. Nothing is deleted.
# SPDX-License-Identifier: AGPL-3.0-or-later

cd /opt/nourax/basic-office-infra
# shellcheck disable=SC1091
. scripts/lib.sh
need_root
git pull -q --ff-only

umask 077
QA_DIR=/etc/nourax/qa
install -d -m 0700 "$QA_DIR"

first="${QA_FIRST:-21}"
last="${QA_LAST:-30}"

for n in $(seq "$first" "$last"); do
	uid="qa-t1-$n"
	if occ user:info "$uid" >/dev/null 2>&1 </dev/null; then
		log "$uid already exists; left as it is"
		continue
	fi
	pass_file="$QA_DIR/$uid.pass"
	app_file="$QA_DIR/$uid.app"
	openssl rand -base64 30 | tr -d '\n=' >"$pass_file"
	chmod 600 "$pass_file"
	# The password travels in the environment of docker compose, never on a command line.
	OC_PASS="$(cat "$pass_file")" dc exec -T -e OC_PASS -u www-data app \
		php occ user:add --password-from-env --display-name "QA t1 $n" "$uid" </dev/null >/dev/null
	occ user:setting "$uid" settings email "$uid@example.invalid" </dev/null >/dev/null
	if [ "$n" != "27" ]; then
		occ user:setting "$uid" deck firstRun no </dev/null >/dev/null
	fi
	OC_PASS="$(cat "$pass_file")" dc exec -T -e OC_PASS -u www-data app \
		php occ user:auth-tokens:add --password-from-env --name "qa mcp" "$uid" </dev/null | tail -n 1 | tr -d '\r\n' >"$app_file"
	chmod 600 "$app_file"
	[ -s "$app_file" ] || die "$uid: no app password was made"
	log "$uid created (password $(wc -c <"$pass_file") characters, app password $(wc -c <"$app_file") characters)"
done
