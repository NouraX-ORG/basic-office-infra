# Tests

`curl` tests for the NoMail API and the NoMail contract (U1–U5). They run **on the server**, from
the checkout, with sudo, because they read keys from `/etc/nourax/secrets`:

```
cd /opt/nourax/basic-office-infra
sudo tests/nomail-api-health.sh
sudo tests/api-provision.sh
sudo tests/api-scan.sh       # on the server only: it sends the EICAR test string
sudo tests/admin-api.sh      # after api-provision.sh, which makes qa-t6-1
sudo tests/admin-people.sh   # after admin-api.sh, which makes the QA organisations and teams
sudo tests/privacy.sh        # after admin-api.sh; once the org privacy step is on (docs/teams.md)
sudo tests/nomail-contract.sh  # U1-U5 as qa-t6-1, after api-provision.sh; a few minutes, adds a 1.1 GB file
sudo tests/qa-wrapup.sh      # at the end of a round: QA teams archived, QA accounts disabled
```

The owner's kept demo accounts (not QA objects; [docs/teams.md](../docs/teams.md#demo-accounts)):

```
sudo tests/demo-accounts.sh          # make what is missing, put back what changed, then check
sudo tests/demo-accounts.sh --check  # read only
```

After a wrap-up, start the next round with `sudo tests/qa-wrapup.sh --enable` (it enables
`qa-t6-1` to `qa-t6-5` again).

Each prints one `PASS` or `FAIL` line per check and exits 0 only when every check passed.

One test runs **on the owner's PC** instead (Git Bash, from the repo, after `npm ci` in `worker/`),
because it starts the upload Worker with `wrangler dev`:

```
tests/worker-local.sh <scratch-dir>                                                  # local Worker
WORKER_URL=https://drive.nourax.org/nomail-upload tests/worker-local.sh <scratch-dir>  # after the route's yes
```

And one checks, from the owner's PC, how the owner signs in as a demo person (the sign-in page is
open only to the owner's address):

```
tests/demo-signin.sh [keys-file]   # default ../_private/nourax-workspace-demo-accounts.txt
```

