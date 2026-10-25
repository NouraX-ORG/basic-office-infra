#!/usr/bin/env bash
# U3 of the NoMail contract (docs/nomail-contract.md): reading mail -> "Save to Drive". NoMail
# saves a received attachment into /NoMail/Received/<yyyy-mm>/ as its saveNewFile() does: MKCOL
# for each folder (201 made, 405 already there), a PROPFIND for the names in use, then a PUT.
# Run it on the server: sudo tests/u3-save-received.sh (or all five with tests/nomail-contract.sh).
#
# As qa-t6-1 (CONTRACT_UID), with the netrc file from tests/api-provision.sh. The name has a
# space and an umlaut, as real attachment names do, so the path encoding is tested too. The
# file stays (a QA file). No server change, so no lock. Exit 0 when every check passes.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
contract_setup

folder="/NoMail/Received/$CONTRACT_MONTH"
name="qa-t6 Rechnung März $(date -u +%Y%m%d%H%M%S).pdf"
path="$folder/$name"

ensure_folders U3 "$folder"
check "U3 PROPFIND the folder (Depth 1, the names in use) -> 207" 207 "$(dav_list "$folder/" 1)"
check "U3 the name is free" "" "$(dav_field "$path" 2)"

head -c 307200 /dev/urandom > "$T_OUT/first"
check "U3 PUT the attachment -> 201" 201 \
	"$(dav PUT "$path" -H 'Content-Type: application/pdf' --data-binary "@$T_OUT/first")"
check "U3 PROPFIND the folder again -> 207" 207 "$(dav_list "$folder/" 1)"
check "U3 the file is in /NoMail/Received/$CONTRACT_MONTH/ under its name" file "$(dav_field "$path" 2)"
check "U3 its size" 307200 "$(dav_field "$path" 3)"
check "U3 its content type" application/pdf "$(dav_field "$path" 4)"

# Saving to the same path again replaces the file (NoMail picks a free name instead, but a PUT
# that replaces answers 204)
head -c 204800 /dev/urandom > "$T_OUT/second"
check "U3 PUT the same path again (replace) -> 204" 204 \
	"$(dav PUT "$path" -H 'Content-Type: application/pdf' --data-binary "@$T_OUT/second")"
check "U3 PROPFIND the file -> 207" 207 "$(dav_list "$path" 0)"
check "U3 the new size" 204800 "$(dav_field "$path" 3)"
check "U3 GET -> 200" 200 "$(dav GET "$path")"
check "U3 downloaded SHA-256 = the second upload's" "$(sha256sum < "$T_OUT/second")" "$(sha256sum < "$T_OUT/dav")"

finish U3
