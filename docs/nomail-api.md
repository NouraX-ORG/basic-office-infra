# NoMail API

NoMail's Supabase Edge Functions use this API to check the Drive, create a person's Drive
account and virus-scan attachments (NoMail's handoff `2026-10-23-nourax-nomail-to-drive-provision-scan.md`,
section 2). The admin-only organisations and teams API lives in the same app (described in
`docs/teams.md` when it is built) and is never offered as an MCP tool.

| | |
|---|---|
| Base URL (`NODRIVE_API_URL`) | `https://drive.nourax.org/apps/nourax_api` (no trailing slash) |
| Where it runs | The Nextcloud app `nextcloud-apps/nourax_api` (PHP), inside the `app` container. No extra container, tunnel route or admin password. |
| Switched on by | `scripts/configure.d/60-nomail-api.sh` |
| Auth | `Authorization: Bearer <NODRIVE_API_KEY>` |

The app uses the server's own APIs (users, groups, files, app passwords), so it needs no admin
login and opens nothing new to the internet: `/apps/nourax_api/...` is the only new path.

## Endpoints

| Call | Answer | Status |
|---|---|---|
| `GET /v1/health` | `{"status":"ok","clamav":"ok"\|"unavailable","signatures":"YYYY-MM-DD"\|null}` | Live |
| `POST /v1/provision` | `{"uid","login","app_password","created"}` | Live |
| `POST /v1/scan` | `{"status":"clean"}` or `{"status":"infected","signature"}`, 413, 503 | Coming (T6-4) |

`status` is always `ok` while the API answers. ClamAV being down only changes `clamav` to
`unavailable` (and `signatures` to `null`): NoMail's account set-up needs `status` only, and its
scanner waits for `clamav` = `ok` by itself. `signatures` is the date of the newest signatures,
from clamd's `VERSION` answer (`ClamAV 1.x/<db>/<date>`). The ClamAV check gives up after 3 seconds.

```
curl -sS https://drive.nourax.org/apps/nourax_api/v1/health \
  -H "Authorization: Bearer $NODRIVE_API_KEY"
{"status":"ok","clamav":"unavailable","signatures":null}
```

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

## Errors

Every answer is JSON with `Cache-Control: no-store`. Errors look like `{"error":"<code>"}`.

| Status | `error` | When |
|---|---|---|
| 401 | `unauthorized` | No key, or the wrong key. Also sends `WWW-Authenticate: Bearer`. |
| 429 | `rate_limited` | A rate limit is full. `Retry-After: 30`. The brute-force block (below) also answers 429, as HTML. |
| 500 | `internal_error` | Anything unexpected. The server log has the error class and message, nothing else. |
| 503 | `not_configured` | No key has been imported into the app yet. |

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
| `scan_concurrency` | 2 | Scans at the same time |
| `leaver_deletion_enabled` | `no` | The daily deletion of people who left 30+ days ago. Stays `no` until the owner says yes. |

`occ nourax_api:status` prints all of this as JSON (keys only as `set` or `missing`), with the
ClamAV state and the row counts.

## What the app contains

| Part | Purpose |
|---|---|
| `appinfo/info.xml` | Version 1.0.0. Declares every background job and command from the start, so later features need no version bump or `occ upgrade`. |
| `appinfo/routes.php` | The `/v1/...` routes |
| `lib/Http/ApiKeyAuth.php`, `lib/Http/RateLimiter.php` | Key check; global rate limits and scan slots |
| `lib/Controller/NomailController.php` | The NoMail endpoints |
| `lib/Service/ClamdClient.php`, `HealthService.php` | clamd `PING` and `VERSION` (NUL-framed commands), the health answer |
| `lib/Migration/Version1000Date20261025000000.php` | All tables: `nourax_api_orgs`, `_teams`, `_people`, `_members`, `_nonces`, `_drift`, `_audit` |
| `lib/Listener/GroupDriftListener.php` | Notes changes to `org:*` and `team:*` groups made outside the API |
| Commands | `nourax_api:secret`, `:status`, `:service-account`, `:reconcile` |
| Background jobs | `NonceCleanup` (hourly), `DriftReconcile` (every 15 minutes), `LeaverDeletion` (daily, switched off) |

## Test

On the server: `sudo tests/nomail-api-health.sh` (no key → 401, wrong key → 401, right key → 200
with `status` ok, a valid `clamav` and `signatures`, `Cache-Control: no-store`).

`sudo tests/api-provision.sh` tests `/v1/provision` with QA ids only (see `tests/README.md`): a new
account `qa-t6-1` (created true, backend `user_oidc`, the four folders, a 72-character password
that passes NoMail's `validCredentials`), a second call (created false, a new password, the old
one now 401, exactly one `NoMail` app password), the refusals (`nodrive`, `admin`, an uppercase
UUID, a missing email, a local account, a disabled account that stays disabled, 16 KB+), and the
rate limit (70 calls in a minute give 429 with `Retry-After`).

## Deploying a change to the app

`git pull` on the server is enough for code changes (PHP notices changed files within a minute).
**New routes** need one more step: the server keeps its route table in its local memory cache
for up to an hour, and that cache only starts again when an app's version or the set of enabled
apps changes. Reload the web server inside the `app` container (no recreate, no downtime;
requests that are running finish first), under the lock:

```
docker compose exec -T app apachectl -k graceful
```
