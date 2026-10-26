#!/usr/bin/env bash
# The switch for privacy between organisations (docs/teams.md#the-switch), with privacy on, without
# switching it off. Run it on the server: sudo tests/org-privacy-switch.sh
#
# One list, three ways in: the nourax_api service OrgPrivacySwitch is behind the occ command
# nourax_api:org-privacy, the configure step scripts/configure.d/60-org-privacy.sh and the admin
# page "Nourax Workspace". This checks:
# - tests/org-privacy-switch.php (the list, status, dry runs, the lock, the page's texts);
# - occ nourax_api:org-privacy status: on, the stored step on, sharing limited, every setting on,
#   federation and circles disabled; nourax_api:status says the same;
# - occ ... off --dry-run lists the changes and changes nothing; on (already on) changes nothing
#   and writes an audit row "unchanged" by "tests" (read back through the signed admin API);
#   a wrong action or --by is refused;
# - the configure step: ORG_PRIVACY=off with ORG_PRIVACY_DRY_RUN=1 only logs, a plain run keeps it
#   on and changes nothing, ORG_PRIVACY=maybe stops with an error and changes nothing;
# - the admin page's route through Cloudflare: no session -> 401, a normal QA person's app
#   password (qa-t6b-2) -> 403 for both the GET and the POST, even with the OCS header that
#   passes the CSRF check. (The page itself, a real switch and the CSRF refusal are checked from
#   the owner's PC by tests/org-privacy-page.sh: the settings pages are open only there.)
#
# It takes the server-change lock. It changes nothing but audit rows (on, already on). Keys and
# passwords are never printed. Exit 0 when every check passes.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_admin_key
take_lock

ROUTE="https://${DRIVE_HOST}/apps/nourax_api/admin/org-privacy"
QA_NORMAL=qa-t6b-2

privacy() { occ nourax_api:org-privacy "$@" </dev/null; }
same_values() { # a snapshot of every value of the switch, the apps and the step
	privacy status | jq -c '{items: [.items[] | [.id, .value]], apps: (.apps | map_values(.enabled)), step}'
}
step_run() { # runs the configure step in a subshell with the given environment; prints its log
	env "$@" bash -c '. "$1/scripts/lib.sh"; load_env; . "$1/scripts/configure.d/60-org-privacy.sh"' _ "$REPO_DIR" 2>&1
}

log "--- the service, inside the app container"
if dc exec -T -u www-data app php < "$REPO_DIR/tests/org-privacy-switch.php" > "$T_OUT/php.log" 2>&1; then
	check "tests/org-privacy-switch.php" pass pass
else
	check "tests/org-privacy-switch.php" pass fail
fi
sed 's/^/  /' "$T_OUT/php.log"

log "--- occ nourax_api:org-privacy status"
privacy status > "$T_OUT/status.json"
check "status: state on" on "$(jq -r .state "$T_OUT/status.json")"
check "status: the stored step is on" on "$(jq -r .step "$T_OUT/status.json")"
check "status: sharing is limited (OrgPrivacy refuses across organisations)" true "$(jq -r .sharing_limited "$T_OUT/status.json")"
check "status: 21 settings" 21 "$(jq '.items | length' "$T_OUT/status.json")"
check "status: no setting off or different" "" "$(jq -r '[.items[] | select(.now == "off" or .now == "other") | .id] | join(" ")' "$T_OUT/status.json")"
check "status: federation and circles disabled" "false false" "$(jq -r '"\(.apps.federation.enabled) \(.apps.circles.enabled)"' "$T_OUT/status.json")"
occ nourax_api:status </dev/null > "$T_OUT/nx.json"
check "nourax_api:status: org_privacy, org_privacy_step, org_privacy_switch" "on on on" \
	"$(jq -r '"\(.org_privacy) \(.org_privacy_step) \(.org_privacy_switch)"' "$T_OUT/nx.json")"

log "--- dry run of off, and on while on"
before="$(same_values)"
privacy off --dry-run --by=tests > "$T_OUT/dry.json"
check "off --dry-run: would switch off" "would_switch_off true" "$(jq -r '"\(.result) \(.dry_run)"' "$T_OUT/dry.json")"
check "off --dry-run: lists both apps and the step" yes "$(yes_no jq -e '(.changed | index("app federation enabled")) and (.changed | index("app circles enabled")) and (.changed | index("nourax_api org_privacy_step = off"))' "$T_OUT/dry.json")"
# Every setting whose two values differ (15 while NoForms is enabled), both apps and the step.
check "off --dry-run: each differing setting, 2 apps and the step" \
	"$(jq '[.items[] | select(.now != "not_used" and .on != .off)] | length + 3' "$T_OUT/status.json")" \
	"$(jq '.changed | length' "$T_OUT/dry.json")"
