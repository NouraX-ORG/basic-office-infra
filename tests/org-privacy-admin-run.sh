#!/usr/bin/env bash
# ONLY WITH THE OWNER'S YES: the real Off and On through the admin page, in one command, on the
# owner's PC (Git Bash, from the repo at origin/main; docs/teams.md#the-switch):
#
#   tests/org-privacy-admin-run.sh --owner-yes
#
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
# NOURAX_SSH_KEY and NOURAX_SSH_HOST override the key and the server.
# SPDX-License-Identifier: AGPL-3.0-or-later

# shellcheck source=../scripts/lib.sh
. "$(dirname "$0")/../scripts/lib.sh"

[ "${1:-}" = --owner-yes ] || die "this makes qa-t6b-admin an admin for a few minutes and switches privacy off for a few seconds; run it only with the owner's yes: tests/org-privacy-admin-run.sh --owner-yes"
SSH_KEY="${NOURAX_SSH_KEY:-$HOME/.ssh/nourax_workspace_ed25519}"
SSH_HOST="${NOURAX_SSH_HOST:-nourax@57.129.185.78}"
remote() { ssh -i "$SSH_KEY" -o BatchMode=yes -o IdentitiesOnly=yes "$SSH_HOST" "cd /opt/nourax/basic-office-infra && $1"; }

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
