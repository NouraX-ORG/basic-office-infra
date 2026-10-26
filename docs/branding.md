# Branding

Nourax Workspace is built on Nextcloud, but no screen a person can see may show the Nextcloud name,
its logo, its blue (`#0082c9`, `#00679e`) or links to nextcloud.com, apps.nextcloud.com,
docs.nextcloud.com or github.com/nextcloud. Nextcloud is credited in the repo only (NOTICE.md,
README and these docs).

This page has the naming rules, how the sweep that keeps the upstream name off people's screens
works, how to run it and its guard again, how to undo each change, and the exceptions.

## Naming rules

| What people see | Its name |
|---|---|
| The site and the product as a whole: page titles, the login page, e-mails, the web app's name, "your …" | **Nourax Workspace** |
| Files: folders, share links, WebDAV, and the desktop and phone apps for files once they ship | **NoDrive** ("NoDrive desktop", "NoDrive iOS app") |
| Calendar | **NoCalendar** |
| Contacts | **NoContacts** |
| Deck (boards and cards) | **NoBoard** |
| Tasks | **NoTasks** |
| Notes | **NoNotes** |
| Forms | **NoForms** |
| Gantt | **NoGantt** ([docs/gantt.md](gantt.md)) |
| The mail link in the app menu, after NoBoard (opens `https://mail.nourax.org` in a new tab) | **NoMail** |
| The Assistant | **Nourax AI** |
| Group folders | **Team folders** |
| The office editors | **ONLYOFFICE** keeps its own name, in the app menu and inside the editors |
| Other apps (Photos, Activity, Text, Flow and so on) | A plain word for what they do, never with the upstream name in front |

Rules for every new text, page, e-mail, picture or app, in every language:

- Never write the upstream name, in any case, spelling or script, and never show its logo or its two
  blues. Use the Nourax colours (cobalt `#2563EB`, light `#3B82F6`, accent `#F97316`/`#EA580C`) and
  the Nourax logo as it is (`branding/nourax-logo.png`, never recoloured or redrawn).
- Never link to an upstream website: nextcloud.com and its subdomains, apps.nextcloud.com,
  docs.nextcloud.com, github.com/nextcloud, the upstream's translation project, social media or app
  store pages. Help links go to our own help page, `/apps/nourax_branding/help`.
- Where a text must say what Nourax Workspace is built on, it says "open-source software" and links
  our own repo, github.com/NouraX-ORG/basic-office-infra, as the notice on the Profile page does.
- A product that is not in the table above gets its name from the owner first.
- The names in the app menu come from `APP_LABELS` in `scripts/configure.sh` and the files in
  `config/nextcloud/app-labels.d/`. The site's name is the theming name and the theming
  `productName`, both "Nourax Workspace" (`scripts/configure.sh`).
- Plain English. Everything a task adds must pass `scripts/check-branding.sh` (see *Running the
  guard*).

## Trademark summary

- Nextcloud is a trademark of Nextcloud GmbH; ONLYOFFICE is a trademark of Ascensio System SIA.
- We credit Nextcloud in NOTICE.md and the README only, and we never use its name or logo as our
  brand: not on a screen, in an e-mail, in a page title or in a link. Other docs in this repo, this
  one included, name it only to say what was changed and why.
- NOTICE.md lists the software Nourax Workspace is built from, with its licences and sources, as the
  licences ask. The README says Nourax Workspace is an independent deployment that is not affiliated
  with or endorsed by the authors of that software.
- ONLYOFFICE is the one outside name people see, as the name of the document editors.
- Licence texts stay where a licence asks for them (see *Exceptions*).

## How the sweep works

Every text people can read that comes from a translation file of core, lib or an enabled app is
rewritten: "Nourax Workspace" where the upstream name means the site or product, "NoDrive" where it
means files, the product names of *Naming rules* where it names an app. This covers every language, including
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
  of the app's translations with the changes in it. It starts from the app's own `.js` file, whose
  texts are not always the same as its `.json` file (onlyoffice's `ja.js` has texts its `ja.json`
  lacks), and sweeps those too.

**Why the two differ** (Nextcloud 35.0.2 source, read on the server on 2026-10-26):

- On the server, `OC\L10N\Factory::getL10nFilesForApp()` lists the app's own `<lang>.json` and then
  the theme's file of the same name. `OC\L10N\L10N` loads them in that order and merges them
  (`array_merge`), so a text in the theme's file wins and every other text stays the app's. A small
  file with only the changed texts is enough.
- In the browser, `OC\Template\JSResourceLocator::doFind()` looks for a translation script in a
  fixed order: `core/<app>/l10n`, the theme's `core/<app>/l10n`, `<app>/l10n` under the server
  folder, the theme's `<app>/l10n`, the app's own folder, then the theme's `apps/<app>/l10n`. The
  places are joined with `||`, so it stops at the first file it finds; its code comment says it loads
  them all, but it does not. For an app the first file found is the theme's `<app>/l10n/<lang>.js`,
  and for core it is the theme's `core/core/l10n/<lang>.js`. Only that one file reaches the browser,
  so it must hold every text of the app. A file with only the changed texts would leave all the
  others in English.

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
   "Nexcloud" or "Nextclouod", and the spellings in other scripts (Arabic نكست كلاود and ناكست كلاود,
   Persian, Serbian, Mongolian, Hindi and more, all listed in `name_patterns`). A word ending stays
   after a hyphen ("Nextcloudhoz" becomes "Nourax Workspace-hoz");
4. last, spellings nobody has listed yet: `near_name` in `sweep/rules.json` finds any Latin word
   that starts with something at most two letters away from the name (a letter added, dropped,
   changed, or two letters swapped: "Nextclaud", "Nexrcloud"). These are replaced too, and `--report`
   lists them so they can be added to `name_patterns`. A scan of every translation on the server
   (9,543 files, 2026-10-25) found no ordinary word that close; at three letters away, words such as
   "exclude" turn up, so the distance stays at two. The Arabic loanword كلاود ("cloud") is used only
   in the name, so it is a name pattern too (`arabic-cloud`): it is never replaced, but a new Arabic
   spelling of the name in front of it shows up in the report and in the guard.

