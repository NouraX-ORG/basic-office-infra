# The NoMail contract

What NoMail uses on the Drive, and how each part was tested. NoMail's side is in the NoMail repo
(`supabase/functions/_shared/drive.ts`, `driveFiles*.ts`, `driveTicket.ts`, and the browser's
`src/lib/driveApi.ts` and `src/lib/driveFiles.ts`).

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
# 201 new; 204 when it replaced a file with the same name; 415 when the virus check refuses it
# (see "Virus check on upload (415)" below)
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
  Drive and the upload Worker use 50 MiB (52,428,800 bytes). The Drive's own WebDAV chunk `PUT`
  answers an empty **200** for a stored chunk, not the 201 of the docs (Nextcloud 35 on object
  storage). This is only about the raw WebDAV request: the upload Worker's `PUT /chunks/{n}`, which
  NoMail's page calls, still answers **201** (it takes the Drive's 200, 201 or 204 as stored). The
  Drive does not compare the chunks with `OC-Total-Length` at the `MOVE`: check the upload folder
  (a `PROPFIND`, Depth 1, lists `1`, `2`, … with their sizes) before the `MOVE`, as the Worker's
  `/finish` does.
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
  `password`, then `password=` (empty), which takes the password off and keeps the end date.
  Tested in the QA review on 2026-10-25: an empty `expireDate` (NoMail's "no end date"),
  `PUT …/shares/125` with the form body `expireDate=`, gave HTTP 200, statuscode 200 and
  `expiration: null`, and a `GET` of the link afterwards also showed `expiration: null`.
- **Passwords** for links: at least 10 characters, not a common or leaked password
  (`password_policy`; leaked ones are checked against haveibeenpwned.com). A refusal is a 400 with
  a plain message, which NoMail passes on. That message can be longer than NoMail keeps: the
  password `abc12` gave HTTP 400, statuscode 400 and a message of three sentences, about 236
  characters (QA review, 2026-10-25), while NoMail's `shareFailure()` keeps only
  `message.slice(0, 200)`, so its last sentence is cut off mid-word. NoMail could keep 400.
- **The `/NoMail` folder is not empty on a new account.** The Drive's welcome files are copied
  into every new account: `/Welcome to Nourax Workspace.md` at the top and
  `/NoMail/About this folder.md` (`text/markdown`, 380 bytes), which a `PROPFIND` of `/NoMail/`
  lists next to `Sent/`, `Received/` and `Images/`. NoMail's `listFolder()` hides only names that
  start with a dot, so its Drive picker shows that file. That is harmless (it explains the
  folder); NoMail can hide it by name if it wants.
- **A disabled account whose app passwords were not revoked answers 503, not 401.** When the
  account is disabled through the admin API (`"active": false`), every app password is revoked
  and WebDAV answers 401. But when a server administrator disables it by hand
  (`occ user:disable`), the app password stays, and WebDAV answers **503** with
  `OC\User\DisabledUserException: Account disabled` (seen in the QA review for `PUT`, `MKCOL` and
  `MOVE` with `qa-t6-1` disabled). NoMail's `checkDriveLogin()` then returns `unavailable` and
  `failure()` shows "Nourax Drive answered 503.", and it keeps trying. `/v1/provision` for that
  person answers 409 `account_disabled` (tested), which is the way to tell the two apart.
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
  test file took 12–21 s, while the 1.1 GB file's took 1.2 s. A refused upload answers **415**:
  see the next section.

### Virus check on upload (415)

The Drive's "Antivirus for files" app (`files_antivirus` 6.5.0) checks an upload when it is
written: a plain `PUT` (U3, U4) at once, a chunked upload (U2) at its `MOVE`. It refuses with
**HTTP 415** and a Sabre error body (its shape as the installed `sabre/dav` `Server.php` and
`apps/dav` write it; the message as seen live):

```
<?xml version="1.0" encoding="utf-8"?>
<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">
  <s:exception>OCA\DAV\Connector\Sabre\Exception\UnsupportedMediaType</s:exception>
  <s:message>Virus Eicar-Test-Signature is detected in the file. Upload cannot be completed.</s:message>
</d:error>
```

| Case | `<s:message>` (English; it follows the person's language) | How it was checked |
|---|---|---|
| Infected file | `Virus <signature> is detected in the file. Upload cannot be completed.` | **Tested** in the QA review on 2026-10-25 as `qa-t6-1` through Cloudflare: a plain `PUT` of the EICAR string answered 415 with this message and left no file (a `GET` afterwards 404). A chunked upload: `MKCOL` 201, `PUT 00001` 200, then `MOVE` 415 with the same message; afterwards a `PROPFIND` of the upload session answered 500 (the session is broken). |
| The scanner cannot be reached | `No connection to anti virus. Upload cannot be completed.` | **Not tested live**; read in the installed source. The app runs with `av_block_unreachable` = 1 (checked with `occ config:app:get`), so while ClamAV is down or reloading **every** upload gets this 415 (`AvirWrapper::handleConnectionError`, then `apps/dav/lib/Connector/Sabre/File.php` turns its `InvalidContentException` into `UnsupportedMediaType`). |

The Drive's chunk `PUT`s are not checked (the EICAR chunk was stored with 200); only the `MOVE` is.

**How NoMail's code reads it today** (commit `a9b5f07`) and what it should do:

- **U3 and U4** (`_shared/driveFiles.ts`): `putFile()` passes 415 to `failure()`, which has no
  branch for it and returns a 502 "Saving the file: Nourax Drive answered 415." NoMail should add a
  415 branch with a plain message (for example "Your Drive's virus scanner found a virus in this
  file, so it was not saved." when the message starts with `Virus`, otherwise "Your Drive could not
  check this file for viruses just now, so it was not saved. Please try again in a few minutes.")
  and not retry it as it is. Note that `uploadEmailImage` already uses 415 for its own
  "Only PNG, JPEG, GIF and WebP pictures" refusal; keep the two apart.
- **U2** (the upload Worker, `src/lib/driveApi.ts`): before 2026-10-25 12:09 UTC the Worker turned
  the `MOVE`'s 415 into 502 `drive_error`; `driveApi.ts` reads 502 as retryable and would have sent
  `/finish` 4 more times, each failing on the broken session. **The Worker now passes the 415 on**
  (below), and `driveApi.ts` does not retry 415, so the person sees
  `Finishing the upload failed: <the Worker's message>.` once. NoMail can show its own plain
  message for the codes `virus_found` and `scanner_unavailable`.

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

### State on 2026-10-28

| | |
|---|---|
| Script | `nodrive-upload` deployed with `npx wrangler deploy` (wrangler 4.152.0). Current version `1ac4bf36-d0c1-4c41-a265-a1d02a4c2f83`, deployed 2026-10-28 21:24:43 UTC with the route (same code as before). Earlier: `4730d701-9b74-4004-b4af-8958714a49b6` (2026-10-25 12:09 UTC, the 415 pass-through below, no route) and `92671026-32aa-4af0-a852-aaed05f78e67` (09:07 UTC) |
| Route | `drive.nourax.org/nomail-upload/*` → `nodrive-upload`, route id `4b377ec8ebfb4ad8b6c0c3042987f411`, on since 2026-10-28 21:24 UTC ([below](#the-route-on-since-2026-10-28)). The zone's only other Worker route is `office.nourax.org/nourax-ai/*` (`nourax-office-ai`) |
| `workers.dev`, previews | Off: `GET …/workers/scripts/nodrive-upload/subdomain` gives `{"enabled":false,"previews_enabled":false}` |
| Custom domains | None |
| Secret | `UPLOAD_TICKET_KEY` set (43 characters), piped from `/etc/nourax/secrets/upload_ticket_key` on the server on 2026-10-25. **Proven to be the same value as the server file** on 2026-10-28: the live route test sealed every ticket with the server file's key (piped over SSH into `mint-ticket.mjs`), and the Worker opened them all (`/start` 201, `/finish` 201); a ticket sealed with another key got 401 `bad_ticket` |
| Settings | `ORIGIN_BASE=https://drive.nourax.org`, `ALLOWED_ORIGINS=https://mail.nourax.org`, chunks up to 50 MiB, files up to 10 GiB |
| Live check | `https://drive.nourax.org/nomail-upload/health` answers 200 `{"status":"ok"}` |

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

### The Drive's virus check through the Worker (415)

Found in the QA review on 2026-10-25: the Drive's `MOVE` answers 415 when its virus check refuses
the file ([above](#virus-check-on-upload-415)), and the Worker used to turn that into 502
`drive_error`, which NoMail's page would retry 4 times against a session that is already broken.
Since version `4730d701-…` (12:09 UTC) the Worker answers **415**, which NoMail's page does not
retry, with a plain message:

| `error.code` | When | `error.message` |
|---|---|---|
| `virus_found` (and `error.signature`) | The Drive's English "Virus … is detected" message | `the Drive's virus scanner found <signature> in this file, so it was not saved` |
| `scanner_unavailable` | The Drive's English "No connection to anti virus" message | `the Drive's virus scanner could not be reached, so the file was not saved - try again in a few minutes` |
| `file_refused` | Any other 415 (for example the message in another language) | `the Drive refused this file: <the Drive's message>` |

Only a new upload can follow. NoMail's page already sends `DELETE /` when an upload fails.
**Tested** with 6 new unit tests that feed the Worker the Drive's 415 answer (`npm test` in
`worker/`: 56 tests pass; `tsc --noEmit` clean), and **live through the route** on 2026-10-28
(R4 [below](#the-route-on-since-2026-10-28)): the EICAR string (68 bytes, one chunk) gave
`PUT /chunks/1` 201 (the Drive does not scan chunks), then `POST /finish` **415** `virus_found`
with `signature` `Eicar-Test-Signature`; no file at the destination, nothing in Deleted files;
the `DELETE /` that NoMail's page sends afterwards answered 204, and the upload session was gone
(`PROPFIND` 404).

### The route (on since 2026-10-28)

Route `drive.nourax.org/nomail-upload/*` → `nodrive-upload`, route id
`4b377ec8ebfb4ad8b6c0c3042987f411`. Switched on 2026-10-28 21:24 UTC with the owner's yes
(NoMail's handoff `2026-10-28-nomail-to-drive-upload-route.md`), by putting the `routes` line into
`worker/wrangler.jsonc` and running `npx wrangler deploy` in `worker/` (version
`1ac4bf36-d0c1-4c41-a265-a1d02a4c2f83`, the same code as `4730d701-…`). Later deploys keep the
route because the line is in the file.

- **What it changes:** only that path runs the Worker; everything else on `drive.nourax.org` still
  goes to the Drive. No WAF rule covers the path ([cloudflare/waf-rule.md](../cloudflare/waf-rule.md)
  lists it as open, protected by the sealed ticket). Checked through the Cloudflare API before the
  switch: the zone's three custom rules (NoMail's `318d…`, `1f4cc937…` with its IP lock on login,
  settings and the user/group API only, `4b382b6c…` on `office.nourax.org` only) do not match
  `/nomail-upload/…`; Bot Fight Mode is off; there are no rate-limit, managed, redirect,
  transform or configuration rules. Security level "medium" and Browser Integrity Check apply as
  for the rest of the Drive (a normal browser passes both).
- **Undo:** take the line out of `wrangler.jsonc` and delete the route:
  `DELETE https://api.cloudflare.com/client/v4/zones/b5ad28d80272c1af478450bab1a2356c/workers/routes/4b377ec8ebfb4ad8b6c0c3042987f411`
  (or the dashboard → Workers Routes → delete). A deploy without the line does not remove it.
- **Key:** NoMail's `DRIVE_UPLOAD_TICKET_KEY` must be the value of the server file
  `/etc/nourax/secrets/upload_ticket_key` (43 characters, no newline). The Worker's
  `UPLOAD_TICKET_KEY` is proven to be that value (R3). Until NoMail has it, NoMail's big uploads
  get 401 `bad_ticket` and NoMail says the Drive is being set up; nothing else breaks.

**Tests on 2026-10-28** (owner's PC, Git Bash; `qa-t6-2` switched on for the test and off again
afterwards):

| # | Test | Result |
|---|---|---|
| R1 | `curl -sS https://drive.nourax.org/nomail-upload/health` | 200 `{"status":"ok"}`, `Content-Type: application/json`, `Cache-Control: no-store` |
| R2 | Preflight (`OPTIONS /chunks/1`, `Access-Control-Request-Headers: x-upload-ticket`) | From `https://mail.nourax.org`: 204 with `Access-Control-Allow-Origin: https://mail.nourax.org`, allow-headers `X-Upload-Ticket, Content-Type`, methods `GET, POST, PUT, DELETE, OPTIONS`, max-age 86400. From `https://evil.example`: 403 `origin_not_allowed`, no `Access-Control-*` header |
| R3 | `WORKER_URL=https://drive.nourax.org/nomail-upload tests/worker-local.sh <scratch-dir>`, every ticket sealed with the server file's key | **All 71 checks passed** (21:26:44–21:28:16 UTC). 120 MiB (`125829120` bytes, chunks 50 + 50 + 20 MiB, 13 s, 14 s and 7 s): `/start` 201, three `PUT` 201, `/finish` **201** (17 s) with file id 22452; WebDAV `PROPFIND` 125829120 bytes and the same id; SHA-256 of a WebDAV `GET` = SHA-256 sent (`4f0061b4…41753`). Also: wrong-key ticket 401, no ticket 401, chunk 4 of 3 → 400, short chunk → 400, same name → 409 `exists`, cancel → 204 then 404, early finish → 409 `incomplete` (no file), finish twice → 201 with the same file |
| R4 | The EICAR string (68 bytes, built in memory from two halves) through the route | `PUT /chunks/1` 201, `POST /finish` **415** `{"error":{"code":"virus_found","message":"the Drive's virus scanner found Eicar-Test-Signature in this file, so it was not saved","signature":"Eicar-Test-Signature"}}`; destination `PROPFIND` 404; not in Deleted files; `DELETE /` afterwards 204; upload session `PROPFIND` 404 |
| R5 | `wrangler tail nodrive-upload` during R3 and R4 (headers never kept) | 31 requests, all outcome `ok`, version `1ac4bf36…`; no 5xx, no exception, no `exceededCpu`/1102. CPU per request: 50 MiB chunk 1–2 ms, `/start` 3–4 ms, `/finish` 7 ms (the most; the Free plan allows 10 ms) |
| R5+ | 205 MiB in **41** chunks of 5 MiB through the route, read back over WebDAV | All 41 `PUT` 201 (88 s), `GET /chunks` lists 41, `/finish` 201 (40 s), SHA-256 equal. 44 requests, all `ok`; chunk `PUT` at most 3 ms CPU, `GET /chunks` 2 ms, `/finish` 8 ms: the chunk count hardly changes the CPU time |
| R6 | The rest of `drive.nourax.org`, before and after | Unchanged: `/apps/nourax_api/v1/health` 401, `/remote.php/dav/files/x/` 401, `/status.php` 200 (installed, no maintenance, "Nourax Workspace"), `/` 302 to `/login`, `/login` 200, `/s/<unknown>` 404, `/nomail-uploadx` 404. Only `/nomail-upload/health` changed (404 → 200) |

**Watch:** `/finish` takes 7–8 ms of the Free plan's 10 ms CPU per request. Cloudflare allows a
Worker to go over now and then ("some built-in flexibility"), but a steady overrun would answer
1102. If NoMail ever sees 1102 on `/finish`, the fix is the Workers Paid plan (an owner purchase) or
less work in `/finish`; the chunks themselves use 1–3 ms.

Files left in `qa-t6-2`'s `/NoMail/Sent/2026-10/` (a QA account, switched off again):
`worker-120m-live.bin`, `worker-gaps-live.bin`, `worker-41chunks-live-20261028213000.bin`.
