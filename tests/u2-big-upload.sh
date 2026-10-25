#!/usr/bin/env bash
# U2 of the NoMail contract (docs/nomail-contract.md): a big file goes to
# /NoMail/Sent/<yyyy-mm>/ and gets a public link with an end date (30 days by default) and,
# if the person wants, a password.
# Run it on the server: sudo tests/u2-big-upload.sh (or all five with tests/nomail-contract.sh).
#
# A real upload of 1,100,000,000 bytes (U2_SIZE) through Cloudflare with the Drive's chunked
# upload (WebDAV chunking v2), in 50 MiB chunks: Cloudflare refuses request bodies over 100 MB,
# and R2 needs every part but the last to be the same size. The bytes come from /dev/urandom and
# are piped straight into the chunk PUTs (split --filter), so nothing is written to disk here;
# the SHA-256 of the stream is taken on the way. Then a full download and a SHA-256 compare,
# and two links: one with an end date, one with an end date and a password.
#
# As qa-t6-1 (CONTRACT_UID), with the netrc file from tests/api-provision.sh. The file stays in
# the QA account (qa-t6-u2-big-<time>.bin; each run adds one, 1.1 GB in R2); the links are
# removed by U5. Takes a few minutes. No server change, so no lock. Exit 0 when every check passes.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/lib.sh"
contract_setup

SIZE="${U2_SIZE:-1100000000}"
CHUNK=52428800 # 50 MiB, as the web page, the upload Worker and NoMail use
[[ "$SIZE" =~ ^[0-9]+$ ]] && [ "$SIZE" -gt "$CHUNK" ] || die "U2_SIZE must be a number of bytes, more than one chunk ($CHUNK)"
chunks=$(((SIZE + CHUNK - 1) / CHUNK))
last=$((SIZE - (chunks - 1) * CHUNK))

stamp="$(date -u +%Y%m%d%H%M%S)"
folder="/NoMail/Sent/$CONTRACT_MONTH"
name="qa-t6-u2-big-$stamp.bin"
path="$folder/$name"
upload_id="qa-t6-u2-$stamp-$(openssl rand -hex 4)"
dest="$(dav_url "$path")"
upload_url="$DAV_BASE/uploads/$CONTRACT_UID/$upload_id"
log "U2: $SIZE bytes in $chunks chunks of $CHUNK (the last $last) to $path"

# --- Upload ----------------------------------------------------------------------------------
ensure_folders U2 "$folder"
check "U2 the name is free (PROPFIND 404)" 404 "$(dav PROPFIND "$path" -H 'Depth: 0')"
check "U2 MKCOL the upload folder, with Destination -> 201" 201 \
	"$(dav_raw MKCOL "$upload_url" -H "Destination: $dest")"

# Each chunk is one PUT to <upload folder>/<00001..>, with Destination and OC-Total-Length (the
# quota check), exactly as the upload Worker sends it. split runs the filter once per chunk, one
# after the other, with FILE=c00001, c00002, ... One line per chunk goes to $T_OUT/chunks:
# number, HTTP status, bytes sent, seconds.
export U2_NETRC="$CONTRACT_NETRC" U2_DEST="$dest" U2_UPLOAD="$upload_url" U2_TOTAL="$SIZE" U2_LOG="$T_OUT/chunks"
: > "$U2_LOG"
# shellcheck disable=SC2016 # the filter is expanded by split's shell, once per chunk
filter='curl -sS -X PUT --netrc-file "$U2_NETRC" -H "Destination: $U2_DEST" -H "OC-Total-Length: $U2_TOTAL" -H "Content-Type: application/octet-stream" --data-binary @- -o /dev/null -w "${FILE#c} %{http_code} %{size_upload} %{time_total}\n" "$U2_UPLOAD/${FILE#c}" >> "$U2_LOG"'
started="$(now)"
set +e
head -c "$SIZE" /dev/urandom |
	tee >(sha256sum | cut -d' ' -f1 > "$T_OUT/sent.sha") >(head -c 1024 > "$T_OUT/first1k"; cat > /dev/null) |
	split -b "$CHUNK" --numeric-suffixes=1 -a 5 --filter="$filter" - c
status=("${PIPESTATUS[@]}")
set -e
upload_seconds="$(since "$started")"
check "U2 the stream and every chunk PUT ran (exit statuses)" "0 0 0" "${status[*]}"
for _ in $(seq 1 150); do # sha256sum ends a moment after the last byte
	[ -s "$T_OUT/sent.sha" ] && break
	sleep 0.2
