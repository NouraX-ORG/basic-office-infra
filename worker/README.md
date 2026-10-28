# nodrive-upload

The Cloudflare Worker that carries big uploads from NoMail's page (`https://mail.nourax.org`) into
the person's Drive. NoMail's server (Supabase Edge Functions) cannot carry large bodies, and the
Drive sends no CORS headers, so the browser sends the file here in 50 MiB chunks. The Worker
answers the CORS preflight, opens the sealed ticket and replays each chunk to the Drive's chunked
upload (WebDAV chunked upload v2) with the person's app password. It stores nothing.

```
NoMail page (browser, mail.nourax.org)
   │  X-Upload-Ticket: v1.…   (sealed by NoMail's server; the browser cannot read it)
   ▼
Worker nodrive-upload, on drive.nourax.org/nomail-upload/*   (route on since 2026-10-28)
   │  Basic auth with the login + app password inside the ticket
   ▼
Drive  /remote.php/dav/uploads/<uid>/<upload-id>/00001 …  then MOVE .file → /remote.php/dav/files/<uid>/NoMail/…
```

Each chunk is one request under Cloudflare's 100 MB body limit (Free plan), so files of any size up
to `MAX_UPLOAD_BYTES` (10 GiB) get through.

## Where it runs

| | |
|---|---|
| Script | `nodrive-upload`, deployed with `npx wrangler deploy` (first 2026-10-25; with its route 2026-10-28, version `1ac4bf36-d0c1-4c41-a265-a1d02a4c2f83`) |
| Route | `drive.nourax.org/nomail-upload/*`, on since 2026-10-28 21:24 UTC with the owner's yes; see [docs/nomail-contract.md](../docs/nomail-contract.md#the-route-on-since-2026-10-28). Every other path on `drive.nourax.org` goes straight to the Drive. |
| `workers.dev`, preview URLs | Off (`"workers_dev": false`, `"preview_urls": false`) |

The route's line is in `wrangler.jsonc`, so the file says what is live. wrangler 4.152 touches
routes only when the list is not empty: then it replaces the script's routes with the list
(`PUT …/workers/scripts/nodrive-upload/routes`). So a deploy keeps exactly that route, and a
deploy from an older copy without the line leaves the live route alone.

## Requests

All under `/nomail-upload`. Every request except `/health` and `OPTIONS` needs the ticket in the
`X-Upload-Ticket` header.

| Method and path | What it does | Answer |
|---|---|---|
| `OPTIONS` any | CORS preflight | 204 with `Access-Control-Allow-Origin` for an allowed origin; 403 `origin_not_allowed` for any other |
| `GET /health` | Is the Worker there? | 200 `{"status":"ok"}` |
| `POST /start` | Makes the `/NoMail/…` folders and the upload session | 201 `{upload, path, size, chunkSize, chunks}`; 409 `exists` when the name is taken |
| `PUT /chunks/{n}` | Chunk `n` (from 1). Every chunk except the last is exactly `chunk` bytes; `Content-Length` is required | 201 `{chunk, size}`; 400 `bad_chunk_number` or `bad_chunk_length`; 411 without a length |
| `GET /chunks` | The chunks the Drive has, to resume | 200 `{received:[{n, size}]}` |
| `POST /finish` | Checks that every chunk is there with its exact length, then puts the file together | 201 `{path, fileId, size, etag, contentType}`; 409 `incomplete` with `missing:[n…]` when a chunk is missing or the wrong length (no file is made, and the session stays usable); 409 `unexpected_chunks`; 415 when the Drive's virus check refuses the file (below); 500 `size_mismatch` |
| `DELETE /` | Cancels the upload session | 204 |

Errors look like `{"error":{"code":"…","message":"…"}}`. A bad, expired or missing ticket gives
401 `bad_ticket`. The Drive's answers become `drive_unauthorized` (401), `drive_forbidden` (403),
`upload_not_found` (404), `conflict` (409), `throttled` (429), `quota_exceeded` (507) or
`drive_error` (502). A request without an `Origin` header (a server tool, a test) is let through:
it still needs a ticket.

**The Drive's virus check (415).** The Drive's "Antivirus for files" app scans an upload when the
`MOVE` puts it together, and answers 415 for an infected file (`Virus <signature> is detected in
the file. Upload cannot be completed.`) and also while it cannot reach the scanner (`No connection
to anti virus. Upload cannot be completed.`; it blocks uploads then). After such a `MOVE` the
upload session is broken (the Drive answers 500 for it), so the Worker passes the 415 on, a status
NoMail's page does not retry, instead of the 502 it would retry:

