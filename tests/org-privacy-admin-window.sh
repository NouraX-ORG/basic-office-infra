#!/usr/bin/env bash
# ONLY WITH THE OWNER'S YES: makes the QA account qa-t6b-admin an admin for a few minutes, so
# tests/org-privacy-page.sh admin can switch privacy Off and straight back On through the admin
# page from the owner's PC (docs/teams.md#the-switch). Run it on the server:
#
#   sudo tests/org-privacy-admin-window.sh check   # read only: would start open? (no yes needed)
#   sudo tests/org-privacy-admin-window.sh start   # enable qa-t6b-admin, add it to "admin", hold the lock
#   ... on the owner's PC: tests/org-privacy-page.sh admin <creds-dir>
#   sudo tests/org-privacy-admin-window.sh stop    # end the window now and show what it did
#
# "check" changes nothing and takes no lock: privacy is on, qa-t6b-admin exists, is disabled and
# is not in "admin", "admin" holds only nodrive, the account's password and TOTP files are there
# (0600, root; never read), no window is open, the admin key is there, the scripts the window runs
# parse, and the switch's address answers 401 without a session (its route is live). It says who
# holds the server-change lock, if anyone (start waits for it). Exit 0 when all of these hold.
#
# (tests/org-privacy-admin-run.sh --owner-yes, on the owner's PC, does all three in one go.)
#
# "start" opens the window only while privacy is on. It takes the server-change lock and keeps it
# in a background process for the whole window (10 minutes at most), so no other server change
# runs meanwhile. At the end of the window, by "stop" or by the time limit, whatever the PC test
# did: privacy is switched on (occ nourax_api:org-privacy on --by=admin-window; "unchanged" when
# the test switched it back on), qa-t6b-admin is taken out of "admin" and disabled, the audit rows
# of the window are checked (tests/org-privacy-audit.sh: switched_off then switched_on from the
# admin page, with the client's address, less than 20 s apart), and the lock is let go. "stop"
# prints the log (/run/nourax-t6b-admin-window.log) and exits 0 only when privacy is on, the
# account is out of "admin" and disabled, and the audit check passed. It deletes nothing and
# prints no secret.
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail
cd "$(dirname "$0")/.."
QA_ADMIN=qa-t6b-admin
READY=/run/nourax-t6b-admin-window.ready
DONE=/run/nourax-t6b-admin-window.done
RESULT=/run/nourax-t6b-admin-window.result
LOG=/run/nourax-t6b-admin-window.log
LIMIT=600
[ "$(id -u)" -eq 0 ] || { echo "run this with sudo" >&2; exit 1; }
occ() { docker compose exec -T -u www-data app php occ "$@" </dev/null; }
say() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S')" "$*"; }
privacy_state() { occ nourax_api:org-privacy status | jq -r .state; }

window() {
	exec 9>/run/nourax-deploy.lock
	say "waiting for /run/nourax-deploy.lock"
	flock -w 1800 9 || { say "could not take the lock"; echo 1 > "$RESULT"; exit 1; }
	say "lock taken"
	if [ "$(privacy_state)" != on ]; then
		say "privacy is not on, so the window stays closed"
		echo 1 > "$RESULT"
		exit 1
	fi
	opened="$(date +%s)"
	occ user:enable "$QA_ADMIN" && occ group:adduser admin "$QA_ADMIN" && say "$QA_ADMIN enabled and added to admin"
	occ user:info "$QA_ADMIN" --output=json | jq -c '{user_id, enabled, groups}'
	touch "$READY"
	local until=$((SECONDS + LIMIT))
	while [ ! -e "$DONE" ] && [ "$SECONDS" -lt "$until" ]; do sleep 2; done
	say "window ends: $([ -e "$DONE" ] && echo stop || echo "time limit of $LIMIT s")"
	local ok=0
	occ nourax_api:org-privacy on --by=admin-window | jq -c '{result, state, changed}' || say "PRIVACY NOT SWITCHED ON - check now"
	occ group:removeuser admin "$QA_ADMIN" && say "$QA_ADMIN taken out of admin"
	occ user:disable "$QA_ADMIN" && say "$QA_ADMIN disabled"
	occ user:info "$QA_ADMIN" --output=json | jq -c '{user_id, enabled, groups}'
	occ group:list --output=json | jq -c '{admin: .admin}'
	occ nourax_api:status | jq -c '{org_privacy, org_privacy_step, org_privacy_switch}'
	if [ "$(privacy_state)" = on ]; then say "privacy is on"; else say "PRIVACY IS NOT ON - check now"; ok=1; fi
	if occ user:info "$QA_ADMIN" --output=json | jq -e '.enabled == false and (.groups | index("admin") | not)' >/dev/null; then
		say "$QA_ADMIN is disabled and not in admin"
	else
		say "$QA_ADMIN IS STILL ENABLED OR IN ADMIN - check now"
		ok=1
	fi
	say "the audit rows of the window (since $(date -u -d "@$opened" '+%H:%M:%S') UTC):"
	bash tests/org-privacy-audit.sh "$opened" "$QA_ADMIN" 2>&1 || ok=1
	echo "$ok" > "$RESULT"
	rm -f "$READY" "$DONE"
	say "lock let go"
}

