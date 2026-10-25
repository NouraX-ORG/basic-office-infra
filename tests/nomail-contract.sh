#!/usr/bin/env bash
# The NoMail contract tests U1-U5 (docs/nomail-contract.md): what NoMail's drive-files function
# does with a person's Drive, one script per use case, with NoMail's own requests, as a QA
# account with its "NoMail" app password from /v1/provision, through Cloudflare like NoMail.
# Run it on the server, from the checkout:
#   sudo tests/nomail-contract.sh            # U1 to U5
#   sudo tests/nomail-contract.sh u3 u4 u5   # some of them (U5 then removes only U4's link)
#
#   U1 tests/u1-list-download.sh   list folders and download a file
#   U2 tests/u2-big-upload.sh      a real 1.1 GB chunked upload to /NoMail/Sent/<yyyy-mm>/, links
#                                  with an end date and with a password
#   U3 tests/u3-save-received.sh   save into /NoMail/Received/<yyyy-mm>/
#   U4 tests/u4-raw-image.sh       a picture link for <img src>
#   U5 tests/u5-shares.sh          list and cancel the links U2 and U4 made
#
# Needs qa-t6-1's netrc file (made by tests/api-provision.sh). No server change, so no lock.
# U2 takes a few minutes and adds a 1.1 GB file to the QA account each run. Prints one PASS or
# FAIL line per use case at the end and exits 0 only when all of them passed.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
contract_setup

CONTRACT_STATE="$(mktemp -d)"
export CONTRACT_STATE
trap 'rm -rf "$T_OUT" "$CONTRACT_STATE"' EXIT

declare -A scripts=([u1]=u1-list-download [u2]=u2-big-upload [u3]=u3-save-received [u4]=u4-raw-image [u5]=u5-shares)
wanted=("$@")
[ "${#wanted[@]}" -gt 0 ] || wanted=(u1 u2 u3 u4 u5)
for u in "${wanted[@]}"; do
	[ -n "${scripts[$u]:-}" ] || die "unknown use case '$u' (u1 to u5)"
done

log "NoMail contract as $CONTRACT_UID through https://$DRIVE_HOST, month folder $CONTRACT_MONTH"
results=()
for u in "${wanted[@]}"; do
	log "--- ${u^^} (tests/${scripts[$u]}.sh) ---"
	started="$(now)"
	if "$REPO_DIR/tests/${scripts[$u]}.sh"; then
		results+=("PASS ${u^^} ($(since "$started") s)")
	else
		results+=("FAIL ${u^^} ($(since "$started") s)")
		fails=$((fails + 1))
	fi
done

log "--- results ---"
for line in "${results[@]}"; do log "$line"; done
[ ! -s "$CONTRACT_STATE/u2-timing" ] || log "$(cat "$CONTRACT_STATE/u2-timing")"
finish "NoMail contract (${wanted[*]})"