| Code (all 415) | When | `message` |
|---|---|---|
| `virus_found`, with `signature` | The English "Virus … is detected" message | `the Drive's virus scanner found <signature> in this file, so it was not saved` |
| `scanner_unavailable` | The English "No connection to anti virus" message | `the Drive's virus scanner could not be reached, so the file was not saved - try again in a few minutes` |
| `file_refused` | Any other 415 (the Drive writes its messages in the person's language) | `the Drive refused this file: <the Drive's message>` (plain text, at most 300 characters of it) |

Only a new upload (a new ticket and upload id) can follow. The same mapping applies to a chunk
`PUT`, although the Drive does not scan chunks today.

### How `/finish` keeps files whole

The Drive (Nextcloud 35 with its files in R2) does **not** check the chunks itself. Its
`ChunkingV2Plugin::beforeMove` adds up the parts' sizes only for the free-space check and never
compares them with `OC-Total-Length`; the `MOVE` then completes the R2 multipart upload with
whatever parts are there and answers 201. A lost chunk would give a short file, and a `MOVE` with
no parts at all fails on R2, after which the Drive drops the session (every later request 500).
So the Worker does the check:

1. It lists the session (`PROPFIND` Depth 1, as `GET /chunks` does) and needs chunks 1 to N, each
   exactly the length the ticket gives it (every chunk `chunk` bytes, the last one the rest).
   Anything missing or the wrong length: 409 `incomplete` with the first 100 chunk numbers to send
   again in `error.missing`; no `MOVE`. Chunks past N (only possible with two tickets of
   different sizes for one upload id): 409 `unexpected_chunks`.
2. Only then the `MOVE`. A 400 or 412 from it still becomes 409 `incomplete`.
3. It reads the file back (`PROPFIND`) and answers 201 only when its size is the ticket's size;
   otherwise 500 `size_mismatch` (not retried by NoMail), never 201.

A `/finish` sent again after a lost answer finds no session. If the file is there with the full
size, the answer is the same 201 as the first time; with another size, 500 `size_mismatch`; with
no file, 404 `upload_not_found`.

## The ticket, v1

`"v1." + base64url(12-byte IV || AES-256-GCM ciphertext and tag)`, additional data
`nodrive-upload-v1`, key `UPLOAD_TICKET_KEY`. NoMail seals it in
`supabase/functions/_shared/driveTicket.ts` with the same key (its `DRIVE_UPLOAD_TICKET_KEY`);
[tools/mint-ticket.mjs](tools/mint-ticket.mjs) is the reference and the test tool. Inside is JSON:

| Field | Rule |
|---|---|
| `v` | `1` |
| `uid` | The Drive user id, used in the DAV paths: 1-64 of `A-Z a-z 0-9 . _ @ -`, not only dots |
| `login` | The login for Basic auth, 1-256 characters (from `/v1/provision`: the same as `uid`) |
| `pass` | The app password named "NoMail" (from `/v1/provision`) |
| `path` | The destination, starting with `/NoMail/`; no empty, `.` or `..` parts, no backslashes or control characters |
| `size` | 1 byte to `MAX_UPLOAD_BYTES` |
| `chunk` | 5 MiB to `MAX_CHUNK_BYTES`; at most 10,000 chunks |
| `upload` | The upload id NoMail picks: 8-64 of `A-Z a-z 0-9 -` |
| `exp` | Unix seconds; in the future and at most 24 hours ahead (NoMail uses 12 hours) |
| `mtime` | Optional modification time, unix seconds |

The format stays as it is. A change would need a `v2.` prefix and a matching change in NoMail.

## Settings and secret

| Name | Kind | Value |
|---|---|---|
| `ORIGIN_BASE` | var | `https://drive.nourax.org` |
| `ALLOWED_ORIGINS` | var | `https://mail.nourax.org` (comma-separated list) |
| `MAX_CHUNK_BYTES` | var | `52428800` (50 MiB) |
| `MAX_UPLOAD_BYTES` | var | `10737418240` (10 GiB) |
| `UPLOAD_TICKET_KEY` | secret | 32 random bytes, base64url (43 characters). Kept on the server as `/etc/nourax/secrets/upload_ticket_key`; NoMail gets the same value as `DRIVE_UPLOAD_TICKET_KEY` |

The secret was set on 2026-10-25 by piping the server's file straight into wrangler, so the value
never showed on screen (Git Bash, in `worker/`):

```
ssh -i ~/.ssh/nourax_workspace_ed25519 -o BatchMode=yes -o IdentitiesOnly=yes nourax@57.129.185.78 \
	'sudo cat /etc/nourax/secrets/upload_ticket_key' | tr -d '\r\n' | npx wrangler secret put UPLOAD_TICKET_KEY
npx wrangler secret list      # shows the name only
```

**Changing the key:** make a new one on the server
(`openssl rand 32 | basenc --base64url | tr -d '=\n' | sudo scripts/secrets.sh put upload_ticket_key`),
pipe it into the Worker as above, then give NoMail the same value (an owner-yes step, see
[docs/nomail-contract.md](../docs/nomail-contract.md#upload-worker)). Until both sides match,
uploads get 401 `bad_ticket`; nothing else breaks.

## Tests

```
npm ci
npm test            # 50 tests: tickets, CORS, every request, the Drive's answers, the /finish checks
npm run typecheck
```

`tests/worker-local.sh <scratch-dir>` (Git Bash on the owner's PC, from the repo) runs this Worker
with `wrangler dev` and a throwaway key, and uploads a real 120 MiB file through it into the live
Drive as `qa-t6-2`. A second, 6 MiB upload finishes too early on purpose (before any chunk, then
with a chunk missing: 409 `incomplete` and no file each time), and then twice in a row (201 and
the same file both times). See [tests/README.md](../tests/README.md).
