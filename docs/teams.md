# Organisations and teams (admin API)

The admin API makes and keeps up to date each organisation and team of Nourax Workspace. It is a
tool for the Nourax administrator only. **It is never added to the MCP tool list**: the Nourax
Workspace MCP server (`mcp/` and `docs/mcp.md`, built by Task 1) has no tool for it and must never get one,
and NoMail's own MCP tool provider must not offer it either. It uses its own key (not NoMail's
`NODRIVE_API_KEY`), and every request is signed.

NoMail is the source of truth. The API is keyed by NoMail's ids, never by names, and every step is
an "ensure": it makes things the way they should be and says what it did. Sending the same call
again finishes a call that stopped half way and reports `unchanged` for what was already right.

| | |
|---|---|
| Base URL | `https://drive.nourax.org/apps/nourax_api` (the `/index.php/apps/nourax_api` form works too) |
| Where it runs | The `nourax_api` app (`nextcloud-apps/nourax_api`), next to the [NoMail API](nomail-api.md) |
| Key | Server secret `nodrive_admin_api_key` (48 characters), imported by `scripts/configure.d/60-nomail-api.sh` |
| Tests | `sudo tests/admin-api.sh` (part 1), `sudo tests/admin-people.sh` (part 2) and `sudo tests/privacy.sh` (privacy between organisations) on the server |
| Demo data | `sudo tests/demo-accounts.sh` makes and checks the owner's kept [demo accounts](#demo-accounts) (`--check` reads only) |

**Part 1 (live):** request signing, the audit, organisations and teams.
**Part 2 (live):** people (`PUT /v1/admin/people/{user_id}`: joins, moves, leaves, leaving the
organisation), the reconcile call, the drift guard that keeps the groups locked, and the scheduled
delete of leavers, built **switched off**.
**Privacy between organisations (on since 2026-10-25 10:08, the owner's yes):** people find,
autocomplete and share only with people of their own organisation. See
[Privacy between organisations](#privacy-between-organisations).
**NoMail's side:** NoMail is the source of truth and calls this API from one admin-only function.
See [What NoMail builds](#what-nomail-builds).

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

**Read-only: a write gets 403 and nothing is written.** When a member tries to change the
directory or a team address book through `/remote.php/dav` (NoContacts and every sync app use
it), the answer is **403** with the message "This address book is read-only. Your organisation
keeps it up to date." The book stays as it was (tested in `tests/admin-people.sh` and
`tests/admin-api.sh`).

- Refused: adding, changing or deleting a card (PUT, DELETE), changing a card's or the book's
  properties (PROPPATCH), moving a card out (MOVE), copying a card in (COPY to the book),
  deleting the book, and every other write method.
- Allowed: reading (GET, PROPFIND, REPORT), and copying a card out to one's own address book.
- How: the server's own permission check (`DavAclPlugin` in the dav app) refuses these writes
  too, but answers 404 "Addressbook ... could not be found" to anyone but the book's owner, which
  sync apps read as "the book is gone". So `nourax_api` adds a small DAV plugin
  (`lib/Dav/ReadOnlyBooksPlugin.php`, through the dav app's `SabrePluginAddEvent`) that answers
  403 first. It looks only at books the service account owns, and only at people who may read
  them; anyone else still gets the server's 404, so no book is revealed to people outside the
  team.
- Members could not change their own view settings of these books before either (a PROPPATCH
  needs the write-properties right, which a read-only share does not give), so nothing they
  could do is lost.
- The old address `/remote.php/carddav` is not covered by the plugin; there the server's own
  404 still refuses every write.

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

**Worked example** (a made-up key, for unit tests). On 2026-10-25 the code above, run in Node's
Web Crypto, and the app's own `HmacAuth::sign` (run with `php -r` in the server's `app`
container) gave the same signature:

| Input | Value |
|---|---|
| Key | `example-key-not-real-0123456789abcdefghijklmnop` (not a real key) |
| Method, path | `PUT`, `/v1/admin/orgs/2f6c1b9e-1d1a-4c55-9a64-3b9b8f0f6a10` |
| Timestamp, nonce | `1792929600` (2026-10-25 12:00:00 UTC), `0f8a3c2e9b7d4e61a5c3b2d1e0f9a8b7` |
| Body (exact bytes) | `{"name":"Acme","version":1}` |
| SHA-256 of the body | `da3a344c0679adfd6995b9371e18ebcde4a4aefa97e187259234d2c7ebe291e9` |
| Signature | `de96f9d30ba3c7273e4ad3b184471a43399fa616673614df2981cfc6e0290059` |

The key is made up, so the server refuses this request, and a refused signature counts towards
the brute-force block: use it in unit tests only.

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
  "folder":{"id":2,"exists":true,"mount_point":"Sales","storage_id":26,"root_id":542,"acl":true,"groups":{"team:<team_id>":31},"leads":["<uid>"]},
  "addressbook":{"id":6,"exists":true,"display_name":"Team: Sales","cards":1,"shared_read_only":true},
  "calendar":{"id":10,"exists":true,"display_name":"Team: Sales","color":"#2563EB","shared_read_write":true},
  "board":{"id":12,"exists":true,"title":"Team: Sales","archived":false,"shared_edit":true,"leads":["<uid>"]},
  "drift":[]}}
```

The organisation answer has `group`, `directory`, the list of its `teams` and its `drift`. 404
`not_found` when the id is unknown (or the team belongs to another organisation).

**`drift`** lists the changes to the group that were made outside this API (for example on the
admin pages, or with `occ group:adduser`) and have not been put back yet, newest first, at most
100: `{"id":3,"at":"2026-10-25T09:12:40+00:00","kind":"member_added","user_id":"<uid>"}`.
`kind` is `member_added`, `member_removed` or `group_deleted` (then `user_id` is null). It is
`[]` when the group has only been changed through this API. The drift job puts such changes back
the way the stored state has them and closes the rows (see "Locked groups" below); until then they
stay listed. `leads` are the team's leads (people PUT with role `lead`).

### `PUT /v1/admin/people/{user_id}`

A person's **whole** desired state. `user_id` is the account's uid: the person's Supabase user id
(a lowercase UUID; `qa-t<task>-<n>` for tests; `^demo-[a-z0-9-]{1,40}$` for the owner's kept
[demo accounts](#demo-accounts)). A demo person belongs only to a demo organisation, and a demo
organisation holds only demo people (400 `invalid_request` otherwise).

```
{"email":"ana@acme.example","display_name":"Ana Diaz","org_id":"<org_id>",
 "teams":[{"team_id":"<team_id>","role":"member"},{"team_id":"<team_id>","role":"lead"}],
 "active":true,"version":7}
