# The NoMail contract

What NoMail uses on the Drive, and how each part was tested. NoMail's side is in the NoMail repo
(`supabase/functions/_shared/drive.ts`, `driveFiles*.ts`, `driveTicket.ts` and `src/lib/driveApi.ts`).

| Part | Where it is described |
|---|---|
| The NoMail API: health, provision, scan | [nomail-api.md](nomail-api.md) |
| Organisations, teams and people (admin API) | [teams.md](teams.md) |
| Big uploads from the NoMail page | [Upload Worker](#upload-worker), below |
| U1-U5 (folders, uploads, links, images, link list) | [U1–U5](#u1u5-what-nomail-does-with-a-persons-drive), below; tested by `tests/nomail-contract.sh` |

## U1–U5: what NoMail does with a person's Drive

NoMail's `drive-files` function works in the person's own Drive with HTTP Basic auth: the
`login` and the `NoMail` app password that `POST /v1/provision` returned (the `uid` is the
same as the login for "Log in with Nourax" accounts). Everything goes to
`https://drive.nourax.org` through Cloudflare. WebDAV paths are under
`/remote.php/dav/files/<uid>/`, each part URL-encoded; links use the sharing API
`/ocs/v2.php/apps/files_sharing/api/v1/shares`.

`sudo tests/nomail-contract.sh` on the server sends NoMail's own requests (the same methods,
headers and bodies as `driveFiles.ts`) as the QA account `qa-t6-1`, with its `NoMail` app
password from `/v1/provision` in a netrc file. The commands below are those requests with
`-u '<login>:<app-password>'` in place of the netrc file.

### Result on 2026-10-25

`sudo tests/nomail-contract.sh` from `/opt/nourax/basic-office-infra` (commit `9ffe627`), 10:46 to
10:49 UTC: **139 checks, none failed, exit 0.**

| Use case | Script | What was checked |
|---|---|---|
| U1 | `tests/u1-list-download.sh` | **PASS.** `PROPFIND` 207 of `/` and `/NoMail/`: `Sent`, `Received` and `Images` as folders with `oc:size`; a 1 MiB file with `getcontentlength`, `getcontenttype`, `getlastmodified` and `oc:fileid`. `GET` 200, `Content-Length` 1048576, the same SHA-256. A missing file 404. |
| U2 | `tests/u2-big-upload.sh` | **PASS.** 1,100,000,000 bytes from `/dev/urandom` in 21 chunk `PUT`s (20 × 52,428,800 + 51,424,000), each answered 200; before the `MOVE` the Drive held chunks 1 to 21 with those sizes; `MOVE` 201; `getcontentlength` 1100000000; the SHA-256 of a full `GET` equal to the SHA-256 of the bytes sent. A link with `expireDate` 2026-11-24 (today + 30 days): statuscode 200, `expiration` `2026-11-24 23:59:59`, `permissions` 1, the page 200, `/download` a 303 to `/public.php/dav/files/<token>`, ranged GETs of both 206 with the right first 1024 bytes (`Content-Range: bytes 0-1023/1100000000`). A link with a 20-character password: `/download` leads to the password page (200 HTML), never to the bytes. |
| U3 | `tests/u3-save-received.sh` | **PASS.** `MKCOL` 201 or 405 for each folder of `/NoMail/Received/2026-10/`; `PUT` 201 of `qa-t6 Rechnung März <time>.pdf`; its size 307200 and type `application/pdf`; a second `PUT` 204, size 204800, the same SHA-256 on a `GET`. |
| U4 | `tests/u4-raw-image.sh` | **PASS.** A 32 × 32 PNG to `/NoMail/Images/2026-10/<uuid>.png` (201); a link without `expireDate`: `expiration` null. `/s/<token>/download`: 303 with no body, then 200 `image/png`, the PNG's bytes, `nosniff`, with no login or cookie. `/public.php/dav/files/<token>` 200 `image/png` (same bytes), `/index.php/s/<token>/download` the same 303, `/s/<token>/preview` 200 `image/png`, the page 200. |
| U5 | `tests/u5-shares.sh` | **PASS.** The list had the three links of the run (ids 84, 85, 86, `share_type` 3) and every public link in it passes NoMail's `readShare()`. A `PUT` of the first link with 90 days and a password (expiration 2027-01-23, password set), then `password=` (password gone, end date kept). `DELETE` 200 for each; the first one's page then 404; `GET` by id 404; a second `DELETE` HTTP 404 with statuscode 404; none of them listed any more. |

The tests leave their files in the QA account (U5 removes only its links):
`/NoMail/qa-t6-u1-<time>.bin` (1 MiB), `/NoMail/Sent/<yyyy-mm>/qa-t6-u2-big-<time>.bin`
(1.1 GB), `/NoMail/Received/<yyyy-mm>/qa-t6 Rechnung März <time>.pdf` and
`/NoMail/Images/<yyyy-mm>/<uuid>.png`. Removing them needs the owner's yes.

### One tested command per use case

Placeholders: `<uid>`, `<login>`, `<app-password>` (from `/v1/provision`), `<yyyy-mm>` (the UTC
month, as NoMail's `monthFolder()`), `<token>` and `<id>` (from a link's answer). The OCS calls
need `OCS-APIRequest: true`; with `Accept: application/json` the answer is
`{"ocs":{"meta":{"status","statuscode","message"},"data":…}}`, and `statuscode` 200 means done.

**U1 – list a folder, then download a file** (Compose → Attach from Drive)

```
curl -sS -u '<login>:<app-password>' -X PROPFIND -H 'Depth: 1' \
  -H 'Content-Type: application/xml; charset=utf-8' \
  --data-binary '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:resourcetype/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/><oc:fileid/><oc:size/></d:prop></d:propfind>' \
  https://drive.nourax.org/remote.php/dav/files/<uid>/NoMail/
# 207, a multistatus: one <d:response> for the folder itself and one per entry. Folders have
# <d:collection/> and <oc:size>; files have getcontentlength, getcontenttype, getlastmodified
# ("Sun, 25 Oct 2026 10:12:39 GMT") and oc:fileid.

curl -sS -u '<login>:<app-password>' -o file.bin \
  https://drive.nourax.org/remote.php/dav/files/<uid>/NoMail/<name>
# 200 with Content-Length; 404 when the file is gone
```

**U2 – a big file into `/NoMail/Sent/<yyyy-mm>/`, then a public link** (NoMail's page sends it
through the upload Worker, which makes exactly these requests; the test sends them itself)

```
# 1. the folders (each: 201 made, 405 already there)
curl -sS -u '<login>:<app-password>' -X MKCOL https://drive.nourax.org/remote.php/dav/files/<uid>/NoMail/Sent/<yyyy-mm>/

# 2. an upload folder (any name of A-Z a-z 0-9 -), with the destination
DEST=https://drive.nourax.org/remote.php/dav/files/<uid>/NoMail/Sent/<yyyy-mm>/<name>
UP=https://drive.nourax.org/remote.php/dav/uploads/<uid>/<upload-id>
curl -sS -u '<login>:<app-password>' -X MKCOL -H "Destination: $DEST" "$UP"                  # 201

# 3. one PUT per chunk, 00001 to 00021 for 1,100,000,000 bytes in 52,428,800-byte chunks
curl -sS -u '<login>:<app-password>' -X PUT -H "Destination: $DEST" -H 'OC-Total-Length: 1100000000' \
  -H 'Content-Type: application/octet-stream' --data-binary @chunk-00001 "$UP/00001"           # 200 (stored)

# 4. put the file together
curl -sS -u '<login>:<app-password>' -X MOVE -H "Destination: $DEST" -H 'OC-Total-Length: 1100000000' \
  "$UP/.file"                                                                               # 201

# 5. a read-only public link that ends in 30 days, optionally with a password
curl -sS -u '<login>:<app-password>' -H 'OCS-APIRequest: true' -H 'Accept: application/json' \
  --data-urlencode 'path=/NoMail/Sent/<yyyy-mm>/<name>' --data-urlencode shareType=3 \
  --data-urlencode permissions=1 --data-urlencode expireDate=2026-11-24 \
  [--data-urlencode 'password=<link password, 10+ characters>'] \
  https://drive.nourax.org/ocs/v2.php/apps/files_sharing/api/v1/shares
# 200, statuscode 200, data: {"id":"81","token":"<token>","url":"https://drive.nourax.org/s/<token>",
#   "share_type":3,"permissions":1,"expiration":"2026-11-24 23:59:59","password":null,
#   "item_size":1100000000,"mimetype":"application/x-bin","stime":…,"path":"/NoMail/Sent/…",…}
# With a password, "password" is a non-empty string (not the password itself).
```

**U3 – save a received attachment into `/NoMail/Received/<yyyy-mm>/`**

```
curl -sS -u '<login>:<app-password>' -X MKCOL https://drive.nourax.org/remote.php/dav/files/<uid>/NoMail/Received/<yyyy-mm>/   # 201 or 405
curl -sS -u '<login>:<app-password>' -X PUT -H 'Content-Type: application/pdf' --data-binary @invoice.pdf \
  'https://drive.nourax.org/remote.php/dav/files/<uid>/NoMail/Received/<yyyy-mm>/qa-t6%20Rechnung%20M%C3%A4rz.pdf'
# 201 new; 204 when it replaced a file with the same name
```

**U4 – a picture for an HTML email** (a link with no end date)

```
curl -sS -u '<login>:<app-password>' -X PUT -H 'Content-Type: image/png' --data-binary @picture.png \
  https://drive.nourax.org/remote.php/dav/files/<uid>/NoMail/Images/<yyyy-mm>/<uuid>.png          # 201
curl -sS -u '<login>:<app-password>' -H 'OCS-APIRequest: true' -H 'Accept: application/json' \
  --data-urlencode 'path=/NoMail/Images/<yyyy-mm>/<uuid>.png' --data-urlencode shareType=3 \
  --data-urlencode permissions=1 https://drive.nourax.org/ocs/v2.php/apps/files_sharing/api/v1/shares
# 200, statuscode 200, "expiration": null, "mimetype": "image/png"

curl -sSL -o got.png https://drive.nourax.org/s/<token>/download    # no login, no cookie
# 303 (no body) to https://drive.nourax.org/public.php/dav/files/<token>, then 200
# Content-Type: image/png, the picture's bytes
```

**U5 – list the links, cancel one**

```
curl -sS -u '<login>:<app-password>' -H 'OCS-APIRequest: true' -H 'Accept: application/json' \
  https://drive.nourax.org/ocs/v2.php/apps/files_sharing/api/v1/shares
# 200, statuscode 200, data: every share the person made (filter share_type 3 for links)

curl -sS -u '<login>:<app-password>' -H 'OCS-APIRequest: true' -H 'Accept: application/json' \
  -X DELETE https://drive.nourax.org/ocs/v2.php/apps/files_sharing/api/v1/shares/<id>
# 200, statuscode 200. Then https://drive.nourax.org/s/<token> answers 404. The same DELETE
# again answers HTTP 404, statuscode 404 "Wrong share ID, share does not exist" (already gone).
```

### Link formats

| What | Address | What it gives |
|---|---|---|
| Page | `https://drive.nourax.org/s/<token>` | The share page (HTML) with a download button; asks for the password first when the link has one. **The only link to give out for a password link.** |
| Direct download | `https://drive.nourax.org/s/<token>/download` | `303` to `https://drive.nourax.org/public.php/dav/files/<token>`, which sends the bytes (`Content-Disposition: attachment`, ranges work: 206). For a password link it goes to `/s/<token>/authenticate/downloadshare`, the password page, never the bytes. |
| Raw image (`<img src>`) | The same `https://drive.nourax.org/s/<token>/download` | One 303, then `200 image/png` (or the picture's type), the bytes, `X-Content-Type-Options: nosniff`. No login and no cookie needed. |

Also tested: `https://drive.nourax.org/index.php/s/<token>/download` (the same 303),
`https://drive.nourax.org/public.php/dav/files/<token>` (the bytes at once, no redirect; for a
password link 401) and `https://drive.nourax.org/s/<token>/preview` (`200 image/png`, a preview).

### What NoMail must know

- **Headers.** OCS calls need `OCS-APIRequest: true`, and `Accept: application/json` for JSON
  (`?format=json` works too). WebDAV `PROPFIND` needs `Depth` (0 or 1). Chunked uploads need
  `Destination` on the `MKCOL`, every chunk `PUT` and the `MOVE`, and `OC-Total-Length` on the
  `PUT`s (the quota is checked early) and the `MOVE`.
- **Chunks.** Under 100 MB each (Cloudflare refuses bigger request bodies). Named `00001` to
  `10000`; at least 5 MiB each, and all the same size except the last (R2 multipart rules). The
  Drive and the upload Worker use 50 MiB (52,428,800 bytes). A stored chunk answers an empty
  **200**, not the 201 of the docs (Nextcloud 35 on object storage). The Drive does not compare
  the chunks with `OC-Total-Length` at the `MOVE`: check the upload folder (a `PROPFIND`, Depth 1,
  lists `1`, `2`, … with their sizes) before the `MOVE`, as the Worker's `/finish` does.
- **Password links.** `/s/<token>/download` and `/public.php/dav/files/<token>` never give the
  bytes without the password. NoMail's `readShare()` sets `downloadUrl` for every link; for a
  link with `hasPassword` only `url` (the page) works.
- **`/s/<token>/download` is a redirect.** Mail readers and browsers follow it. The Drive marks
  this address as old (deprecated since version 31, still working in 35); the address it leads
  to, `/public.php/dav/files/<token>`, gives the same bytes without the extra step and could be
  used for `<img src>` later.
- **End dates.** Send `expireDate` as `YYYY-MM-DD`. The answer's `expiration` is
  `YYYY-MM-DD 23:59:59` (the link works until the end of that day, server time Europe/London);
  `readShare()` keeps the first 10 characters, which is right. No end date is enforced: a link
  without `expireDate` has `expiration: null` (U4). Changing a link: `PUT …/shares/<id>` with a
  form body, as NoMail's `updatePublicShare()` sends it. Tested in U5: a new `expireDate` with a
  `password`, then `password=` (empty), which takes the password off and keeps the end date. An
  empty `expireDate` (NoMail's "no end date") was not tested.
- **Passwords** for links: at least 10 characters, not a common or leaked password
  (`password_policy`; leaked ones are checked against haveibeenpwned.com). A refusal is a 400 with
  a plain message, which NoMail passes on.
- **Content types** come from the file name, not the `PUT`'s `Content-Type` (`.bin` →
  `application/x-bin`, `.pdf` → `application/pdf`, `.png` → `image/png`). NoMail names pictures by
  their real type, so U4 links give the right type.
- **The share list** holds every share the person made, also links made in the Drive itself, not
  only NoMail's. NoMail could keep the ids it made, or look at the path (`/NoMail/…`).
- **Limits.** Link creation: 120 per 10 minutes per person (raised from 20 with
  `ratelimit_overwrite`; over it 429). NoMail's own limit for Drive writes is 300 per hour. Files
  up to the upload Worker's 10 GiB; no quota is set for accounts today.
- **Brute-force protection.** Every request for a link that does not exist (or no longer
  does), and every refused public WebDAV login, counts as a failed attempt for the caller's
  address: the next requests of that kind from the address wait longer (doubling, up to 25 s, for
  12 hours) and more than 10 in 30 minutes are refused. NoMail's server never needs to open
  public links; mail readers that fetch a removed picture only slow themselves down.
- **The Drive sends no email yet.** No mail server is set (on 2026-10-25 `occ config:system:get`
  found `mail_smtpmode`, `mail_smtphost` and `mail_from_address` unset). Link-by-email shares,
  calendar invitations and the "email address changed" notice that core sends when
  `/v1/provision` changes an email are not delivered (the notice failed in the provision tests).
  NoMail gives out links in its own emails, so U1–U5 do not depend on it. Sending through NoMail is
  an idea for later (the reply to NoMail, section 15).
- **Antivirus.** A chunked upload over 256 MiB is not scanned while it arrives; the stored-file
  scan checks it within about 15 minutes ([search-and-antivirus.md](search-and-antivirus.md)).
  Files up to 256 MiB are scanned before the `MOVE` answers, which is why the `MOVE` of a 110 MB
  test file took 12–21 s, while the 1.1 GB file's took 1.2 s.

### U2 timing

From the server, out through Cloudflare and back in through the tunnel (as NoMail's requests
travel, but without a home line in the way), on 2026-10-25:

| Step | Time |
|---|---|
| 21 chunk `PUT`s, 1,100,000,000 bytes | 104.5 s (10.5 MB/s); the slowest chunk 6.7 s |
| `MOVE` (put the file together) | 1.2 s |
| Full download (WebDAV `GET`) | 55.4 s (19.9 MB/s) |
| The whole U2 script, links included | 166.8 s |

Each chunk takes a few seconds, far below Cloudflare's 100-second limit per request. Earlier
runs with 110 MB (3 chunks) took 10.0 and 11.5 s to upload and 4.0 s to download.

## Upload Worker

NoMail's page sends big files to `https://drive.nourax.org/nomail-upload` (NoMail's
`UPLOAD_WORKER_URL`) in 50 MiB chunks, each with a sealed ticket. The Worker `nodrive-upload`
([worker/README.md](../worker/README.md)) replays them to the Drive's chunked upload. The ticket
format is v1, unchanged: NoMail seals `uid`, `login` and the "NoMail" app password from
`/v1/provision` with `DRIVE_UPLOAD_TICKET_KEY`; the Worker opens it with the same value
(`UPLOAD_TICKET_KEY`).

### State on 2026-10-25

| | |
|---|---|
| Script | `nodrive-upload` deployed with `npx wrangler deploy` (wrangler 4.152.0): "No targets deployed" |
| Route | **None.** The Cloudflare API lists only `office.nourax.org/nourax-ai/*` (`nourax-office-ai`) for the zone |
| `workers.dev`, previews | Off: `GET …/workers/scripts/nodrive-upload/subdomain` gives `{"enabled":false,"previews_enabled":false}` |
| Custom domains | None |
| Secret | `UPLOAD_TICKET_KEY` set (43 characters), piped from `/etc/nourax/secrets/upload_ticket_key` on the server |
| Settings | `ORIGIN_BASE=https://drive.nourax.org`, `ALLOWED_ORIGINS=https://mail.nourax.org`, chunks up to 50 MiB, files up to 10 GiB |
| Live check | `https://drive.nourax.org/nomail-upload/health` answers 404 (the Drive's own page) |

### Tested without the route

`tests/worker-local.sh <scratch-dir>` (Git Bash on the owner's PC) runs the Worker locally with
`wrangler dev` and a throwaway key, and talks to the live Drive as the QA account `qa-t6-2`. On
2026-10-25 it uploaded a 120 MiB file of random bytes (`125829120` bytes, chunks of 50, 50 and
20 MiB) to `/NoMail/Sent/2026-10/`:

- `POST /start` 201 with `chunks: 3`; three `PUT /chunks/{n}` 201; `GET /chunks` listed all three
  with their sizes; `POST /finish` 201 with the file id.
- A WebDAV `PROPFIND` straight to the Drive showed `getcontentlength` 125829120 and the same file
  id, and the SHA-256 of a WebDAV `GET` matched the SHA-256 of the bytes sent.
- CORS: the preflight from `https://mail.nourax.org` gave 204 with
  `Access-Control-Allow-Origin: https://mail.nourax.org`; from `https://evil.example` 403
  `origin_not_allowed`, without the header.
- Tickets: none, or one sealed with another key, gave 401 `bad_ticket`.
- Chunk 4 of 3 gave 400 `bad_chunk_number`; a short chunk 400 `bad_chunk_length`; starting again
  for the same name 409 `exists`; `DELETE /` cancelled a second upload (204, then 404
  `upload_not_found`) and left no file.

**Found and fixed in that test:** the Drive (Nextcloud 35 on object storage) answers a stored chunk
with an empty **200**, not 201. Its `ChunkingV2Plugin::beforePut` sets 201 and returns `false` on
`beforeMethod:PUT`, and Sabre's `Server::invokeMethod` then returns without sending the response,
so PHP's default 200 (`text/html`, no body) goes out. The chunk is stored all the same. The Worker
took the 200 for an error and answered 502 for every chunk; it now accepts 200, 201 and 204 for a
chunk (a new unit test covers it, and another that a redirect is still an error). The first run's
file, `/NoMail/Sent/2026-10/worker-120m.bin`, is complete (size and file id checked); the runs
after the fix wrote `worker-120m-<time>.bin` and passed all 47 checks, the SHA-256 included.

**Found by QA and fixed (fix round 1, 2026-10-25): a missing chunk gave a short file.** With chunk 2
of 2 missing, `POST /finish` answered 201 and saved only the first 5 MiB of a 6 MiB file; a
finish before any chunk answered 502 and broke the session (every later request 502 until a new
`/start`). The cause is in the Drive: on object storage `ChunkingV2Plugin::beforeMove` adds up
the parts only for the free-space check, never compares them with `OC-Total-Length`, and
completes the R2 multipart upload with whatever parts there are; with no parts the R2 complete
fails and the Drive aborts the multipart upload. NoMail's `driveApi.ts` relies on 409 to resend
lost chunks and takes 201 as success. Now `/finish` lists the session first and needs chunks 1 to
N, each the exact length; otherwise 409 `incomplete` with `error.missing` and no `MOVE`. After the
`MOVE` it answers 201 only when the file's size is the ticket's size (else 500 `size_mismatch`).
A `/finish` sent again after a lost answer gets the same 201 instead of 404. Details:
[worker/README.md](../worker/README.md#how-finish-keeps-files-whole). 16 new unit tests (50 in
all). The run of `tests/worker-local.sh` after the fix passed all 71 checks: the 120 MiB upload as
before (`worker-120m-20261025090525.bin`, SHA-256 equal) and the new 6 MiB one
(`worker-gaps.bin`): finish before any chunk 409 `incomplete`, missing `1,2`, then `GET /chunks`
200 (the session still works); finish with chunk 2 missing 409, missing `2`, and no file on the
Drive; with both chunks 201, and a second finish 201 with the same file id; size 6291456 and
SHA-256 equal on a WebDAV `GET`.

### The route (waits for the owner's yes)

Route `drive.nourax.org/nomail-upload/*` → `nodrive-upload`.

- **Do (Git Bash, in `worker/`):** put the line back into `wrangler.jsonc` (it is there as a
  comment): `"routes": [{ "pattern": "drive.nourax.org/nomail-upload/*", "zone_name": "nourax.org" }],`
  and run `npx wrangler deploy`. Or with the API:
  `POST https://api.cloudflare.com/client/v4/zones/b5ad28d80272c1af478450bab1a2356c/workers/routes`
  with `{"pattern":"drive.nourax.org/nomail-upload/*","script":"nodrive-upload"}`, and then put the
  line back into `wrangler.jsonc` as well.
- **What it changes:** only that path runs the Worker; everything else on `drive.nourax.org` still
  goes to the Drive. No WAF rule covers the path ([cloudflare/waf-rule.md](../cloudflare/waf-rule.md)
  lists it as open, protected by the sealed ticket).
- **Undo:** `DELETE https://api.cloudflare.com/client/v4/zones/b5ad28d80272c1af478450bab1a2356c/workers/routes/<route_id>`
  (the id comes from `GET …/workers/routes`), or the dashboard → Workers Routes → delete. Then take
  the line out of `wrangler.jsonc` again.
- **Test:**
  - `curl -si https://drive.nourax.org/nomail-upload/health -H 'Origin: https://mail.nourax.org'`
    gives 200 `{"status":"ok"}` with `Access-Control-Allow-Origin: https://mail.nourax.org`.
  - The same with `-H 'Origin: https://evil.example'` gives 403 `origin_not_allowed`.
  - A real 120 MiB upload through the route, with every check of the local test (Git Bash, from
    the repo): `WORKER_URL=https://drive.nourax.org/nomail-upload tests/worker-local.sh <scratch-dir>`.
    It seals the tickets with the real key, piped from the server into `mint-ticket.mjs` on stdin
    (never into a file), and ends with "all worker-local checks passed (live route)". `/finish`
    must answer 201. Before the route it stops at once ("the route is not on yet"; tested).
  - That run also shows that 50 MiB chunks stay inside the Workers CPU limit (10 ms on the Free
    plan; the chunk body is piped through, not read by the script). A chunk over the limit would
    answer Cloudflare error 1102 instead of 201.

After the route, NoMail needs the same key as its `DRIVE_UPLOAD_TICKET_KEY` (an owner-yes step for
NoMail's Supabase project, prepared with the other NoMail secrets). Until both match, NoMail's big
uploads get 401 `bad_ticket` and NoMail says the Drive is being set up; nothing else breaks.
