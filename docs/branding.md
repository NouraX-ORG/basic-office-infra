# Branding

Nourax Workspace is built on Nextcloud, but no screen a person can see may show the Nextcloud name,
its logo, its blue (`#0082c9`, `#00679e`) or links to nextcloud.com, apps.nextcloud.com,
docs.nextcloud.com or github.com/nextcloud. Nextcloud is credited in the repo only (NOTICE.md,
README and these docs).

## Text sweep

Every text people can read that comes from a translation file of core, lib or an enabled app is
rewritten: "Nourax Workspace" where the upstream name means the site or product, "NoDrive" where it
means files, the product names below where it names an app. This covers every language, including
"English (US)" (`en`, which has no translation file of its own), and both the texts the server writes
into pages and e-mails and the texts the browser shows. ONLYOFFICE keeps its own name.

**How it works.** `'theme' => 'nourax'` in config.php switches on the theme folder `themes/nourax` in
the Nextcloud folder (on the persistent volume; the integrity check skips it). Nextcloud 35 reads
translation overrides from there:

- the server loads `themes/nourax/<l10n folder>/<lang>.json` after the app's own file and merges the
  two, for example `themes/nourax/apps/settings/l10n/de.json`. The sweep writes only the texts that
  change into it;
- the browser loads one file per app and language and takes the theme's first, so
  `themes/nourax/<app>/l10n/<lang>.js` (core: `themes/nourax/core/core/l10n/<lang>.js`) is a full copy
  of the app's translations with the changes in it.

The `nourax_branding` app builds these files from the installed translation files
(`occ nourax_branding:sweep`, code in `nextcloud-apps/nourax_branding/lib/Service/`). For each text:

1. links to upstream addresses lose the address and keep their text; bare upstream addresses go;
2. the phrases in `sweep/rules.json` run, for example:

   | Upstream text | Becomes |
   |---|---|
   | Nextcloud Files (also "Nextcloud Dateien") | NoDrive |
   | Nextcloud Calendar, Contacts, Deck, Tasks, Notes, Forms | NoCalendar, NoContacts, NoBoard, NoTasks, NoNotes, NoForms |
   | Nextcloud Assistant | Nourax AI |
   | Nextcloud Talk, Office, Mail, Text, Teams, Flow, Photos | the app name alone |
   | Nextcloud desktop, mobile, Android, iOS, sync client | NoDrive desktop, mobile, ... |
   | #Nextcloud | #NouraxWorkspace |
   | user@your-nextcloud.org (in any language) | user@drive.nourax.org |
   | Nextcloud Hub 27 Winter, "(Nextcloud <= 9)" | Nourax Workspace; left out |
   | Nextcloud Enterprise | "an enterprise subscription" in English, "Enterprise" elsewhere |
   | `{productName} iOS app`, `{productName} Android app` | NoDrive iOS app, NoDrive Android app |

3. every other spelling of the name becomes "Nourax Workspace": every case, misspellings such as
   "Nexcloud", and the spellings in other scripts (Arabic, Persian, Serbian, Mongolian, Hindi and
   more, all listed in `name_patterns`). A word ending stays after a hyphen ("Nextcloudhoz" becomes
   "Nourax Workspace-hoz").

A text that names the upstream but has no translation in a language would show its English source
text there, so it gets the swept English text. Sentences a word swap cannot fix have curated texts in
`sweep/en-overrides.json`: "english" for `en` and `en_GB`, "every_language" for the upstream's own
notices (for example about its free push service), which would otherwise speak as the upstream.
Placeholders such as `{productName}` and `%s` are never changed.

Translations that another step wrote into the theme folder first (the NoGantt wording of
`scripts/configure.d/55-gantt.sh`) are kept, and the sweep builds on top of them. Each file the sweep
writes carries a `nouraxSweep` marker with a digest, so it can tell its own files from those.

With theme files for core, Nextcloud would list every language twice in the language menu; the
`nourax_branding` app removes the doubles from that menu.

**When it runs.** By itself, so nobody has to remember it:

- `sudo scripts/configure.sh` runs it (`scripts/configure.d/20-branding.sh` calls
  `scripts/branding-sweep.sh`, which also sets the theme);
- switching an app on or updating it (`occ app:enable`, `app:install`, `app:update`, `occ upgrade`,
  the Apps page) sweeps that app at once;
- a background job compares `themes/nourax/sweep-state.json` (server version, rules, every enabled app
  and its version) with what is installed every 15 minutes and sweeps what changed: a new image, an
  app added in some other way, or new rules after a `git pull`.

