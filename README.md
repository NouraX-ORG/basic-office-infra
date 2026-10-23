# Nourax Workspace (basic-office-infra)

Everything needed to rebuild **Nourax Workspace**: Nourax's self-hosted files, calendar, contacts,
office documents and boards at `https://drive.nourax.org`.

| Product | What it is | Built on |
|---|---|---|
| **NoDrive** | Files, folders, share links, version history | Nextcloud Files |
| **NoCalendar** | Calendars, synced to phones (CalDAV) | Nextcloud Calendar |
| **NoContacts** | Address book, synced to phones (CardDAV) | Nextcloud Contacts |
| **NoBoard** | Kanban boards with a Gantt view | Nextcloud Deck |
| **ONLYOFFICE** | Documents, spreadsheets, presentations (docx, xlsx, pptx) | ONLYOFFICE Docs Community Edition |

Nourax Workspace runs the **official, unmodified [Nextcloud](https://nextcloud.com) server**
(AGPL-3.0) and the **official [ONLYOFFICE Docs](https://www.onlyoffice.com) Community Edition**
(AGPL-3.0), configured and themed for Nourax. This repository contains no copy of their source
code: it holds the deployment files, the theme settings, the scripts and the docs.
See [NOTICE.md](NOTICE.md) for credits and [docs/branding.md](docs/branding.md) for the trademark rules we follow.

## How it fits together

```
Browser · phone and desktop apps · NoMail · email recipients (share links)
        │  https://drive.nourax.org  and  https://office.nourax.org
        ▼  Cloudflare (DNS, proxy, WAF; Worker on /nomail-upload/*)
Cloudflare Tunnel ──► cloudflared container (the server opens no inbound ports)
        ▼
Server (Ubuntu 24.04, Docker Compose):
  Nextcloud 35 (apache) · cron · PostgreSQL 18 · Redis 8 · ONLYOFFICE Docs 10
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
| `cloudflare/` | Tunnel routes and the WAF rule, as applied |
| `tests/` | `curl` tests for the NoMail contract (attach, share links, save, images, cancel) |
| `docs/` | Architecture, operations, upgrades, restore, security, branding, NoMail contract |

## Rebuild from scratch

Follow [docs/operations.md](docs/operations.md#first-install). In short:

1. A fresh Ubuntu 24.04 server with 8 GB RAM; run `scripts/bootstrap-server.sh <your-ip>` as root.
2. Create the R2 buckets and keys, the Cloudflare Tunnel and the DNS routes.
3. `sudo scripts/secrets.sh init|admin|r2|backup-r2|tunnel|age`, then `sudo scripts/setup.sh`.
4. Turn on two-factor login for the admin account, add the WAF rule, enable the backup timers.

## Licence

[AGPL-3.0](LICENSE). Nextcloud and ONLYOFFICE keep their own copyright and licences.
"Nextcloud" and "ONLYOFFICE" are trademarks of their owners and are used here only to say what
this deployment runs; Nourax Workspace is not affiliated with or endorsed by them.
