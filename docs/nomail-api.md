# NoMail API

NoMail's Supabase Edge Functions use this API to check the Drive, create a person's Drive
account and virus-scan attachments (NoMail's handoff `2026-10-23-nourax-nomail-to-drive-provision-scan.md`,
section 2). The admin-only organisations and teams API lives in the same app, with its own signed
key, and is never offered as an MCP tool: see [docs/teams.md](teams.md).

| | |
|---|---|
| Base URL (`NODRIVE_API_URL`) | `https://drive.nourax.org/apps/nourax_api` (no trailing slash) |
| Where it runs | The app `nextcloud-apps/nourax_api` (PHP), version 1.0.0, inside the file server's `app` container. No extra container, tunnel route or admin password. |
| Switched on by | `scripts/configure.d/60-nomail-api.sh` |
| Auth | `Authorization: Bearer <NODRIVE_API_KEY>` |
| Status | Live since 2026-10-25. NoMail switches it on by setting its Supabase secrets (below, [NoMail's secrets](#nomails-secrets)). |
| Reply to NoMail | `handoffs/2026-10-25-nourax-drive-to-nomail.md` (outside this repo, in the owner's handoffs folder) |

The app uses the server's own APIs (users, groups, files, app passwords), so it needs no admin
login and opens nothing new to the internet: `/apps/nourax_api/...` is the only new path.

## Endpoints

| Call | Answer | Status |
|---|---|---|
| `GET /v1/health` | `{"status":"ok","clamav":"ok"\|"unavailable","signatures":"YYYY-MM-DD"\|null}` | Live |
| `POST /v1/provision` | `{"uid","login","app_password","created"}` | Live |
| `POST /v1/scan` | `{"status":"clean"}` or `{"status":"infected","signature"}`; 413, 422, 429, 503 | Live |

`status` is always `ok` while the API answers. ClamAV being down only changes `clamav` to
`unavailable` (and `signatures` to `null`): NoMail's account set-up needs `status` only, and its
scanner waits for `clamav` = `ok` by itself. `signatures` is the date of the newest signatures,
from clamd's `VERSION` answer (`ClamAV 1.x/<db>/<date>`). The ClamAV check gives up after 3 seconds.

```
curl -sS https://drive.nourax.org/apps/nourax_api/v1/health \
  -H "Authorization: Bearer $NODRIVE_API_KEY"
{"status":"ok","clamav":"ok","signatures":"2026-10-24"}
```

Tested 2026-10-25 09:41 UTC (clamd `ClamAV 1.5.4/28163/Sat Oct 24 06:26:10 2026`). With ClamAV
pointed at a missing host the answer was `{"status":"ok","clamav":"unavailable","signatures":null}`.

### `POST /v1/provision`

Creates or fetches a person's Drive account and gives NoMail a fresh app password for it.

```
curl -sS https://drive.nourax.org/apps/nourax_api/v1/provision \
  -H "Authorization: Bearer $NODRIVE_API_KEY" -H 'Content-Type: application/json' \
  --data-binary '{"user_id":"<Supabase user id>","email":"a@nourax.org","display_name":"A Person"}'
{"uid":"<Supabase user id>","login":"<Supabase user id>","app_password":"<72 letters and digits>","created":true}
```

**Request:** JSON, at most 16 KB.

| Field | Rule |
|---|---|
| `user_id` | The Supabase user id: a lowercase UUID. QA ids `qa-t<task>-<n>` are allowed for the tests. Anything else is refused, so `nodrive`, `admin` or any other local name can never be reached. |
| `email` | Trimmed, at most 320 characters, a valid address. May be empty: then the account's email is left as it is. |
| `display_name` | At most 255 characters. Control characters become spaces. May be empty: then the name is left as it is. |

**What it does** (every step is "make sure", so calling again is safe):

1. **The account.** If there is no account with this uid, it makes a "Log in with Nourax" account
   (user_oidc, provider `Nourax`, uid = `user_id`) the way user_oidc's own create-user API does,
   and copies the Nourax welcome files into it. A later "Log in with Nourax" lands in the same
   account. The app first checks that the provider maps uid = `sub` as it is (no hash, no
   prefix), and answers 503 `oidc_uid_mapping` if not.
2. **Name and email** follow NoMail when they change. The uid never changes.
3. **Folders:** `/NoMail`, `/NoMail/Sent`, `/NoMail/Received` and `/NoMail/Images`.
4. **App password:** older app passwords named `NoMail` are revoked, then a new one is made the
   way `occ user:auth-tokens:add` does: 72 letters and digits, permanent, without the login
   password. It is returned once and never logged. Its creation shows in the person's activity
   ("security").

`login` is the uid. NoMail uses `login` + `app_password` with HTTP Basic auth for WebDAV and
the sharing API, and in the upload Worker's tickets. `created` is `true` only on the call that
made the account. A first call takes about 7 seconds (the account and its folders); later calls
well under a second.

**One run per account at a time.** A second call for the same account while one runs gets 409
`busy` (a Redis lock, 60 seconds at most). NoMail counts that as a failed try and asks again
2 minutes later.

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_request` | Not JSON, a missing field, a `user_id` that is not a lowercase UUID or QA id, a bad email |
| 409 | `uid_not_oidc` | An account with this uid exists but is not a "Log in with Nourax" account (e.g. a local one). It is not changed. |
| 409 | `account_disabled` | The account is disabled. It stays disabled; no password is made. |
| 409 | `busy` | Another call for this account is running |
| 409 | `folder_conflict` | A file sits where one of the `/NoMail` folders belongs. It is left alone. |
| 413 | `too_large` | The body is over 16 KB |
| 503 | `oidc_unavailable`, `oidc_provider_missing`, `oidc_uid_mapping` | "Log in with Nourax" is off, missing, or maps uids differently |

409 and not 403 or 404, because NoMail reads 401, 403, 404, 429 and 5xx as "the API is not ready"
and would never stop asking; 400, 409 and 413 count as failed tries, retried after 2, 4, 8 and
16 minutes, then every 6 hours.

### `POST /v1/scan`

Virus-scans one file with ClamAV (the `clamav` service, clamd on `clamav:3310` inside the compose
network) and forgets it.

```
curl -sS https://drive.nourax.org/apps/nourax_api/v1/scan \
  -H "Authorization: Bearer $NODRIVE_API_KEY" -H 'Content-Type: application/octet-stream' \
  -H 'X-File-Name: report%20Q3.pdf' --data-binary @report.pdf
{"status":"clean"}
```

**Request:** the raw file bytes as the body, at most **99,614,720 bytes** (95 MiB, NoMail's
`MAX_SCAN_BYTES`; Cloudflare refuses bodies over 100 MB). `X-File-Name` is optional and used for
the debug log only: it is URL-decoded, cut to 200 characters and never logged at the normal log
level. `Content-Type` is not checked.

| Status | Body | When | NoMail reads it as |
|---|---|---|---|
| 200 | `{"status":"clean"}` | clamd found nothing | clean |
| 200 | `{"status":"infected","signature":"Eicar-Test-Signature"}` | clamd found something. The name is clamd's, at most 200 characters, without control characters. | infected |
| 413 | `{"error":"too_large","max_bytes":99614720}` | `Content-Length` over the limit (refused before clamd is asked), a chunked body that goes over it while it streams, or clamd's own size limit | "Too big for the virus scanner" (not retried) |
| 422 | `{"error":"scan_error"}` | clamd failed part-way: an `ERROR` answer, a closed connection, or no answer within 60 seconds of a wait (90 seconds in all) | a failed try for this file: retried after 2, 4, 8 and 16 minutes |
| 429 | `{"error":"scanner_busy"}`, `Retry-After: 30` | 2 scans are already running (`scan_concurrency`) | "not ready": the run stops and tries again next minute |
| 429 | `{"error":"rate_limited"}`, `Retry-After: 30` | over 60 scans this minute | the same |
| 503 | `{"error":"scanner_unavailable"}`, `Retry-After: 60` | clamd cannot be reached within 5 seconds (ClamAV is down or starting) | the same |

NoMail scans one file at a time, so it only meets `scanner_busy` when something else scans at
the same moment.

**How it works.** The body goes from the request (`php://input`) straight to clamd with the
`INSTREAM` command: `zINSTREAM\0`, then 1 MiB pieces, each with a 4-byte big-endian length, then
a zero length, then clamd's answer (`stream: OK`, `stream: <name> FOUND` or `... ERROR`). At most
2 scans run at once, counted in Redis; a slot frees itself after 150 seconds if its PHP process
dies. Every scan gets an audit row with the result (`clean`, `infected`, `too_large`, ...), never a
file name or a byte of the file.

**No stored copy.** The app never writes the bytes anywhere: no file, no log, no database, no
Drive storage. Two programs keep a short-lived temporary file, as they always do, and delete it
at once:

- PHP keeps any request body over 16 KB in a temporary file in the app container's `/tmp` until
  the request ends;
- clamd writes the stream to a temporary file in the clamav container's `/tmp` while it scans.

Tested 2026-10-25: after 12 scan calls (among them three of 95 MiB that ran, two of them at
once) the file table had the same 620 rows, no new file over 1 MiB in the data folder, no PHP or clamd temporary file left, and
neither the test file names nor any EICAR bytes in the server log.

Optional later hardening, not done: `php_admin_flag enable_post_data_reading off` for this path
only would let PHP pass the body through without its temporary file. It needs the Apache config
of the `app` and `cron` containers changed, so they would have to be recreated.

**What clamd must allow.** `StreamMaxLength` and `MaxFileSize` at least 100M and `MaxScanSize` at
least 100M (they are 110M, 110M and 400M in `config/clamav/clamd.conf`, Task 5). Lowering them
below 95 MiB would turn big attachments into 413s.

**Measured** on 2026-10-25 (2 vCPU, 3.7 GB RAM), from the server through Cloudflare:

| Body | Answer | Total time | Time inside the app |
|---|---|---|---|
| EICAR test string (68 bytes) | infected, `Eicar-Test-Signature` | 0.26 s | 30 ms |
| 5 MiB of random bytes | clean | 1.1 s | 0.8 s |
| 99,614,720 bytes (the limit) | clean | 10.4 s | 7.5 s |
| 96 MiB, straight to the app container | 413 `too_large` | 0.26 s | 3 ms |
| 96 MiB chunked, straight to the app container | 413 `too_large` after 95 MiB went to clamd | 0.6 s | 0.3 s |
| 4 × 95 MiB at once, straight to the app container | 2 clean, 2 × 429 `scanner_busy` | 1.4 s | 1.3 s each (clean) |

NoMail waits 45 seconds for one scan.

## Errors

Every answer is JSON with `Cache-Control: no-store`. Errors look like `{"error":"<code>"}`.

| Status | `error` | When |
|---|---|---|
| 401 | `unauthorized` | No key, or the wrong key. Also sends `WWW-Authenticate: Bearer`. |
| 404 | `not_found` | Any other path or method under `/v1/` (a trailing slash, a typo). No key is checked. |
| 429 | `rate_limited` | A rate limit is full. `Retry-After: 30`. The brute-force block (below) also answers 429, as HTML. |
| 500 | `internal_error` | Anything unexpected. The server log has the error class and message, nothing else. |
| 503 | `not_configured` | No key has been imported into the app yet. |

`/v1/provision` and `/v1/scan` add their own answers (400, 409, 413, 422, 429 `scanner_busy`,
503 `oidc_*` and `scanner_unavailable`); see their sections above.

NoMail treats 401, 403, 404, 429 and 503 as "the API is not ready" and simply tries again on its
next run, so nothing on the NoMail side breaks while the Drive side is down or not set up.

## Keys and secrets

| Server secret file (`/etc/nourax/secrets/`) | Made with | What it is |
|---|---|---|
| `nodrive_api_key` | `sudo scripts/secrets.sh gen nodrive_api_key` | `NODRIVE_API_KEY`, 48 characters |
| `nodrive_admin_api_key` | `sudo scripts/secrets.sh gen nodrive_admin_api_key` | The admin API's HMAC key, 48 characters |
| `upload_ticket_key` | 32 random bytes, base64url (43 characters), piped into `secrets.sh put upload_ticket_key` | The `nodrive-upload` Worker's `UPLOAD_TICKET_KEY`, later NoMail's `DRIVE_UPLOAD_TICKET_KEY` |

The configure step reads the two API keys from their files over stdin, so they are never on a
command line:

```
occ nourax_api:secret api_key   < /etc/nourax/secrets/nodrive_api_key        # stores only its SHA-256
occ nourax_api:secret admin_key < /etc/nourax/secrets/nodrive_admin_api_key  # stored encrypted (sensitive app setting)
occ nourax_api:secret api_key --check < /etc/nourax/secrets/nodrive_api_key  # "api_key matches the stored key"
```

The key check is `hash_equals(stored SHA-256, SHA-256(given key))`, so it takes the same time
whether the key is close or not. Keys must be 32 to 1024 visible characters.

**Changing a key:** `sudo scripts/secrets.sh gen nodrive_api_key --rotate`, run the configure step
again, then give NoMail the new value the same way as the first time.

### NoMail's secrets

NoMail's Supabase Edge Functions read these. Setting them is the owner's step (it changes NoMail's
Supabase project); the exact commands are in the reply to NoMail. The values are piped from the
server's secret files into a short-lived env file and `supabase secrets set --env-file`, never
shown, never on a command line on the server and never in the clipboard.

| NoMail secret | Value | When |
|---|---|---|
| `NODRIVE_API_URL` | `https://drive.nourax.org/apps/nourax_api` (no trailing slash) | Now |
| `NODRIVE_API_KEY` | The file `nodrive_api_key` | Now: NoMail's account set-up (`drive-provision`) and attachment scans (`scan-attachments`) switch on |
| `NODRIVE_ADMIN_API_KEY` | The file `nodrive_admin_api_key` | Now; used only by NoMail's admin-only function for organisations and teams ([teams.md](teams.md#what-nomail-builds)) |
| `DRIVE_UPLOAD_TICKET_KEY` | The file `upload_ticket_key` (the Worker's `UPLOAD_TICKET_KEY`) | Only after the route `drive.nourax.org/nomail-upload/*` is live ([nomail-contract.md](nomail-contract.md#the-route-waits-for-the-owners-yes)) |

## Limits and protection

- **Rate limits** count all callers together (NoMail's Edge Functions have no fixed IP), per
  minute, in Redis: health 120, provision 60, scan 60 (and at most 2 scans at once), admin 120.
  NoMail sends at most 10 provisions and 20 scans per run, one run a minute. Tested 2026-10-25
  with `rate_limit_health` set to 3 for a moment: calls 1-3 gave 200, calls 4 and 5 gave 429 with
  `Retry-After: 30`.
- **Wrong keys** are counted by the built-in brute-force protection (action `nourax_api_key`), per
  IP address. After more than 10 misses within 30 minutes, that address gets 429 from this API
  (a short HTML page, not JSON) until its misses age out. Tested 2026-10-25: calls 1-10 with a
  wrong key gave 401, calls 11 and 12 gave 429. A call with the right key clears its address's
  misses. To see or clear them: `occ security:bruteforce:attempts <ip> nourax_api_key`,
  `occ security:bruteforce:reset <ip>`.
- **Logs:** no request bodies, no keys, no app passwords. Errors are logged as class and message.
  Stack traces never show a key (`#[\SensitiveParameter]`).
- **Audit:** every call except a successful health check gets a row in `oc_nourax_api_audit`
  (time, key id, method, route, target id, HTTP status, result, client IP, duration). Never a body.

## Settings

Change with `occ config:app:set nourax_api <key> --value=<value>` (no `--type`).

| Key | Default | Meaning |
|---|---|---|
| `clamav_host`, `clamav_port` | `clamav`, `3310` | Where clamd listens (the compose service) |
| `oidc_provider` | `Nourax` | The "Log in with Nourax" provider new accounts belong to |
| `rate_limit_health`, `rate_limit_provision`, `rate_limit_scan`, `rate_limit_admin` | 120, 60, 60, 120 | Calls per minute; 0 switches a limit off |
| `scan_concurrency` | 2 | Scans at the same time; one more gets 429 `scanner_busy` |
| `scheduled_delete` | `off` | The daily deletion of people who left their organisation 30+ days ago ([docs/teams.md](teams.md)). Only `on` switches it on; it stays `off` until the owner says yes. The configure step writes `off` when the key is missing and never changes it otherwise. |
| `leaver_deletion_last_run` | — | Written by the daily job: `{"at","mode","due","deleted"}` of its last run |

`occ nourax_api:status` prints all of this as JSON (keys only as `set` or `missing`), with the
ClamAV state and the row counts.

## What the app contains

| Part | Purpose |
|---|---|
| `appinfo/info.xml` | Version 1.0.0. Declares every background job and command from the start, so later features need no version bump or `occ upgrade`. |
| `appinfo/routes.php` | The `/v1/...` routes. The catch-all `fallback#notFound` routes (JSON 404) must stay last. |
| `lib/Controller/FallbackController.php` | The JSON 404 for any other path or method under `/v1/` |
| `lib/Http/ApiKeyAuth.php`, `lib/Http/RateLimiter.php` | Key check; global rate limits and scan slots |
| `lib/Controller/NomailController.php` | The NoMail endpoints |
| `lib/Controller/AdminController.php`, `lib/Http/HmacAuth.php` | The admin API and its request signing ([docs/teams.md](teams.md)) |
| `lib/Service/OrgService.php`, `TeamService.php`, `PeopleService.php`, `LeaveService.php`, `ReconcileService.php` | Organisations, teams, people, leaving a team, reconcile and drift repair |
| `lib/Service/OnlyofficeCommand.php` | The signed ONLYOFFICE "drop" command that ends a leaver's editing sessions |
| `lib/Service/ClamdClient.php`, `ScanResult.php`, `HealthService.php` | clamd `PING`, `VERSION` and `INSTREAM` (NUL-framed commands), the scan's verdict, the health answer |
| `lib/Migration/Version1000Date20261025000000.php` | All tables: `nourax_api_orgs`, `_teams`, `_people`, `_members`, `_nonces`, `_drift`, `_audit` |
| `lib/Listener/GroupDriftListener.php` | Notes changes to `org:*` and `team:*` groups made outside the API |
| Commands | `nourax_api:secret`, `:status`, `:service-account`, `:reconcile` |
| Background jobs | `NonceCleanup` (hourly), `DriftReconcile` (every 15 minutes: puts `org:*` and `team:*` groups back), `LeaverDeletion` (daily, switched off: it only counts) |

## Test

On the server: `sudo tests/nomail-api-health.sh` (no key → 401, wrong key → 401, right key → 200
with `status` ok, a valid `clamav` and `signatures`, `Cache-Control: no-store`).

`sudo tests/api-scan.sh` tests `/v1/scan` and the ClamAV part of health, **on the server only**
(Windows Defender on the owner's PC quarantines the EICAR test file; the test builds the EICAR
string in memory and pipes it). It first runs `tests/clamd-instream.php` (the `INSTREAM`
exchange against a fake clamd: framing, the exact limit and one byte over, clamd's size limit,
odd answers, a closed connection, silence), waits up to 90 minutes for ClamAV (exit 2, BLOCKED,
if it never comes), then checks health (clamav ok, signatures at most 2 days old), EICAR →
infected, 5 MiB → clean, exactly 99,614,720 bytes through Cloudflare → clean within 45 s, 96 MiB
and one byte over straight to the app container → 413 (also chunked), 4 at once → 2 clean and
2 × 429, no stored copy, the audit rows, and, under the lock, `clamav_host=clamav-missing` → scan
503 and health ok with clamav unavailable, then put back.

`sudo tests/api-provision.sh` tests `/v1/provision` with QA ids only (see `tests/README.md`): a new
account `qa-t6-1` (created true, backend `user_oidc`, the four folders, a 72-character password
that passes NoMail's `validCredentials`), a second call (created false, a new password, the old
one now 401, exactly one `NoMail` app password), the refusals (`nodrive`, `admin`, an uppercase
UUID, a missing email, a local account, a disabled account `qa-t6-8` that stays disabled, 16 KB+),
and the rate limit (70 calls in a minute give 429 with `Retry-After`).

**End-of-day run, 2026-10-25** (from `main`, privacy between organisations on): `nomail-api-health.sh`
11:05 UTC, `api-provision.sh` 11:06–11:08 and `api-scan.sh` 11:17 (39 checks; EICAR infected in
0.20 s, 5 MiB clean in 1.2 s, 99,614,720 bytes through Cloudflare clean in 12.0 s) all passed.

## Deploying a change to the app

`git pull` on the server is enough for code changes (PHP notices changed files within a minute).
**New routes** need one more step: the server keeps its route table in its local memory cache
for up to an hour, and that cache only starts again when an app's version or the set of enabled
apps changes. Reload the web server inside the `app` container (no recreate, no downtime;
requests that are running finish first), under the lock:

```
docker compose exec -T app apachectl -k graceful
```