A file is written only when its content changes, always in one step, and nothing is ever deleted; a
second run writes nothing. Each change raises the theming cache buster, so browsers fetch the new
files.

**By hand.** `sudo scripts/branding-sweep.sh` sweeps everything now; `--report` also lists, per app,
the notes and every translation that leaves the name out or spells it in a way the rules do not
know. Add a new spelling to `name_patterns` in `sweep/rules.json` (the guard reads the same list),
then run the sweep again. Check the result with
`sudo scripts/check-branding.sh /etc/nourax/qa/qa-t3-1.netrc --server --only l10n`. The rules have
their own tests:
`sudo docker compose exec -T -u www-data app php /var/www/html/nourax_apps/nourax_branding/tests/run.php`.

**Undo.** `occ config:system:delete theme` switches the overrides off; the files stay and do nothing.

## Apps and their upstream branding

Every app that is switched on was checked for the upstream name and links in its texts (en_GB
translations), its shipped scripts and templates, its app-menu entry and its Personal settings.
Checked on 2026-10-25 against Nextcloud 35.0.2.

Each app gets one of three answers:

- **Off**: switched off. It shows the upstream name and does nothing for Nourax.
  `scripts/configure.d/20-branding.sh` switches these off each time `sudo scripts/configure.sh` runs.
  Switching an app off keeps its data, and an upgrade does not switch it back on.
- **Keep, fix**: it is needed, and its upstream texts or links are fixed in place:
  - *text sweep*: `scripts/branding-sweep.sh` rewrites the upstream name in the translations of every
    app that is switched on ("Nourax Workspace" for the site, "NoDrive" for files);
  - *links and assets*: settings, theme template overrides and CSS that hide or replace upstream
    links, logos and pictures.
- **Keep**: no upstream branding on any screen.

After adding or updating an app, run `scripts/check-branding.sh` and add or change its row here.

### Switched off

| App | Version | What people saw | Why it is off |
|---|---|---|---|
| `office` | 1.1.0 | "Office" in the app menu: an overview page of the upstream office suite. | The owner approved switching it off. Documents are made from the NoDrive "New" menu. |
| `privacy` | 7.0.0 | Personal settings > Privacy: the upstream mission text ("We at Nextcloud believe…"), the User Data Manifesto, and links to nextcloud.com/yourdata and the upstream blog. | It only shows these pages. Its one table (extra admin names for the "who has access" box) is empty, and no other app needs it. Rewording it would make the upstream's promises sound like Nourax's. Its old address, `/settings/user/privacy`, now sends people to Personal settings > Profile and contact: the nourax_branding app does that for any Personal settings address with nothing on it. |

`scripts/configure.sh` already switches off the upstream intro, news, survey, support and update apps,
the Dashboard, Weather status and External Apps (`firstrunwizard`, `nextcloud_announcements`,
`survey_client`, `support`, `updatenotification`, `dashboard`, `weather_status`, `app_api`).

### Kept, with a fix

"Always on" means Nextcloud does not let the app be switched off.