```

- `teams` lists every team the person should be in, at most 100, each once, all of the person's
  organisation. `[]` means in no team. `role` is `member` or `lead`.
- `email` and `display_name` may be `""` to leave them as they are. The email may change; the
  uid never does.
- `active: false` means the person has left the organisation (below).

Refused before anything changes:

| Status | Error | When |
|---|---|---|
| 409 | `org_missing` | The organisation has not been sent yet |
| 409 | `team_missing`, `team_in_other_org` | A team is unknown, or belongs to another organisation |
| 409 | `uid_not_oidc` | A local (password) account has that name; it is never taken over |
| 409 | `account_disabled` | `active` is true, but the account was disabled on the server by someone else (an administrator). The API never undoes that; an administrator enables it with `occ user:enable`. |
| 423 | `busy` | Another call works on the same person |

Steps while `active` is true:

| Step | What it does |
|---|---|
| `record` | Stores the desired state (`nourax_api_people`, and the team rows in `nourax_api_members`) |
| `account` | The "Log in with Nourax" account and its `/NoMail` folders, made as `/v1/provision` makes them, without an app password. An account this API disabled is enabled again; its app passwords were revoked when it was disabled, so NoMail gets a new one from `/v1/provision` and sync clients sign in again. |
| `profile` | Display name and email |
| `leave` | One step per team the person leaves (below), also when they move to another organisation. It carries `team_id` and `counts`. |
| `org` | Member of `org:{org_id}` and of no other organisation group |
| `teams` | Joins (an archived team comes back from the archive); a **lead** may manage the team folder's advanced permissions and gets a board share of their own that may manage the board; a member gets neither. Fields `joined` and `changes`. |
| `directories` | The organisation directory and the team address books rebuilt |

Every group change fires the server's normal events, so team folders, shares, calendars and
caches follow at once.

### Leaving a team

A `leave` step, for example:

```
{"step":"leave","result":"updated","detail":"left team <team_id>","team_id":"<team_id>",
 "counts":{"group_shares_removed":1,"team_file_shares_removed":1,"locks_released":1,
   "removed_from_group":true,"onlyoffice_drop":{"sent":1,"codes":{"0":1},"not_sent":0},
   "lead_rights_removed":0,"archived":false}}
```

| Count | What happened |
|---|---|
| `group_shares_removed` | Shares the person made of any of their files **to the team's group** are removed |
| `team_file_shares_removed` | Shares the person made **on files of the team folder** are removed: public links, email shares, user and group shares |
| `locks_released` | Their own locks on team folder files (a lock of their own or a WebDAV lock token). Locks the office editor holds are released by the editor itself. |
| `removed_from_group` | They left `team:{team_id}`: the team folder, calendar, address book and board are gone for them from the next request on |
| `onlyoffice_drop` | Their open ONLYOFFICE sessions on team folder documents are ended (below) |
| `lead_rights_removed` | Folder permission management and their own board share, if they were a lead |
| `archived` | They were the last member, so the team was archived |

- **Files stay.** What the person put in the team folder belongs to the team (the Team Folders
  app), not to them.
- **The order:** shares and locks go first, while the person can still reach the files; their
  group membership ends right after, in the same call; then the editor sessions are dropped, so a
  reconnect is refused.
- **ONLYOFFICE:** for each document key of the team folder's files (at most 200), the command
  service's `drop` command `{"c":"drop","key":"<key>","users":["<instanceid>_<uid>"]}` goes to
  the document server inside the compose network (`http://onlyoffice/coauthoring/CommandService.ashx`),
  signed HS256 with the onlyoffice app's JWT secret, in the body and in the `AuthorizationJwt`
  header, as the onlyoffice app signs its own commands. `codes` counts the answers: `0` done
  (ONLYOFFICE Docs 10 also answers 0 when nobody has the document open), `1` no such key, `6` a
  bad signature (a setup fault: the leave then fails, so it is sent again). If the document
  server does not answer, the rest count as `not_sent`.
- **The last member leaves:** the team is archived. Its folder is renamed "<name> (archived)" and
  its board is archived. The group, the folder and its files, the address book and the calendar
  stay; nothing is deleted. When someone joins again, the folder gets its name back and the board
  comes back.

### Leaving the organisation (`"active": false`)

Steps: `record`, `account`, `profile`, `leave` (every team), `org` (out of every organisation
group), `disable`, `directories`. `disable`:

- disables the account **at once**: no sign-in with the login form or "Log in with Nourax", no
  sync client, and NoMail's next `/v1/provision` gets 409 `account_disabled`;
- ends the person's open browser sessions (`sessions_ended`) and **revokes every app password**
  (`app_passwords_revoked`): NoMail's, the sync clients' and one-time login tokens. Only a
  remote-wipe token stays, so a device an admin marked for wiping is still wiped. So the old app
  passwords get **401** on WebDAV and OCS. (With the account only disabled and its app passwords
  kept, the server's WebDAV answers 503, from its `DisabledUserException`; NoMail and sync
  clients read 503 as a server fault and retry, but read 401 as "this login is gone": NoMail then
  asks `/v1/provision` for a new one and gets 409 `account_disabled`.) This runs on every
  `"active": false` call, so a second call also revokes a token made in between;
- public links the person made stop working (404). Links on **team folder** files were already
  deleted by the `leave` step. Links on the person's **own** files are only hidden while the
  account is disabled, not deleted: if the person comes back (`"active": true`), those links work
  again at once, with the same addresses. Links that should not come back are removed in NoDrive's
  sharing panel once the person is back (by the person, or by an admin). When the account is
  deleted (scheduled delete on), its links go with it;
- keeps the account and its files for **30 days**: `disabled_at` and `delete_after` are stored
  and shown in the step and in the status.

`"active": true` later (a higher version) enables the account again and clears `delete_after`.
The old app passwords stay revoked: NoMail's next `/v1/provision` gives a new one, and the
person signs in again in their sync and mobile apps. Public links on their own files work again
(see above); team folder links do not, as the `leave` step deleted them.

**Deleting is switched off.** The daily job `LeaverDeletion` deletes nothing until the owner says
yes and `occ config:app:set nourax_api scheduled_delete --value=on` is run. While it is `off` it
only counts the accounts it would delete and writes `{"at","mode":"off","due","deleted":0}` to the
app setting `leaver_deletion_last_run` (also in `occ nourax_api:status`). When it is `on`, it
deletes an account only when its person row says it left, `delete_after` has passed, it is not on
`hold` (for example while an admin moves its files to someone else first), and the account is
still disabled and a "Log in with Nourax" account. Team folder files stay; the person's own files
go with the account.

### `GET /v1/admin/people/{user_id}`

```
200 {"ok":true,"person":{"user_id","org_id","email","display_name","active":true,"version":7,
  "teams":[{"team_id","role"}],"disabled_at":null,"delete_after":null,"hold":false,"created_at","updated_at",
  "account":{"exists":true,"enabled":true,"backend":"user_oidc","display_name","email"},
  "groups":["org:<org_id>","team:<team_id>"],"groups_wanted":[...],"in_sync":true,
  "drift":[]}}
```

