# The NoMail contract

What NoMail uses on the Drive, and how each part was tested. NoMail's side is in the NoMail repo
(`supabase/functions/_shared/drive.ts`, `driveFiles*.ts`, `driveTicket.ts` and `src/lib/driveApi.ts`).

| Part | Where it is described |
|---|---|
| The NoMail API: health, provision, scan | [nomail-api.md](nomail-api.md) |
| Organisations, teams and people (admin API) | [teams.md](teams.md) |
| Big uploads from the NoMail page | [Upload Worker](#upload-worker), below |
| U1-U5 (folders, uploads, links, images, link list) | Not written yet: added with the contract tests (`tests/nomail-contract.sh`) |

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