| App | Version | Upstream branding found | Fix |
|---|---|---|---|
| core (the app menu) | 35.0.2 | An "App store" tile at the end of the app menu of people who are not admins. It opens apps.nextcloud.com in a new tab. It is part of Nextcloud itself, not of the `appstore` app, and shows while the core setting `appstore_link_shown` is unset. | `scripts/configure.d/20-branding.sh` sets `appstore_link_shown` to false, which hides only this tile. Admins still install and update apps from Administration > Apps. |
| `deck` (NoBoard) | 1.19.1 | A welcome board is made on a person's first visit. Its title, "Welcome to Nextcloud Deck!", is a translation, but its card texts come from a fixed file inside the app and name the upstream 15 times. | The text sweep renames the title. The card texts need more: the nourax_branding app should set the person's Deck setting `firstRun` to `no` when the account is made, so no welcome board is made. Boards that already exist are people's data and stay. |
| `federatedfilesharing` | 2.0.0 | Personal settings > Sharing: the Federated Cloud ID, "Share with me via Nextcloud" and a link to nextcloud.com/sharing; "Add to your Nextcloud" on public share pages. | Always on. Links and assets: turn federation off. |
| `settings` | 2.0.0 | 40 texts with the upstream name, the Help page, the developer notice, the "Reasons" PDF button, links to docs.nextcloud.com. | Always on. Text sweep, plus links and assets (theme template overrides and CSS). |
| `theming` | 3.0.0 | Accessibility paragraph links; two backgrounds in the picker credited to "Nextcloud GmbH"; "Adjust the Nextcloud theme". | Always on. Links and assets (CSS), text sweep. |
| `dav` | 2.0.0 | The page shown when `/remote.php/dav` is opened in a browser; the sample calendar event; some error texts. | Always on. Links and assets (a page plugin), text sweep. |
| `circles` (Teams) | 35.0.0 | 8 texts, for example "Nextcloud Account". | Text sweep. |
| `calendar` (NoCalendar) | 6.6.3 | 4 texts, mostly the app description. | Text sweep. |
| `contacts` (NoContacts) | 8.9.2 | 4 texts, mostly the app description. | Text sweep. |
| `text` | 9.0.1 | "Nextcloud Text", "Nextcloud Assistant". | Text sweep ("Nourax AI" for the Assistant). |
| `files_sharing` | 2.0.0 | 4 texts about sending share passwords by "Nextcloud Talk" (Talk is not installed). | Text sweep. |
| `user_oidc` | 8.11.0 | Sign-in error texts such as "You must access Nextcloud with HTTPS to use OpenID Connect." | Text sweep. |
| `onlyoffice` | 10.2.1 | App descriptions only. ONLYOFFICE keeps its own name. | Text sweep. |
| `activity` | 8.0.0 | The app description; Activity texts and e-mails are checked with the e-mail templates. | Text sweep. |
| `workflowengine` (Flow) | 3.0.0 | People see Personal settings > Flow. The upstream developer link and the app store button show to admins only. | Always on. Text sweep (description). |
| `groupfolders` (Team folders) | 23.0.1 | 5 texts, on the admin page and in descriptions. | Text sweep. |
| `files_lock`, `files_pdfviewer`, `viewer`, `cloud_federation_api`, `provisioning_api`, `password_policy` | 35.0.1, 8.0.0, 8.0.0, 2.0.0, 2.0.0, 7.0.0 | One description or admin text each. | Text sweep. `viewer`, `cloud_federation_api` and `provisioning_api` are always on. |

Admin pages only (people never see them; admin pages are not part of the user check):

| App | Version | Upstream branding found | Fix |
|---|---|---|---|
| `appstore` | 2.0.0 | Administration > Apps: the "More apps" tile links to apps.nextcloud.com; "Nextcloud Appstore". The "App store" tile in the app menu of people who are not admins is not part of this app: see the core row above. | Always on. Links hidden by CSS, text sweep. |
| `settings` (Administration overview) | 2.0.0 | A release name written into a template, "Nextcloud Hub 26 Summer". | Links and assets (theme template override). |
| `notifications` | 8.0.1 | Notices about the upstream's free push service limits, with links to nextcloud.com. | Text sweep; the links show to admins only. |
| `serverinfo`, `logreader`, `bruteforcesettings` | 7.0.0, 8.0.0, 8.0.0 | Links to docs.nextcloud.com and descriptions. | Links hidden by CSS, text sweep. |
| `webhook_listeners` | 2.0.0 | "Nextcloud Webhook Support" and other descriptions. | Text sweep. |
| `files_antivirus` | 6.5.0 | "An antivirus app for Nextcloud" (description). | Text sweep. |
| `theming_customcss` | 1.22.0 | "Adjust the Nextcloud theme with custom CSS" (description). | Text sweep. |

### Kept, nothing to fix

No upstream name or link on any screen. Links to github.com/nextcloud inside these apps' scripts are
code comments, and links in command-line tools are not shown to people.

| App | Version | Note |
|---|---|---|
| `files` (NoDrive) | 3.0.0 | Always on. |
| `photos` | 8.0.0 | |
| `comments`, `contactsinteraction`, `federation`, `files_downloadlimit`, `files_reminders`, `files_trashbin`, `files_versions` | 2.0.0, 2.0.0, 2.0.0, 5.3.0, 2.0.0, 2.0.0, 2.0.0 | |
| `oauth2`, `profile`, `sharing` | 2.0.0, 2.0.0, 1.0.4 | Always on. |
| `recommendations`, `related_resources`, `sharebymail`, `systemtags`, `user_status` | 8.0.0, 6.0.0, 2.0.0, 2.0.0, 2.0.0 | |
| `twofactor_backupcodes`, `twofactor_totp` | 2.0.0, 17.1.0 | `twofactor_backupcodes` is always on. |
| `nc_gantt` (NoGantt) | 2.4.1 | Shown as NoGantt (docs/gantt.md). |
| `nourax_api`, `nourax_antivirus`, `nourax_branding` | 1.0.0 | Nourax's own apps. |
| `lookup_server_connector` | 2.0.0 | Always on, no screen. `'lookup_server' => ''` in `config/nextcloud/zz-nourax.config.php` stops its calls. |