preflight() {
	local bad=0 info admins file code holders secret drive
	ok() { say "ok   $*"; }
	no() { say "FAIL $*"; bad=1; }
	if [ "$(privacy_state)" = on ]; then ok "privacy is on"; else no "privacy is not on, so start would stay closed"; fi
	info="$(occ user:info "$QA_ADMIN" --output=json 2>/dev/null || true)"
	if jq -e '.enabled == false and ((.groups // []) | index("admin") | not)' <<<"$info" >/dev/null 2>&1; then
		ok "$QA_ADMIN exists, is disabled and is not in admin"
	else
		no "$QA_ADMIN is missing, enabled or in admin: $(jq -c '{user_id, enabled, groups}' <<<"$info" 2>/dev/null || echo none)"
	fi
	admins="$(occ group:list --output=json | jq -c .admin)"
	if [ "$admins" = '["nodrive"]' ]; then ok "admin holds only nodrive"; else no "admin holds $admins"; fi
	for file in "/etc/nourax/qa/$QA_ADMIN.pass" "/etc/nourax/qa/$QA_ADMIN.totp"; do
		if [ -s "$file" ] && [ "$(stat -c '%a %U' "$file")" = "600 root" ]; then ok "$file is there (0600, root)"; else no "$file is missing, empty or not 0600 root"; fi
	done
	if [ ! -e "$READY" ]; then ok "no window is open"; else no "a window is open already ($READY)"; fi
	# The secret's path and the host from .env, in subshells (scripts/lib.sh has its own occ()).
	secret="$(. scripts/lib.sh; load_env; secret_path nodrive_admin_api_key)" || secret=""
	drive="$(. scripts/lib.sh; load_env; printf '%s' "${DRIVE_HOST:-}")" || drive=""
	if [ -n "$secret" ] && [ -s "$secret" ]; then ok "the admin key is there (for the audit check)"; else no "the admin key nodrive_admin_api_key is missing"; fi
	for file in "$0" tests/org-privacy-audit.sh tests/lib.sh; do
		if bash -n "$file"; then ok "bash -n $file"; else no "bash -n $file"; fi
	done
	code="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Accept: application/json' \
		"https://${drive:-drive.nourax.org}/apps/nourax_api/settings/org-privacy" || true)"
	if [ "$code" = 401 ]; then ok "the switch's address answers 401 without a session (its route is live)"; else no "the switch's address answers $code without a session (401 expected)"; fi
	holders="$(lsof -t /run/nourax-deploy.lock 2>/dev/null | tr '\n' ' ' || true)"
	say "info: the server-change lock is ${holders:+held by pid(s) $holders; start waits for it}${holders:-free}"
	say "checkout: $(git log --oneline -1)"
	return "$bad"
}

case "${1:-}" in
check) preflight ;;
start)
	[ ! -e "$READY" ] || { echo "a window is open already" >&2; exit 1; }
	rm -f "$DONE" "$RESULT"
	setsid bash "$0" window > "$LOG" 2>&1 < /dev/null &
	for _ in $(seq 1 900); do
		[ -e "$READY" ] || [ -e "$RESULT" ] && break
		sleep 2
	done
	cat "$LOG"
	[ -e "$READY" ] || { echo "the window did not open (see $LOG)" >&2; exit 1; }
	echo "open: run tests/org-privacy-page.sh admin <creds-dir> on the owner's PC, then: sudo $0 stop"
	;;
stop)
	touch "$DONE"
	for _ in $(seq 1 90); do
		[ -e "$READY" ] || break
		sleep 2
	done
	cat "$LOG"
	[ "$(cat "$RESULT" 2>/dev/null || echo 1)" = 0 ] || { echo "the window's end checks did not all pass (see above)" >&2; exit 1; }
	;;
window) window ;;
*)
	echo "usage: sudo $0 check|start|stop" >&2
	exit 2
	;;
esac
