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
  of the app's translations with the changes in it. It starts from the app's own `.js` file, whose
  texts are not always the same as its `.json` file (onlyoffice's `ja.js` has texts its `ja.json`
  lacks), and sweeps those too.

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

A translation file that starts with a byte order mark (onlyoffice's `eu.json`) cannot be read by
Nextcloud, which then shows that language in English. The sweep reads it all the same and writes every
one of its texts into the theme file, so Basque people see Basque, without the name.

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
the notes, every translation that leaves the name out or spells it in a way the rules do not know, and
every spelling `near_name` found ("guessed spelling"). Add a new spelling to `name_patterns` in
`sweep/rules.json` (the guard and the browser audit read the same list and the same `near_name`), then
run the sweep again. Check the result with
`sudo scripts/check-branding.sh /etc/nourax/qa/qa-t3-1.netrc --server --only l10n`: for every enabled
app and every language it works out what the server shows (the app's file with the theme file on top,
English where a text is missing) and what the browser shows (the first `.js` file Nextcloud's loader
finds), and fails on any spelling of the name. The rules have their own tests:
`sudo docker compose exec -T -u www-data app php /var/www/html/nourax_apps/nourax_branding/tests/run.php`.

**Undo.** `occ config:system:delete theme` switches the overrides off; the files stay and do nothing.

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
    left out of the picker; the others stay;
  - Sharing (when federation is on): the "share it" buttons point at our help page;
  - `/settings/download/reasons`, the upstream's "Reasons to use Nextcloud" PDF, answers 404.
- *Theme previews* (`js/theme-previews.js`, `img/theme-previews/`): Personal settings > Appearance and
  accessibility shows a picture of each theme. The theming app builds their addresses in the browser
  (`/apps/theming/img/<theme id>.jpg`), and the upstream pictures show the upstream logo and, for the
  four themes, a header in the upstream blue. On that page only, the app's middleware gives the page
  the addresses of our own pictures (initial state `nourax_branding` / `theme_previews`) and the small
  script, which puts our picture of the same theme in place of each upstream one before the browser
  has fetched it. A theme with no picture of ours (one a later version adds) has its picture hidden
  instead; `tests/run.php` and `scripts/check-branding.sh` then fail and name it. Our pictures are a
  NoDrive page in each theme (light, dark, high contrast light and dark, and light and dark side by
  side for "System default"), drawn with plain shapes and no words so they suit every language, with
  the Nourax logo as it is, only smaller; "Reduced motion" is a ball that has stopped, and "Dyslexia
  font" a line of text in that font, as upstream. `branding/theme-previews/make-previews.py` draws
  them (Pillow; `--font` is the theming app's `fonts/OpenDyslexic-Regular.otf`, SIL OFL 1.1); run it
  again after changing it and commit the pictures. The upstream files stay where they are and are
  never shown.
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
page that hold the source of its placeholder pictures, upstream copyright line included.

**What is left, on purpose:**

- Fallback values in stylesheets that are never used while the theming app works: the static
  `apps/theming/css/default.css` (upstream primary blue), and `var(--…, <upstream blue or logo>)`
  defaults in `core/css/guest.css` and in the Calendar and Forms stylesheets. The theming app defines
  every one of these variables on every page. `scripts/check-branding.sh --only css` lists them.
- `PRODID:-//Nextcloud/Nextcloud CalDAV Server//EN` inside calendar invitation files: a program id that
  calendar programs do not show.
- An upload error text written in English inside the dav app ("Expected filesize of … (from Nextcloud
  client)"), shown only when an upload breaks off half way.
- Boards that Deck made before the welcome board was switched off, including the owner's, if any:
  people's data. They can be renamed or deleted by their owners.
- Example cards that accounts got before the Nourax example contact was in place, and calendars or
  task lists made in the upstream blue before the app recoloured new ones: people's data, so nothing
  changes them by itself. `occ nourax_branding:example-contact --existing --all` and
  `occ nourax_branding:calendar-colours --all` list them; with `--apply` (or `--user UID --apply` for
  one account) they change them. `scripts/check-branding.sh --server` counts the calendars (INFO).
- The Administration overview's release name (admin page only; see the admin table below).

**Check:** `scripts/check-branding.sh CREDENTIALS_FILE` (pages, theming, share, dav, errors) and, on the
server, `sudo scripts/check-branding.sh /etc/nourax/qa/qa-t3-1.netrc --server` (also config and mail).

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

What the audit found so far, and the fix:

| Found | Fix |
|---|---|
| Personal settings > Language & locale: a "Help translate" link to the upstream project's translations | `branding/custom.css` hides that row |
| Arabic: the login page, the public link pages and the other signed-out pages ran left to right (core sets `dir` only on signed-in pages) | nourax_branding `PageDirectionMiddleware` sets `dir="rtl"`; `custom.css` for the few error pages drawn outside the app framework |
| Arabic: the WebDAV page (`/remote.php/dav` in a browser) was plain text, left to right | nourax_branding `Dav/BrandedGetPlugin.php` answers a small HTML page with its language and direction |
| NoNotes showed the upstream phone-app badges (a link with the upstream name) while `scripts/configure.sh` ran: it writes `custom.css` first, and the app steps in `configure.d` add their hiding rules minutes later | `custom.css` holds a copy of those rules (NoNotes badges and marker, the upstream-blue colour swatch in every colour picker, NoGantt's default project colour) |
| The sparkle icon of Nourax AI (its dialog and page, the Text and NoBoard editors' menus) has a gradient stop in the upstream dark blue, in the light theme; the scanner had counted the `<stop>` as not drawn | `custom.css` draws gradient stops in the upstream blues in Nourax cobalt; `scan-page.js` treats an SVG's gradients and patterns as drawn when the SVG is, and checks SVG colours as computed |
| A new account's NoContacts opened the example contact "Leon Green" with the website `www.nextcloud.com` (the audit's main account opened its own test contact first, and the fresh pass did not open NoContacts) | the Nourax example contact (`occ nourax_branding:example-contact`); the fresh pass opens NoContacts and reads every card |
| A new account's first NoTasks list ("Tasks", "المهام") was in the upstream blue `#0082C9`, in NoTasks and in NoCalendar's task lists (the main account already had a list) | new calendars in an upstream blue get the site colour (`CalendarColourListener`); the fresh pass opens NoTasks, then NoCalendar, and reads every calendar's colour |
| Accounts made through the nourax_api app (admin API, `/v1/provision`, the demo accounts) still got the NoBoard welcome board: user_oidc makes them without `UserCreatedEvent`, and their first sign-in is an app password, which sends no `UserFirstTimeLoggedInEvent` | `NewAccountListener` also sets Deck's `firstRun` to `no` on every sign-in (`PostLoginEvent`) when it is unset |

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
| `deck` (NoBoard) | 1.19.1 | A welcome board is made on a person's first visit. Its title, "Welcome to Nextcloud Deck!", is a translation, but its card texts come from a fixed file inside the app and name the upstream 15 times. | The text sweep renames the title. The nourax_branding app sets the person's Deck setting `firstRun` to `no` when it is unset: as soon as an account is made, and on every sign-in (login form, "Log in with Nourax", app password), which also covers accounts the nourax_api app makes. So no welcome board is made. Boards that already exist are people's data and stay. |
| `tasks` (NoTasks) | 0.18.1 | A person's first task list is made in the upstream blue `#0082C9` (it reads a theming field Nextcloud 35 no longer has), shown in NoTasks and in NoCalendar. | The nourax_branding app gives every new calendar in an upstream blue the site colour (links and assets). |
| `federatedfilesharing` | 2.0.0 | Personal settings > Sharing: the Federated Cloud ID, "Share with me via Nextcloud" and "share it" buttons pointing at nextcloud.com/sharing; "Add to your Nextcloud" on public share pages. | Always on. Sharing with other servers is off while privacy between organisations is on (`60-org-privacy.sh`), which hides all of it. When it is on: the texts are swept, "Add to your …" uses the product name, and the "share it" buttons point at our help page (links and assets). |
| `settings` | 2.0.0 | 40 texts with the upstream name, the Help page, the developer notice with social links, the "Reasons" PDF button, links to docs.nextcloud.com. | Always on. Text sweep, plus links and assets: our notice in place of the developer notice, `/settings/help` goes to our help page, the PDF answers 404, help links open our help page. |
| `theming` | 3.0.0 | Accessibility paragraph links; two backgrounds in the picker credited to "Nextcloud GmbH"; the theme previews of Appearance and accessibility (the upstream logo, and a header in the upstream blue); "Adjust the Nextcloud theme"; the upstream blue in the Assistant gradient; app summaries such as "A Calendar app for Nextcloud" in the app manifests. | Always on. Links and assets (CSS, the two backgrounds left out, our own theme previews, blue and manifests fixed where they are made), text sweep. |
| `dav` | 2.0.0 | The page shown when `/remote.php/dav` is opened in a browser; the sample calendar event; the example contact's website (`www.nextcloud.com`); some error texts. | Always on. Links and assets (our own WebDAV page text, the Nourax example contact), text sweep. |
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
| `settings` (Administration overview) | 2.0.0 | A release name written into a template, "Nextcloud Hub 26 Summer". | Not fixed: admin page only. A copy of that whole template in the theme would hide upstream changes to it after an update. |
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