`groups` are the person's real `org:*` and `team:*` groups, `groups_wanted` what the stored state
says, `drift` the open drift rows about them. 404 `not_found` for a person never sent.

### `POST /v1/admin/orgs/{org_id}/reconcile`

NoMail's full state of one organisation, to put everything right at once:

```
{"dry_run":false,
 "teams":[{"team_id","name","version"}],
 "people":[{"user_id", ...the body of a person PUT}]}
```

- At most 500 people and 500 teams (413 `too_large`). Every person must be of this organisation
  (409 `person_in_other_org`) and name only listed teams (409 `team_not_listed`).
- Every listed team and person is applied as by its own PUT (same versions: an equal version runs
  every step again).
- Members of the organisation's groups who are not in that state leave (a `leave` as above).
- People stored for the organisation but not listed leave its teams and its group. They are
  **not** disabled: only `"active": false` disables.
- Stored teams that are not listed are archived (nothing is deleted).
- `"dry_run": true` changes nothing and only reports.

```
200 {"ok":true,"dry_run":false,"org_id",
  "drift_found":[{"kind":"extra_member","group":"team:<team_id>","user_id":"<uid>"}],
  "drift_fixed":[...],"drift_left":[],
  "teams":[{"team_id","ok":true,"applied":true}],"people":[{"user_id","ok":true,"applied":true}]}
```

`kind` is `extra_member` (in the group, not wanted), `missing_member` (wanted, not in the group),
`group_missing`, `team_unlisted` or `person_unlisted`. 502 when anything is left or a team or
person failed (their `failed_steps` or `error` say what); send it again.

### Locked groups: the drift guard

- Changes to `org:*` and `team:*` groups made outside this API (the admin pages, `occ
  group:adduser`, another app) are noted in `oc_nourax_api_drift` and listed as `drift` in the
  status answers. Changes made by the API itself are not noted.
- **Every 15 minutes** the `DriftReconcile` job puts the groups back the way the **stored**
  desired state has them: a person added outside the API leaves again (a full leave), a person
  removed comes back (with their lead rights), a deleted group is made again from its stored
  state. Then the drift rows of the groups that match again are closed. Wanted members whose
  account is missing or disabled are left alone.
- `occ nourax_api:reconcile [org_id] [--dry-run]` does the same now and prints what it found,
  fixed and left, as JSON.
- **Testing drift:** the job runs from the `cron` container at the first cron run after its 15
  minutes are up, so it may undo an `occ group:adduser` a second after it was made (it did at
  06:20:01 on 2026-10-25, before the test could look). A test that changes these groups with occ
  on purpose first runs the job itself (`drift_job_now` in `tests/lib.sh`: `occ
  background-job:execute <id> --force-execute`), so the next run is 15 minutes away, then makes
  the change and checks it is there before it calls the reconcile.

### `GET /v1/admin/audit?limit=100[&target=team:<team_id>]`

The newest audit rows first (`limit` 1-500, default 100), optionally for one object: `org:<id>`,
`team:<id>` or a uid. Each row: `id`, `at`, `key_id`, `method`, `route`, `target`,
`http_status`, `result`, `remote_ip`, `duration_ms`. Rows of the NoMail API are there too.

