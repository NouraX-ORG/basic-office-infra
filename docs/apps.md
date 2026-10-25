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
