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
Worker nodrive-upload, on drive.nourax.org/nomail-upload/*   (route: after the owner's yes)
   │  Basic auth with the login + app password inside the ticket
   ▼
Drive  /remote.php/dav/uploads/<uid>/<upload-id>/00001 …  then MOVE .file → /remote.php/dav/files/<uid>/NoMail/…
```

Each chunk is one request under Cloudflare's 100 MB body limit (Free plan), so files of any size up
to `MAX_UPLOAD_BYTES` (10 GiB) get through.

## Where it runs

| | |
|---|---|
| Script | `nodrive-upload`, deployed 2026-10-25 with `npx wrangler deploy` |
| Route | **None yet.** `drive.nourax.org/nomail-upload/*` is added only after the owner's yes; see [docs/nomail-contract.md](../docs/nomail-contract.md#upload-worker). Until then `https://drive.nourax.org/nomail-upload/…` is the Drive's own "Page not found" (404). |
| `workers.dev`, preview URLs | Off (`"workers_dev": false`, `"preview_urls": false`) |

When the route is switched on, its line goes back into `wrangler.jsonc` (it is there as a comment),
so the file says what is live. wrangler 4.152 touches routes only when the list is not empty: then
it replaces the script's routes with the list (`PUT …/workers/scripts/nodrive-upload/routes`). So a
deploy without the line leaves a live route alone, and a deploy with it keeps exactly that route.

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
| `POST /finish` | Puts the file together | 201 `{path, fileId, size, etag, contentType}`; 409 `incomplete` when chunks are missing |
| `DELETE /` | Cancels the upload session | 204 |

Errors look like `{"error":{"code":"…","message":"…"}}`. A bad, expired or missing ticket gives
401 `bad_ticket`. The Drive's answers become `drive_unauthorized` (401), `upload_not_found` (404),
`conflict` (409), `throttled` (429), `quota_exceeded` (507) or `drive_error` (502). A request
without an `Origin` header (a server tool, a test) is let through: it still needs a ticket.

## The ticket, v1

`"v1." + base64url(12-byte IV || AES-256-GCM ciphertext and tag)`, additional data
`nodrive-upload-v1`, key `UPLOAD_TICKET_KEY`. NoMail seals it in
`supabase/functions/_shared/driveTicket.ts` with the same key (its `DRIVE_UPLOAD_TICKET_KEY`);
[tools/mint-ticket.mjs](tools/mint-ticket.mjs) is the reference and the test tool. Inside is JSON:

| Field | Rule |
|---|---|
| `v` | `1` |
| `uid` | The Drive user id, used in the DAV paths: 1-64 of `A-Z a-z 0-9 . _ @ -` |
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
npm test            # 34 tests: tickets, CORS, every request, the Drive's answers
npm run typecheck
```

`tests/worker-local.sh <scratch-dir>` (Git Bash on the owner's PC, from the repo) runs this Worker
with `wrangler dev` and a throwaway key, and uploads a real 120 MiB file through it into the live
Drive as `qa-t6-2`; see [tests/README.md](../tests/README.md).
