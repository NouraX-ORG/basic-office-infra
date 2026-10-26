#!/usr/bin/env bash
# The audit rows of a real Off and On through the admin page (docs/teams.md#the-switch), read
# through the signed admin API as NoMail would read them. Run it on the server, after
# tests/org-privacy-page.sh admin (tests/org-privacy-admin-window.sh runs it at the end of its
# window):
#
#   sudo tests/org-privacy-audit.sh SINCE [UID]
#
# SINCE is a Unix time (seconds) before the switches; UID is who switched (default qa-t6b-admin).
# GET /v1/admin/audit?target=UID must list, from SINCE on, exactly two rows of the route
# org-privacy, oldest first switched_off then switched_on, both from key id admin-page with method
# POST and HTTP status 200, with their times, and with the client's own address (the same for
# both; not empty, not this machine and not the tunnel's address, which is a trusted proxy). From
# the start of Off to the end of On must be less than 20 s. It prints the rows (no secret is in
# them). Read only: it needs no lock and changes nothing.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
need_admin_key

SINCE="${1:-}"
WHO="${2:-qa-t6b-admin}"
case "$SINCE" in '' | *[!0-9]*) die "usage: sudo tests/org-privacy-audit.sh SINCE-UNIX-TIME [UID]" ;; esac

check "GET /v1/admin/audit?target=$WHO -> 200" 200 "$(admin_api GET "/v1/admin/audit?limit=50&target=$WHO")"
# The rows since SINCE, oldest first, with their time as a Unix time.
jq -c --argjson since "$SINCE" '[.rows[]
	| select(.route == "org-privacy")
	| . + {t: (.at | sub("\\+00:00$"; "Z") | fromdateiso8601)}
	| select(.t >= $since)] | sort_by(.id)' "$T_OUT/body" > "$T_OUT/rows.json"
jq -r '.[] | "  row \(.id): \(.at) key \(.key_id) \(.method) \(.http_status) \(.result) by \(.target) from \(.remote_ip), \(.duration_ms) ms"' "$T_OUT/rows.json" | while IFS= read -r line; do log "$line"; done

check "two org-privacy rows since $(date -u -d "@$SINCE" '+%Y-%m-%d %H:%M:%S') UTC: switched_off, then switched_on" \
	"switched_off switched_on" "$(jq -r 'map(.result) | join(" ")' "$T_OUT/rows.json")"
check "both from the admin page: key id admin-page, POST, HTTP 200, by $WHO" \
	"admin-page POST 200 $WHO|admin-page POST 200 $WHO" \
	"$(jq -r 'map("\(.key_id) \(.method) \(.http_status) \(.target)") | join("|")' "$T_OUT/rows.json")"
ip="$(jq -r 'map(.remote_ip) | unique | if length == 0 then "" elif length == 1 then .[0] else "different: " + join(", ") end' "$T_OUT/rows.json")"
proxies="$(occ config:system:get trusted_proxies </dev/null 2>/dev/null | tr '\n' ' ' || true)"
real_ip=no
case "$ip" in
'' | different:* | 127.* | ::1 | 10.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].* | fc* | fd*) ;;
*) case " $proxies " in *" $ip "*) ;; *) real_ip=yes ;; esac ;;
esac
check "both with the client's own address (not empty, private, local or the tunnel's): $ip" yes "$real_ip"
# From the start of Off (its row's time less its duration) to the end of On.
window="$(jq -r 'if length == 2 then (.[1].t - .[0].t + .[0].duration_ms / 1000) else "none" end' "$T_OUT/rows.json")"
log "  privacy was off for about $window s (row times are whole seconds)"
check "Off to On: less than 20 s" yes "$(awk -v s="$window" 'BEGIN { print (s != "none" && s + 0 < 20 ? "yes" : "no") }')"

finish org-privacy-audit