done
check "U2 SHA-256 of the sent stream taken" 64 "$(tr -d '\n' < "$T_OUT/sent.sha" | wc -c)"

check "U2 $chunks chunk PUTs sent" "$chunks" "$(wc -l < "$U2_LOG")"
# The Drive (Nextcloud 35 on object storage) answers a stored chunk with an empty 200, not the
# 201 of the docs (see "Upload Worker" in docs/nomail-contract.md); both mean stored.
codes="$(awk '{ print $2 }' "$U2_LOG" | sort | uniq -c | awk '{ printf "%s%s x%s", (NR > 1 ? ", " : ""), $2, $1 }')"
check "U2 every chunk PUT stored (200 or 201: $codes)" 0 "$(awk '$2 != 200 && $2 != 201' "$U2_LOG" | wc -l)"
check "U2 every chunk had the right size" 0 \
	"$(awk -v n="$chunks" -v c="$CHUNK" -v l="$last" '$3 != ($1 + 0 == n ? l : c)' "$U2_LOG" | wc -l)"
slowest="$(sort -k4 -n -r "$U2_LOG" | head -n 1 | awk '{ printf "%.1f", $4 }')"

# Before the MOVE: the Drive holds every chunk, whole (on R2 it would complete a short file)
check "U2 PROPFIND the upload folder -> 207" 207 "$(dav_raw PROPFIND "$upload_url/" -H 'Depth: 1' \
	-H 'Content-Type: application/xml' --data-binary '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/></d:prop></d:propfind>')"
dav_props "$T_OUT/dav" | awk -F'\t' -v id="$upload_id" '{ n = split($1, p, "/"); if (p[n - 1] == id && p[n] ~ /^[0-9]+$/) print p[n] + 0, $3 }' |
	sort -n > "$T_OUT/held"
check "U2 the Drive holds $chunks chunks" "$chunks" "$(wc -l < "$T_OUT/held")"
check "U2 the chunks held are 1..$chunks with the right sizes" 0 \
	"$(awk -v n="$chunks" -v c="$CHUNK" -v l="$last" '$1 != NR || $2 != (NR == n ? l : c)' "$T_OUT/held" | wc -l)"

started="$(now)"
check "U2 MOVE .file to the destination, with OC-Total-Length -> 201" 201 \
	"$(dav_raw MOVE "$upload_url/.file" -H "Destination: $dest" -H "OC-Total-Length: $SIZE")"
move_seconds="$(since "$started")"

check "U2 PROPFIND the file -> 207" 207 "$(dav_list "$path" 0)"
check "U2 getcontentlength" "$SIZE" "$(dav_field "$path" 3)"
check "U2 oc:fileid is a number" yes "$(yes_no grep -qE '^[0-9]+$' <<<"$(dav_field "$path" 6)")"

started="$(now)"
curl -sS -g --netrc-file "$CONTRACT_NETRC" -D "$T_OUT/get.h" "$dest" | sha256sum | cut -d' ' -f1 > "$T_OUT/got.sha" || true
download_seconds="$(since "$started")"
check "U2 GET the whole file -> 200" 200 "$(tr -d '\r' < "$T_OUT/get.h" | awk '/^HTTP\// { c = $2 } END { print c }')"
check "U2 downloaded SHA-256 = SHA-256 of the sent stream" "$(cat "$T_OUT/sent.sha")" "$(cat "$T_OUT/got.sha")"

# --- A public link with an end date (NoMail's default: 30 days) ------------------------------
expire="$(date -u -d '+30 days' +%F)" # NoMail's expiryDate(30), a UTC day
check "U2 link, 30 days -> HTTP 200" 200 "$(public_link "$path" --data-urlencode "expireDate=$expire")"
check "U2 link: statuscode 200" 200 "$(ocs_code)"
check "U2 link: NoMail can read it (id, token, page URL)" yes "$(share_readable)"
check "U2 link: share_type 3" 3 "$(share_field share_type)"
check "U2 link: permissions 1 (read only)" 1 "$(share_field permissions)"
check "U2 link: expiration is today + 30 days ($expire)" "$expire" "$(share_field expiration | cut -c1-10)"
check "U2 link: no password" null "$(share_field password)"
check "U2 link: item_size" "$SIZE" "$(share_field item_size)"
id1="$(share_field id)"
token1="$(share_field token)"
remember_share u2-link "$id1" "$token1"
log "U2 link: id $id1, expiration $(share_field expiration)"

