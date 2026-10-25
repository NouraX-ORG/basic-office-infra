#!/usr/bin/env bash
# U1 of the NoMail contract (docs/nomail-contract.md): Compose -> "Attach from Drive". NoMail lists
# a folder (PROPFIND, Depth 1, with its own body: tests/propfind.xml) and downloads the file the
# person picks (GET), server-side, with the person's app password.
# Run it on the server: sudo tests/u1-list-download.sh (or all five with tests/nomail-contract.sh).
#
# As qa-t6-1 (CONTRACT_UID), with the netrc file from tests/api-provision.sh. It first puts a
# 1 MiB file of random bytes at /NoMail/qa-t6-u1-<time>.bin to pick (kept; it is a QA file).
# No server change, so no lock. Exit 0 when every check passes.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
contract_setup

SIZE=1048576
name="qa-t6-u1-$(date -u +%Y%m%d%H%M%S).bin"
path="/NoMail/$name"

head -c "$SIZE" /dev/urandom > "$T_OUT/u1.bin"
check "U1 setup: PUT a 1 MiB file to /NoMail/$name -> 201" 201 \
	"$(dav PUT "$path" -H 'Content-Type: application/octet-stream' --data-binary "@$T_OUT/u1.bin")"

# The Drive's top level, as NoMail opens it first
check "U1 PROPFIND / (Depth 1) -> 207" 207 "$(dav_list / 1)"
check "U1 / lists NoMail as a folder" folder "$(dav_field /NoMail 2)"

# The NoMail folder: the three folders and the file, with every property NoMail reads
check "U1 PROPFIND /NoMail/ (Depth 1) -> 207" 207 "$(dav_list /NoMail/ 1)"
for sub in Sent Received Images; do
	check "U1 /NoMail/ lists $sub as a folder" folder "$(dav_field "/NoMail/$sub" 2)"
	check "U1 $sub has oc:size (a number)" yes "$(yes_no grep -qE '^[0-9]+$' <<<"$(dav_field "/NoMail/$sub" 7)")"
done
check "U1 the file is listed as a file" file "$(dav_field "$path" 2)"
check "U1 getcontentlength" "$SIZE" "$(dav_field "$path" 3)"
# The Drive takes the type from the name, not from the PUT's Content-Type (.bin: application/x-bin)
check "U1 getcontenttype (from the name)" application/x-bin "$(dav_field "$path" 4)"
check "U1 getlastmodified is an HTTP date" yes \
	"$(yes_no grep -qE '^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9:]{8} GMT$' <<<"$(dav_field "$path" 5)")"
check "U1 oc:fileid is a number" yes "$(yes_no grep -qE '^[0-9]+$' <<<"$(dav_field "$path" 6)")"

# The download NoMail passes on as an attachment (it reads Content-Length to refuse > 25 MB)
check "U1 GET the file -> 200" 200 "$(dav GET "$path")"
check "U1 Content-Length" "$SIZE" "$(tr -d '\r' < "$T_OUT/dav.h" | awk 'tolower($1) == "content-length:" { print $2 }' | tail -n 1)"
check "U1 downloaded SHA-256 = uploaded SHA-256" "$(sha256sum < "$T_OUT/u1.bin")" "$(sha256sum < "$T_OUT/dav")"
check "U1 GET a missing file -> 404" 404 "$(dav GET "/NoMail/qa-t6-u1-missing-$RANDOM.bin")"

finish U1