## Answers

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"ok":true,"applied":true,"version","steps":[...]}` | Every step worked (a reconcile: everything matches afterwards) |
| 200 | `{"ok":true,"applied":false,"reason":"stale_version","version":<sent>,"current_version":<stored>,"steps":[]}` | A newer version is already stored; nothing changed. `version` is the one you sent, `current_version` the one stored. |
| 502 | `{"ok":false,"applied":true,...}`, the failed step with a `detail` | Send the same call again later; it finishes what is missing |
| 400 | `{"error":"invalid_request"}` | An id that is not a lowercase UUID, a QA id `qa-...` or a demo id `demo-...`; a demo id mixed with a non-demo one (a team or a person and its organisation); a bad body; a query on a PUT |
| 401 | `{"error":"unauthorized"}` | No signature, a wrong one, an unknown key id. Counted by the brute-force protection. |
| 401 | `{"error":"stale_timestamp"}` | The signature is right but the timestamp is more than 300 seconds off, either way (check the clock) |
| 401 | `{"error":"replayed"}` | This nonce was used before |
| 404 | `{"error":"not_found"}` | GET of an unknown organisation, team or person. Also any other path or method under `/v1/` (a trailing slash, dot segments, a typo), without a key check. |
| 409 | `org_missing`, `team_in_other_org`, `team_missing`, `uid_not_oidc`, `account_disabled`, `person_in_other_org`, `team_not_listed` | See the PUTs and the reconcile |
| 413 | `{"error":"too_large"}` | A body over 2 MB, or a reconcile with more than 500 people or teams |
| 423 | `{"error":"busy"}` | Another call is working on the same organisation, team or person; send it again shortly |
| 429 | `{"error":"rate_limited"}` | Over 120 admin calls a minute (`Retry-After: 30`); the brute-force block also answers 429 |
| 503 | `{"error":"not_configured"}` | The admin key has not been imported |

**Versions:** `version` is NoMail's counter for that object, an integer of at least 1. A stored
version greater than the incoming one changes nothing. An equal one runs every step again.

**What NoMail does with `stale_version`** (one rule): the call changed nothing, because the Drive
holds `current_version`, which is higher than the version the call sent. NoMail compares
`current_version` with its own newest version of that object:

- its own is **higher**: nothing to do. That newer call was applied already or is still on its
  way (its retries finish it).
- its own is **equal or lower**: NoMail's counter is behind the Drive (for example an older call
  arrived late, or NoMail's data was restored from a backup). NoMail sets its version to
  `current_version + 1` and sends the whole current state once more. An extra call is harmless:
  every step is "ensure".

**400 and 404:** a 400 `invalid_request` is a fault in what NoMail sent (an id, the body, or a
path that does not match): fix the data, do not send it again as is. A 404 `not_found` on a GET
means that organisation, team or person was never sent (send it first, if it should exist).

**Ids:** `org_id` and `team_id` are lowercase UUIDs; `^qa-[a-z0-9-]{1,40}$` is allowed for tests,
and `^demo-[a-z0-9-]{1,40}$` (organisations, teams and people) for the owner's kept
[demo accounts](#demo-accounts). A Supabase id is always a UUID, so a `demo-` id can never be a
real person or one of NoMail's organisations. Demo ids only go together: a `demo-` team or person
belongs only to a `demo-` organisation, and the other way round. `POST /v1/provision` (NoMail's
key) still takes only UUIDs and `qa-t<task>-<n>` ids, so it can never make a demo account or give
one an app password, and the scheduled delete never deletes one.
The API reads them from the signed path, never from the body.

## Safety

- **Audit:** every admin call writes one row in `oc_nourax_api_audit` (method, route, object,
  status, result, client IP, duration). Never a body, never a key. Failed calls also log one
  warning line (`nourax_api admin ...`).
- **Logs** hold no bodies or keys. A failed step's `detail` is the error's class and message.
- **One call per object at a time:** a Redis lock per organisation, team and person (120 seconds
  at most; 900 for a reconcile); choosing a team folder name is serialised per organisation, and
  each address book is rebuilt by one call at a time.
- **Locked groups:** changes to `org:*` and `team:*` groups made elsewhere (for example on the
  admin pages) are noted in `oc_nourax_api_drift`, listed as `drift` in the status answers and put
  back by the drift job every 15 minutes.
- **What the API deletes:** cards of people who are no longer members, and, when a person leaves
  a team, the shares they made to that team or on its files and their locks there. Never files,
  folders, groups, teams or accounts. The scheduled delete of leavers' accounts is switched off.

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

## Privacy between organisations

People find, autocomplete and share only with people of their **own organisation**: the people
in its group `org:{org_id}` (and so in its teams). Nobody of another organisation is suggested,
found by an exact name, email address or account id, or can be shared with.

**State: on** since 2026-10-25 10:08 (the owner's yes; `occ nourax_api:status` shows
`"org_privacy": "on"`, and `federation` and `circles` are disabled). These are server-wide
switches (see "Who else this changes"), so the step `scripts/configure.d/60-org-privacy.sh` did
nothing until it was switched on once, on purpose; it now keeps them on at every
`scripts/configure.sh` run. Before the switch, `PRIVACY_BASELINE=1 tests/privacy.sh` showed 33
leaks the step closes (for example `qa-t6-1` of organisation A was offered `qa-t6-3`, `qa-t6-5` and
organisation B's groups, the "Accounts" address book listed every account, and profile pages
answered); the search checks already passed. With privacy on, the full `tests/privacy.sh` passes:
see [The test](#the-test) for the run of the reply to NoMail.

### What is limited, and how

| What | With privacy on | Done by |
|---|---|---|
| Suggestions in the share dialog, autocomplete (@-mentions in comments and documents), the contacts menu, calendar invitees and DAV principal search | Only people who share a group (an organisation or a team) | core `shareapi_allow_share_dialog_user_enumeration=yes`, `shareapi_restrict_user_enumeration_to_group=yes`, `shareapi_restrict_user_enumeration_to_phone=no` |
| Typing someone's exact name, email address or account id | Finds nobody outside those groups | core `shareapi_restrict_user_enumeration_full_match=no`, and `..._full_match_user_id`, `..._full_match_email`, `..._full_match_displayname` = `no` |
| Sharing a file or folder with a person or a group | Only with people who share a group, and only with one's own groups ("Sharing is only allowed with group members.") | core `shareapi_only_share_with_group_members=yes`; `shareapi_only_share_with_group_members_exclude_group_list=["admin"]`, so being in `admin` together never counts |
| Sharing a calendar or an address book (NoCalendar, NoContacts, any CalDAV or CardDAV app) | The same rule: 403 "Sharing is only allowed with people of your organisation." and nothing is shared. The server itself checks only `mailto:` targets here, not account or group ids. | nourax_api `lib/Dav/OrgSharePlugin.php` (a DAV plugin on `/remote.php/dav`, before the server's sharing plugin) |
| Sharing a board (NoBoard, in the app or through its REST and OCS APIs) | The same rule: 403 with the same message. Deck itself takes any account or group id. | nourax_api `lib/Middleware/OrgShareMiddleware.php` (looks only at Deck's three "add a board share" actions) |
| Sharing or handing over in the other apps: a NoGantt project share or planning person (resource), a NoForms share or new form owner, a new board owner or a board import (NoBoard), asking someone to take over one's files (NoDrive), a Photos album collaborator, a team folder rule (a lead's advanced permissions) | The same rule: 403 "Sharing is only allowed with people of your organisation." (for a group: "... with your own organisation and teams.") and nothing is shared or handed over. An id that does not exist gets the same 403, so the answer never tells whether an account exists. The apps themselves only check that the account exists (Deck's import not even that). | nourax_api `lib/Middleware/OrgShareMiddleware.php` (the apps' own actions) and `lib/Dav/OrgPeoplePlugin.php` (the album and team folder PROPPATCH) |
| Who a person is, given their exact id: their own DAV address (`/remote.php/dav/principals/users/<id>/`, and `.../groups/<id>/` for a group), the names the ONLYOFFICE editor asks for, the name in a file or card comment that mentions "@<id>", their avatar picture, online status and out of office, and NoCalendar's public appointments page | Only for people who share a group, and one's own groups. For anyone else the address answers no name, email address, groups or language; the editor gets no name; a comment shows the id that was typed; the avatar, status and out of office answer as for an account that does not exist (404); the appointments page is the "not found" page unless the person has a public booking page. | nourax_api `lib/Dav/OrgPeoplePlugin.php` and `lib/Middleware/OrgShareMiddleware.php` (with `lib/Service/MentionNames.php` for card comments) |
| The "Accounts" address book of every account on the server | Not offered in anyone's address books. Asked for at its own address, it lists only people who share a group. Each organisation has its own directory instead. | dav `system_addressbook_exposed=false` |
| Profile pages (`/u/<uid>`) | Off for everyone, signed in or not: every address shows the "Profile not found" page (the server answers it with HTTP 200, the same as for an account that does not exist), with no name or other field | system `profile.enabled=false` |
| Shares with other servers, the public lookup server | Off | files_sharing `outgoing_server2server_share_enabled`, `incoming_server2server_share_enabled`, `outgoing_server2server_group_share_enabled`, `incoming_server2server_group_share_enabled`, `lookupServerEnabled`, `lookupServerUploadEnabled` = `no`. The server reads these keys in files_sharing only; the step stores `outgoing_server2server_share_enabled` and `incoming_server2server_share_enabled` = `no` under federatedfilesharing too, so a check of either app reads the same (nothing reads them there). |
| Trusted servers | Off | app `federation` disabled (0 federated shares and 0 trusted servers on 2026-10-25) |
| The Teams app (circles) | Off | app `circles` disabled: its member search lists every account on the server, disabled ones too, whatever the settings above say, and anyone may add any account to a team (tested 2026-10-25). Team folders, boards and the team address books do not use it. |
| Search | Unchanged: the search box only finds one's own files and files shared with one, and one's own contacts and directories. Tested with a word only another organisation's file has. | — |

The rule for calendars, address books, boards and the other apps is the server's own rule for
files (core's `RestrictInteractionListener`), in `lib/Service/OrgPrivacy.php`: a person only when
the two share a group other than `admin`; a group only when one is a member and it is not `admin`;
a Teams-app team or a person on another server never. The service account `nourax-teams` is never
limited, so the admin API keeps sharing the team books, calendars and boards with their team
groups, and it stays visible to everyone (it owns the team calendars and books).
`occ nourax_api:status` shows `org_privacy` (`on` while sharing is limited to group members).
None of this edits another app's files: an app update keeps it.

### Every place people meet, app by app

Checked on 2026-10-25 with privacy on, as the demo accounts see each other (Demo Alpha and Demo
Beta, both ways) and, for everything that shares or hands something over, as three QA accounts in
two QA organisations (so a leak could never change a demo account). `tests/privacy-apps.sh` runs
all of it; [The test](#the-test) has the runs.

| App | Where a person meets another | Result |
|---|---|---|
| NoDrive (files) | Share dialog (files, and the calendar, board and principal kinds of the same search), recommendations, autocomplete (@-mentions in comments), contacts menu, hovercards, online statuses, the account API | Nobody of the other organisation, by part of a name, the exact id, email or name, or a group name. Hovercards and the contacts menu's card by id: 404. Server settings (above). |
| NoDrive | Asking someone to take over one's files (`files/api/v1/transferownership`) | Was a leak: any account got the request, with the sender's name. Now 403. |
| NoDrive | Comments: "@<id>" in a comment | The mentioned person gets no notification (the server drops it: they cannot open the file). Was a leak: the comment answered their name to everyone who reads it. Now the id. |
| NoCalendar | Attendee suggestions, photos, contact groups, principal search, free/busy | Nobody of the other organisation; free/busy answers "could not find principal" (3.7). |
| NoCalendar | Sharing a calendar; inviting someone | Shares: 403 (above). An invitation to someone of another organisation goes out as an email to their address; it never reaches their calendar inbox. |
| NoCalendar | The public appointments page (`/apps/calendar/appointments/<id>`) | Was a leak, to anyone, even a visitor who is not signed in: the page held the name of any account id ("Karim (Marketing)" for `demo-b01`, who has no booking page). Now, for an account without a public booking page, people outside its organisation and visitors who are not signed in get the page of an account that does not exist. A public booking page is the person's own choice to be found, like a public link, and stays. |
| Out of office | A person's absence asked by id (`/ocs/v2.php/apps/dav/api/v1/outOfOffice/<id>` and `.../now`); naming one's replacement | Was a leak: anyone could read the dates, message and replacement of anyone's absence, and naming any account as one's replacement answered that person's name. Now 404 (no data) for someone outside the organisation, and 403 for such a replacement (or an id that does not exist). |
| Online status | A person's status asked by id (`/ocs/v2.php/apps/user_status/api/v1/statuses/<id>`) | Was a leak: the status and its message. Now 404 "No status for the requested userId", as for someone without a status. The list of everyone's statuses was already empty (the server gives none while people search is limited to groups). |
| Avatars (every app) | The picture of a person asked by id (`/avatar/<id>/64`, `.../dark`, `?guestFallback=true`, and DAV `avatars/<id>/64.png`) | Was a leak: without an uploaded picture the server draws the first letters of the name ("K(" for "Karim (Marketing)"). Now 404 `[]`, as for an account that does not exist (with `guestFallback`, the guest picture of the id that was typed). Same-organisation pictures are unchanged. |
| NoTasks | Sharing a task list (a calendar) | 403, as for calendars. |
| NoContacts | Address books, the directory, contacts search | Only one's own organisation's directory and teams' books, never the "Accounts" book; the directory holds the organisation's 12 people only; search finds nobody else. |
| DAV (any app) | A person's or group's own address (`principals/users/<id>`, `principals/groups/<id>`) | Was a leak: anyone who knew the id got the name, email address, groups and language. Now nothing but "it is a principal". |
| NoBoard | Board shares | 403 (above). |
| NoBoard | A new board owner (`transferOwner`) | Was a leak: Deck took any id, even one that does not exist. Now 403. |
| NoBoard | Board imports (the import API and the upload) | Was a leak: the shares, card people, comment authors, card editors and attachment authors of an import were written as they are (the import API answered 200 with a `uidRelation` that named `qa-t6b-3`, and the upload 200 with a share to `qa-t6b-3`). Now an import that names someone of another organisation, or another organisation's group, gets 403 (the import API answers through `/index.php` in OCS version 1: HTTP 200 with status 403 and the message in the answer; the upload answers HTTP 403). Each field is read exactly as Deck 1.19.1 reads it (a share by `participant.primaryKey`, a card person by `participant.uid`, the export's owner becomes the importing person, comment authors never), so an export cannot say one thing to the check and another to Deck. |
| NoBoard | Card people, @-mentions on cards | Only the board's people (Deck's own rule). |
| NoBoard | Card comments that mention "@<id>" | Was a leak: Deck answered the mentioned person's name to everyone who reads the card. Now the id that was typed, in the JSON and the XML answers. The person is not notified (Deck notifies only the board's people). |
| NoForms | Sharing a form, a new form owner | Was a leak: any account or group. Now 403. The "all accounts" options stay off (`50-apps.sh`). |
| NoGantt | Its own sharee search, people search and email match | Nobody of the other organisation (they use the server's search); the email match answers `not_found`. |
| NoGantt | Sharing a project, a planning person (resource) | Was a leak (Task 1's lane G found it too): a project share with any account, and a resource for any account answered that person's name and could send them notifications. Now 403. |
| ONLYOFFICE | The editor's people list (mentions, protected ranges), its names for account ids, mentions by email | The list holds the organisation's people only. Was a leak: the editor's name lookup answered any account's name. Now only names of people one shares a group with. A mention by email of someone of another organisation shares nothing and notifies nobody (ONLYOFFICE's own check). |
| Team folders | The lead's people search; a lead's advanced permissions | The search holds the team only. Was a leak: a rule could name anyone, and then showed their name. Now a new rule for someone outside the organisation, or for a group the lead is not in, gets 403. Rules the folder already has are not checked again, so an old rule (for someone who has since left) never blocks the lead's other changes. |
| Photos | Album collaborators | Was a leak: any account or group (Photos checks only that it exists). Now a new collaborator outside the organisation gets 403; collaborators the album already has are not checked again. Public links stay possible. |
| NoNotes | — | No people list of its own: notes are files and are shared as files. |
| Text documents | @-mentions | The suggestions are the server's people search plus the people in the document, so nobody of the other organisation (checked live: a session on a QA file, the list for "qa-t6b", the id and the name). A mention of them notifies nobody: Text's Notifier drops a notification for someone who cannot open the file (text 9.0.1). |
| Activity | The activity stream | Names nobody of the other organisation. |
| Search box | Every provider (files, contacts, comments, NoBoard cards and comments, NoForms, NoGantt, full text, calendar, tasks, tags, notes, settings, apps) | Nothing of the other organisation for a name, an id or the organisation's id. |

### What stays possible

- **Public links**, and "share by email" (a link sent to any address). Typing an email address
  offers that address for a link by email; the offer is the typed text only and says nothing
  about whether an account has that address.
- **Inviting** anyone to an event by email address (an invitation, as an email would be).
- **Existing shares** stay: the settings check new shares only.

### Who else this changes

- Accounts in **no organisation** share with nobody but their group-mates. The owner and
  `nodrive` are only in `admin`, which never counts: they keep links, but no longer share with
  people directly. To share with an organisation's people, put the account in that organisation.
- **Other tasks' QA accounts** (for example `qa-t1-7` and `qa-t1-8`, `qa-t5b-*`) are in no common
  group: shares between them are refused now that privacy is on. QA accounts that must find each
  other need a shared `org:` or `team:` group, made with this API.
- The team **"hammadddd"** (made 2026-10-23 in the Teams app by `nodrive`) is hidden while the
  Teams app is off. Nothing is deleted; enabling the app shows it again.

### Known limits

- Someone who already knows the exact account id of a person in another organisation (a random
  36-character id they cannot find through Drive) can still tell that the account exists: its
  DAV address answers "a principal" with no name. They cannot find it, share with it, hand it
  anything, or see its name, picture, status, absence, email address, groups or profile.
- A visitor who is **not signed in** and knows an exact id still gets its avatar picture
  (`/avatar/<id>/64`: the first letters of the name, when no picture was uploaded). Pages made
  for visitors, such as a public booking page, show the person's picture, so pictures are limited
  for signed-in people only. Real account ids are random; only the demo and QA ids can be
  guessed.
- Someone who writes "@<id>" of such a person in a comment sees that person's name in their own
  activity stream ("You commented ..."): the activity app names the people in a comment with the
  server's display-name lookup, which no app can change. Only the comment's author sees it, and
  only for an id they typed themselves; the comment itself and everyone else show the id, and the
  person is not notified.
- Opening NoNotes for the first time makes an empty "Notes" folder in one's files (the app's own
  behaviour, not a privacy matter).
- The old addresses `/remote.php/caldav` and `/remote.php/carddav` have no sharing at all, so
  `OrgSharePlugin` covers every way to share a calendar or an address book.
- The "Accounts" book at its own address (`/remote.php/dav/addressbooks/system/system/system/`):
  a full listing, a search, a card fetch and a first sync give only people who share a group
  (the server filters them; checked in `tests/privacy.sh`). A sync app that asks again later with
  its sync token is also told which cards were removed since, by file name
  (`<backend>:<account id>.vcf`), for every account on the server, since the server does not
  filter removals. That is an account id only, no name or email address.

### Switching it on, and back off

Under the server-change lock, after the other tasks' sharing tests (it needs no restart):

```
ssh … 'cd /opt/nourax/basic-office-infra && sudo flock -w 1800 /run/nourax-deploy.lock bash -c "git pull -q --ff-only && ORG_PRIVACY=on bash -c \". scripts/lib.sh; load_env; . scripts/configure.d/60-org-privacy.sh\" && NOURAX_LOCK_HELD=1 tests/privacy.sh"'
```

It sets the settings above, disables `federation` and `circles` and stores the switch
(`nourax_api org_privacy_step=on`), so every later `scripts/configure.sh` run keeps it on.
**Undo** with `ORG_PRIVACY=off` in the same command (without the test): the server's defaults come
back and both apps are enabled again.

### The test

`sudo tests/privacy.sh` (after `tests/admin-api.sh`). It puts `qa-t6-1` (team A2) and `qa-t6-2`
(team A1) in organisation A and `qa-t6-3` and `qa-t6-5` (team B1) in organisation B through the
people API, then, as `qa-t6-1` with its app password from `/v1/provision`, checks every row of the
table above: the settings, the sharee search (a wide search, the exact id, email and name of
`qa-t6-3`), autocomplete, the contacts menu, the address book list and the directory's cards, the
system book at its own address, principal search, the files, full-text and contacts search (with
`qa-t6-3` finding its own file as the control), profiles, the Teams app, file shares (person,
group, other server), calendar and address book shares (account, email, group) and board shares
(REST and OCS), each refused for organisation B and allowed for `qa-t6-2`. It also runs
`tests/org-privacy-rules.php`, which asks `OrgPrivacy` directly, and checks that a team PUT
still shares the team's book, calendar and board.

`PRIVACY_BASELINE=1 sudo tests/privacy.sh` runs only the checks that read, for a picture before
the step is on: every FAIL there is a leak the step closes. It shares nothing.

**With privacy on**, 2026-10-25 11:12–11:14 UTC (commit `c025c99`): `sudo tests/privacy.sh`
passed every check (105 PASS lines, none failed, the rule file's 52 among them). For example the
sharee search for "qa-t6" as `qa-t6-1` found only `qa-t6-2` and `qa-t6-1`'s own two groups; the
exact id, email and name of `qa-t6-3` found nobody; the system book at its own address and its
sync report held 2 cards, none outside organisation A; every profile page was "not found".

## What NoMail builds

NoMail is the source of truth for organisations, teams and who is in them. The Drive only
follows. NoMail stores none of this yet: its code (commit `a9b5f07`, 33 migrations, read on
2026-10-25) has no table or column for organisations, teams or memberships; it has
`public.admin_users`, `public.profiles` and one `public.drive_accounts` row per person. NoMail
needs (the full list, a table sketch and what to do with each answer are in the reply to NoMail,
`handoffs/2026-10-25-nourax-drive-to-nomail.md`):

| Table | Columns |
|---|---|
| `organisations` | `id uuid`, `name`, `version` (an integer, +1 on every change) |
| `teams` | `id uuid`, `org_id`, `name`, `version` |
| `memberships` | `team_id`, `user_id`, `role` (`member` or `lead`) |
| `people` | `user_id` (the Supabase user id), `org_id`, `active`, `version` |

- **One admin-only Edge Function** signs `NOURAX-ADMIN-V1` requests with the Supabase secret
  `NODRIVE_ADMIN_API_KEY` (recipe: [Signing a request](#signing-a-request)) and sends
  `PUT /v1/admin/orgs/{org_id}`, `PUT …/teams/{team_id}` and `PUT /v1/admin/people/{user_id}`
  whenever one of those rows changes, plus one `POST /v1/admin/orgs/{org_id}/reconcile` per
  organisation every night.
- Only NoMail's administrators can call that function. It is never an MCP tool, never reachable
  by an ordinary signed-in person, and the key never reaches a browser.
- Bump `version` on every change and send the newest. An answer with `applied: false,
  reason: stale_version` means the Drive holds a higher version; what NoMail then does is under
  [Answers](#answers) ("What NoMail does with `stale_version`"). A 502 or 423 means "send the same
  call again later". A 400 `invalid_request` means "fix the data, do not retry as is"; a 404
  `not_found` on a GET means "never sent".
- A person leaves the organisation with `"active": false`: their Drive account is disabled at once
  and kept 30 days. There is no delete call. The account is deleted after the 30 days only if the
  owner has switched the scheduled delete on (it is off).

When NoMail calls:

| Event in NoMail | Call |
|---|---|
| An organisation is made or renamed | `PUT /v1/admin/orgs/{org_id}` |
| A team is made or renamed | `PUT /v1/admin/orgs/{org_id}/teams/{team_id}` (after its organisation) |
| A person's account is confirmed and placed in an organisation | `PUT /v1/admin/people/{user_id}`, `"active": true` (makes the Drive account if needed, without an app password) |
| Team join, leave, move, role change, email or name change | The person PUT with the whole new state |
| A move to another organisation | One person PUT with the new `org_id` (supported; not tested across organisations) |
| Leaving the organisation, or closing the NoMail account | The person PUT with `"active": false`, before NoMail deletes anything |
| Every night | `POST /v1/admin/orgs/{org_id}/reconcile`, per organisation |

## Demo accounts

Demo data for the owner, to see how organisations, teams, team folders and privacy work. It is
made through this API, signed with the admin key, exactly as NoMail would call it. **It is kept,
and it belongs to the owner: no task may disable, change or delete these accounts.** They are not
QA objects, and no test round touches them.

| Organisation | Team | People (the lead first) |
|---|---|---|
| Demo Alpha (`demo-alpha`) | Sales (`demo-alpha-sales`) | `demo-a01` Amina (lead), `demo-a02` Ben, `demo-a03` Chloe, `demo-a04` Daniel, `demo-a05` Elif, `demo-a06` Omar, `demo-a07` Priya |
| | Engineering (`demo-alpha-engineering`) | `demo-a08` Farah (lead), `demo-a09` George, `demo-a10` Hana, `demo-a11` Ivan, `demo-a12` Jade, `demo-a06` Omar, `demo-a07` Priya |
| Demo Beta (`demo-beta`) | Marketing (`demo-beta-marketing`) | `demo-b01` Karim (lead), `demo-b02` Lena, `demo-b03` Mateo, `demo-b04` Nadia, `demo-b05` Oscar, `demo-b06` Rania, `demo-b07` Sami |
| | Support (`demo-beta-support`) | `demo-b08` Tara (lead), `demo-b09` Umar, `demo-b10` Vera, `demo-b11` Wes, `demo-b12` Yusuf, `demo-b06` Rania, `demo-b07` Sami |

- Omar, Priya, Rania and Sami are in both teams of their organisation, so each team has 7 people
  and each organisation 12.
- The name shown is the first name and the team: "Amina (Sales)", "Omar (Sales + Engineering)".
- The emails are `<uid>@demo-alpha.invalid` and `<uid>@demo-beta.invalid`. The `.invalid` ending
  can never receive mail.
- They are "Log in with Nourax" accounts (backend `user_oidc`), made by the people PUT like real
  people, so they get everything a real member gets.

What is in them:

- In each team folder, "Welcome to <team>.md" (who is in the team, and what to try) and
  "<team> plan.docx", an ONLYOFFICE document. Each team's lead writes them, and only when they are
  missing, so changes the owner makes are kept.
- "Ben's notes for George.md" in the own files of Ben (`demo-a02`, Sales), shared read-only with
  George (`demo-a09`, Engineering): the same organisation, another team.
- Each team's calendar "Team: <team>", its board "Team: <team>" and its read-only address book, as
  for every team.

**Making and checking them:** `sudo tests/demo-accounts.sh` on the server. It takes the
server-change lock itself (never wrap it in `flock`; set `NOURAX_LOCK_HELD=1` if you already hold
the lock), makes what is missing, puts back what changed, then checks everything.
`sudo tests/demo-accounts.sh --check` only reads. Both are safe to run again, and neither deletes
anything.

### Signing in as a demo person

Each demo account has one app password called "Demo sign-in" (its key). The keys are kept in two
places only:

- on the server, `/etc/nourax/demo/demo-accounts.txt` (root only: folder 0700, file 0600);
- on the owner's PC, `_private\nourax-workspace-demo-accounts.txt` in the folder that holds the
  repo checkouts (outside every git repo; only the owner's Windows account can read it). It is
  copied straight from the server, so the keys are never shown. In Git Bash, in that folder:

  ```
  mkdir -p _private
  ssh -i ~/.ssh/nourax_workspace_ed25519 nourax@57.129.185.78 'sudo cat /etc/nourax/demo/demo-accounts.txt' > _private/nourax-workspace-demo-accounts.txt
  MSYS_NO_PATHCONV=1 icacls '_private\nourax-workspace-demo-accounts.txt' /inheritance:r /grant:r "$USERNAME:F"
  ```

Each file has one line per account, with tabs between: uid, name, organisation, teams, key.

**The sign-in page does not take these keys.** Its form asks only the kinds of accounts that have
a password (core's `LoginController::tryLogin`, then `UidLoginCommand` and
`Manager::checkPasswordNoLogging`). "Log in with Nourax" accounts (`user_oidc`) have none, and app
passwords are checked only for apps and WebDAV (`Session::logClientIn`). So the form refuses a
demo key as a wrong password (checked: the POST goes back to `/login?direct=1&user=demo-a01`, and
that page's reason is `invalidpassword`), while the same request with a local QA account's
password signs in (to `/apps/files/`).

**The way in, in a private browser window:**

1. Open a private window (Chrome Incognito, Edge InPrivate or a Firefox private window).
2. Go to `https://drive.nourax.org/remote.php/webdav/`. The browser asks for a user name and a
   password for "Nourax Workspace".