check "U2 page /s/<token> -> 200" 200 "$(curl -sS -g -o /dev/null -w '%{http_code}' "$PUBLIC_BASE/s/$token1")"
check "U2 /s/<token>/download -> 303" 303 "$(curl -sS -g -o /dev/null -D "$T_OUT/hop.h" -w '%{http_code}' "$PUBLIC_BASE/s/$token1/download")"
check "U2 ... to https://$DRIVE_HOST/public.php/dav/files/<token>" yes \
	"$(yes_no test "$(location_of "$T_OUT/hop.h")" = "$PUBLIC_BASE/public.php/dav/files/$token1")"
# A ranged GET (resumable downloads); --max-filesize stops curl if the whole file came instead
check "U2 ranged GET of /s/<token>/download (followed) -> 206" 206 \
	"$(curl -sS -g -L -r 0-1023 --max-filesize 1048576 -o "$T_OUT/range" -w '%{http_code}' "$PUBLIC_BASE/s/$token1/download")"
check "U2 ranged GET: the first 1024 bytes of the file" yes "$(yes_no cmp -s "$T_OUT/range" "$T_OUT/first1k")"
# The address the 303 leads to, asked directly (a HEAD there answers 401, so a ranged GET)
check "U2 ranged GET of /public.php/dav/files/<token> -> 206" 206 \
	"$(curl -sS -g -r 0-1023 --max-filesize 1048576 -o "$T_OUT/range-direct" -D "$T_OUT/direct.h" -w '%{http_code}' "$PUBLIC_BASE/public.php/dav/files/$token1")"
check "U2 ... Content-Range bytes 0-1023/$SIZE" "bytes 0-1023/$SIZE" \
	"$(tr -d '\r' < "$T_OUT/direct.h" | awk 'tolower($1) == "content-range:" { $1 = ""; print substr($0, 2) }')"
check "U2 ... the same first 1024 bytes" yes "$(yes_no cmp -s "$T_OUT/range-direct" "$T_OUT/first1k")"

# --- A second link with a password (password_policy: at least 10 characters) -----------------
(umask 077 && openssl rand -base64 15 | tr -d '\n' > "$T_OUT/link.pw") # 20 characters, never printed
check "U2 password link -> HTTP 200" 200 \
	"$(public_link "$path" --data-urlencode "expireDate=$expire" --data-urlencode "password@$T_OUT/link.pw")"
check "U2 password link: statuscode 200" 200 "$(ocs_code)"
check "U2 password link: NoMail can read it" yes "$(share_readable)"
check "U2 password link: NoMail sees a password (hasPassword)" yes \
	"$(jq -e '.ocs.data.password | type == "string" and . != ""' "$T_OUT/ocs.json" >/dev/null && echo yes || echo no)"
check "U2 password link: expiration" "$expire" "$(share_field expiration | cut -c1-10)"
id2="$(share_field id)"
token2="$(share_field token)"
remember_share u2-password-link "$id2" "$token2"

check "U2 password link: /s/<token>/download -> 303" 303 \
	"$(curl -sS -g -o /dev/null -D "$T_OUT/hop2.h" -w '%{http_code}' "$PUBLIC_BASE/s/$token2/download")"
check "U2 ... to the password page /s/<token>/authenticate/downloadshare" yes \
	"$(yes_no test "$(location_of "$T_OUT/hop2.h")" = "/s/$token2/authenticate/downloadshare")"
answer="$(curl -sS -g -L -r 0-1023 --max-filesize 1048576 -o "$T_OUT/range2" -w '%{http_code} %{content_type}' "$PUBLIC_BASE/s/$token2/download")"
check "U2 password link: /download (followed) is the password page" yes \
	"$(yes_no grep -qE '^200 text/html' <<<"$answer")"
check "U2 password link: /download does not give the file's bytes" no "$(yes_no cmp -s "$T_OUT/range2" "$T_OUT/first1k")"
# Not asked here: /public.php/dav/files/<token> of the password link (401). Each 401 there is a
# brute-force attempt for the caller's address, and these tests share the server's address with
# every other test (docs/nomail-contract.md, "Brute-force protection").

# --- Timing ----------------------------------------------------------------------------------
mb_s() { awk -v b="$SIZE" -v s="$1" 'BEGIN { printf "%.1f", (s > 0 ? b / s / 1000000 : 0) }'; }
timing="U2 timing: $SIZE bytes; upload of $chunks chunks ${upload_seconds} s ($(mb_s "$upload_seconds") MB/s, slowest chunk ${slowest} s); MOVE ${move_seconds} s; full download ${download_seconds} s ($(mb_s "$download_seconds") MB/s)"
log "$timing"
printf '%s\n' "$timing" > "$CONTRACT_STATE/u2-timing"

finish U2
