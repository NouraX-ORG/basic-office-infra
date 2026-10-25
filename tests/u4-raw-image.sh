#!/usr/bin/env bash
# U4 of the NoMail contract (docs/nomail-contract.md): pictures in designed (HTML) emails. NoMail
# stores the picture in /NoMail/Images/<yyyy-mm>/<uuid>.<ext> and makes a public link with no
# end date (publishEmailImage(): days null), then puts https://<drive>/s/<token>/download in
# <img src>. That address must give the picture's bytes, with an image content type and no
# login or cookie.
# Run it on the server: sudo tests/u4-raw-image.sh (or all five with tests/nomail-contract.sh).
#
# As qa-t6-1 (CONTRACT_UID), with the netrc file from tests/api-provision.sh. The PNG is made
# here (a 32 x 32 colour gradient). The file stays (a QA file); the link is removed by U5.
# No server change, so no lock. Exit 0 when every check passes.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
contract_setup

python3 -I -c '
import struct, sys, zlib
def chunk(kind, data):
	return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
rows = b"".join(b"\x00" + b"".join(bytes([x * 8, y * 8, 160]) for x in range(32)) for y in range(32))
sys.stdout.buffer.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 32, 8, 2, 0, 0, 0))
	+ chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
' > "$T_OUT/picture.png"

folder="/NoMail/Images/$CONTRACT_MONTH"
path="$folder/$(cat /proc/sys/kernel/random/uuid).png"
ensure_folders U4 "$folder"
check "U4 PUT the PNG (Content-Type image/png) -> 201" 201 \
	"$(dav PUT "$path" -H 'Content-Type: image/png' --data-binary "@$T_OUT/picture.png")"

# A link with no end date: NoMail sends no expireDate. This works because the Drive enforces no
# default end date today (core shareapi_default_expire_date is off).
check "U4 link without expireDate -> HTTP 200" 200 "$(public_link "$path")"
check "U4 link: statuscode 200" 200 "$(ocs_code)"
check "U4 link: NoMail can read it" yes "$(share_readable)"
check "U4 link: expiration null" null "$(share_field expiration)"
check "U4 link: mimetype image/png" image/png "$(share_field mimetype)"
id="$(share_field id)"
token="$(share_field token)"
remember_share u4-image "$id" "$token"

# The address NoMail puts in <img src>: one 303 to the public WebDAV address, then the bytes
raw="$PUBLIC_BASE/s/$token/download"
check "U4 /s/<token>/download -> 303" 303 "$(curl -sS -g -o "$T_OUT/hop" -D "$T_OUT/hop.h" -w '%{http_code}' "$raw")"
check "U4 ... to https://$DRIVE_HOST/public.php/dav/files/<token>" yes \
	"$(yes_no test "$(location_of "$T_OUT/hop.h")" = "$PUBLIC_BASE/public.php/dav/files/$token")"
check "U4 ... the 303 has no body" 0 "$(wc -c < "$T_OUT/hop")"
# curl sends no cookie and no login here: a mail reader fetching the picture has neither
answer="$(curl -sS -g -L --max-filesize 10485760 -o "$T_OUT/got.png" -D "$T_OUT/got.h" -w '%{http_code} %{num_redirects} %{content_type}' "$raw")"
check "U4 <img src> address (followed) -> 200 after 1 redirect" "200 1" "$(cut -d' ' -f1-2 <<<"$answer")"
check "U4 Content-Type image/png" image/png "$(cut -d' ' -f3- <<<"$answer")"
check "U4 the bytes are the PNG's (SHA-256)" "$(sha256sum < "$T_OUT/picture.png")" "$(sha256sum < "$T_OUT/got.png")"
check "U4 the answer is not HTML" no "$(yes_no grep -qi '<html' "$T_OUT/got.png")"
final_headers="$(tr -d '\r' < "$T_OUT/got.h" | awk '/^HTTP\// { h = "" } { h = h $0 "\n" } END { printf "%s", h }')"
check "U4 X-Content-Type-Options nosniff" yes "$(yes_no grep -qi '^x-content-type-options: nosniff' <<<"$final_headers")"
disposition="$(awk 'tolower($1) == "content-disposition:" { $1 = ""; print substr($0, 2) }' <<<"$final_headers" | cut -d';' -f1)"
log "U4 note: Content-Disposition is '$disposition' (browsers and mail readers still show it in <img>)"

# The same bytes without the redirect, and the other forms, for the record
check "U4 /public.php/dav/files/<token> -> 200 image/png" "200 image/png" \
	"$(curl -sS -g -o "$T_OUT/direct.png" -w '%{http_code} %{content_type}' "$PUBLIC_BASE/public.php/dav/files/$token")"
check "U4 ... the same bytes" yes "$(yes_no cmp -s "$T_OUT/direct.png" "$T_OUT/picture.png")"
check "U4 /index.php/s/<token>/download -> 303 to the same address" "303 yes" \
	"$(curl -sS -g -o /dev/null -D "$T_OUT/hop3.h" -w '%{http_code}' "$PUBLIC_BASE/index.php/s/$token/download") $(yes_no test "$(location_of "$T_OUT/hop3.h")" = "$PUBLIC_BASE/public.php/dav/files/$token")"
check "U4 /s/<token>/preview -> 200 image/png" "200 image/png" \
	"$(curl -sS -g -o /dev/null -w '%{http_code} %{content_type}' "$PUBLIC_BASE/s/$token/preview")"
check "U4 page /s/<token> -> 200 (HTML)" 200 "$(curl -sS -g -o /dev/null -w '%{http_code}' "$PUBLIC_BASE/s/$token")"

finish U4
