# Tests

`curl` tests for the NoMail API and the NoMail contract (U1–U5). They run **on the server**, from
the checkout, with sudo, because they read keys from `/etc/nourax/secrets`:

```
cd /opt/nourax/basic-office-infra
sudo tests/nomail-api-health.sh
sudo tests/api-provision.sh
sudo tests/admin-api.sh      # after api-provision.sh, which makes qa-t6-1
```

Each prints one `PASS` or `FAIL` line per check and exits 0 only when every check passed.

| Test | What it checks |
|---|---|
| `nomail-api-health.sh` | `GET /v1/health`: no key and a wrong key give 401, the right key gives 200 with `status`, `clamav` and `signatures`; `Cache-Control: no-store` |
| `api-provision.sh` | `POST /v1/provision`: a new "Log in with Nourax" account with the four `/NoMail` folders and a 72-character app password; a second call rotates the password (the old one gets 401) and leaves exactly one `NoMail` app password; refused ids (`nodrive`, `admin`, uppercase), bad bodies, a local account, a disabled account; 413 over 16 KB; 429 with `Retry-After` past 60 calls a minute. Runs `provision-request.php` first. |
| `provision-request.php` | The input rules of `/v1/provision` on their own, inside the app container: `sudo docker compose exec -T app php < tests/provision-request.php` |
| `admin-api.sh` | The admin API, part 1 ([docs/teams.md](../docs/teams.md)): signing (no, wrong, old, reused signatures give 401), 413 over 2 MB, input rules, organisations and teams with every step, "Sales" and "Sales 2" in one organisation, renames that keep every id, stale versions, 423 while a call runs, a member's cards and what they can reach, the audit. QA organisations and teams `qa-t6-*` only. |

`lib.sh` holds the shared helpers (`check`, `api`, `provision`, `propfind`, `save_netrc`, `qa_local_user`, `take_lock`).

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
| `qa-t6-2` | `api-provision.sh`, through the API | none | The disabled-account check; left disabled |
| `qa-t6-9` | `api-provision.sh`, as a local account | `qa-t6-9.pass` | The local-account check; left disabled |

Running `api-provision.sh` again gives `qa-t6-1` a new app password and updates its netrc file.
Deleting QA accounts needs the owner's yes.
