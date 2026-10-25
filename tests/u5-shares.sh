#!/usr/bin/env bash
# U5 of the NoMail contract (docs/nomail-contract.md): the person sees and cancels the links
# NoMail made. NoMail lists them (GET .../shares, share_type 3 only) and cancels one with
# DELETE .../shares/<id>; a link that is already gone counts as cancelled (404).
# Run it on the server: sudo tests/u5-shares.sh (or all five with tests/nomail-contract.sh).
#
# As qa-t6-1 (CONTRACT_UID), with the netrc file from tests/api-provision.sh. It removes only the
# links this run made: those U2 and U4 left in $CONTRACT_STATE/shares, or, run on its own, one
# link it makes first on a small new file (the file stays). Other links of the account are never
# touched. No server change, so no lock. Exit 0 when every check passes.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
contract_setup

state="$CONTRACT_STATE/shares"
if [ ! -s "$state" ]; then
	log "U5: no links from U2 and U4 in this run, so U5 makes one of its own"
	path="/NoMail/Sent/$CONTRACT_MONTH/qa-t6-u5-$(date -u +%Y%m%d%H%M%S).txt"
	ensure_folders U5 "/NoMail/Sent/$CONTRACT_MONTH"
	check "U5 setup: PUT a small file -> 201" 201 "$(dav PUT "$path" --data-binary 'a file for U5')"
	check "U5 setup: link -> statuscode 200" "200 200" "$(public_link "$path") $(ocs_code)"
	remember_share u5-link "$(share_field id)" "$(share_field token)"
fi

check "U5 GET the shares -> HTTP 200" 200 "$(ocs GET "")"
check "U5 statuscode 200" 200 "$(ocs_code)"
check "U5 every public link listed passes NoMail's readShare" yes "$(jq -e '[.ocs.data[] | select(.share_type == 3)]
	| all((.id | tostring | test("^[0-9]+$")) and (.token | type == "string" and test("^[A-Za-z0-9_.-]{1,128}$")))' \
	"$T_OUT/ocs.json" >/dev/null && echo yes || echo no)"
cp "$T_OUT/ocs.json" "$T_OUT/list.json"
while read -r what id _; do
	check "U5 the list has the $what link ($id), share_type 3" 1 \
		"$(jq --arg id "$id" '[.ocs.data[] | select((.id | tostring) == $id and .share_type == 3)] | length' "$T_OUT/list.json")"
done < "$state"

# Only the first link's page is opened after the delete: every request for a link that is gone
# is a brute-force attempt for the caller's address (12 hours; the delay doubles each time), and
# the server's address is shared by every test. The others are checked through the API.
first=yes
while read -r what id token; do
	check "U5 DELETE the $what link -> HTTP 200" 200 "$(ocs DELETE "/$id")"
	check "U5 ... statuscode 200" 200 "$(ocs_code)"
	if [ "$first" = yes ]; then
		check "U5 ... its page /s/<token> -> 404" 404 "$(curl -sS -g -o /dev/null -w '%{http_code}' "$PUBLIC_BASE/s/$token")"
		first=no
	fi
	check "U5 GET it by id -> HTTP 404" 404 "$(ocs GET "/$id")"
	check "U5 DELETE it again -> HTTP 404 (NoMail: already gone)" 404 "$(ocs DELETE "/$id")"
	check "U5 ... statuscode 404" 404 "$(ocs_code)"
done < "$state"

check "U5 GET the shares again -> HTTP 200" 200 "$(ocs GET "")"
while read -r what id _; do
	check "U5 the $what link is no longer listed" 0 \
		"$(jq --arg id "$id" '[.ocs.data[] | select((.id | tostring) == $id)] | length' "$T_OUT/ocs.json")"
done < "$state"

finish U5
