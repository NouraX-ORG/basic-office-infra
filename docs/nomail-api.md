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
| `POST /v1/provision` | `{"uid","login","app_password","created"}` | Coming (T6-2) |
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

## Errors

Every answer is JSON with `Cache-Control: no-store`. Errors look like `{"error":"<code>"}`.

| Status | `error` | When |
|---|---|---|
| 401 | `unauthorized` | No key, or the wrong key. Also sends `WWW-Authenticate: Bearer`. |
| 429 | `rate_limited` | A rate limit is full. `Retry-After: 30`. Also sent by the brute-force protection (below). |
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
  NoMail sends at most 10 provisions and 20 scans per run, one run a minute.
- **Wrong keys** are counted by the built-in brute-force protection (action `nourax_api_key`), per
  IP address: each miss slows the next calls from that address, up to 25 seconds, and after more
  than 10 misses in 12 hours the address gets 429. A call with the right key clears its address's misses.
  To see or clear them: `occ security:bruteforce:attempts <ip> nourax_api_key`,
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