3. Type the uid (for example `demo-a01`) and that person's key from the file. A short WebDAV page
   shows.
4. Go to `https://drive.nourax.org/apps/files/`. You are now that person, in the normal pages:
   files, team folders, calendar, board and ONLYOFFICE.
5. To stop, choose "Log out" in the user menu or close the private window. The key keeps working.

All private windows of one browser share one sign-in. To be two demo people at the same time, use
two browsers, or two browser profiles.

Why this way: it uses only what is already there for the desktop and phone apps, an app password
over HTTPS on the WebDAV address, which is open to the internet anyway and takes only app
passwords and sessions (`token_auth_enforced`). Nothing changes for real people: "Log in with
Nourax" and the sign-in page stay as they are, no page is opened to more people, and the demo
accounts get no login password. Left out on purpose: a local password for each demo account (a
second kind of account, and passwords the sign-in page would take), an "impersonate" app (it needs
admin rights and the admin pages), and any change to the sign-in page.

`tests/demo-signin.sh` checks this from the owner's PC (Git Bash, from the repo; the sign-in page
is open only to the owner's address). Run on 2026-10-25 for all 24 accounts: the sign-in form
refuses the key, and its reason is a wrong password; WebDAV `PROPFIND` with the key answers 207;
`/remote.php/webdav/` with the key answers 200 and starts a session; with only that session's
cookies, `/ocs/v2.php/cloud/user` names the uid and `/apps/files/` is that person's page; the
page's own "Log out" link ends the session, and the key still answers 207.