| Test | What it checks |
|---|---|
| `nomail-api-health.sh` | `GET /v1/health`: no key and a wrong key give 401, the right key gives 200 with `status`, `clamav` and `signatures`; `Cache-Control: no-store` |
| `api-provision.sh` | `POST /v1/provision`: a new "Log in with Nourax" account with the four `/NoMail` folders and a 72-character app password; a second call rotates the password (the old one gets 401) and leaves exactly one `NoMail` app password; refused ids (`nodrive`, `admin`, uppercase), bad bodies, a local account, a disabled account; 413 over 16 KB; 429 with `Retry-After` past 60 calls a minute. Runs `provision-request.php` first. |
| `api-scan.sh` | `POST /v1/scan` and ClamAV in `GET /v1/health` ([docs/nomail-api.md](../docs/nomail-api.md#post-v1scan)): waits up to 90 minutes for ClamAV (exit 2, BLOCKED, if it never comes); health (clamav ok, signatures at most 2 days old); no key 401; EICAR infected (built in memory from two halves and piped, never a file); 5 MiB clean; exactly 99,614,720 bytes through Cloudflare clean within 45 s; 96 MiB, one byte over and a 96 MiB chunked body straight to the app container (Cloudflare caps bodies at 100 MB) give 413 `too_large`; 4 scans at once give 2 clean and 2 × 429 `scanner_busy` with `Retry-After: 30`; no stored copy (file table, data folder, PHP and clamd temporary files, no file name or EICAR bytes in the log); the audit rows; and, under the lock, `clamav_host=clamav-missing` gives scan 503 and health ok with clamav unavailable, then the setting is put back. Needs no QA account. Runs `clamd-instream.php` first. |
| `clamd-instream.php` | The `INSTREAM` exchange of `/v1/scan` (`ClamdClient`) against a fake clamd, a forked child on a socket pair, inside the app container: `sudo docker compose exec -T app php < tests/clamd-instream.php`. The fake answers with the SHA-256, piece count and largest piece it received, so the test sees every byte arrive once, in order, in 1 MiB pieces; also the exact limit and one byte over, clamd's size-limit error, odd answers, a closed connection and a silent clamd. |
| `provision-request.php` | The input rules of `/v1/provision` on their own, inside the app container: `sudo docker compose exec -T app php < tests/provision-request.php` |
| `admin-api.sh` | The admin API, part 1 ([docs/teams.md](../docs/teams.md)): signing (no, wrong, old, reused signatures give 401), 413 over 2 MB, input rules, organisations and teams with every step, "Sales" and "Sales 2" in one organisation, renames that keep every id, stale versions, 423 while a call runs, a member's cards and what they can reach (`qa-t6-5`, added with occ), the audit. QA organisations and teams `qa-t6-*` only. |
| `admin-people.sh` | The admin API, part 2: people PUT and GET (input rules, joins, a lead's rights, stale versions), what a member reaches (the team books are read-only: every write gets 403 and nothing is written; people outside the team still get 404), leaving a team (the shares, the lock, the ONLYOFFICE drop, access gone at once, files stay), a move, an email change that keeps the uid, the last member leaving (team archived, nothing deleted), leaving the organisation (disabled, every app password revoked so WebDAV and OCS answer 401, links hidden, kept 30 days, the delete job off and harmless) and coming back (links on own files work again; the test removes its one link), the reconcile call (dry run and fix; the drift job is run first, so it cannot undo the occ change in the middle of the test), the drift repair, 423 for parallel PUTs, the audit. |
| `privacy.sh` | Privacy between organisations ([docs/teams.md](../docs/teams.md#privacy-between-organisations)), as `qa-t6-1` of QA organisation A sees `qa-t6-3` and `qa-t6-5` of organisation B: the settings and disabled apps, sharee search (wide, exact id, email and name), autocomplete, the contacts menu, address books (no system book; the directory holds org A only), principal search, files, full-text and contacts search, profiles (404), the Teams app (off), and file, calendar, address book and board shares (refused for org B, allowed for `qa-t6-2`). `PRIVACY_BASELINE=1` runs only the reading checks, for a picture before the step is on. Runs `org-privacy-rules.php` first. |
| `org-privacy-rules.php` | nourax_api's rule for calendar, address book and board shares (`OrgPrivacy`), asked directly with the real QA accounts as if privacy were on: `sudo docker compose exec -T -u www-data app php < tests/org-privacy-rules.php` |
| `nomail-contract.sh` | The NoMail contract U1–U5 ([docs/nomail-contract.md](../docs/nomail-contract.md#u1u5-what-nomail-does-with-a-persons-drive)): runs the five scripts below in order as `qa-t6-1` with its `NoMail` app password, through Cloudflare like NoMail, and prints one `PASS` or `FAIL` line per use case and the U2 timing. `sudo tests/nomail-contract.sh u3 u4 u5` runs some of them. No server change, so no lock. |
| `u1-list-download.sh` | U1: `PROPFIND` (Depth 1, NoMail's body `propfind.xml`) of `/` and `/NoMail/` lists the folders and a 1 MiB file with every property NoMail reads; `GET` gives 200, the `Content-Length` and the same SHA-256; a missing file 404. Leaves `/NoMail/qa-t6-u1-<time>.bin`. |
| `u2-big-upload.sh` | U2: a real chunked upload (v2) of 1,100,000,000 bytes (`U2_SIZE`) to `/NoMail/Sent/<yyyy-mm>/` in 21 chunks of 50 MiB, piped from `/dev/urandom` (nothing on disk): every chunk stored, the Drive holds chunks 1–21 with the right sizes before the `MOVE`, `MOVE` 201, the size, a full download with the same SHA-256; a link with `expireDate` today + 30 days (the `/s/<token>` page, the 303 of `/s/<token>/download` to `/public.php/dav/files/<token>`, ranged GETs of both with the right first 1024 bytes); a second link with a 20-character password, whose `/download` leads to the password page, never to the bytes. Prints the timing. Leaves `qa-t6-u2-big-<time>.bin` (1.1 GB) each run. |
| `u3-save-received.sh` | U3: as NoMail's `saveNewFile()`: `MKCOL` of each folder of `/NoMail/Received/<yyyy-mm>/` (201 or 405), the names in use, a `PUT` (201) of a name with a space and an umlaut, its size and type; a `PUT` to the same path replaces it (204) and a `GET` gives the new bytes. Leaves the file. |
| `u4-raw-image.sh` | U4: a PNG made in the script, put at `/NoMail/Images/<yyyy-mm>/<uuid>.png`, and a link without `expireDate` (expiration null); `/s/<token>/download` is one 303 with no body, then 200 `image/png` with the PNG's bytes and `nosniff`, with no login or cookie; also `/public.php/dav/files/<token>`, `/index.php/s/<token>/download`, `/s/<token>/preview` and the page. Leaves the file. |
| `u5-shares.sh` | U5: lists the shares (every public link passes NoMail's `readShare`) and finds the links U2 and U4 made; changes the first one as NoMail's `updatePublicShare()` does (a `PUT` with 90 days and a password, then the password taken off; the end date stays); deletes each (200); then a `GET` by id and a second `DELETE` give 404 (NoMail: already gone) and the list no longer has them; the first one's `/s/<token>` page gives 404. Removes only this run's links (run on its own, one it makes first). |
| `qa-wrapup.sh` | The end of a test round, under the lock: every `org:qa-t6*` organisation gets a reconcile with an empty state through the admin API (everybody leaves its teams and group, every team is archived: folder "<name> (archived)", board archived; the group, folder, files, book and calendar stay), checked with the status calls; then every `qa-t6-<number>` account is disabled with `occ user:disable` and checked. Deletes nothing. `--enable` enables `qa-t6-1` to `qa-t6-5` again for the next round. |
| `demo-accounts.sh` | The owner's kept demo data ([docs/teams.md](../docs/teams.md#demo-accounts)), through the signed admin API: organisations `demo-alpha` and `demo-beta`, four teams of seven, 24 people `demo-a01`..`demo-a12` and `demo-b01`..`demo-b12` (four of them in two teams), one lead per team; one "Demo sign-in" app password each, kept only in `/etc/nourax/demo/demo-accounts.txt` (0600; a key that still answers 207 is kept); a welcome note and an ONLYOFFICE document in each team folder and one read-only share inside Demo Alpha, written only when missing. The checks: accounts enabled with the right names, emails and groups, the leads, no drift, every key signs in, the file's shape and mode, the files, the share, and a first privacy look (Demo Alpha finds its own people, never Demo Beta's). Takes the lock itself, except with `--check`. Runs `admin-ids.php` first. Deletes nothing and never prints a key. |
| `demo-signin.sh` | On the owner's PC, for every account in the owner's copy of the demo keys ([docs/teams.md](../docs/teams.md#signing-in-as-a-demo-person)): the sign-in form (CSRF token, cookies, Origin) refuses the key and its reason is `invalidpassword`; WebDAV `PROPFIND` with the key 207; `/remote.php/webdav/` with the key 200 and a session; with only the session cookies the OCS user call names the person and `/apps/files/` is their page; the page's own Log out link ends the session and the key still answers 207. Also the 401 Basic prompt "Nourax Workspace". Changes nothing. |
| `admin-ids.php` | The id rules of the admin API and `/v1/provision`, inside the app container: `sudo docker compose exec -T app php < tests/admin-ids.php`. `demo-` ids are taken for organisations, teams and people, only together with a `demo-` organisation; `/v1/provision` and the scheduled delete still refuse them; the UUID and `qa-` rules are unchanged. |
| `propfind.xml` | NoMail's `PROPFIND` body (`PROPFIND_BODY` in `driveFiles.ts`), used by the U-scripts |
| `worker-local.sh` | The upload Worker ([worker/README.md](../worker/README.md), [docs/nomail-contract.md](../docs/nomail-contract.md#upload-worker)), end to end into the live Drive as `qa-t6-2`: a 120 MiB file in three chunks (50, 50 and 20 MiB) through `/start`, `/chunks/{n}`, `GET /chunks` and `/finish`, then a WebDAV `PROPFIND` (size, file id) and a SHA-256 compare of a `GET`; CORS (`mail.nourax.org` 204 with the header, `evil.example` 403), tickets missing or sealed with another key (401), bad chunk numbers and lengths (400), a taken name (409), cancelling. A second, 6 MiB upload (chunks of 5 and 1 MiB) finishes too early on purpose: before any chunk and then with chunk 2 missing, each 409 `incomplete` with the missing numbers and no file, the session still usable; then a finish sent twice (201 both times, the same file id) and a size and SHA-256 compare. Locally it runs the Worker with `wrangler dev --env-file` and a throwaway key; with `WORKER_URL` it tests the live route and pipes the real key from the server into `mint-ticket.mjs` on stdin. It reads `qa-t6-2`'s netrc file from the server over SSH into the scratch folder. |

`lib.sh` holds the shared helpers (`check`, `api`, `provision`, `propfind`, `save_netrc`, `qa_local_user`, `take_lock`, `drift_job_now`, and for U1–U5 `contract_setup`, `dav`, `dav_list`, `dav_field`, `ensure_folders`, `ocs`, `public_link`, `remember_share`).

## Rules the tests keep

- **No secret on a command line or in the output.** The API key goes to curl as a config line
  through `-K <(...)`; app passwords go into netrc files and curl reads them with `--netrc-file`.
  The output shows statuses, lengths and yes/no, never a key or a password.
- **QA accounts only.** Ids are `qa-t6-N`. `lib.sh` stops the test if any request would name the
  owner's account. The one exception is `demo-accounts.sh`, which keeps the owner's demo accounts
  (`demo-*`) the way they should be; no other test may touch those.
- **The server-change lock.** A test that adds or changes accounts or writes under `/etc` takes
  `/run/nourax-deploy.lock` for its whole run (`take_lock`). Set `NOURAX_LOCK_HELD=1` when you
  already hold it.

## QA accounts and their logins

Kept in `/etc/nourax/qa/` (root, folder 0700, files 0600), never in the repo:

| Account | Made by | File | Used for |
|---|---|---|---|
| `qa-t6-1` | `api-provision.sh`, through the API | `qa-t6-1.netrc` (its newest `NoMail` app password) | U1–U5 (`nomail-contract.sh`; it leaves `/NoMail/qa-t6-u1-*.bin`, `/NoMail/Sent/<yyyy-mm>/qa-t6-u2-big-*.bin`, `/NoMail/Received/<yyyy-mm>/qa-t6 Rechnung März *.pdf` and `/NoMail/Images/<yyyy-mm>/<uuid>.png`) and the other contract tests |
| `qa-t6-2` | `api-provision.sh` (part 1), now the people API | `qa-t6-2.netrc` | A team lead in `admin-people.sh`; the uploads of `worker-local.sh` (its `/NoMail/Sent/<yyyy-mm>/worker-120m*.bin` and `worker-gaps*.bin` files) |
| `qa-t6-3` | the people API | `qa-t6-3.netrc` | Leaves its last team and the organisation, then comes back, in `admin-people.sh` |
| `qa-t6-4` | `admin-people.sh`, through `/v1/provision` | none | Added to a team with occ: the drift the reconcile takes out again |
| `qa-t6-5` | `admin-api.sh`, through `/v1/provision` | `qa-t6-5.netrc` | Added with occ in part 1's member checks; the drift job takes it out again |
| `qa-t6-8` | `api-provision.sh`, through the API | none | The disabled-account check; left disabled |
| `qa-t6-9` | `api-provision.sh`, as a local account | `qa-t6-9.pass` | The local-account check; left disabled |
| `qa-t6-62` | a review run, through `/v1/provision` | none | A rename check ("QA t6 62 renamed"); left disabled |
| `qa-t6b-1` | `lib.sh` `qa_local_user`, a local account (Task 6b) | `qa-t6b-1.pass` | Once, the control for `demo-signin.sh`: the same sign-in form request with its password signs in (to `/apps/files/`); left disabled |

Running `api-provision.sh` again gives `qa-t6-1` a new app password and updates its netrc file.
`qa-wrapup.sh` disables all of them at the end of a round. Deleting QA accounts needs the owner's
yes.
