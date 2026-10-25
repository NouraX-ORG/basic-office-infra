# Extra apps

Apps added on top of the base workspace. They all come from the app store and are installed and
switched on by `scripts/configure.d/50-apps.sh` (run by `sudo scripts/configure.sh`).

The app store always gives the newest release for this server version; occ can't choose one. So
the script logs each app's version and prints a `WARNING` when it is not the release we tested:

| App id | Shown as | Tested release | Licence |
|---|---|---|---|
| `groupfolders` | Team folders | 23.0.1 | AGPL-3.0-or-later |
| `tasks` | NoTasks | 0.18.1 | AGPL-3.0-or-later |
| `notes` | NoNotes | 6.1.0 | AGPL-3.0-or-later |
| `forms` | NoForms | 5.4.1 | AGPL-3.0-or-later |

The app-menu names (NoTasks, NoNotes, NoForms) are in `config/nextcloud/app-labels.d/50-apps.conf`;
`scripts/configure.sh` turns them into the theme CSS.

Two more apps ship with the server itself, so nothing is downloaded. `scripts/configure.d/50-audit.sh`
switches them on ([Suspicious login](#suspicious-login), [Audit log](#audit-log)):

| App id | What it is | Release (server 35.0.2) | Licence |
|---|---|---|---|
| `suspicious_login` | Warns people about sign-ins from unusual addresses | 13.0.0 | AGPL-3.0-or-later |
| `admin_audit` | The audit log | 2.0.0 | AGPL-3.0-or-later |

In the commands below, `OCC` means, on the server:

```
cd /opt/nourax/basic-office-infra
OCC() { sudo docker compose exec -T -u www-data app php occ "$@"; }
```

## Team folders

A team folder belongs to the workspace, not to one person. An admin gives one or more groups access
to it. Every member then sees it at the top level of their NoDrive, and the files stay there when
someone leaves the group. People outside those groups don't see it at all.

- **The name is the folder's place.** A team folder called `Sales` shows as `/Sales` in every
  member's NoDrive. Renaming the team folder renames it for everyone. A member can't rename or
  move it themselves.
- **Rights per group:** read, write (edit and create), share and delete. In the API they are bits:
  read 1, edit 2, create 4, delete 8, share 16. 31 means all of them, and it is what a group gets
  when it is added.
- **Our settings:** advanced permissions (rights per subfolder or per person) stay off, and there
  is no quota. Both can be set per folder later.
- **Storage:** each team folder is a storage of its own in the database
  (`object::store:object::groupfolder:<id>.amazon::nourax-drive`), and its files are objects in the
  same R2 bucket `nourax-drive` as everyone else's (`urn:oid:<file id>`). The nightly backups cover them. Each team folder has its own
  trash and version history; the app's background jobs expire old ones.
- **Where people see it:** in NoDrive, in the file list and under "Team folders" in the left
  column. Admins manage them under Administration settings, "Team folders" (the admin pages only
  open from the owner's IP, WAF rule 1).

- **Names on screen:** what members see (the folder itself and the "Team folders" view) names no
  upstream product. The admin page has a few app-store texts that do (the delegation note and the
  app description); only admins see them, and the branding sweep (`docs/branding.md`) covers them.

Team folders for real teams are made by Task 6 (`docs/teams.md`) through the app's API or occ.

### occ commands

```
OCC groupfolders:create "Sales"                         # prints the new folder's id
OCC groupfolders:group <id> <group> read write share delete   # give a group access; list the rights
OCC groupfolders:group <id> <group> read                # the same group, read only
OCC groupfolders:group <id> <group> --delete            # take a group's access away (files stay)
OCC groupfolders:quota <id> 50GB                        # or: unlimited
OCC groupfolders:rename <id> "Sales team"
OCC groupfolders:list --output=json                     # all team folders, groups and rights
OCC groupfolders:list --user <uid>                      # the ones one person can see
```

`groupfolders:group` with no rights gives read only.

**Deleting a team folder deletes all its files, versions and trash.** It is never done by an
agent: it needs the owner's yes (`OCC groupfolders:delete <id>`).

### HTTP API

For Task 6. All paths are under `https://drive.nourax.org/index.php/apps/groupfolders`. Every call
sends the header `OCS-APIRequest: true` and asks for JSON (`Accept: application/json` or
`?format=json`). Only admins (or people the admins delegate in the Team folders settings) may
change anything. Bodies are form fields or JSON.

| Call | Body | What it does |
|---|---|---|
| `GET /folders` | | All team folders (admins); for others only their own |
| `GET /folders/{id}` | | One team folder |
| `POST /folders` | `mountpoint` | Make a team folder; the answer has its `id` |
| `POST /folders/{id}/groups` | `group` | Give a group access, with all rights (31) |
| `POST /folders/{id}/groups/{group}` | `permissions` (number) | Change a group's rights |
| `DELETE /folders/{id}/groups/{group}` | | Take a group's access away (files stay) |
| `POST /folders/{id}/quota` | `quota` (bytes; `-3` = no limit) | Set the size limit |
| `POST /folders/{id}/mountpoint` | `mountpoint` | Rename it |
| `DELETE /folders/{id}` | | Delete it with all its files: owner-yes only |

A folder in the answer (inside `ocs.data`) looks like
`{"id":1,"mount_point":"Sales","quota":-3,"acl":false,"size":24,"groups":{"sales":31},…}`
(`-3`: no limit).

**Errors come back with HTTP 200.** These routes answer in the old OCS style: the HTTP status is
200 and the real result is `ocs.meta.statuscode` (100 = OK, 403, 404, …) with a message in
`ocs.meta.message`. Check that field, not the HTTP status.

**Password confirmation.** Every call that changes something (all except the two `GET`s) is marked
"password confirmation required". A request signed in with an app password can't confirm a
password, so the server refuses it: `ocs.meta.statuscode` 403, "Password confirmation is
required" (tested on 2026-10-25 with a QA app password; this check runs before the admin check, so
an admin's app password gets the same answer). Two ways that work:

- **In the server (recommended for Task 6's `nourax_api` app):** call the app's own service
  `OCA\GroupFolders\Folder\FolderManager`: `createFolder($mountPoint): int`,
  `addApplicableGroup($id, $gid)`, `setGroupPermissions($id, $gid, $permissions)`,
  `setFolderQuota($id, $bytes)`, `renameFolder($id, $mountPoint)`, `getFolder($id)`,
  `mountPointExists($mountPoint)`. It isn't a public API, so check it again when the app's major
  version changes.
- **From a script on the server:** the `occ` commands above.

The browser admin page works too, because a browser session confirms the password in a dialog.

## NoTasks

To-do lists: tasks with due dates, priorities, subtasks, tags and progress. Open it from the app
menu (**NoTasks**) or at `https://drive.nourax.org/apps/tasks/`.

- **Lists are calendars.** Each list is a calendar that holds tasks (CalDAV `VTODO`). NoTasks also
  shows the tasks of every NoCalendar calendar that can hold them, and NoCalendar can show tasks
  with a due date. Lists are shared like calendars, under the same sharing rules.
- **Where they are kept:** in the database (calendar objects), not in NoDrive, so the nightly
  database backup covers them.
- **Phones:** any CalDAV app syncs them (on Android, DAVx5 with a tasks app; on iPhone,
  Reminders). The phone app signs in through the browser sign-in; the account password never goes
  into it.
- **New lists** start in Nourax cobalt (the theme colour).

**API.** NoTasks has no API of its own for tasks: it is a CalDAV client, so tasks are read and
written with CalDAV at `https://drive.nourax.org/remote.php/dav/calendars/<uid>/<list>/`, with an
app password. Tested on 2026-10-25 as `qa-t5-1`:

| Step | Request | Answer |
|---|---|---|
| A list that holds tasks only | `MKCALENDAR …/calendars/qa-t5-1/qa-t5-tasks/` with a `mkcalendar` body: `displayname`, and `supported-calendar-component-set` with only `<c:comp name="VTODO"/>` | 201 |
| One task | `PUT …/qa-t5-tasks/qa-t5-task1.ics`, `Content-Type: text/calendar`: a `VCALENDAR` with one `VTODO` (`UID`, `DTSTAMP`, `SUMMARY:QA t5 task`, `STATUS:NEEDS-ACTION`) | 201 |
| All tasks of the list | `REPORT …/qa-t5-tasks/`, `Depth: 1`, a `calendar-query` with `<c:comp-filter name="VTODO"/>` inside `VCALENDAR` | 207, with `SUMMARY:QA t5 task` |

The app's own routes under `/index.php/apps/tasks/api/v1/` hold only its view settings
(`settings`, `collections`).

## NoNotes

Notes in Markdown, with a plain or a rich editor, categories and favourites. Open it from the app
menu (**NoNotes**) or at `https://drive.nourax.org/apps/notes/`.

- **Notes are files.** Each note is a `.md` file in the folder `Notes` of the person's NoDrive
  (the app's defaults: folder `Notes`, suffix `.md`; each person can change both in the NoNotes
  settings). A category is a subfolder. So notes are in R2 and the file backups like every other
  file, have version history and trash, are checked by the virus scanner and are found by search
  inside files. Tested on 2026-10-25: a note saved through the API was found by a word of its body
  in the search box within 3 minutes, by its owner only; a note with the EICAR test text was
  refused and no file was left.
- **Sharing:** NoNotes has no sharing of its own. A note, or its category folder, can be shared as
  a file from NoDrive.
- **Not shown:** the app's "Mobile apps" badges (on the empty-notes page and in its settings) point
  to the upstream's phone apps, so `scripts/configure.d/50-apps.sh` hides them with the theme CSS.
  Phone apps that speak the Notes API still work; we just don't advertise them.

**API: Notes API v1** (v1.4 in this release) at
`https://drive.nourax.org/index.php/apps/notes/api/v1/`, JSON, with an app password:

| Call | Body | What it does |
|---|---|---|
| `GET /notes` | | All notes (`?category=`, `?exclude=content`, `?chunkSize=`, `?pruneBefore=`) |
| `GET /notes/{id}` | | One note: `id`, `etag`, `readonly`, `content`, `title`, `category`, `favorite`, `modified` |
| `POST /notes` | `title`, `content`, `category`, `favorite` | Make a note; the answer is the note with its `id` |
| `PUT /notes/{id}` | the fields to change; header `If-Match: <etag>` refuses to overwrite a newer change (412) | Change a note |
| `DELETE /notes/{id}` | | Delete a note (it goes to the NoDrive trash) |
| `GET`, `PUT /settings` | `notesPath`, `fileSuffix` | The person's folder and file suffix |

Tested on 2026-10-25 as `qa-t5-1`: `POST /notes` with `{"title":"QA t5 note","content":"hello"}`
gave id 906, `GET /notes/906` gave the content `hello`, and the file `Notes/QA t5 note.md` is in
that person's NoDrive.

Release: the brief named 6.1.0-beta.3; the app store has the stable 6.1.0 (2026-09-15, PHP 8.2 to
8.5), which is what `occ app:install` installs and what we tested.

## NoForms

Forms, surveys and polls: questions of many kinds (text, choices, dates, scales, grids, files), the
answers in one table, and an export to a spreadsheet in NoDrive (CSV, ODS, XLSX). Open it from the
app menu (**NoForms**) or at `https://drive.nourax.org/apps/forms/`.

- **Where it is kept:** forms, questions and answers are in the database. Files uploaded as
  answers go into the form owner's NoDrive.
- **Who can fill a form in:** the people, groups and teams it is shared with, and anyone with its
  public link (link sharing is on, as for files). Tested on 2026-10-25: a form's public link opens
  signed out, titled "Nourax Workspace".
- **Privacy between organisations:** two of the app's options reach every account on the server,
  in every organisation: "show to all accounts" (the form is listed in everyone's NoForms) and
  "all accounts may open it". On 2026-10-25 a form of `qa-t5-1` set to both appeared in the list of
  `qa-t5-3`, who shares no group with `qa-t5-1`. So while org privacy is on,
  `scripts/configure.d/50-apps.sh` switches both options off (app settings `forms allowPermitAll`
  and `forms allowShowToAll` = false). After that the same form was gone from `qa-t5-3`'s list,
  opening it gave 403, and setting the options on a form was refused (403). If org privacy is
  switched off, give them back with
  `OCC config:app:set forms allowPermitAll --value=true --type=boolean` (and `allowShowToAll`).
- **Known limit:** the app's share API checks only that a person or group exists; it does not apply
  the server rule "share only with your own groups". The share dialog only finds people of one's
  own organisation, so this matters only to someone who calls the API with another person's
  account id.

**API: Forms OCS API v3** at `https://drive.nourax.org/ocs/v2.php/apps/forms/api/v3/`. Every call
sends `OCS-APIRequest: true` and `Accept: application/json`; the result is in `ocs.data`. Changes
use `PATCH` with `{"keyValuePairs":{…}}`.

| Call | Body | What it does |
|---|---|---|
| `GET /forms` | | The person's own forms (`?type=shared`: forms shared with them) |
| `POST /forms` | | Make an empty form; the answer is the form with its `id` (HTTP 201) |
| `GET /forms/{id}` | | One form, with its questions, options and shares |
| `PATCH /forms/{id}` | `keyValuePairs`, for example `{"title":"…"}` or `{"access":{…}}` | Change the form |
| `POST /forms/{id}/questions` | `type` (`short`, `long`, `multiple`, `multiple_unique`, `dropdown`, `date`, `datetime`, `time`, `linearscale`, `grid`, `ranking`, `color`, `file`), `text` | Add a question |
| `POST /forms/{id}/shares` | `shareType` (0 person, 1 group, 3 link; 7 is a Teams circle, and the Teams app is off), `shareWith`, `permissions` | Share it |
| `DELETE /forms/{id}/shares/{shareId}` | | Stop a share |
| `GET /forms/{id}/submissions` | | The answers (the owner, or people given "results") |
| `POST /forms/{id}/submissions` | `answers` | Fill it in |

Tested on 2026-10-25 as `qa-t5-1`: `POST /forms` gave HTTP 201 with form id 1; a `PATCH` set its
title to "QA t5 form"; a short question was added; `GET /forms` listed `{"id":1,"title":"QA t5
form"}`. The test link share was removed again with `DELETE /forms/1/shares/1`.

## Names on screen (NoTasks, NoNotes, NoForms)

Checked on 2026-10-25:

- **Texts:** the branding sweep (`docs/branding.md`) rewrote the upstream name in their
  translations as soon as the apps were switched on: 100 texts in tasks, 286 in notes and 68 in
  forms, over 89 to 97 languages, none left (`sudo scripts/branding-sweep.sh --report --app tasks
  --app notes --app forms`). For example "Error from Nextcloud server" and "Nextcloud Forms" now
  name Nourax Workspace and NoForms. `scripts/check-branding.sh --server`: 0 hits in the l10n area.
- **Pages:** the pages are titled "Tasks - Nourax Workspace", "Notes - Nourax Workspace" and
  "Forms - Nourax Workspace", like "Files - Nourax Workspace". The page check finds nothing on them
  that the Files page does not have too (core page settings, which belong to the branding work).
- **Browser code:** three things that no translation reaches are hidden or recoloured by a CSS
  block that `scripts/configure.d/50-apps.sh` adds to the theme CSS (between `NouraxApps50:start`
  and `NouraxApps50:end`): NoNotes' "Mobile apps" store badges with their settings section and
  menu entry; NoNotes' shared-note marker, drawn in the upstream blue (now cobalt); and the colour
  picker's "Nextcloud blue" swatch. NoTasks lists start in the theme colour, not the upstream blue.
- **Admins only:** the app descriptions on the Apps page (swept too).

## Suspicious login

`suspicious_login` 13.0.0 ships with the server. `scripts/configure.d/50-audit.sh` switches it on;
it has no settings of ours.

- **What people get.** The app learns from where each person usually signs in. When someone signs
  in with a password (in the browser) from an address that does not fit, that person gets a
  notification, "New login detected": *"A new login into your account was detected. The IP address
  … was classified as suspicious by an AI model. If this was you, you can ignore this message, as
  the AI model did not take any automated actions. Otherwise, you should change your password."*
  Nothing is blocked. People who use "Log in with Nourax" change their password in NoMail.
- **E-mail:** the app also tries to send the same text by e-mail. The server has no outgoing mail
  set up yet (`mail_smtpmode` is empty), so for now only the notification arrives and the server
  log has "Could not send suspicious login email".
- **Requests with an app password** (phones, the desktop app, NoMail, the APIs) are counted for
  learning but never flagged.
- **Real addresses.** Cloudflare's `CF-Connecting-IP` header is trusted (`trusted_proxies`,
  `forwarded_for_headers`), so the app sees each person's own address, not Cloudflare's.
- **Button to a lookup site.** The notification has a button "Open iplookup.flagfox.net ↗" that
  shows where the address is. That site is not ours, and the address is in its link. To take the
  button and its sentence away: `OCC config:app:set suspicious_login show_more_info_button --value=0`.
- **Names on screen:** the notification and e-mail texts name no upstream product. Only the app's
  description on the Apps page (admins only) did, and the branding sweep rewrote it as soon as the
  app was switched on.

**When it starts warning.** Its background jobs are registered when the app is switched on:

| Job | When | What it does |
|---|---|---|
| `OCA\SuspiciousLogin\BackgroundJob\ETLJob` | every hour | Moves new sign-ins (`oc_login_address`: account, address, time) into one row per account and address (`oc_login_ips_aggregated`: how often, first and last seen), up to 10,000 per run |
| `OCA\SuspiciousLogin\BackgroundJob\TrainJobIpV4` and `…TrainJobIpV6` | once, minutes after the app is switched on; then once a day in the night window, 01:00 to 06:00 UTC (`maintenance_window_start` = 1 lets such jobs run in the hours 1 to 5) | Trains a small neural network (Rubix ML, in PHP, in the cron container) on up to 60 days of sign-ins, keeping the last 7 days to test it |

The app trains only when it has an IPv4 address first seen at least 60 days earlier, so **the first
model comes about 60 days after the app was switched on (from about 24 December 2026)**. Until then
nothing is flagged, and each night's job logs "insufficient data" at the info level, which
`nextcloud.log` does not keep.

**What is kept:** the account id, address and time of each sign-in, in the database, so also in the
nightly database backup. The raw rows are removed every hour once they are counted.

```
OCC suspiciouslogin:etl                       # count new sign-ins now (up to 25,000), if the hourly job falls behind
OCC suspiciouslogin:train --dry-run --stats   # try a training by hand; refuses while there is too little data
OCC suspiciouslogin:predict <account id> <ip> # after the first model: would this sign-in be flagged?
```

## Audit log

`admin_audit` 2.0.0 ships with the server. `scripts/configure.d/50-audit.sh` switches it on.

**What it writes:** one line of JSON per action, for every account:

- sign-ins: successful, failed, signed out, two-factor passed or failed;
- files: created, written, opened or downloaded ("accessed"), renamed, copied, deleted, restored
  from the trash, versions restored, previews;
- shares: made, changed, removed, and public links opened;
- accounts and groups: made, deleted, changed, password changed, added to or removed from a group;
- apps switched on, off or updated; tags made.

Each line has `time` (London time, `logtimezone`), `user`, `remoteAddr` (the person's address),
`method`, `url`, `userAgent` and `message`. A line written during an occ command has
`occ_command` with the command's name only, never its options.

**What it leaves out.** admin_audit writes at the info level, and the server keeps only warnings and
worse (`loglevel` 2, in `zz-nourax.config.php`). So the script sets a log condition that lets the
app's lines through, apart from two kinds:

- **occ commands** ("Console command executed: …"). Their options can hold secrets (for example,
  `configure.sh` hands the ONLYOFFICE key to occ), and the log is a plain file. What occ changes in
  accounts, groups, apps and shares is still written, through those actions' own lines.
- **"Login attempt"**. It comes before every sign-in, and each request with an app password is a
  sign-in, so it was 62% of all lines in our test. Every attempt also ends in a "Login successful"
  or "Login failed" line, and those stay.

The condition, as `OCC config:system:get log.condition --output=json` prints it (wrapped here):

```
{"matches":[{"apps":["admin_audit"],"message":"Console command executed:","loglevel":4},
            {"apps":["admin_audit"],"message":"Login attempt: \"","loglevel":4},
            {"apps":["admin_audit"],"loglevel":1}]}
```

The first match wins: level 4 (fatal only) drops a line, level 1 writes it. Other apps are not
touched. The upstream docs suggest the simpler `'apps' => ['admin_audit']`. It is not used, because
it is checked before `matches` and would let those lines through. A file whose path contains one of
the two phrases would also be left out.

**Where it is:** `/var/www/html/data/audit.log` in the app container (volume `nextcloud`), owned by
www-data, mode 0640. It is not moved with `logfile_audit`: admin_audit's rotation job does not read
that setting, so a log there would never be rotated.

**Rotation:** `log_rotate_size` is 50 MiB (the default is 100 MiB). Every 3 hours admin_audit's job
`OCA\AdminAudit\BackgroundJobs\Rotate` looks at the log: one over that size is renamed to
`audit.log.1`, replacing the older copy, and a new log starts. The server's own job does the same
for `nextcloud.log` every hour. The size is only checked when the job runs, so a log passes 50 MiB
by whatever is written in up to 3 hours before it is rotated. **How big the files get depends on
how busy the server is:**

| Audit log growth | 3 hours add | Largest `audit.log` | Both files together |
|---|---|---|---|
| 60 KB a minute | about 10 MiB | about 60 MiB | about 120 MiB |
| 400 KB a minute | about 70 MiB | about 120 MiB | about 240 MiB |

Measured on 2026-10-25 during the QA tests, with five test runs at once and after the two left-out
kinds: 5 to 150 KB a minute in quiet spells, 300 to 400 KB a minute in busy ones (1,547,302 bytes
at 11:57 UTC, 2,804,033 at 12:01) and 870 KB in the busiest minute. One test account made about 60%
of it. By size, "Login successful" (one for each request with an app password) was over 40% of the
lines, "Cache entry inserted" about a quarter. Normal use makes far fewer requests. The disk had
24 GB free. If a longer history is needed, raise the size:
`OCC config:system:set log_rotate_size --type=integer --value=<bytes>` (and the same number in
`50-audit.sh`, which otherwise sets 50 MiB again on its next run).

**Read it** (on the server; `jq` is installed there):

```
cd /opt/nourax/basic-office-infra
sudo docker compose exec -T app tail -n 50 data/audit.log | jq -c '{time, user, remoteAddr, message}'
# one person, in both files
sudo docker compose exec -T app sh -c 'cat data/audit.log.1 2>/dev/null; cat data/audit.log' \
	| jq -c 'select(.user == "<account id>") | {time, remoteAddr, message}'
# failed sign-ins
sudo docker compose exec -T app grep -h 'Login failed' data/audit.log | jq -c '{time, remoteAddr, message}'
```

- **Privacy:** it holds account ids, addresses, browser names, and file and folder names. It stays
  on the server: no screen shows it (the admin log viewer shows `nextcloud.log` only), it is not in
  the backups (`scripts/backup.sh` saves the database, config, apps and theme, not the data folder),
  and a line is gone after two rotations.
- **Lines twice:** this server version sends some events twice, so "Login successful" and "Cache
  entry inserted" can appear twice for one request. Nothing is missing.
- **Where the settings live:** `50-audit.sh` writes `log.condition` and `log_rotate_size` into
  `config.php`, not `zz-nourax.config.php`, so no container restart is needed. If someone later adds
  these keys to `zz-nourax.config.php`, that file wins at the next container start.
- **Switch it off:** `OCC app:disable admin_audit`. The log files stay.

### Tested on 2026-10-25

| Check | Result |
|---|---|
| `OCC app:list --output=json \| jq -r '.enabled.suspicious_login, .enabled.admin_audit'` | `13.0.0`, `2.0.0` |
| `OCC config:system:get log.condition --output=json` | exactly the `matches` value above. Not the upstream `{"apps":["admin_audit"]}`, on purpose: core `lib/private/Log.php` (`getLogLevel`) lets every line of an app named in a plain `apps` entry through before it reads `matches`, and admin_audit's `ConsoleEventListener` writes each occ command with all its arguments. With the plain value, the ONLYOFFICE key that `configure.sh` hands to occ would be written to `audit.log` in plain text on every run |
| `OCC config:system:get log_rotate_size` | `52428800` |
| `OCC background-job:list --class=<job> --output=json \| jq length` for ETLJob, TrainJobIpV4, TrainJobIpV6 and admin_audit's Rotate | 1 each. All four ran at 11:50 UTC, minutes after the apps were switched on (a new job runs once straight away). The training jobs found too little data; since then `oc_jobs` marks them for the night window (`time_sensitive` 0, read only), so with their 24-hour interval they next run on 27 October between 01:00 and 06:00 UTC |
| As `qa-t5-1` from the server's address: WebDAV `PUT` (201), then `GET` (200) of `audit-test.txt` | `audit.log` got "Login successful", "File with id "1126" created", "… written to", then "… accessed", each with `remoteAddr` 57.129.185.78 and the user `qa-t5-1` |
| The same after the "Login attempt" rule (`PUT` 204, `GET` 200) | the same lines; no "Login attempt" lines from then on |
| `grep -c "Console command executed" data/audit.log` after dozens of occ commands | 0 |
| A test logger with the same condition, writing to a file in `/tmp` (not the audit log) | an admin_audit line was written and an admin_audit "Console command executed" line was not; another app's info line was not, its warning was |
| `select count(*) from oc_login_address` (database, read only) | 20 rows from 3 accounts within a minute; after the hourly job, `oc_login_ips_aggregated` had `qa-t5-1` from 57.129.185.78 |
| `nextcloud.log` after the change | no new kinds of warnings or errors (one "Tried to create an object store folder that already exists", a warning that was there before the change too) |
| `sudo scripts/check-branding.sh /etc/nourax/qa/qa-t5-1.netrc --server --only l10n` | `8131 checked, 0 FAIL`, both apps' texts included |
| The app and cron containers | not recreated (started 03:31:49 UTC, before and after) |
