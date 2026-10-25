# Nourax Workspace (basic-office-infra)

Everything needed to rebuild **Nourax Workspace**: Nourax's self-hosted files, calendar, contacts,
office documents and boards at `https://drive.nourax.org`.

| Product | What it is |
|---|---|
| **NoDrive** | Files, folders, share links, version history |
| **NoCalendar** | Calendars, synced to phones (CalDAV) |
| **NoContacts** | Address book, synced to phones (CardDAV) |
| **NoBoard** | Kanban boards with a Gantt view |
| **ONLYOFFICE** | Documents, spreadsheets, presentations (docx, xlsx, pptx), with Nourax AI in the AI tab |
| **NoGantt** | Project plans on a Gantt timeline, with dependencies, resources and NoBoard cards ([docs/gantt.md](docs/gantt.md)) |
| **Team folders** | Folders that belong to a group: every member reads and writes the same files ([docs/apps.md](docs/apps.md#team-folders)) |
| **Virus scanner** | Every upload is checked by ClamAV; infected files are refused ([docs/search-and-antivirus.md](docs/search-and-antivirus.md#virus-scanner)) |
| **Search inside files** | The words inside documents (docx, xlsx, pptx, odt, pdf, txt, md) are found in the normal search box, only by people who can open the file ([docs/search-and-antivirus.md](docs/search-and-antivirus.md#search-inside-files)) |
| **NoMail** | Nourax mail: the NoMail entry in the app menu, right after NoBoard, opens it in a new tab (`nextcloud-apps/nourax_branding/`) |
| **Organisations and teams** | Each team gets a group, a team folder, a read-only team address book, a calendar and a board, made by the admin-only teams API ([docs/teams.md](docs/teams.md)) |
| **Privacy between organisations** | People find, autocomplete and share (files, calendars, address books, boards) only with people of their own organisation; on since 2026-10-25 (`ORG_PRIVACY=on`, [docs/teams.md](docs/teams.md#privacy-between-organisations)) |
| **NoTasks** | To-do lists with due dates, priorities and subtasks; lists are calendars, so they sync to phones (CalDAV) ([docs/apps.md](docs/apps.md#notasks)) |
| **NoNotes** | Markdown notes, kept as files in the person's NoDrive folder `Notes`, so they are backed up, scanned and searchable ([docs/apps.md](docs/apps.md#nonotes)) |
| **NoForms** | Forms, surveys and polls, shared with people, groups or a public link; answers export to a spreadsheet ([docs/apps.md](docs/apps.md#noforms)) |
| **Suspicious login and audit log** | People get a notification when their account is signed in from an unusual address; sign-ins, file actions, shares and account changes go to an audit log on the server ([docs/apps.md](docs/apps.md#suspicious-login)) |
| **Retention and automatic tagging** | Rules that tag files as they arrive (for example NoMail attachments) and delete files with a given tag after a set time; installed with no rules, each rule needs the owner's yes ([docs/apps.md](docs/apps.md#retention)) |
| **Nourax AI** | The Assistant (top bar, NoDrive, text editor): chat, summaries, headlines, rewording, translation; Nourax AI models only, no keys or AI settings for anyone, each request charged to the person's Nourax AI budget in NIG; "not available yet" until NIG's key is in ([docs/assistant.md](docs/assistant.md)) |
| **Demo accounts** | Two demo organisations (Demo Alpha, Demo Beta), four teams of seven and 24 people with demo files, kept for the owner to see how teams, team folders and privacy work ([docs/teams.md](docs/teams.md#demo-accounts)) |
| **No chat or video calls** | Talk is not part of Nourax Workspace; if anyone switches it on, `configure.sh` switches it off again ([docs/apps.md](docs/apps.md#no-talk)) |

Nourax Workspace is an independently branded, white-label deployment built from open-source
software (AGPL-3.0 and others) under its licences; it is not affiliated with or endorsed by the
authors of that software. This repository holds the deployment files, the theme settings, the
scripts and the docs; the Docker images come unchanged from their publishers.
See [NOTICE.md](NOTICE.md) for the licensed software and [docs/branding.md](docs/branding.md) for the
naming rules we follow.

## How it fits together

```
Browser · phone and desktop apps · NoMail · email recipients (share links)
        │  https://drive.nourax.org  and  https://office.nourax.org
        ▼  Cloudflare (DNS, proxy, WAF; Workers on /nomail-upload/* and office /nourax-ai/*)
Cloudflare Tunnel ──► cloudflared container (the server opens no inbound ports)
        ▼
Server (Ubuntu 24.04, Docker Compose):
  file server (PHP, Apache) · cron · PostgreSQL 18 · Redis 8 · ONLYOFFICE Docs 10
        ▼  primary object storage (S3 API)
Cloudflare R2 bucket "nourax-drive"     (nightly encrypted backups → "nourax-workspace-backups")
```

Details: [docs/architecture.md](docs/architecture.md).

## Repository layout

| Path | Contents |
|---|---|
| `compose.yaml`, `.env.example` | The Docker Compose stack and its non-secret settings |
| `config/nextcloud/zz-nourax.config.php` | Nextcloud settings (R2 tuning, chunk size, security, defaults) |
| `branding/` | The Nourax logo, the theme CSS and the welcome files for new accounts |
| `scripts/` | Server hardening, secrets, first setup, backup, restore, update |
| `systemd/` | Timers for the nightly backup and the weekly file mirror |
| `worker/` | `nodrive-upload`, the Cloudflare Worker that takes big uploads from NoMail |
| `nextcloud-apps/nourax_api/` | The NoMail API (health, accounts, virus scan) at `https://drive.nourax.org/apps/nourax_api`, and the admin-only teams API (never an MCP tool), as an app inside the file server ([docs/nomail-api.md](docs/nomail-api.md), [docs/teams.md](docs/teams.md), [docs/nomail-contract.md](docs/nomail-contract.md)) |
| `nextcloud-apps/nourax_antivirus/` | Makes the virus scanner work fully with files in R2: the plain refusal message, scans of uploads in parts, a stored-file scan that is never stuck ([docs/search-and-antivirus.md](docs/search-and-antivirus.md#the-helper-app-nourax_antivirus)) |
| `office-ai/` | `nourax-office-ai`, the Cloudflare Worker that relays the editors' AI requests to NIG ([docs/office-ai.md](docs/office-ai.md)) |
| `ai-relay/` | The Nourax AI relay for the Assistant (compose service `ai-relay`, Python standard library) and the AI task worker (`ai-worker`), with tests against a stand-in for NIG ([docs/assistant.md](docs/assistant.md)) |
| `config/onlyoffice/` | The editors' Nourax AI settings |
| `config/clamav/` | The virus scanner's settings (clamd, freshclam) and the stored-file scan timer ([docs/search-and-antivirus.md](docs/search-and-antivirus.md#virus-scanner)) |
| `config/elasticsearch/` | Search inside files: the index template, the search account's role, the indexing loop of the `jobs` service, and the memory report `memory-report.sh` ([docs/search-and-antivirus.md](docs/search-and-antivirus.md#search-inside-files)) |
| `cloudflare/` | Tunnel routes and the WAF rule, as applied |
| `tests/` | `curl` tests, run on the server: the NoMail API (health, accounts, virus scan), the admin teams API, privacy between organisations, the NoMail contract U1–U5 with a 1.1 GB upload, and the upload Worker; `qa-wrapup.sh` archives and disables the QA objects after a round ([tests/README.md](tests/README.md)) |
| `docs/` | Architecture, operations, upgrades, restore, security, branding, NoMail contract |

## Rebuild from scratch

Follow [docs/operations.md](docs/operations.md#first-install). In short:

1. A fresh Ubuntu 24.04 server with 8 GB RAM; run `scripts/bootstrap-server.sh <your-ip>` as root.
2. Create the R2 buckets and keys, the Cloudflare Tunnel and the DNS routes.
3. `sudo scripts/secrets.sh init|admin|r2|backup-r2|tunnel|age`, then `sudo scripts/setup.sh`.
4. Turn on two-factor login for the admin account, add the WAF rule, enable the backup timers.

## Licence

[AGPL-3.0](LICENSE). The software listed in [NOTICE.md](NOTICE.md) keeps its own copyright and
licences. Trademarks belong to their owners.
