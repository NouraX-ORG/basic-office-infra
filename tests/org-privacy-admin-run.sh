#!/usr/bin/env bash
# ONLY WITH THE OWNER'S YES: the real Off and On through the admin page, in one command, on the
# owner's PC (Git Bash, from the repo at origin/main; docs/teams.md#the-switch):
#
#   tests/org-privacy-admin-run.sh --owner-yes
#
# 0. The read-only checks of --check (below); any FAIL stops it before anything changes.
# 1. On the server: tests/org-privacy-admin-window.sh start (it waits for the server-change lock,
#    opens only while privacy is on, enables qa-t6b-admin and adds it to "admin" for at most 10
#    minutes).
# 2. Copies qa-t6b-admin's login password and TOTP file from /etc/nourax/qa into a private
#    temporary folder on this PC by piping ssh into the files (never shown), and runs
#    tests/org-privacy-page.sh admin with it.
# 3. On the server, always, also after a failure or Ctrl+C: tests/org-privacy-admin-window.sh
#    stop (privacy on, qa-t6b-admin out of "admin" and disabled, the audit rows checked), then
#    occ nourax_api:org-privacy status, occ nourax_api:status, tests/privacy.sh and
#    tests/privacy-apps.sh.
# The temporary folder is removed at the end. Exit 0 only when every step passed.
#
#   tests/org-privacy-admin-run.sh --check
#
# needs no yes: read only, it changes nothing on the server and opens no window. It checks what the
# run needs: ssh works; the server's checkout and this one are at origin/main (the page test and
# the rules it reads are origin/main's); python is there; the sign-in page answers 200 here (the
# owner's address); the switch's address answers 401 without a session (its route is live); and
# on the server tests/org-privacy-admin-window.sh check (privacy on, qa-t6b-admin disabled and not
# in "admin", its login files there, no window open). Exit 0 when the run can start.
# NOURAX_SSH_KEY and NOURAX_SSH_HOST override the key and the server.
# SPDX-License-Identifier: AGPL-3.0-or-later

# shellcheck source=../scripts/lib.sh
. "$(dirname "$0")/../scripts/lib.sh"

case "${1:-}" in
--owner-yes | --check) ;;
*) die "this makes qa-t6b-admin an admin for a few minutes and switches privacy off for a few seconds; run it only with the owner's yes: tests/org-privacy-admin-run.sh --owner-yes (or --check, read only)" ;;
esac
SSH_KEY="${NOURAX_SSH_KEY:-$HOME/.ssh/nourax_workspace_ed25519}"
SSH_HOST="${NOURAX_SSH_HOST:-nourax@57.129.185.78}"
BASE="https://${DRIVE_HOST:-drive.nourax.org}"
remote() { ssh -i "$SSH_KEY" -o BatchMode=yes -o IdentitiesOnly=yes "$SSH_HOST" "cd /opt/nourax/basic-office-infra && $1"; }

# The read-only checks: all of --check, and the first step of the run itself.
preflight() {
	local main server code
	bad=0
	ok() { log "ok   $*"; }
	no() { log "FAIL $*"; bad=1; }
	git -C "$REPO_DIR" fetch -q origin 2>/dev/null || no "git fetch origin failed here"
	main="$(git -C "$REPO_DIR" rev-parse origin/main)"
	server="$(remote 'git rev-parse HEAD' 2>/dev/null || echo none)"
	if [ "$server" = none ]; then no "ssh to $SSH_HOST"; else ok "ssh to $SSH_HOST works"; fi
	if [ "$server" = "$main" ]; then ok "the server's checkout is at origin/main (${main:0:7})"; else no "the server's checkout is at ${server:0:7}, origin/main at ${main:0:7}"; fi
	if [ "$(git -C "$REPO_DIR" rev-parse HEAD)" = "$main" ] && git -C "$REPO_DIR" diff --quiet origin/main -- tests nextcloud-apps/nourax_branding/sweep/rules.json; then
		ok "this checkout is at origin/main (${main:0:7})"
	else
		no "this checkout is not at origin/main ${main:0:7}, or its tests differ (git switch main and git pull first)"
	fi
	if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then ok "python is there"; else no "python3 (or python) is needed"; fi
	code="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/login" || true)"
	if [ "$code" = 200 ]; then ok "the sign-in page answers 200 here (the owner's address)"; else no "the sign-in page answers $code here (only the owner's address gets 200)"; fi
	code="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Accept: application/json' "$BASE/apps/nourax_api/settings/org-privacy" || true)"
	if [ "$code" = 401 ]; then ok "the switch's address answers 401 without a session (its route is live)"; else no "the switch's address answers $code without a session (401 expected)"; fi
	log "--- on the server: tests/org-privacy-admin-window.sh check"
	remote 'sudo tests/org-privacy-admin-window.sh check' || bad=1
	[ "$bad" = 0 ] || die "the owner's run could not start yet (see above)"
}
preflight
if [ "$1" = --check ]; then
	log "ready: with the owner's yes, run tests/org-privacy-admin-run.sh --owner-yes"
	exit 0
fi

umask 077
CREDS="$(mktemp -d)"
opened=0
stop_rc=0
close_window() {
	[ "$opened" = 1 ] || return 0
	opened=0
	log "--- closing the window on the server"
	remote 'sudo tests/org-privacy-admin-window.sh stop' || stop_rc=$?
}
trap 'close_window; rm -rf "$CREDS"' EXIT
trap 'exit 130' INT TERM

log "--- the server's checkout: $(remote 'git log --oneline -1')"
log "--- opening the window on the server (waits for the server-change lock)"
opened=1
remote 'sudo tests/org-privacy-admin-window.sh start'
for f in pass totp; do
	remote "sudo cat /etc/nourax/qa/qa-t6b-admin.$f" > "$CREDS/qa-t6b-admin.$f"
	[ -s "$CREDS/qa-t6b-admin.$f" ] || die "could not copy qa-t6b-admin.$f"
done

log "--- the admin page, as qa-t6b-admin"
page_rc=0
"$REPO_DIR/tests/org-privacy-page.sh" admin "$CREDS" || page_rc=$?
close_window

log "--- privacy after the window"
remote 'sudo docker compose exec -T -u www-data app php occ nourax_api:org-privacy status | jq -c "{state, step, sharing_limited, apps: (.apps | map_values(.enabled))}"; sudo docker compose exec -T -u www-data app php occ nourax_api:status | jq -c "{org_privacy, org_privacy_step, org_privacy_switch}"'
after_rc=0
remote 'sudo tests/privacy.sh' > "$CREDS/privacy.log" 2>&1 || after_rc=$?
grep -E 'FAIL|all .* checks passed' "$CREDS/privacy.log" || true
remote 'sudo tests/privacy-apps.sh' > "$CREDS/privacy-apps.log" 2>&1 || after_rc=$?
log "  privacy-apps PASS lines: $(grep -c PASS "$CREDS/privacy-apps.log" || true)"
grep -E 'FAIL|LEAK|all .* checks passed' "$CREDS/privacy-apps.log" || true

log "--- results: page test exit $page_rc, window end checks exit $stop_rc, privacy tests exit $after_rc"
[ "$page_rc" = 0 ] && [ "$stop_rc" = 0 ] && [ "$after_rc" = 0 ] || die "not every step passed (see above)"
log "the admin page's Off and On passed, and privacy is on"
