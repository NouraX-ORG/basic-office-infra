# NoGantt

NoGantt is the project planner in Nourax Workspace. It is the open-source app nc_Gantt
(app id `nc_gantt`, AGPL-3.0-or-later, https://codeberg.org/fds2610/NC-Gantt), release **2.4.1**,
installed and set up by `scripts/configure.d/55-gantt.sh`. Open it from the app menu (**NoGantt**)
or at `https://drive.nourax.org/apps/nc_gantt/`.

## What it does for people

| Part | What you can do |
|---|---|
| **Projects** | Plan a project with subprojects, tasks and milestones. Each project has its own colour, a planning period and its own people. |
| **Gantt timeline** | See the plan as bars on a day, week, month or sprint scale, next to a table. Drag bars to move dates, link tasks with dependencies (finish-to-start, start-to-start, finish-to-finish, start-to-finish, with lead or lag in working days). Moving a task moves the tasks that depend on it. The critical path shows which chain sets the end date. |
| **Baselines and reports** | Freeze the plan as a baseline and compare later dates with it. Progress, effort, budget and earned-value figures per project. A what-if mode tries changes without saving them. Undo puts back a move and everything it pushed along. |
| **Resources** | People (optionally linked to their Nourax account), roles, material, resource groups, weekly working patterns, holidays and capacity. Warnings show when someone is booked for more than they can do. |
| **NoBoard link** | Link a project to a NoBoard board. From a task you can create a card in that board, or link an existing card. Each project chooses how far the two talk to each other: **off**, **read** (NoGantt shows what changed on the cards), **write with confirmation** or **write** (NoGantt updates card dates, done state and people). Nothing is written to NoBoard until a project owner picks a write level. |
| **Sharing** | Share a project with a person, a group or a team as **viewer**, **editor** or **project admin**. Files attached from NoDrive are shared with the same people. |
| **Calendars and to-dos** | A calendar subscription link per project and a personal one ("my dates"). Optionally, write your own tasks as to-dos into one of your calendars (NoTasks and phone apps show them). |
| **Import and export** | JSON, CSV, Microsoft Project XML, notes or Markdown lists, NoBoard boards; export as JSON, CSV, PNG, SVG or PDF. |
| **Search** | Projects, tasks and milestones appear in the search at the top ("Projects (Gantt)"). |

Some parts only show when another app is there: Talk conversations, Netherrack knowledge links,
the Notes import and the Dashboard widgets. None of those apps is installed, so those parts stay
hidden.

## Who sees what (the settings chosen)

- **A new project is private.** Only the person who created it sees it. Others see it only after
  the owner or a project admin shares it with them, with a group they are in, or with a team they
  are in. Shares are for signed-in accounts only; leaving the group or team removes access at once.
- **Admins see every project.** Members of the `admin` group get full rights on all projects. This
  is built into the app and cannot be switched off.
- **Group shares follow the server's sharing rules**: group sharing must be allowed, and if
  "only share with members of your own groups" is on, a person can only share with groups they are
  in. Today both rules are at the server defaults (group sharing on, "only own groups" off, account
  search open). These settings belong to the whole server, so this task did not change them.
  Sharing with a single person is not limited to one's own groups by the app.
- **No public project links.** The project, its tasks and its files are never reachable without
  signing in.
- **Calendar subscription links are the one exception.** They work without signing in, so that
  phone and desktop calendar apps can subscribe. Each link holds a 64-character random key and shows
  only titles, dates and a link back to NoGantt (which needs signing in); no descriptions, people or
  files. A project link is made only when a project admin opens the project's calendar dialog, a
  personal link only when its owner asks for one, and either can be renewed (the old link stops). The app has no setting to
  turn them off, so a Cloudflare rule that closes them for everyone is ready for the owner (see the
  result of Task 5b; it is not applied yet).
- **Notifications** for due dates, assignments and date changes are on, with one day's notice; each
  person can mute them in their personal settings. Activity entries are on; activity emails are off.
- **Working time** stays at the app defaults: 09:00 to 17:00, 8 hours per person-day.

## Nourax names and colours

- The app menu label is **NoGantt** (`config/nextcloud/app-labels.d/55-gantt.conf`).
- The app calls itself "nc_Gantt" and some of its texts name the upstream server. NoGantt overrides
  those texts with Nextcloud's theme mechanism: `55-gantt.sh` sets the theme folder `nourax` (only
  when no theme is set yet) and writes translation overrides into
  `themes/nourax/custom_apps/nc_gantt/l10n/` (read by the server) and
  `themes/nourax/nc_gantt/l10n/` (read by the browser) for English, British English and the app's
  six languages. The overrides are rebuilt from the installed app on every run of
  `scripts/configure.sh`, so they follow app updates. Replacements: "nc_Gantt"/"NC-Gantt" become
  "NoGantt", the calendar and tasks apps become NoCalendar and NoTasks, "your Nextcloud" becomes
  NoDrive, and any other mention becomes "Nourax". The page title reads "NoGantt - Nourax Workspace".
- Projects without a chosen colour get the upstream brand blue. A small block at the end of the theme
  CSS shows Nourax cobalt (`#2563EB`) instead, in the bars, colour dots and colour swatches.

Known leftovers (they cannot be changed without editing the app's code):

- A card created from a task gets the description line "Geplant in nc_Gantt: <link>" (fixed German
  text, not translatable). It names the app, not the server; people can edit it.
- Exports (PNG, SVG, PDF) of a project that kept the default colour may show the upstream blue.
- The Apps page for admins shows the app's store name and description.

## Install and update

The app comes from the release archive pinned in `55-gantt.sh` (version, URL and SHA-256). The
script downloads it, checks the SHA-256 and that the archive holds only the `nc_gantt/` folder,
unpacks it into `custom_apps` and enables it. Run again, it changes nothing. The archive was
reviewed before use: it needs no extra service, licence key or account; it makes no calls to
outside servers (no telemetry, update checks, web fonts or CDNs; its only HTTP call is to this
server's own Talk, which is not installed); it adds two small background jobs (reminders hourly,
calendar to-dos every 15 minutes); the NoBoard link runs inside the server as the signed-in person,
through NoBoard's own permission checks. Its app store signature was checked against the archive.

**Why 2.4.1, not 2.4.0:** 2.4.1 is the current stable release for Nextcloud 31 to 35. It adds
sharing with groups and teams (2.4.0 can only share with single people), and fixes undo after
dependency moves and the export of roles.

**Updating NoGantt**

1. Read the new release's changelog, `appinfo/info.xml` and source for new outside calls, services
   or public pages, the same way as above.
2. Under the deploy lock: `sudo docker compose exec -T -u www-data app php occ app:update nc_gantt`
   (or `sudo scripts/update.sh --apps`, which updates every store app). The app store checks the
   download's signature.
3. Put the new version, archive URL and SHA-256 into `55-gantt.sh` so a rebuild installs the same
   release, and commit.
4. Under the deploy lock, run `sudo scripts/configure.sh` to rebuild the NoGantt wording. Until then
   it logs a note that the installed version differs from the pinned one.

The app's own data lives in the database tables `oc_nc_gantt_*`; the normal database backup covers
it.
