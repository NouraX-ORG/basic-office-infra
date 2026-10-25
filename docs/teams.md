# Organisations and teams (admin API)

The admin API makes and keeps up to date each organisation and team of Nourax Workspace. It is a
tool for the Nourax administrator only: it is **never** offered as an MCP tool, it uses its own
key (not NoMail's `NODRIVE_API_KEY`), and every request is signed.

NoMail is the source of truth. The API is keyed by NoMail's ids, never by names, and every step is
an "ensure": it makes things the way they should be and says what it did. Sending the same call
again finishes a call that stopped half way and reports `unchanged` for what was already right.

| | |
|---|---|
| Base URL | `https://drive.nourax.org/apps/nourax_api` (the `/index.php/apps/nourax_api` form works too) |
| Where it runs | The `nourax_api` app (`nextcloud-apps/nourax_api`), next to the [NoMail API](nomail-api.md) |
| Key | Server secret `nodrive_admin_api_key` (48 characters), imported by `scripts/configure.d/60-nomail-api.sh` |
| Test | `sudo tests/admin-api.sh` on the server |

**Part 1 (live):** request signing, the audit, organisations and teams.
**Part 2 (coming):** people (`PUT /v1/admin/people/{user_id}`: joins, moves, leaves, disabling),
the full reconcile, and the drift job.

## What one organisation and one team get

| Object | Made as | Who can use it |
|---|---|---|
| Organisation group | group `org:{org_id}`, display name = the organisation's name | — |
| Directory | address book `org-{org_id}`, "Directory: <name>", one card per member | the organisation's group, read-only (NoContacts) |
| Team group | group `team:{team_id}`, display name "Team: <name>"; "locked": only this API changes it | — |
| Team folder | a Team Folder named after the team, every permission (31), advanced permissions on | the team's group only (NoDrive) |
| Team address book | address book `team-{team_id}`, "Team: <name>", one card per member | the team's group, read-only |
| Team calendar | calendar `team-{team_id}`, "Team: <name>", colour `#2563EB` | the team's group, read and write (NoCalendar) |
| Team board | a Deck board "Team: <name>", colour `2563EB` | the team's group: edit cards, not share or manage (NoBoard) |

The address books, calendars and boards belong to the hidden service account `nourax-teams`
(see below), so they never belong to a person who may leave.

**Cards** are vCard 4.0, one per enabled member of the group: `FN` (display name), `EMAIL`,
`ORG` (the organisation's name), `UID:nourax-<uid>`, file `<uid>.vcf`. They are rebuilt on every
call and written only when they differ. Deleting only ever touches cards this API made.

**Team folder names:** the characters `/ \ : * ? " < > |` become spaces, at most 100 characters.
Two teams of the **same** organisation with the same name get "Sales" and "Sales 2"; teams of
different organisations never see each other's folders, so both may be "Sales". A folder that
already has one of its team's names keeps it, so folders are not renamed back and forth.

**Renames** keep every id and file: the group's display name, the folder, the address book, the
calendar and the board are renamed.

## Signing a request

Every request carries four headers:

| Header | Value |
|---|---|
| `X-Nourax-Key-Id` | `admin-1` (the default when left out). The id is there so a key can be rotated later. |
| `X-Nourax-Timestamp` | Unix seconds. Must be within **300 seconds** of the server's clock. |
| `X-Nourax-Nonce` | 16 to 64 characters of `A-Z a-z 0-9 _ -`, new for every request. Remembered for 600 seconds; a second use is refused. |
| `X-Nourax-Signature` | Lowercase hex HMAC-SHA256, with the key's characters as the HMAC key, over the canonical string below |

Canonical string (lines joined with `\n`, no newline at the end):

```
NOURAX-ADMIN-V1
<METHOD>                 PUT or GET, upper case
<PATH>                   from /v1/ on, with ?query if any, exactly as sent, e.g. /v1/admin/audit?limit=100
<TIMESTAMP>
<NONCE>
<sha256 hex of the raw body>   for an empty body (GET): e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

Send PUT bodies as `Content-Type: application/json`, exactly the bytes you hashed.

Example for a Supabase Edge Function (Deno, Web Crypto):

```ts
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function adminFetch(base: string, key: string, method: "GET" | "PUT", path: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const bodyHash = hex(await crypto.subtle.digest("SHA-256", enc.encode(raw)));
  const canonical = ["NOURAX-ADMIN-V1", method, path, timestamp, nonce, bodyHash].join("\n");
  const hmacKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = hex(await crypto.subtle.sign("HMAC", hmacKey, enc.encode(canonical)));
  return fetch(base + path, {
    method,
    headers: {
      "X-Nourax-Key-Id": "admin-1",
      "X-Nourax-Timestamp": timestamp,
      "X-Nourax-Nonce": nonce,
      "X-Nourax-Signature": signature,
      ...(raw ? { "Content-Type": "application/json" } : {}),
    },
    body: raw || undefined,
  });
}
// adminFetch(NODRIVE_API_URL, NODRIVE_ADMIN_API_KEY, "PUT", `/v1/admin/orgs/${orgId}`, { name, version })
```

On the server, `tests/lib.sh` has `admin_api METHOD PATH [BODY]`, which signs with python3 and
reads the key from its secret file (never from a command line).

## Endpoints

### `PUT /v1/admin/orgs/{org_id}`

Body `{"name":"Acme","version":1}`. Steps: `record`, `group`, `directory`, `directory_share`,
`cards`, `team_cards` (the organisation's team address books show its name, so a rename reaches
them too).

```
200 {"ok":true,"applied":true,"version":1,"org_id":"<org_id>","steps":[
  {"step":"record","result":"created","detail":"version 1"},
  {"step":"group","result":"created","detail":"org:<org_id>"},
  {"step":"directory","result":"created","detail":"address book 5"},
  {"step":"directory_share","result":"created","detail":"read-only for org:<org_id>"},
  {"step":"cards","result":"unchanged","detail":"0 card(s)"},
  {"step":"team_cards","result":"unchanged","detail":"0 of 0 team address book(s) changed"}]}
```

### `PUT /v1/admin/orgs/{org_id}/teams/{team_id}`

Body `{"name":"Sales","version":1}`. The organisation must exist (409 `org_missing`); a team never
moves to another organisation (409 `team_in_other_org`). Steps: `record`, `group`,
`team_folder`, `addressbook`, `addressbook_share`, `cards`, `calendar`, `calendar_share`,
`board`, `board_share`.

### `GET /v1/admin/orgs/{org_id}` and `GET /v1/admin/orgs/{org_id}/teams/{team_id}`

The stored state next to what is really there, for example for a team:

```
200 {"ok":true,"team":{"org_id","team_id","name":"Sales","version":3,"archived":false,"created_at","updated_at",
  "group":{"id":"team:<team_id>","exists":true,"display_name":"Team: Sales","members":1},
  "folder":{"id":2,"exists":true,"mount_point":"Sales","storage_id":26,"root_id":542,"acl":true,"groups":{"team:<team_id>":31}},
  "addressbook":{"id":6,"exists":true,"display_name":"Team: Sales","cards":1,"shared_read_only":true},
  "calendar":{"id":10,"exists":true,"display_name":"Team: Sales","color":"#2563EB","shared_read_write":true},
  "board":{"id":12,"exists":true,"title":"Team: Sales","archived":false,"shared_edit":true},
  "drift":[]}}
```

The organisation answer has `group`, `directory`, the list of its `teams` and its `drift`. 404
`not_found` when the id is unknown (or the team belongs to another organisation).

**`drift`** lists the changes to the group that were made outside this API (for example on the
admin pages, or with `occ group:adduser`) and have not been put back yet, newest first, at most
100: `{"id":3,"at":"2026-10-25T09:12:40+00:00","kind":"member_added","user_id":"<uid>"}`.
`kind` is `member_added`, `member_removed` or `group_deleted` (then `user_id` is null). It is
`[]` when the group has only been changed through this API. Part 2 puts such changes back the way
NoMail has them and closes the rows; until then they stay listed.

### `GET /v1/admin/audit?limit=100[&target=team:<team_id>]`

The newest audit rows first (`limit` 1-500, default 100), optionally for one object: `org:<id>`,
`team:<id>` or a uid. Each row: `id`, `at`, `key_id`, `method`, `route`, `target`,
`http_status`, `result`, `remote_ip`, `duration_ms`. Rows of the NoMail API are there too.

## Answers

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"ok":true,"applied":true,"version","steps":[...]}` | Every step worked |
| 200 | `{"ok":true,"applied":false,"reason":"stale_version","version":<sent>,"current_version":<stored>,"steps":[]}` | A newer version is already stored; nothing changed. `version` is the one you sent, `current_version` the one stored. |
| 502 | `{"ok":false,"applied":true,...}`, the failed step with a `detail` | Send the same call again later; it finishes what is missing |
| 400 | `{"error":"invalid_request"}` | An id that is not a lowercase UUID or a QA id `qa-...`, a bad body, a query on a PUT |
| 401 | `{"error":"unauthorized"}` | No signature, a wrong one, an unknown key id. Counted by the brute-force protection. |
| 401 | `{"error":"stale_timestamp"}` | The signature is right but the timestamp is more than 300 seconds off, either way (check the clock) |
| 401 | `{"error":"replayed"}` | This nonce was used before |
| 404 | `{"error":"not_found"}` | GET of an unknown organisation or team. Also any other path or method under `/v1/` (a trailing slash, dot segments, a typo), without a key check. |
| 409 | `{"error":"org_missing"}`, `{"error":"team_in_other_org"}` | See the team PUT |
| 413 | `{"error":"too_large"}` | A body over 2 MB |
| 423 | `{"error":"busy"}` | Another call is working on the same organisation or team; send it again shortly |
| 429 | `{"error":"rate_limited"}` | Over 120 admin calls a minute (`Retry-After: 30`); the brute-force block also answers 429 |
| 503 | `{"error":"not_configured"}` | The admin key has not been imported |

**Versions:** `version` is NoMail's counter for that object, an integer of at least 1. A stored
version greater than the incoming one changes nothing. An equal one runs every step again.

**Ids:** `org_id` and `team_id` are lowercase UUIDs; `^qa-[a-z0-9-]{1,40}$` is allowed for tests.
The API reads them from the signed path, never from the body.

## Safety

- **Audit:** every admin call writes one row in `oc_nourax_api_audit` (method, route, object,
  status, result, client IP, duration). Never a body, never a key. Failed calls also log one
  warning line (`nourax_api admin ...`).
- **Logs** hold no bodies or keys. A failed step's `detail` is the error's class and message.
- **One call per object at a time:** a Redis lock per organisation and per team (120 seconds at
  most); choosing a team folder name is serialised per organisation.
- **Locked groups:** changes to `org:*` and `team:*` groups made elsewhere (for example on the
  admin pages) are noted in `oc_nourax_api_drift` and listed as `drift` in the status answers;
  part 2 puts them back.
- Nothing is ever deleted by part 1, apart from cards of people who are no longer members.

## The service account `nourax-teams`

`occ nourax_api:service-account [--check]` (run by the configure step) makes sure it is in place:

- a local account, display name "Nourax Teams", quota 0 B, in no group;
- its login password is random and thrown away at once (and login passwords do not work for
  apps here anyway);
- one app password, `nourax-api-loopback`, kept only as a sensitive app setting
  (`loopback_app_password`). Deck's PHP services only work for a signed-in person, so the board
  steps call Deck's REST API on this same server over the compose network (`http://app`, app
  setting `loopback_url`), signed in with it. Nothing leaves the server;
- Deck's welcome board is switched off for it.

`--check` signs in with the app password over `http://app` and prints the HTTP status (200).
`occ nourax_api:status` shows `service_account` and `loopback_app_password` (set or missing).

## QA objects made by the test

`tests/admin-api.sh` uses only these, and deletes nothing:

| Kind | Ids |
|---|---|
| Organisations | `qa-t6-org-a` ("QA t6 Org A"), `qa-t6-org-b` ("QA t6 Org B") |
| Teams | `qa-t6-team-a1` and `qa-t6-team-a2` (both "Sales", org A: folders "Sales" and "Sales 2"), `qa-t6-team-b1` ("Sales", org B: folder "Sales") |
| Member | `qa-t6-1`, put into `org:qa-t6-org-a` and `team:qa-t6-team-a1` with `occ group:adduser` (standing in for the people API) |

Because that `occ group:adduser` is a change made outside the API, it is real drift: the status
of `qa-t6-org-a` and `qa-t6-team-a1` lists one open `member_added` row for `qa-t6-1` each (made on
the first run; adding someone who is already a member changes nothing, so later runs add no rows).
The test checks that they are listed there, and that `qa-t6-org-b`, `qa-t6-team-a2` and
`qa-t6-team-b1`, changed only through the API, show `"drift":[]`. When part 2 takes over
`qa-t6-1` through the people API, those two rows are closed.

## Deploying a change

As for the NoMail API: `git pull` on the server, then, for new routes, reload the web server in
the `app` container under the lock (`docker compose exec -T app apachectl -k graceful`).