A text that names the upstream but has no translation in a language would show its English source
text there, so it gets the swept English text; so does an empty translation. Sentences a word swap
cannot fix have curated texts in `sweep/en-overrides.json`: "english" for `en` and `en_GB`,
"every_language" for the upstream's own notices (for example about its free push service), which would
otherwise speak as the upstream, and "by_language" for one language whose translation leaves our name
out where it belongs (Arabic "Failed to add the public link to your Nextcloud" says "your cloud
server"; it now says "your Nourax Workspace"). Placeholders such as `{productName}` and `%s` are never
changed.

**The rule files** are in `nextcloud-apps/nourax_branding/sweep/`. The sweep, the guard and the browser
audit all read them, and each file starts with an `about` list that explains it.

- `rules.json`:
  - `name_patterns`: one `{id, re, note}` per spelling of the name. Each `re` must work in Python,
    PHP and JavaScript (its `about` says how). The ids in `sweep.generic_skip` are found but never
    replaced;
  - `near_name`: the likeness check for spellings nobody has listed yet (`word`, `max_distance` 2,
    `min_length`, `max_length`);
  - `sweep`: `product` (the text that replaces the name, "Nourax Workspace"); `phrases`, each
    `{re, to, note, langs}`, run top to bottom before the name patterns (`langs` is `en`, `other` or
    left out for every language); `key_rules`, each `{app, key, from, to}`, one change inside one exact
    text of one app; `keep`, words that are never changed (ONLYOFFICE);
  - for the guard and the browser audit: `link_patterns` (upstream addresses), `asset_patterns`
    (upstream logo paths), `blue_patterns`, `upstream_files` and `upstream_pictures` (upstream
    pictures, found by their bytes), `backgrounds_off`, `customclient_keys` and `upstream_ios_appid`,
    `apps_off` (apps that must stay off), and `allow` (exceptions for the guard, each
    `{area, url, where, snippet, why}`; empty today);
  - `sweep_state`: where the sweep's state file is and what it holds.
- `en-overrides.json`: whole sentences, as app id, then the exact English source text, then the text
  people see instead. `english` is used for `en`, `en_GB` and the other English variants,
  `every_language` for every language, and `by_language` (language, then app id, source text and
  text) for one language; `by_language` wins over the other two. A plural text takes a list
  `[one, many]`.

After a change to either file, run the sweep, the rule tests and the guard (see *Running the sweep
again after updates*).

A translation file that starts with a byte order mark (onlyoffice's `eu.json`) cannot be read by
Nextcloud, which then shows that language in English. The sweep reads it all the same and writes every
one of its texts into the theme file, so Basque people see Basque, without the name.

Translations that another step wrote into the theme folder first (the NoGantt wording of
`scripts/configure.d/55-gantt.sh`) are kept, and the sweep builds on top of them. Each file the sweep
writes carries a `nouraxSweep` marker with a digest, so it can tell its own files from those.

With theme files for core, Nextcloud would list every language twice in the language menu; the
`nourax_branding` app removes the doubles from that menu.

**The listener and the 15-minute job.** The sweep runs by itself, so nobody has to remember it:

- `Listener/AppChangeListener.php` listens for `AppEnableEvent` and `AppUpdateEvent`. Switching an
  app on or updating it (`occ app:enable`, `app:install`, `app:update`, `occ upgrade`, the Apps page)
  sweeps that app at once.
- `BackgroundJob/RefreshSweep.php` runs every 15 minutes, as a time-sensitive background job of the
  cron container. It compares `themes/nourax/sweep-state.json` (the server version, a digest of
  `rules.json`, `en-overrides.json` and the sweep's own version, and every enabled app with its
  version) with what is installed, and sweeps what changed: a new image, an app added in some other
  way, or new rules after a `git pull`. When nothing changed, it only reads that one file.
- `sudo scripts/configure.sh` runs it too: `scripts/configure.d/20-branding.sh` calls
  `scripts/branding-sweep.sh`, which also copies the theme files and switches the theme on.

A file is written only when its content changes, always in one step, and nothing is ever deleted; a
second run writes nothing. Each change raises the theming cache buster, so browsers fetch the new
files.

## Links and assets

Nothing a person can click may lead to an upstream website (nextcloud.com and its docs, apps, help
and newsletter sites, github.com/nextcloud, the upstream's social media and app store pages), and no
page may show the upstream logo, icon or blue. Checked against Nextcloud 35.0.2 on 2026-10-25. Four
parts do it; all of them come back by themselves when `sudo scripts/configure.sh` runs.

**Settings** (`scripts/configure.d/20-branding.sh`):

| Setting | What it hides or changes | Undo |
|---|---|---|
| `customclient_desktop`, `customclient_android`, `customclient_ios`, `customclient_fdroid`, `customclient_ios_appid` set to `""` | The upstream's download page and app store links (the welcome e-mail's "Install Client" button, the page setting `syncClientUrl`), and the upstream iOS app banner (`<meta name="apple-itunes-app">`) on every page. | Set our own addresses when the NoDrive apps ship (`handoffs/2026-10-25-workspace-to-nodrive-clients.md`); `customclient_ios_appid` is the App Store id. |
| theming `docBaseUrl` = `https://<drive host>/apps/nourax_branding/help` | Every help link Nextcloud builds (`<docBaseUrl>/server/35/go.php?to=<topic>`): Security, Sharing and the other settings pages, the page settings `docBaseUrl` and `docPlaceholderUrl`. | `occ config:app:delete theming docBaseUrl` |
| core `appstore_link_shown` = false | The "App store" tile of the app menu (see the core row below). | `occ config:app:delete core appstore_link_shown` |

`knowledgebaseenabled` is false (no Help entry in the user menu) and `simpleSignUpLink.shown` is false
(no upstream sign-up link on public pages); both were set before this sweep. Sharing with other
servers (federation) belongs to privacy between organisations (`scripts/configure.d/60-org-privacy.sh`,
docs/teams.md); the branding holds with it on or off.

**The nourax_branding app** (`nextcloud-apps/nourax_branding`):

- *Help page* (`Controller/HelpController.php`, public): `/apps/nourax_branding/help` and every address
  below it say, in the person's language (English, German, Arabic), that our help pages are on their
  way and to ask the person who looks after their account, with "Back to NoDrive". `/settings/help`,
  which upstream fills with links to its manual and forum, now leads there.
- *WebDAV page* (`Dav/BrandedGetPlugin.php`): opening `/remote.php/dav`, `/remote.php/webdav` or a
  folder below them in a web browser shows "This is the WebDAV address of NoDrive. Open it in a WebDAV
  client, such as a file manager or a sync app, not in a web browser." and a link to the site, as a
  small page in the person's language (right to left in Arabic), instead of the upstream text that
  names its desktop client. It answers just before the upstream's
  own answer (Sabre priority 199 against 200), after everything that serves files, zip downloads,
  calendar exports and contact photos, so those still work.
- *Fixes in other apps' answers* (`Middleware/UpstreamPagesMiddleware.php`, rules in
  `Service/UpstreamAssets.php`, tested by `tests/run.php`):
  - the theming app's manifests (`/apps/theming/manifest/<app>`) get the text sweep: their summaries
    come from the apps' info.xml files ("A Calendar app for Nextcloud"), which no translation holds;
  - the theming stylesheets (`/apps/theming/theme/<theme>.css`): the upstream blue (`#00679E`, also
    `#0082c9`) becomes the Nourax cobalt `#2563EB`; Nextcloud 35 uses it in the Assistant gradient;
  - Appearance and accessibility: the two backgrounds credited to "Nextcloud GmbH" (Fluid, Globe) are
    left out of the picker, and so are those mostly in the upstream blue, listed in `rules.json`
    `backgrounds_off`: Clouds (55% of its pixels; the upstream's old default background), Underwater
    ocean (32%), Waxing crescent moon (4.5%), and Globe and Fluid again (74%, 52%). The browser audit
    found them; `tests/run.php` measures every shipped background the same way, so one a later version
    adds fails the tests until it is listed. The other 16 stay. On 26 October nobody had chosen any
    of these; a background someone chose before stays theirs;
  - Sharing (when federation is on): the "share it" buttons point at our help page;
  - `/settings/download/reasons`, the upstream's "Reasons to use Nextcloud" PDF, answers 404.
- *Theme previews* (`js/theme-previews.js`, `img/theme-previews/`): Personal settings > Appearance and
  accessibility shows a picture of each theme. The theming app builds their addresses in the browser
  (`/apps/theming/img/<theme id>.jpg`), and the upstream pictures show the upstream logo and, for the
  four themes, a header in the upstream blue. On that page only, the app's middleware gives the page
  the addresses of our own pictures (initial state `nourax_branding` / `theme_previews`) and the small
  script, which puts our picture of the same theme in place of each upstream one as soon as the
  theming app adds it to the page. The browser still downloads the seven upstream pictures, because
  the theming app asks for them before the script can step in, but they are never kept on the page or
  drawn (QA checked this on 26 October by watching every change to the page and every frame drawn).
  A theme with no picture of ours (one a later version adds) has its picture hidden
  instead; `tests/run.php` and `scripts/check-branding.sh` then fail and name it. Our pictures are a
  NoDrive page in each theme (light, dark, high contrast light and dark, and light and dark side by
  side for "System default"), drawn with plain shapes and no words so they suit every language, with
  the Nourax logo as it is, only smaller; "Reduced motion" is a ball that has stopped, and "Dyslexia
  font" a line of text in that font, as upstream. `branding/theme-previews/make-previews.py` draws
  them (Pillow; `--font` is the theming app's `fonts/OpenDyslexic-Regular.otf`, SIL OFL 1.1); run it
  again after changing it and commit the pictures. The upstream files stay where they are and are
  never shown.
- *Letter avatars* (`Middleware/AvatarColourMiddleware.php`): a person without a picture of their own
  gets their initials in one colour on a light (dark theme: dark) tint of it. Nextcloud 35 picks the
  colour from the display name out of 18, and one of the 18 is the upstream blue `#0082C9` itself, so
  one name in 18 got it (on 26 October: 4 of 131 accounts, all QA accounts of other tasks). The app
  redraws exactly those avatars in Nourax cobalt, letters, smooth edges and tint alike, where core
  answers them (`/avatar/<user>/<size>`, `.../dark`, and the guest avatars); every other avatar, and
  every picture people chose, goes out as core made it. A redrawn avatar is cached for a day. The
  initials the browser draws itself (contacts, e-mail guests) get the same colour from
  `branding/custom.css`.
- *No NoBoard welcome board* (`Listener/NewAccountListener.php`): see the deck row below.
- *Example contact* (`Service/ExampleContact.php`, `occ nourax_branding:example-contact`, run by
  `scripts/configure.d/20-branding.sh`): every new address book gets one example card, and NoContacts
  opens it on a person's first visit. The dav app's own card, "Leon Green", has the upstream website.
  The command puts the Nourax copy in place as the dav app's default contact
  (`defaultContact/defaultContact.vcf` in its app data, and `hasCustomDefaultContact`): the same card
  and photo, with its website on `https://example.com`, the reserved example address its e-mail
  (`leon@example.com`) already uses; any other line that named the upstream would be left out. A
  card an admin chose under Administration > Groupware > Example content is kept if it does not name
  the upstream. `--check` only reports. Undo: "reset" on that admin page.
- *Calendar colours* (`Listener/CalendarColourListener.php`, `Service/CalendarColours.php`): NoTasks
  (Tasks 0.18.1) makes a person's first task list in `OCA.Theming.color`, which Nextcloud 35 no longer
  has (it is `primaryColor` now), so the list fell back to the upstream blue `#0082C9`, in NoTasks and
  in NoCalendar's task lists. Every calendar the dav app makes in an upstream blue (`#0082c9` or
  `#00679e`, with or without alpha) now gets the site's main colour (cobalt `#2563EB`, alpha kept) right
  after it is stored, before the answer; NoTasks reads the list back from the server, so it never
  shows the blue. Any other colour is left alone.
- *Right to left when signed out* (`Middleware/PageDirectionMiddleware.php`): Nextcloud 35 sets
  `dir="rtl"` only on signed-in pages, so in Arabic (and Persian, Hebrew, Pashto, Uyghur, Urdu) the
  login page, the public share pages and the other guest pages ran left to right. The app gives their
  `<body>` the same `dir="rtl"`; `branding/custom.css` sets `direction: rtl` for the few error pages
  core draws without the app framework. Found by the browser audit.

**Theme files** (`branding/theme`, copied as they are into `themes/nourax` by
`scripts/branding-sweep.sh`; Nextcloud 35 looks there first for pictures and app templates):

- `core/img/manifest.json`: the web app manifest of every page ("Nourax Workspace", start page `/`,
  our icon from the theming app, cobalt `#2563EB` on `#0B1220`). Upstream sign-in, public and error
  pages linked the core file, named "Nextcloud", with the upstream icon. Because Nextcloud looks in the
  theme before it asks the theming app, signed-in pages use this one too; it replaces the per-app
  manifests, which are still fixed (above) for anyone who opens them.
- `core/img/favicon-mask.svg`: the Safari pinned-tab icon of every page, a plain rounded square in one
  colour (the browser fills it with our cobalt). It is not the logo: the logo is never redrawn.
- `apps/settings/templates/settings/personal/development.notice.php`: the notice at the end of
  Personal settings > Profile and contact. Upstream it links the upstream community, GitHub, Facebook,
  Bluesky, Mastodon, blog and newsletter and offers a "Reasons to use Nextcloud" PDF. Ours says
  "Nourax Workspace is open-source software: get its source code, licensed under the GNU AGPL", with
  links to github.com/NouraX-ORG/basic-office-infra and the licence. That is the source offer the AGPL
  (section 13) asks of software people use over a network; keep it.

When a theme file changes, the sweep raises the theming cache buster and clears the cached picture
paths (Nextcloud keeps them in Redis with no end date), so pages use the new files at once.

**CSS** (`branding/custom.css`, applied by `scripts/configure.sh`): a few upstream scripts write
upstream links into pages themselves (the "How to access files using WebDAV" link in the NoDrive
settings, the issue tracker and design team links under Appearance and accessibility, the "Help
translate" link to the upstream translation project under Language & locale). Links whose
address *starts with* an upstream website are hidden on every page, admin pages too, with
the row or sentence around them where it would make no sense alone. Links that people write
themselves in documents, comments and cards are left alone, and a file that is only named like an
upstream address is never hidden. The CSS also hides three screen-reader-only spans on the Photos
page that hold the source of its placeholder pictures, upstream copyright line included, and draws
the browser's letter avatars that would be in the upstream blue in cobalt (see *Letter avatars*).

What is still left on purpose (stylesheet fallbacks, a calendar program id, people's data made before
the fixes, admin pages) is listed under *Exceptions* at the end of this page. To check all of the
above, run the guard (*Running the guard*).

## Running the sweep again after updates

The listener and the background job (*How the sweep works*) sweep new and updated apps and a new server
version by themselves. Run the sweep by hand to have the result at once, after a change to the rules or
the theme files, or to read its report. On the server, in `/opt/nourax/basic-office-infra`, under the
deploy lock like every server change:

```
sudo flock -w 1800 /run/nourax-deploy.lock bash -c 'git pull -q --ff-only && scripts/branding-sweep.sh'
sudo flock -w 1800 /run/nourax-deploy.lock bash -c 'git pull -q --ff-only && scripts/configure.sh'
```

- `sudo scripts/branding-sweep.sh` copies `branding/theme` into the theme folder when it changed,
  switches the theme on if it is off, and sweeps core, lib and every enabled app. Its options go to
  `occ nourax_branding:sweep`: `--report` also lists, per app, the notes, every translation that leaves
  the name out or spells it in a way the rules do not know, and every spelling `near_name` found
  ("guessed spelling"); `--dry-run` writes nothing; `--app ID` (more than once if needed) sweeps only
  those apps; `--if-needed` sweeps only what changed since the last sweep (what the background job
  does); `--bump` raises the theming cache buster even when no file changed.
- `sudo scripts/configure.sh` runs every branding step (`scripts/configure.d/20-branding.sh`), the
  sweep included.

When to run it:

- **After a new Nextcloud image or app updates.** `scripts/update.sh` is not part of the branding work
  and does not call the sweep. The apps it updates (`occ app:update --all`) are swept at once by the
  listener, and the background job sees a new server version within 15 minutes. Run
  `sudo scripts/branding-sweep.sh` straight after the update to skip that wait, then the guard.
- **After a change to `sweep/rules.json` or `sweep/en-overrides.json`.** The background job finds new
  rules within 15 minutes of the `git pull`; the sweep by hand does it at once. Run the rule tests
  first: `sudo docker compose exec -T -u www-data app php /var/www/html/nourax_apps/nourax_branding/tests/run.php`.
- **After a change to `branding/theme`.** Only `scripts/branding-sweep.sh` (or `configure.sh`) copies
  the theme files; the background job does not.
- **After adding an app.** Switching it on sweeps it. Then run the guard and add the app's row under
  *Apps and their upstream branding*.

A new spelling in the report goes into `name_patterns` in `sweep/rules.json` (the guard and the browser
audit read the same list and the same `near_name`); then run the sweep again. To check only the
translations: `sudo scripts/check-branding.sh /etc/nourax/qa/<QA user>.netrc --server --only l10n`.
For every enabled app and every language it works out what the server shows (the app's file with the
theme file on top, English where a text is missing) and what the browser shows (the first `.js` file
Nextcloud's loader finds), and fails on any spelling of the name.

## Running the guard

`scripts/check-branding.sh` reads what the server sends and fails on any upstream name, link, logo or
blue. Every task runs it at its end, and it is worth running after any change people can see.

```
scripts/check-branding.sh CREDENTIALS_FILE [--base https://drive.nourax.org] [--langs en_GB,en,de,ar]
    [--only pages,l10n,theming,share,dav,errors,config,mail,css] [--server] [--limit 25]
```

- **From the owner's PC** (Cloudflare lets only its address open `/login`, `/settings` and the user
  API): `scripts/check-branding.sh <scratchpad>/qa/qa-t3-1.netrc`. It needs bash, curl and Python 3.8
  or newer (Git Bash on Windows works) and takes about 25 seconds.
- **On the server**, read only: `sudo scripts/check-branding.sh /etc/nourax/qa/qa-t3-1.netrc --server`.
  It adds the config and mail areas, the server-side merge of every enabled app's translations in every
  language, a comparison of `sweep-state.json` with what is installed, and the page of a deleted or
  expired link. The pages Cloudflare opens only from the owner's address show as SKIP there. About 30
  seconds.

**The credentials file** belongs to a normal QA account: never an admin, never `nodrive`, never a real
person. It holds either one netrc line,

```
machine drive.nourax.org login qa-t3-1 password <app password>
```

or `qa-t3-1:<app password>` on its first line. It must be an app password: outside the browser the
server takes only app passwords (`token_auth_enforced`). Keep the file at mode 0600 and outside the
repo: `/etc/nourax/qa/` on the server (root, folder 0700), the scratchpad on the PC. The guard gives
the secret to curl only through `--netrc-file` or a curl config on standard input, never on a command
line, and never prints it.

To make a QA account for it, on the server under the lock, with the login password in a 0600 file
that is passed through the environment, never on a command line:

```
OC_PASS="$(cat /etc/nourax/qa/qa-tN-1.pass)" docker compose exec -T -e OC_PASS -u www-data app \
    php occ user:add --password-from-env --display-name "QA tN 1" qa-tN-1
OC_PASS="$(cat /etc/nourax/qa/qa-tN-1.pass)" docker compose exec -T -e OC_PASS -u www-data app \
    php occ user:add-app-password --password-from-env --name "branding check" qa-tN-1 \
    | tail -n 1 | tr -d '\r\n' > /etc/nourax/qa/qa-tN-1.apppass
```

The last line that command prints is the app password, so it goes straight into a 0600 file (set
`umask 077` first). Make the netrc line from that file without showing it. All 17 of Task 3's
accounts (`qa-t3-1` to `qa-t3-91`) were disabled at its end (26 October); a disabled account cannot
sign in, so use your own task's QA account, or switch one on for the check only
(`occ user:enable qa-t3-1`, then `occ user:disable qa-t3-1`), as Task 3's last run and Task 5 (with
`qa-t5-4`) did.

**What it checks** (every area but `css` by default):

| Area | What |
|---|---|
| `pages` | Signed-in pages (every app in the app menu, so apps added later are covered) and the login page: visible text, page title, attributes, meta tags, every link, the page settings (`var _theme …`) and the initial-state data; on the Appearance page also the theme previews and the background picker |
| `l10n` | Every `/l10n/*.js` file those pages load, in each `--langs` language; with `--server` also the server-side merge for every enabled app and every language, `en` included |
| `theming` | Manifests, theme CSS, custom CSS, logos, favicon, touch and mask icons |
| `share` | A test folder and file of the QA account and four public links to them (file, folder, password, file drop), opened signed out |
| `dav` | The page shown when `/remote.php/dav` is opened in a browser |
| `errors` | 404, 403, a missing path in a link, the unsupported-browser page, `status.php`; with `--server` the page of a deleted or expired link |
| `config` | (`--server`) the theme, the `customclient_*` keys, the apps that must stay off, the example contact new accounts get; it counts people's calendars still in the upstream blue (INFO) |
| `mail` | (`--server`) sample e-mails rendered on the server, never sent |
| `css` | Every other stylesheet the pages link, for hard-coded blues (lists the fallbacks under *Exceptions*) |

The first run makes a folder `branding-check` in the QA account, with `probe.txt` and the four public
links; later runs find and reuse them. They stay with the account.

**Output.** One line `FAIL <area> <url> <where>: <snippet>` per hit (a hit that repeats on many pages
is listed once and counted; `--limit 0` shows every one), `SKIP` and `INFO` lines, then
`SUMMARY <area> N checked, N FAIL, N SKIP` per area and `RESULT PASS (0 hits)` or
`RESULT FAIL (N hits)`. The exit code is 0 when clean, 1 on any hit, and 2 when it could not run.

A hit is fixed where it comes from: a spelling in `sweep/rules.json` or a sentence in
`sweep/en-overrides.json` and a sweep, a link in `branding/custom.css`, a page in the theme or in the
nourax_branding app. `allow` in `rules.json` is only for licence text that a licence requires.

**At the end of Task 3** (26 October 03:42 UTC, `main` at `f4d4088`, `qa-t3-1` switched on for the
check only and off again straight after; the commit that added this paragraph changes only docs,
README.md and NOTICE.md). The first run, at `b4826ec` right after `sudo scripts/configure.sh`, gave the
same counts.

| Where | Result |
|---|---|
| The owner's PC, from a fresh copy of `origin/main`: `scripts/check-branding.sh qa-t3-1.netrc --langs en_GB,en,de,ar` | pages 92, l10n 124, theming 92, share 18, dav 4, errors 21 checked: 0 FAIL, 0 SKIP. *RESULT PASS (0 hits)*, exit 0, 34 seconds |
| The server: `sudo scripts/check-branding.sh /etc/nourax/qa/qa-t3-1.netrc --server` | pages 44 checked (37 SKIP, the pages only the owner's address may open), l10n 8713, theming 73, share 18, dav 4, errors 18 (4 SKIP), config 1, mail 4: 0 FAIL. *RESULT PASS (0 hits)*, exit 0, 34 seconds |

A fresh account (`qa-t3-91`, made at 03:25) gave the same PASS from the owner's PC, and a browser
audit as that account (en_GB, de, ar; light and dark; signed in and signed out) ended *RESULT PASS*:
56 page scans, 66 pictures looked inside, 0 findings, 0 problems.

## Browser audit

`scripts/check-branding.sh` reads what the server sends. The browser audit looks at what a person
actually sees once the page's scripts have run: it signs in through the normal login form as a QA
account, opens every page and menu below in a real browser (Google Chrome, driven by Playwright), and
on each one runs `branding/audit/scan-page.js`. That scanner checks the drawn text, the page title,
link addresses, pictures (`src`, `alt`), `title`, `aria-label` and `placeholder` texts, the labels CSS
draws (the app names in the app menu), meta tags and icons, the colours every drawn element really
gets (text, background, border, outline, SVG fill and stroke) against the upstream blue, background
pictures, and, for Arabic, that the page runs right to left. It uses the same patterns as the sweep
and the guard (`sweep/rules.json`).

It also looks inside every picture the page draws (`branding/audit/scan-pictures.js`): `<img>`
pictures, SVG `<image>`s, posters and CSS background, border and list pictures, also inside the
ONLYOFFICE frames. A picture's address and alt text can be clean while the picture itself shows the
upstream logo or blue (the theme previews did), so the audit fetches each picture once, the way the
page does, and fails when

- its bytes are the same as one of the upstream files listed in `rules.json` (`upstream_files`: the
  upstream logos and icons; `upstream_pictures`: the theming app's theme previews), or
- at least 0.5% of its pixels (and at least 16) are within 28 (distance in RGB) of an upstream blue.
  The Nourax blues are 55 or more away. CSS masks only give a shape, drawn in the element's own
  colour, so their colours do not count.

A picture the check cannot read, or that does not answer 200 or 201, goes to `problems.json`, so a
clean run means every picture was looked at. (`data:` pictures are read in the page itself: the
pages' content security policy does not let scripts fetch them.)

An address under `/apps/theming/img/` with a picture extension is an upstream asset in `rules.json`
(`upstream-theme-preview`), so the scanner and `scripts/check-branding.sh` also fail on the address
alone. `pictures.json` in the output folder lists every picture looked at: its size, how many of its
pixels are in an upstream blue, and the first pages that drew it. A logo with none of the upstream
blue in it, in a picture nobody has listed, is the one thing this cannot see; that is why upstream
pictures that can reach people are listed by name.

An element that is not drawn at all (hidden by
`branding/custom.css`, for example) cannot be seen, clicked or read out, so a hit there is listed
apart, in `hidden.json`, and does not fail the audit.

It also watches every request the browser makes: none may go to an upstream host, and a translation
file fetched as `/l10n/<language>.json` (which would skip the theme overrides) must not hold the name.

**Pages**, each in English (British), English (US), German and Arabic, in the light and the dark
theme (the browser's setting, with the account's theme on "System default"), with a screenshot of each:

- signed in: NoDrive (file list, the folder of test files, New menu, sharing tab of the sidebar, NoDrive
  settings and their WebDAV part, shared with you, shares, recent, deleted files, team folders, the
  "Actions" menu of a file), the picture viewer, a Markdown file in Text, the PDF viewer, a document in
  ONLYOFFICE (also the editor's own frames; ONLYOFFICE keeps its name), the app menu (NoMail must be in
  it), the user menu, the QR code for the mobile app, the status menu, the contacts menu,
  notifications, the search (Ctrl+K), Nourax AI (its dialog from the top bar and its page), Photos,
  Activity, NoCalendar (month, an event, its settings, editing and sharing a calendar), NoContacts,
  NoBoard (boards, a board, a card), NoNotes, NoTasks, NoForms, NoGantt, every other app of the app
  menu, every Personal settings page, the help page, the old "sync clients" address, a profile page,
  `/remote.php/dav` and a folder below it, a missing page and an admin-only page (as a person who is
  not an admin), and last signing out. The apps of the app menu and the Personal settings pages are
  read from the server on each run, so an app added later is audited without a change to the audit;
- signed out: the login page, "Forgot password?", "Log in with a device", the four test links of the QA
  account's `branding-check` folder (a file with its menu, a folder with its menu, a file drop, a
  password-protected link, also with a wrong password), the page of a link that does not exist (a
  deleted or expired link shows the same page), a missing page and the help page;
- once: the language changed through the Personal settings language menu (German), the Appearance
  page's own "Dark theme" (pages must stay dark with a light browser; then back to "System default"),
  and the first sign-in of a fresh account (its welcome files, its NoCalendar example event, its
  NoBoard boards: no welcome board, NoContacts with the example contact it opens and the text of every
  card, NoTasks with the first task list it makes, then NoCalendar again with that list, and the
  colour of every calendar) and of the account that shares a file with the main QA account.

The page of a link that does not exist is a made-up link, opened once per language. The server
counts each one as a guessed link: after that it slows down every link page for this IP for 12 hours
(up to 25 seconds each), and refuses them (HTTP 429) after more than ten in half an hour, so don't run
the public pass many times in a row. (A real link with a path that is not in it, `/s/<link>?path=/missing`,
counts nothing and answers 404, but that page still loads the link's scripts, and in a browser they show
the shared file, so it is not the page a person with a dead link sees.) A page that answers 429 or a 5xx
is a problem in `problems.json`; a 502 or 503 (another task restarting the server) is tried once more
after a minute.

The audit makes its own test data in the QA accounts, once, and finds it again on later runs: four
files in `branding-check`, a board with a card, a calendar event (moved to the next day on each run), a
contact, a file the second account shares with the first, and a comment on it that mentions the first
account (so the first account has a notification).

**Admin pages are not part of it**, and it never signs in as `nodrive` or as a real person: it refuses
any account whose name does not start with `qa-`.

**Run it** on a PC whose address may open `/login` (Cloudflare rule `1f4cc937…`):

```
cd branding/audit
npm ci                                    # playwright-core 1.64.0; uses the installed Google Chrome
node run-audit.mjs CONFIG.json            # [--langs en_GB,de] [--themes dark] [--pages files,deck*] [--passes user,public,extras]
```

`CONFIG.json` is like `audit.config.example.json`: the site, an output folder, and for each QA account a
file with its password (for the login form) and a netrc file with its app password (for the test data).
Keep it and those files outside the repo. Passwords are never printed. The output folder gets a
screenshot per page, language and theme (`<language>-<theme>-<page>.png`), `index.html` (a table of
every page scanned), `findings.json`, `problems.json` (a page or menu that could not be opened),
`hidden.json`, `network.json`, `pictures.json` and `notes.json`. The exit code is 0 only when `findings.json` and
`problems.json` are both empty. A full run takes about 45 minutes.

A finding is fixed where it comes from (a new spelling in `sweep/rules.json` or a sentence in
`sweep/en-overrides.json` and a sweep; a link in `branding/custom.css`; a page in the theme or the
nourax_branding app), then the page is audited again with `--pages`.

What the audit (and the checks of its runs) found so far, the fix, and how the fix was checked again.
Times are UTC. "Full pass" means every page above, in all four languages and both themes, with the
signed-out pages and the extra passes; its folder is kept with its screenshots.

| Found | Fix | Checked again |
|---|---|---|
| Personal settings > Language & locale: a "Help translate" link to the upstream project's translations | `branding/custom.css` hides that row | Full pass 25 Oct 22:09–22:51: 580 page scans, 0 findings, 0 problems (the link is listed in `hidden.json` only, not drawn). Full pass 26 Oct 01:53–02:30 (qa-t3-4, qa-t3-2, fresh qa-t3-73): 592 page scans, 178 pictures looked inside, 0 findings, 0 problems. |
| Arabic: the login page, the public link pages and the other signed-out pages ran left to right (core sets `dir` only on signed-in pages) | nourax_branding `PageDirectionMiddleware` sets `dir="rtl"`; `custom.css` for the few error pages drawn outside the app framework | Full pass 25 Oct 22:09–22:51: every Arabic page `dir="rtl"`, 0 findings. Full pass 26 Oct 01:53–02:30 (qa-t3-4, qa-t3-2, fresh qa-t3-73): 592 page scans, 178 pictures looked inside, 0 findings, 0 problems. |
| Arabic: the WebDAV page (`/remote.php/dav` in a browser) was plain text, left to right | nourax_branding `Dav/BrandedGetPlugin.php` answers a small HTML page with its language and direction | Full pass 25 Oct 22:09–22:51: 0 findings on the `dav` pages. Full pass 26 Oct 01:53–02:30 (qa-t3-4, qa-t3-2, fresh qa-t3-73): 592 page scans, 178 pictures looked inside, 0 findings, 0 problems. |
| NoNotes showed the upstream phone-app badges (a link with the upstream name) while `scripts/configure.sh` ran: it writes `custom.css` first, and the app steps in `configure.d` add their hiding rules minutes later | `custom.css` holds a copy of those rules (NoNotes badges and marker, the upstream-blue colour swatch in every colour picker, NoGantt's default project colour) | Full pass 25 Oct 22:09–22:51: 0 findings on NoNotes. Full pass 26 Oct 01:53–02:30 (qa-t3-4, qa-t3-2, fresh qa-t3-73): 592 page scans, 178 pictures looked inside, 0 findings, 0 problems. |
| The sparkle icon of Nourax AI (its dialog and page, the Text and NoBoard editors' menus) has a gradient stop in the upstream dark blue, in the light theme; the scanner had counted the `<stop>` as not drawn | `custom.css` draws gradient stops in the upstream blues in Nourax cobalt; `scan-page.js` treats an SVG's gradients and patterns as drawn when the SVG is, and checks SVG colours as computed | Full pass 25 Oct 22:09–22:51: 0 findings on the Nourax AI, Text and NoBoard pages. Full pass 26 Oct 01:53–02:30 (qa-t3-4, qa-t3-2, fresh qa-t3-73): 592 page scans, 178 pictures looked inside, 0 findings, 0 problems. |
| A new account's NoContacts opened the example contact "Leon Green" with the website `www.nextcloud.com` (the audit's main account opened its own test contact first, and the fresh pass did not open NoContacts) | the Nourax example contact (`occ nourax_branding:example-contact`); the fresh pass opens NoContacts and reads every card | Fresh-account passes 25 Oct 23:55 (qa-t3-52) and 23:59 (qa-t3-54, Arabic calendar names): 18 page scans each, 0 findings; "Leon Green" with its website on example.com. Full pass 26 Oct 01:53–02:30 (qa-t3-4, qa-t3-2, fresh qa-t3-73): 592 page scans, 178 pictures looked inside, 0 findings, 0 problems. Fresh account: "Leon Green" its only card, no upstream name in it. |
| A new account's first NoTasks list ("Tasks", "المهام") was in the upstream blue `#0082C9`, in NoTasks and in NoCalendar's task lists (the main account already had a list) | new calendars in an upstream blue get the site colour (`CalendarColourListener`); the fresh pass opens NoTasks, then NoCalendar, and reads every calendar's colour | The same two fresh-account passes: the first task list `#2563EB` (also "المهام" for qa-t3-54), 0 findings. Full pass 26 Oct 01:53–02:30 (qa-t3-4, qa-t3-2, fresh qa-t3-73): 592 page scans, 178 pictures looked inside, 0 findings, 0 problems. Fresh account: "Tasks" `#2563EB`. |
| Accounts made through the nourax_api app (admin API, `/v1/provision`, the demo accounts) still got the NoBoard welcome board: user_oidc makes them without `UserCreatedEvent`, and their first sign-in is an app password, which sends no `UserFirstTimeLoggedInEvent` | `NewAccountListener` also sets Deck's `firstRun` to `no` on every sign-in (`PostLoginEvent`) when it is unset | 25 Oct about 23:54: qa-t3-53, made through `/v1/provision`, had Deck's `firstRun` set to `no` by its first app-password sign-in and no board. The QA re-check of that fix (26 Oct, before 00:30) found no board made after it. The fresh passes: no boards. Full pass 26 Oct 01:53–02:30 (qa-t3-4, qa-t3-2, fresh qa-t3-73): 592 page scans, 178 pictures looked inside, 0 findings, 0 problems. Fresh account: no boards. |
| Personal settings > Appearance and accessibility drew the theming app's theme previews (`/apps/theming/img/<theme>.jpg`): the upstream logo on five of them, a header in the upstream blue on four. Found by QA on 26 Oct, in every language and theme: the scanner looked at pictures' addresses and alt texts, not inside them | our own previews (`js/theme-previews.js`, `img/theme-previews/`); the audit now looks inside every picture (`scan-pictures.js`: upstream bytes, upstream-blue pixels), and the theming picture addresses are upstream assets in `rules.json` | 26 Oct 00:51–00:54, that page in all four languages and both themes: the seven pictures drawn are ours, none has an upstream-blue pixel, no upstream file is drawn. A test that put the seven upstream pictures back on a page in a test browser: all seven found (address, same bytes; four also by their blue). Full pass 26 Oct 01:53–02:30 (qa-t3-4, qa-t3-2, fresh qa-t3-73): 592 page scans, 178 pictures looked inside, 0 findings, 0 problems. The Appearance page (8 scans): the seven pictures drawn are ours, no upstream preview drawn. |
| The same page's background picker: Clouds (the upstream's old default background), Underwater ocean and Waxing crescent moon have 55%, 32% and 4.5% of their pixels in the upstream blue. Found by the new picture check, 26 Oct 00:51 | left out of the picker (`rules.json` `backgrounds_off`); `tests/run.php` measures every shipped background | On the server after deploying it (26 Oct): `tests/run.php` 454 pass, among them "every shipped background mostly in an upstream blue is in backgrounds_off"; `scripts/check-branding.sh` from the owner's PC: the picker offers none of them. Full pass 26 Oct 01:53–02:30 (qa-t3-4, qa-t3-2, fresh qa-t3-73): 592 page scans, 178 pictures looked inside, 0 findings, 0 problems. The picker drew 16 backgrounds, none of the five left out; the most upstream blue in any picture drawn was 7 pixels (0.007%) of Barents bloom. |
| Letter avatars: one name in 18 gets the upstream blue `#0082C9` (Nextcloud's avatar colours; 4 of 131 accounts, QA accounts of other tasks). Found while building the picture check, by reading core's avatar code | nourax_branding `AvatarColourMiddleware` redraws those avatars in cobalt; `custom.css` does the same for the initials the browser draws | 26 Oct 01:06, qa-t3-72 ("QA t3 72 u"): its avatars (64 and 512, light and dark) and a guest avatar answer in cobalt with 0 upstream-blue pixels; a contact "Blue Test m" in NoContacts shows its initials in cobalt (inline style still the upstream blue, computed colour `rgb(37, 99, 235)`). Full pass 26 Oct 01:53–02:30 (qa-t3-4, qa-t3-2, fresh qa-t3-73): 592 page scans, 178 pictures looked inside, 0 findings, 0 problems. The fresh account "QA t3 73 s" (upstream-blue colour): its avatars on every page of its pass, 0 upstream-blue pixels. |
| Trial run 25 Oct 12:42 (qa-t3-1, English (British), 20 findings; 2 of them are the "Help translate" row above). NoDrive's Recent and Shares lists showed the file "Nextcloud sample image - add your image here!.jpg" (16 hits: its name, its checkbox label and its link title, light and dark), and Activity showed "You have renamed the board Welcome to Nextcloud Deck! to Welcome to NoBoard!" (2 hits). Deck's welcome board puts that sample picture in a person's NoDrive folder `Deck` and attaches it to a card; qa-t3-1 had got the board at 03:16 that day, before the fix | No welcome board any more (`NewAccountListener`, see the deck row under *Apps*), so no sample picture either. The copies and Activity entries that accounts already had are people's data (*Exceptions*). qa-t3-1's own copy was renamed "Sample image - add your image here!.jpg" on 25 Oct; the later full passes use a new main account (qa-t3-4), whose Activity has no such entry | Read-only database check 26 Oct 03:05: 12 accounts have the sample picture (plus one older version each), the newest made 25 Oct 22:46:41, none since; the newest welcome board is from 22:46:42 too (board ids now go up to 134), and the PostLoginEvent fix of 23:47 came after both. The fresh accounts qa-t3-73 (26 Oct, audit) and qa-t3-81 (26 Oct, QA) and the main account qa-t3-4 have no `Deck` folder and no sample picture. Full pass 26 Oct 01:53–02:30 (qa-t3-4, qa-t3-2, fresh qa-t3-73): 592 page scans, 0 findings, NoDrive Recent, Shares and Activity included. |

## Apps and their upstream branding

Every app that is switched on was checked for the upstream name and links in its texts (en_GB
translations), its shipped scripts and templates, its app-menu entry and its Personal settings.
Checked on 2026-10-25 against Nextcloud 35.0.2; the apps Task 5 switched on later (NoNotes, NoForms,
Nourax AI, search inside files, retention, automatic tagging, suspicious login and the audit log) on
2026-10-26, from their installed files on the server.

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

`circles` (Teams) and `federation` are off too, since 25 October, but not because of the branding:
privacy between organisations switches them off (`scripts/configure.d/60-org-privacy.sh`,
docs/teams.md). Their rows below are for when it is off again; switching an app on sweeps it at once.

### Kept, with a fix

"Always on" means Nextcloud does not let the app be switched off.

| App | Version | Upstream branding found | Fix |
|---|---|---|---|
| core (the app menu) | 35.0.2 | An "App store" tile at the end of the app menu of people who are not admins. It opens apps.nextcloud.com in a new tab. It is part of Nextcloud itself, not of the `appstore` app, and shows while the core setting `appstore_link_shown` is unset. | `scripts/configure.d/20-branding.sh` sets `appstore_link_shown` to false, which hides only this tile. Admins still install and update apps from Administration > Apps. |
| `deck` (NoBoard) | 1.19.1 | A welcome board is made on a person's first visit. Its title, "Welcome to Nextcloud Deck!", is a translation, but its card texts come from a fixed file inside the app and name the upstream 15 times. | The text sweep renames the title. The nourax_branding app sets the person's Deck setting `firstRun` to `no` when it is unset: as soon as an account is made, and on every sign-in (login form, "Log in with Nourax", app password), which also covers accounts the nourax_api app makes. So no welcome board is made. Boards that already exist are people's data and stay. |
| `tasks` (NoTasks) | 0.18.1 | A person's first task list is made in the upstream blue `#0082C9` (it reads a theming field Nextcloud 35 no longer has), shown in NoTasks and in NoCalendar. | The nourax_branding app gives every new calendar in an upstream blue the site colour (links and assets). |
| `federatedfilesharing` | 2.0.0 | Personal settings > Sharing: the Federated Cloud ID, "Share with me via Nextcloud" and "share it" buttons pointing at nextcloud.com/sharing; "Add to your Nextcloud" on public share pages. | Always on. Sharing with other servers is off while privacy between organisations is on (`60-org-privacy.sh`), which hides all of it. When it is on: the texts are swept, "Add to your …" uses the product name, and the "share it" buttons point at our help page (links and assets). |
| `settings` | 2.0.0 | 40 texts with the upstream name, the Help page, the developer notice with social links, the "Reasons" PDF button, links to docs.nextcloud.com. | Always on. Text sweep, plus links and assets: our notice in place of the developer notice, `/settings/help` goes to our help page, the PDF answers 404, help links open our help page. |
| `theming` | 3.0.0 | Accessibility paragraph links; two backgrounds in the picker credited to "Nextcloud GmbH"; the theme previews of Appearance and accessibility (the upstream logo, and a header in the upstream blue); "Adjust the Nextcloud theme"; the upstream blue in the Assistant gradient; app summaries such as "A Calendar app for Nextcloud" in the app manifests. | Always on. Links and assets (CSS, the two backgrounds left out, our own theme previews, blue and manifests fixed where they are made), text sweep. |
| `dav` | 2.0.0 | The page shown when `/remote.php/dav` is opened in a browser; the sample calendar event; the example contact's website (`www.nextcloud.com`); some error texts. | Always on. Links and assets (our own WebDAV page text, the Nourax example contact), text sweep. |
| `circles` (Teams) | 35.0.0 | 8 texts, for example "Nextcloud Account". | Text sweep. Off while privacy between organisations is on (above). |
| `calendar` (NoCalendar) | 6.6.3 | 4 texts, mostly the app description. | Text sweep. |
| `contacts` (NoContacts) | 8.9.2 | 4 texts, mostly the app description. | Text sweep. |
| `text` | 9.0.1 | "Nextcloud Text", "Nextcloud Assistant". | Text sweep ("Nourax AI" for the Assistant). |
| `files_sharing` | 2.0.0 | 4 texts about sending share passwords by "Nextcloud Talk" (Talk is not installed). | Text sweep. |
| `user_oidc` | 8.11.0 | Sign-in error texts such as "You must access Nextcloud with HTTPS to use OpenID Connect." | Text sweep. |
| `onlyoffice` | 10.2.1 | App descriptions only. ONLYOFFICE keeps its own name. | Text sweep. |
| `activity` | 8.0.0 | The app description; Activity texts and e-mails are checked with the e-mail templates. | Text sweep. |
| `workflowengine` (Flow) | 3.0.0 | People see Personal settings > Flow. The upstream developer link and the app store button show to admins only. | Always on. Text sweep (description). |
| `groupfolders` (Team folders) | 23.0.1 | 5 texts, on the admin page and in descriptions. | Text sweep. |
| `assistant` (Nourax AI) | 4.0.0 | 22 texts: "Nextcloud Assistant", "Close Nextcloud Assistant", example prompts such as "Generate a slide deck about the features of Nextcloud", and other apps named "Nextcloud Files", "Nextcloud Calendar" and so on. Its "No provider found" box links docs.nextcloud.com, but only for admins, as does its admin page. | Text sweep ("Nourax AI", the names of *Naming rules*). What the chat says about itself is set by `scripts/configure.d/50-assistant.sh` (docs/assistant.md). The sparkle icon's gradient is drawn in cobalt by `branding/custom.css` (*Browser audit*). |
| `notes` (NoNotes) | 6.1.0 | 6 texts, for example "Nextcloud Notes", "Error from Nextcloud server: {msg}" and the app description with a link to nextcloud.com. "Mobile apps" store badges for the upstream phone apps (one link names the upstream project); the marker of a note in a shared folder in the upstream blue. A page for copies installed from a development source links apps.nextcloud.com; ours comes from the app store, so it never shows. | Text sweep. `branding/custom.css` and `scripts/configure.d/50-apps.sh` hide the badges, their settings section and its menu entry, and draw the marker in cobalt. |
| `forms` (NoForms) | 5.4.1 | "Nextcloud Forms" and the app description. | Text sweep. |
| `files_lock`, `files_pdfviewer`, `viewer`, `cloud_federation_api`, `provisioning_api`, `password_policy` | 35.0.1, 8.0.0, 8.0.0, 2.0.0, 2.0.0, 7.0.0 | One description or admin text each. | Text sweep. `viewer`, `cloud_federation_api` and `provisioning_api` are always on. |

Admin pages only (people never see them; admin pages are not part of the user check):

| App | Version | Upstream branding found | Fix |
|---|---|---|---|
| `appstore` | 2.0.0 | Administration > Apps: the "More apps" tile links to apps.nextcloud.com; "Nextcloud Appstore". The "App store" tile in the app menu of people who are not admins is not part of this app: see the core row above. | Always on. Links hidden by CSS, text sweep. |
| `settings` (Administration overview) | 2.0.0 | A release name written into a template, "Nextcloud Hub 26 Summer". | Not fixed: admin page only. A copy of that whole template in the theme would hide upstream changes to it after an update. |
| `notifications` | 8.0.1 | Notices about the upstream's free push service limits, with links to nextcloud.com. | Text sweep; the links show to admins only. |
| `serverinfo`, `logreader`, `bruteforcesettings` | 7.0.0, 8.0.0, 8.0.0 | Links to docs.nextcloud.com and descriptions. | Links hidden by CSS, text sweep. |
| `webhook_listeners` | 2.0.0 | "Nextcloud Webhook Support" and other descriptions. | Text sweep. |
| `files_antivirus` | 6.5.0 | "An antivirus app for Nextcloud" (description). | Text sweep. |
| `theming_customcss` | 1.22.0 | "Adjust the Nextcloud theme with custom CSS" (description). | Text sweep. |
| `integration_openai` | 5.0.0 | 2 admin texts and the app description, with links to apps.nextcloud.com, docs.nextcloud.com and nextcloud.com/blog. People see no AI settings: the Personal settings section "Assistant" is hidden (docs/assistant.md). | Text sweep; links hidden by CSS. |
| `fulltextsearch`, `files_fulltextsearch`, `fulltextsearch_elasticsearch` | 35.0.1, 35.0.0, 35.0.1 | 4 texts of `fulltextsearch` (its descriptions and the admin page's note "… within your Nextcloud") and a link to its wiki on github.com/nextcloud on that page. The results show in the normal search box, which names no upstream. | Text sweep; links hidden by CSS. |
| `files_retention`, `files_automatedtagging` | 6.0.0, 6.0.1 | The app descriptions ("An app for Nextcloud …"). Their rules are made under Administration > Flow. | Text sweep. |
| `suspicious_login` | 13.0.0 | The app description. The notification and e-mail people get name no upstream (docs/apps.md). | Text sweep. |
| `admin_audit` | 2.0.0 | The app description. It has no screen: it writes `audit.log` on the server. | Text sweep. |

### Kept, nothing to fix

No upstream name or link on any screen. Links to github.com/nextcloud inside these apps' scripts are
code comments, and links in command-line tools are not shown to people.

| App | Version | Note |
|---|---|---|
| `files` (NoDrive) | 3.0.0 | Always on. |
| `photos` | 8.0.0 | |
| `comments`, `contactsinteraction`, `federation`, `files_downloadlimit`, `files_reminders`, `files_trashbin`, `files_versions` | 2.0.0, 2.0.0, 2.0.0, 5.3.0, 2.0.0, 2.0.0, 2.0.0 | `federation` is off while privacy between organisations is on. |
| `oauth2`, `profile`, `sharing` | 2.0.0, 2.0.0, 1.0.4 | Always on. |
| `recommendations`, `related_resources`, `sharebymail`, `systemtags`, `user_status` | 8.0.0, 6.0.0, 2.0.0, 2.0.0, 2.0.0 | |
| `twofactor_backupcodes`, `twofactor_totp` | 2.0.0, 17.1.0 | `twofactor_backupcodes` is always on. |
| `nc_gantt` (NoGantt) | 2.4.1 | Shown as NoGantt (docs/gantt.md). |
| `nourax_api`, `nourax_antivirus`, `nourax_branding` | 1.0.0 | Nourax's own apps. |
| `lookup_server_connector` | 2.0.0 | Always on, no screen. `'lookup_server' => ''` in `config/nextcloud/zz-nourax.config.php` stops its calls. |

## Undo

Each change can be undone on the server with occ (`cd /opt/nourax/basic-office-infra && sudo docker
compose exec -T -u www-data app php occ …`), under the deploy lock. `scripts/configure.sh` puts every
one of them back the next time it runs, so to undo one for good, also take it out of
`scripts/configure.d/20-branding.sh` (and, where the guard checks it, out of `sweep/rules.json`).
Undoing any of these brings the upstream name, links or pictures back on people's screens.

| Change | Undo |
|---|---|
| The theme folder `themes/nourax`: every translation override, the web app manifest, the mask icon and the Profile page notice | `occ config:system:delete theme`. The files stay in the folder and do nothing. |
| The upstream desktop and mobile app links and the iOS app banner hidden | `occ config:system:delete customclient_desktop`, and the same for `customclient_android`, `customclient_ios`, `customclient_fdroid` and `customclient_ios_appid`. When the NoDrive apps ship, set our own addresses in `20-branding.sh` instead. |
| Help links open our help page | `occ config:app:delete theming docBaseUrl` |
| The "App store" tile hidden | `occ config:app:delete core appstore_link_shown` |
| The `office` and `privacy` apps switched off | `occ app:enable office`, `occ app:enable privacy`; also take them out of the loop in `20-branding.sh` and out of `apps_off` in `rules.json`. |
| The nourax_branding app: NoMail in the app menu, the help page, the WebDAV page, the fixes in other apps' answers, the theme previews, the letter avatars, no welcome board, new calendars in the site colour, right to left when signed out, the language menu without doubles, the sweep's listener and background job | `occ app:disable nourax_branding`, and take `occ app:enable nourax_branding` out of `20-branding.sh`. What it already set stays: Deck's `firstRun` of the accounts that signed in, the example contact (next row), the calendar colours it gave. |
| NoMail's address | `occ config:app:delete nourax_branding nomail_url` goes back to `https://mail.nourax.org/` |
| The Nourax example contact for new accounts | Administration > Groupware > Example content > reset. Cards changed with `occ nourax_branding:example-contact --existing … --apply` are not changed back. |
| Old calendars recoloured with `occ nourax_branding:calendar-colours … --apply` | Not undone by itself: give a calendar its old colour in NoCalendar. |
| The hiding rules and colours in `branding/custom.css` | Edit the file, then `sudo scripts/configure.sh`. |
| Sharing with other servers off (the federation keys) | Not part of the branding: `scripts/configure.d/60-org-privacy.sh` sets them, with privacy between organisations. Undo with `occ nourax_api:org-privacy off` or the admin page ([docs/teams.md](teams.md#the-switch)). The branding holds with federation on or off. |

## Exceptions

What people may still meet, and why. Anything else the guard or the browser audit finds is a fault
to fix.

**Licence text, only where a licence requires it.** The notice at the end of Personal settings >
Profile and contact is the source offer the AGPL asks for (section 13): it says Nourax Workspace is
open-source software and links our own repo, github.com/NouraX-ORG/basic-office-infra, and the licence.
It does not name the upstream. Licence and copyright files inside the shipped apps stay as they are;
no page links them. `allow` in `rules.json` is the place for a licence text that would have to show the
name on a screen; it is empty today.

**Not text people read:**

- code identifiers, config keys and app ids, HTTP paths (`/remote.php/dav`, `/ocs/v2.php`,
  `/apps/theming/…`), the `nc:` and `oc:` XML namespaces of WebDAV answers, HTML ids and class names
  such as `#nextcloud` (the link around the logo in the top bar), and server logs;
- `PRODID:-//Nextcloud/Nextcloud CalDAV Server//EN` inside calendar invitation files and calendar
  downloads: a program id that calendar programs do not show;
- fallback values in stylesheets that are never used while the theming app works: the static
  `apps/theming/css/default.css` (upstream primary blue), and `var(--…, <upstream blue or logo>)`
  defaults in `core/css/guest.css` and in the Calendar and Forms stylesheets. The theming app defines
  every one of these variables on every page. `scripts/check-branding.sh --only css` lists them;
- an upload error text written in English inside the dav app ("Expected filesize of … (from Nextcloud
  client)"), shown only when an upload breaks off half way.

**Upstream addresses that nothing links to.** The upstream's own files are still on the server
(the Docker image is not changed) and answer when someone types their address: for example
`/core/img/logo/logo.svg`, the upstream logo, and the theming app's theme previews
`/apps/theming/img/<theme>.jpg`, which the browser downloads on the Appearance page but never draws
(*Theme previews*). The route of the upstream "Reasons to use Nextcloud" PDF,
`/settings/download/reasons`, answers 404 (the nourax_branding app). No page links any of them; the
guard and the browser audit fail if one does.

**People's data made before the fixes.** Nothing changes these by itself, and no task may change
the owner's or the demo accounts' data; their owners can rename or delete them.

- Boards that Deck made before the welcome board was switched off. On 26 October these were the
  owner's own board "Welcome to Nextcloud Deck!", the demo account demo-a01's board (renamed "Welcome
  to NoBoard!"; 4 of its cards still name the upstream) and boards of some other tasks' QA accounts.
  No board was made after the fix, and by 26 October 01:20 UTC all 24 demo accounts had Deck's
  `firstRun` set to `no` (set at their sign-ins), so none of them gets a welcome board any more.
- The sample picture those welcome boards put in the person's NoDrive folder `Deck`, "Nextcloud sample
  image - add your image here!.jpg", attached to one of the board's cards. On 26 October 12 accounts
  had it (the owner's, demo-a01's and ten QA accounts of Tasks 1, 5 and 5b), each with one older
  version. The newest is from 25 October 22:46 UTC; none has been made since.
- Activity entries written before the fixes keep the names they had then, for example "You have
  renamed the board Welcome to Nextcloud Deck! to Welcome to NoBoard!" and the entries about the
  sample picture: 234 entries in 15 accounts on 26 October (29 of them the owner's). The Activity app
  clears entries after a year (`activity_expire_days`, 365 by default).
- Example cards that accounts got before the Nourax example contact was in place, and calendars or
  task lists made in the upstream blue before the app recoloured new ones.
  `occ nourax_branding:example-contact --existing --all` and
  `occ nourax_branding:calendar-colours --all` list them; with `--apply` (or `--user UID --apply` for
  one account) they change them. `scripts/check-branding.sh --server` counts the calendars (INFO).

**Admin pages only.** Admin pages are not part of the user check, and people who are not admins never
see them. What is left there is in the admin table under *Apps and their upstream branding*: the
Administration overview's release name "Nextcloud Hub 26 Summer", and app texts and descriptions that
only admins see (swept where they are translations, links hidden by CSS).