### What keeps them as they are

Checked on 2026-10-25 in this repo and in the other tasks' work:

- `POST /v1/provision` (NoMail's key) refuses `demo-` ids: it can never make a demo account or
  give one an app password.
- The scheduled delete (`LeaverDeletion`, off) takes only Supabase and QA ids, never a `demo-` id.
- A demo person or team belongs only to a demo organisation (400 otherwise). NoMail's PUTs and its
  nightly reconcile name only NoMail's own organisations (UUIDs), so they never list, move, leave,
  archive or disable a demo person or team.
- The drift job (every 15 minutes) only puts the `org:demo-*` and `team:demo-*` groups back the way
  they are stored. It keeps the demo accounts as they are and disables nobody.
- `tests/qa-wrapup.sh` touches only `org:qa-t6*` organisations and `qa-t6-<number>` accounts. The
  other tests, and Task 1's MCP tests, touch only their own `qa-t<task>-*` accounts.
- `user_oidc` has no job that disables accounts, and demo people never sign in through it (a
  Supabase id is always a UUID), so it never rewrites their names or emails.
- The retention app has no rules.

So nothing needed a `demo-` exception. They change only through a signed admin call that names a
`demo-` id (only `tests/demo-accounts.sh` sends those) or through an admin (occ or the admin pages).

**One limit:** the server's regular clean-up removes an app password that has not been used for a
year (core's `token_auth_token_retention`, 365 days by default). If a key stops working, run
`sudo tests/demo-accounts.sh` again: it makes a new key only for a person whose stored key gets 401
and writes it to the server file. Then copy the file to the PC again (above).

## QA objects made by the test

`tests/admin-api.sh` uses only these, and deletes nothing:

| Kind | Ids |
|---|---|
| Organisations | `qa-t6-org-a` ("QA t6 Org A"), `qa-t6-org-b` ("QA t6 Org B") |
| Teams | `qa-t6-team-a1` and `qa-t6-team-a2` (both "Sales", org A: folders "Sales" and "Sales 2"), `qa-t6-team-b1` ("Sales", org B: folder "Sales") |
| Member (part 1) | `qa-t6-5`, put into `org:qa-t6-org-a` and `team:qa-t6-team-a1` with `occ group:adduser` |
| People (part 2, `tests/admin-people.sh`) | `qa-t6-1` (A1 member, then moved to A2), `qa-t6-2` (A1 lead), `qa-t6-3` (B1; leaves the organisation and comes back), `qa-t6-4` (added to A1 with occ, taken out by the reconcile) |
| People and objects (`tests/privacy-apps.sh`) | Organisations `qa-t6b-org-a` ("QA t6b Org A", team `qa-t6b-team-a1`) and `qa-t6b-org-b` (team `qa-t6b-team-b1`); `qa-t6b-4` (A1 lead), `qa-t6b-2` (A1), `qa-t6b-3` (B1). Of `qa-t6b-4`: a folder `qa-t6b-privacy` (with `probe.txt`, its comment "@qa-t6b-3 privacy probe", and `transfer-me.txt`), the NoGantt project "QA t6b privacy" (shared with `qa-t6b-2`) and a resource for `qa-t6b-2`, the forms "QA t6b privacy" (shared with `qa-t6b-2`) and "QA t6b transfer", the boards "QA t6b privacy" (a list and a card with the comments "@qa-t6b-3 privacy probe" and "@qa-t6b-2 privacy probe"), "QA t6b transfer" and "QA t6b import (same organisation)", the album "QA t6b privacy" (with `qa-t6b-2`), the folder `qa-t6b-acl` in the team folder (a rule for `qa-t6b-2`), the task list "QA t6b tasks" (shared with `qa-t6b-2`), the calendar "QA t6b events" (one invitation a day to `qa-t6b-3`'s address), and one ownership transfer request to `qa-t6b-2` (never accepted); an out of office for today and tomorrow with `qa-t6b-2` as replacement. `qa-t6b-2` and `qa-t6b-3` keep a status message ("... status probe") and an out of office for today and tomorrow, set again each run. The run before the fixes also left what the leaks let through, all between QA accounts: see [The test](#the-test). Kept for the next run. |
| People and objects (`tests/privacy.sh`) | `qa-t6-1` (A2), `qa-t6-2` (A1), `qa-t6-3` and `qa-t6-5` (B1); a folder `qa-t6-privacy` in `qa-t6-1`'s and `qa-t6-3`'s files, a calendar and an address book `qa-t6-privacy` and a board "QA t6 privacy" of `qa-t6-1`, each shared with `qa-t6-2` only. Kept for the next run. |

`tests/admin-people.sh` names the teams "QA t6 Team A1 Renamed", "QA t6 Team A2" and "QA t6 Team
B1"; `tests/admin-api.sh` names them "Sales" again. Both count the versions on from what is
stored, so they can run in any order and again.

Two more QA organisations come from review runs: `qa-t6v-org-a` (teams `qa-t6v-team-a1`,
`qa-t6v-team-a2`) and `qa-t6q3-org-a` (team `qa-t6q3-team-a1`).

**At the end of a test round**, `sudo tests/qa-wrapup.sh` leaves every `org:qa-t6*` organisation's
teams archived through the API (a reconcile with `{"teams":[],"people":[]}`: everybody leaves,
every team is archived, nothing is deleted) and disables every `qa-t6-<number>` account with
`occ user:disable`. Before the next round, `sudo tests/qa-wrapup.sh --enable` enables `qa-t6-1` to
`qa-t6-5` again; the tests' own PUTs bring the teams back out of the archive. Deleting the QA
accounts, organisations or files needs the owner's yes.

Part 1's `occ group:adduser` of `qa-t6-5` is a change made outside the API, so it is real drift:
the status of `qa-t6-org-a` and `qa-t6-team-a1` lists an open `member_added` row for it, and the
drift job takes `qa-t6-5` out again within 15 minutes and closes the rows. `qa-t6-org-b`,
`qa-t6-team-a2` and `qa-t6-team-b1`, changed only through the API, show `"drift":[]`. (Part 1 used
`qa-t6-1` here; its two rows were closed by the first drift run of part 2.)

## Deploying a change

As for the NoMail API: `git pull` on the server, then, for new routes, reload the web server in
the `app` container under the lock (`docker compose exec -T app apachectl -k graceful`). The
background jobs run in the `cron` container from the same files; nothing needs a restart.