check "off --dry-run: 15 settings while NoForms is enabled (else 13), 2 apps and the step" \
	"$(if occ app:list --output=json </dev/null | jq -e '.enabled.forms != null' >/dev/null; then echo 18; else echo 16; fi)" \
	"$(jq '.changed | length' "$T_OUT/dry.json")"
check "off --dry-run changed nothing" "$before" "$(same_values)"
check "off --dry-run: still on" on "$(jq -r .state "$T_OUT/dry.json")"

privacy on --by=tests > "$T_OUT/on.json"
check "on while on: unchanged, nothing changed" "unchanged 0" "$(jq -r '"\(.result) \(.changed | length)"' "$T_OUT/on.json")"
check "on while on changed nothing" "$before" "$(same_values)"
check "audit: the newest org-privacy row is occ, by tests, unchanged" "occ CLI tests unchanged 0" \
	"$(admin_api GET '/v1/admin/audit?limit=20' >/dev/null; jq -r '[.rows[] | select(.route == "org-privacy")][0] | "\(.key_id) \(.method) \(.target) \(.result) \(.http_status)"' "$T_OUT/body")"

code=0
privacy maybe > "$T_OUT/bad.json" || code=$?
check "a wrong action: exit 1, invalid_action" "1 invalid_action" "$code $(jq -r .error "$T_OUT/bad.json")"
code=0
privacy on '--by=two words' > "$T_OUT/bad.json" || code=$?
check "a wrong --by: exit 1, invalid_by" "1 invalid_by" "$code $(jq -r .error "$T_OUT/bad.json")"
check "the refusals changed nothing" "$before" "$(same_values)"

log "--- the configure step"
step_run ORG_PRIVACY=off ORG_PRIVACY_DRY_RUN=1 > "$T_OUT/step-dry.log" || true
sed 's/^/  /' "$T_OUT/step-dry.log"
check "step, ORG_PRIVACY=off dry run: logs it would switch off" yes \
	"$(grep -q 'org privacy: on (would_switch_off)' "$T_OUT/step-dry.log" && grep -q 'app circles enabled' "$T_OUT/step-dry.log" && echo yes || echo no)"
check "step, dry run changed nothing" "$before" "$(same_values)"
step_run > "$T_OUT/step.log" || true
sed 's/^/  /' "$T_OUT/step.log"
check "step, plain run: keeps it on, nothing changed" yes "$(grep -q 'org privacy: on (unchanged); nourax_api: on' "$T_OUT/step.log" && echo yes || echo no)"
code=0
step_run ORG_PRIVACY=maybe > "$T_OUT/step-bad.log" || code=$?
check "step, ORG_PRIVACY=maybe: stops with the error" "1 yes" "$code $(grep -q "ORG_PRIVACY must be on or off, not 'maybe'" "$T_OUT/step-bad.log" && echo yes || echo no)"
check "step runs changed nothing" "$before" "$(same_values)"

log "--- the admin page's route, through Cloudflare"
check "GET without a session -> 401" 401 "$(curl -sS -H 'Accept: application/json' -o "$T_OUT/r" -w '%{http_code}' "$ROUTE")"
check "POST without a session -> 401" 401 "$(curl -sS -X POST -H 'Accept: application/json' -H 'Content-Type: application/json' \
	--data-binary '{"state":"off"}' -o "$T_OUT/r" -w '%{http_code}' "$ROUTE")"
NETRC="$(qa_netrc "$QA_NORMAL")"
[ -s "$NETRC" ] || die "$NETRC is missing (tests/privacy-apps.sh makes it)"
check "$QA_NORMAL is no admin" no "$(occ user:info "$QA_NORMAL" --output=json </dev/null | jq -r 'if (.groups | index("admin")) then "yes" else "no" end')"
check "GET as $QA_NORMAL (app password) -> 403" 403 "$(curl -sS --netrc-file "$NETRC" -H 'Accept: application/json' \
	-H 'OCS-APIRequest: true' -o "$T_OUT/r" -w '%{http_code}' "$ROUTE")"
check "POST off as $QA_NORMAL (app password, OCS header) -> 403" 403 "$(curl -sS -X POST --netrc-file "$NETRC" \
	-H 'Accept: application/json' -H 'OCS-APIRequest: true' -H 'Content-Type: application/json' \
	--data-binary '{"state":"off"}' -o "$T_OUT/r" -w '%{http_code}' "$ROUTE")"
log "  the answer: $(head -c 200 "$T_OUT/r")"
check "after the refused POST: still on, nothing changed" "$before" "$(same_values)"

finish org-privacy-switch
