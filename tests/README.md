# Tests

`curl` tests for the NoMail API and the NoMail contract (U1–U5). They run **on the server**, from
the checkout, with sudo, because they read keys from `/etc/nourax/secrets`:

```
cd /opt/nourax/basic-office-infra
sudo tests/nomail-api-health.sh
sudo tests/api-provision.sh
sudo tests/admin-api.sh      # after api-provision.sh, which makes qa-t6-1
sudo tests/admin-people.sh   # after admin-api.sh, which makes the QA organisations and teams
sudo tests/privacy.sh        # after admin-api.sh; once the org privacy step is on (docs/teams.md)
```

Each prints one `PASS` or `FAIL` line per check and exits 0 only when every check passed.

One test runs **on the owner's PC** instead (Git Bash, from the repo, after `npm ci` in `worker/`),
because it starts the upload Worker with `wrangler dev`:

```
tests/worker-local.sh <scratch-dir>                                                  # local Worker
WORKER_URL=https://drive.nourax.org/nomail-upload tests/worker-local.sh <scratch-dir>  # after the route's yes
```

| Test | What it checks |
|---|---|
| `nomail-api-health.sh` | `GET /v1/health`: no key and a wrong key give 401, the right key gives 200 with `status`, `clamav` and `signatures`; `Cache-Control: no-store` |
| `api-provision.sh` | `POST /v1/provision`: a new "Log in with Nourax" account with the four `/NoMail` folders and a 72-character app password; a second call rotates the password (the old one gets 401) and leaves exactly one `NoMail` app password; refused ids (`nodrive`, `admin`, uppercase), bad bodies, a local account, a disabled account; 413 over 16 KB; 429 with `Retry-After` past 60 calls a minute. Runs `provision-request.php` first. |
| `provision-request.php` | The input rules of `/v1/provision` on their own, inside the app container: `sudo docker compose exec -T app php < tests/provision-request.php` |
| `admin-api.sh` | The admin API, part 1 ([docs/teams.md](../docs/teams.md)): signing (no, wrong, old, reused signatures give 401), 413 over 2 MB, input rules, organisations and teams with every step, "Sales" and "Sales 2" in one organisation, renames that keep every id, stale versions, 423 while a call runs, a member's cards and what they can reach (`qa-t6-5`, added with occ), the audit. QA organisations and teams `qa-t6-*` only. |
| `admin-people.sh` | The admin API, part 2: people PUT and GET (input rules, joins, a lead's rights, stale versions), what a member reaches (the team books are read-only: every write gets 403 and nothing is written; people outside the team still get 404), leaving a team (the shares, the lock, the ONLYOFFICE drop, access gone at once, files stay), a move, an email change that keeps the uid, the last member leaving (team archived, nothing deleted), leaving the organisation (disabled, every app password revoked so WebDAV and OCS answer 401, links hidden, kept 30 days, the delete job off and harmless) and coming back (links on own files work again; the test removes its one link), the reconcile call (dry run and fix; the drift job is run first, so it cannot undo the occ change in the middle of the test), the drift repair, 423 for parallel PUTs, the audit. |
| `privacy.sh` | Privacy between organisations ([docs/teams.md](../docs/teams.md#privacy-between-organisations)), as `qa-t6-1` of QA organisation A sees `qa-t6-3` and `qa-t6-5` of organisation B: the settings and disabled apps, sharee search (wide, exact id, email and name), autocomplete, the contacts menu, address books (no system book; the directory holds org A only), principal search, files, full-text and contacts search, profiles (404), the Teams app (off), and file, calendar, address book and board shares (refused for org B, allowed for `qa-t6-2`). `PRIVACY_BASELINE=1` runs only the reading checks, for a picture before the step is on. Runs `org-privacy-rules.php` first. |
| `org-privacy-rules.php` | nourax_api's rule for calendar, address book and board shares (`OrgPrivacy`), asked directly with the real QA accounts as if privacy were on: `sudo docker compose exec -T -u www-data app php < tests/org-privacy-rules.php` |
| `worker-local.sh` | The upload Worker ([worker/README.md](../worker/README.md), [docs/nomail-contract.md](../docs/nomail-contract.md#upload-worker)), end to end into the live Drive as `qa-t6-2`: a 120 MiB file in three chunks (50, 50 and 20 MiB) through `/start`, `/chunks/{n}`, `GET /chunks` and `/finish`, then a WebDAV `PROPFIND` (size, file id) and a SHA-256 compare of a `GET`; CORS (`mail.nourax.org` 204 with the header, `evil.example` 403), tickets missing or sealed with another key (401), bad chunk numbers and lengths (400), a taken name (409), cancelling. A second, 6 MiB upload (chunks of 5 and 1 MiB) finishes too early on purpose: before any chunk and then with chunk 2 missing, each 409 `incomplete` with the missing numbers and no file, the session still usable; then a finish sent twice (201 both times, the same file id) and a size and SHA-256 compare. Locally it runs the Worker with `wrangler dev --env-file` and a throwaway key; with `WORKER_URL` it tests the live route and pipes the real key from the server into `mint-ticket.mjs` on stdin. It reads `qa-t6-2`'s netrc file from the server over SSH into the scratch folder. |

`lib.sh` holds the shared helpers (`check`, `api`, `provision`, `propfind`, `save_netrc`, `qa_local_user`, `take_lock`, `drift_job_now`).

## Rules the tests keep

- **No secret on a command line or in the output.** The API key goes to curl as a config line
  through `-K <(...)`; app passwords go into netrc files and curl reads them with `--netrc-file`.
  The output shows statuses, lengths and yes/no, never a key or a password.
- **QA accounts only.** Ids are `qa-t6-N`. `lib.sh` stops the test if any request would name the
  owner's account.
- **The server-change lock.** A test that adds or changes accounts or writes under `/etc` takes
  `/run/nourax-deploy.lock` for its whole run (`take_lock`). Set `NOURAX_LOCK_HELD=1` when you
  already hold it.

## QA accounts and their logins

Kept in `/etc/nourax/qa/` (root, folder 0700, files 0600), never in the repo:

| Account | Made by | File | Used for |
|---|---|---|---|
| `qa-t6-1` | `api-provision.sh`, through the API | `qa-t6-1.netrc` (its newest `NoMail` app password) | U1–U5 and the other contract tests |
| `qa-t6-2` | `api-provision.sh` (part 1), now the people API | `qa-t6-2.netrc` | A team lead in `admin-people.sh`; the uploads of `worker-local.sh` (its `/NoMail/Sent/<yyyy-mm>/worker-120m*.bin` and `worker-gaps*.bin` files) |
| `qa-t6-3` | the people API | `qa-t6-3.netrc` | Leaves its last team and the organisation, then comes back, in `admin-people.sh` |
| `qa-t6-4` | `admin-people.sh`, through `/v1/provision` | none | Added to a team with occ: the drift the reconcile takes out again |
| `qa-t6-5` | `admin-api.sh`, through `/v1/provision` | `qa-t6-5.netrc` | Added with occ in part 1's member checks; the drift job takes it out again |
| `qa-t6-8` | `api-provision.sh`, through the API | none | The disabled-account check; left disabled |
| `qa-t6-9` | `api-provision.sh`, as a local account | `qa-t6-9.pass` | The local-account check; left disabled |

Running `api-provision.sh` again gives `qa-t6-1` a new app password and updates its netrc file.
Deleting QA accounts needs the owner's yes.
