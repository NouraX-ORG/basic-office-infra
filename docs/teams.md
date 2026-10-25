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
| Tests | `sudo tests/admin-api.sh` (part 1), `sudo tests/admin-people.sh` (part 2) and `sudo tests/privacy.sh` (privacy between organisations) on the server |

**Part 1 (live):** request signing, the audit, organisations and teams.
**Part 2 (live):** people (`PUT /v1/admin/people/{user_id}`: joins, moves, leaves, leaving the
organisation), the reconcile call, the drift guard that keeps the groups locked, and the scheduled
delete of leavers, built **switched off**.
**Privacy between organisations (built; not switched on yet):** people find, autocomplete and
share only with people of their own organisation. See
[Privacy between organisations](#privacy-between-organisations).

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
(a lowercase UUID; `qa-t<task>-<n>` for tests).

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
| 400 | `{"error":"invalid_request"}` | An id that is not a lowercase UUID or a QA id `qa-...`, a bad body, a query on a PUT |
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

**Ids:** `org_id` and `team_id` are lowercase UUIDs; `^qa-[a-z0-9-]{1,40}$` is allowed for tests.
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

**State:** built on 2026-10-25; **not switched on yet**. These are server-wide switches (see
"Who else this changes"), so the step `scripts/configure.d/60-org-privacy.sh` does nothing until
it is switched on once, on purpose. Until then the nourax_api checks below do nothing either.
Tested so far: the rule, the DAV plugin and the board check in place on the server, as if privacy
were on (`tests/org-privacy-rules.php`, 52 checks pass), and a picture of today with
`PRIVACY_BASELINE=1 tests/privacy.sh`: 33 checks fail, each a leak the step closes (for example
`qa-t6-1` of organisation A is offered `qa-t6-3`, `qa-t6-5` and organisation B's groups, the
"Accounts" address book lists every account, and profile pages answer). The search checks already
pass: nobody finds another organisation's files or contacts.

### What is limited, and how

| What | With privacy on | Done by |
|---|---|---|
| Suggestions in the share dialog, autocomplete (@-mentions in comments and documents), the contacts menu, calendar invitees and DAV principal search | Only people who share a group (an organisation or a team) | core `shareapi_allow_share_dialog_user_enumeration=yes`, `shareapi_restrict_user_enumeration_to_group=yes`, `shareapi_restrict_user_enumeration_to_phone=no` |
| Typing someone's exact name, email address or account id | Finds nobody outside those groups | core `shareapi_restrict_user_enumeration_full_match=no`, and `..._full_match_user_id`, `..._full_match_email`, `..._full_match_displayname` = `no` |
| Sharing a file or folder with a person or a group | Only with people who share a group, and only with one's own groups ("Sharing is only allowed with group members.") | core `shareapi_only_share_with_group_members=yes`; `shareapi_only_share_with_group_members_exclude_group_list=["admin"]`, so being in `admin` together never counts |
| Sharing a calendar or an address book (NoCalendar, NoContacts, any CalDAV or CardDAV app) | The same rule: 403 "Sharing is only allowed with people of your organisation." and nothing is shared. The server itself checks only `mailto:` targets here, not account or group ids. | nourax_api `lib/Dav/OrgSharePlugin.php` (a DAV plugin on `/remote.php/dav`, before the server's sharing plugin) |
| Sharing a board (NoBoard, in the app or through its REST and OCS APIs) | The same rule: 403 with the same message. Deck itself takes any account or group id. | nourax_api `lib/Middleware/OrgShareMiddleware.php` (looks only at Deck's three "add a board share" actions) |
| The "Accounts" address book of every account on the server | Not offered in anyone's address books. Asked for at its own address, it lists only people who share a group. Each organisation has its own directory instead. | dav `system_addressbook_exposed=false` |
| Profile pages (`/u/<uid>`) | Off for everyone: 404 | system `profile.enabled=false` |
| Shares with other servers, the public lookup server | Off | files_sharing `outgoing_server2server_share_enabled`, `incoming_server2server_share_enabled`, `outgoing_server2server_group_share_enabled`, `incoming_server2server_group_share_enabled`, `lookupServerEnabled`, `lookupServerUploadEnabled` = `no` (the keys live in files_sharing, not federatedfilesharing) |
| Trusted servers | Off | app `federation` disabled (0 federated shares and 0 trusted servers on 2026-10-25) |
| The Teams app (circles) | Off | app `circles` disabled: its member search lists every account on the server, disabled ones too, whatever the settings above say, and anyone may add any account to a team (tested 2026-10-25). Team folders, boards and the team address books do not use it. |
| Search | Unchanged: the search box only finds one's own files and files shared with one, and one's own contacts and directories. Tested with a word only another organisation's file has. | — |

The rule for calendars, address books and boards is the server's own rule for files (core's
`RestrictInteractionListener`), in `lib/Service/OrgPrivacy.php`: a person only when the two share
a group other than `admin`; a group only when one is a member and it is not `admin`; a Teams-app
team or a person on another server never. The service account `nourax-teams` is never limited, so
the admin API keeps sharing the team books, calendars and boards with their team groups.
`occ nourax_api:status` shows `org_privacy` (`on` while sharing is limited to group members).

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
  group: shares between them are refused once privacy is on. So it is switched on after their
  sharing tests.
- The team **"hammadddd"** (made 2026-10-23 in the Teams app by `nodrive`) is hidden while the
  Teams app is off. Nothing is deleted; enabling the app shows it again.

### Known limits

- Someone who already knows the exact account id of a person in another organisation (a random
  36-character id they cannot find through Drive) can still see that the account exists and its
  avatar picture (`/avatar/<id>/64`), and its online status if one is set. They cannot find it,
  share with it or see its profile.
- The old addresses `/remote.php/caldav` and `/remote.php/carddav` have no sharing at all, so
  `OrgSharePlugin` covers every way to share a calendar or an address book.

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

## QA objects made by the test

`tests/admin-api.sh` uses only these, and deletes nothing:

| Kind | Ids |
|---|---|
| Organisations | `qa-t6-org-a` ("QA t6 Org A"), `qa-t6-org-b` ("QA t6 Org B") |
| Teams | `qa-t6-team-a1` and `qa-t6-team-a2` (both "Sales", org A: folders "Sales" and "Sales 2"), `qa-t6-team-b1` ("Sales", org B: folder "Sales") |
| Member (part 1) | `qa-t6-5`, put into `org:qa-t6-org-a` and `team:qa-t6-team-a1` with `occ group:adduser` |
| People (part 2, `tests/admin-people.sh`) | `qa-t6-1` (A1 member, then moved to A2), `qa-t6-2` (A1 lead), `qa-t6-3` (B1; leaves the organisation and comes back), `qa-t6-4` (added to A1 with occ, taken out by the reconcile) |
| People and objects (`tests/privacy.sh`) | `qa-t6-1` (A2), `qa-t6-2` (A1), `qa-t6-3` and `qa-t6-5` (B1); a folder `qa-t6-privacy` in `qa-t6-1`'s and `qa-t6-3`'s files, a calendar and an address book `qa-t6-privacy` and a board "QA t6 privacy" of `qa-t6-1`, each shared with `qa-t6-2` only. Kept for the next run. |

`tests/admin-people.sh` names the teams "QA t6 Team A1 Renamed", "QA t6 Team A2" and "QA t6 Team
B1"; `tests/admin-api.sh` names them "Sales" again. Both count the versions on from what is
stored, so they can run in any order and again.

Part 1's `occ group:adduser` of `qa-t6-5` is a change made outside the API, so it is real drift:
the status of `qa-t6-org-a` and `qa-t6-team-a1` lists an open `member_added` row for it, and the
drift job takes `qa-t6-5` out again within 15 minutes and closes the rows. `qa-t6-org-b`,
`qa-t6-team-a2` and `qa-t6-team-b1`, changed only through the API, show `"drift":[]`. (Part 1 used
`qa-t6-1` here; its two rows were closed by the first drift run of part 2.)

## Deploying a change

As for the NoMail API: `git pull` on the server, then, for new routes, reload the web server in
the `app` container under the lock (`docker compose exec -T app apachectl -k graceful`). The
background jobs run in the `cron` container from the same files; nothing needs a restart.
