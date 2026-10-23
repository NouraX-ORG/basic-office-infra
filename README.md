# Nourax Workspace (basic-office-infra)

Everything needed to rebuild **Nourax Workspace**: Nourax's self-hosted files, calendar, contacts,
office documents and boards at `https://drive.nourax.org`.

| Product | What it is |
|---|---|
| **NoDrive** | Files, folders, share links, version history |
| **NoCalendar** | Calendars, synced to phones (CalDAV) |
| **NoContacts** | Address book, synced to phones (CardDAV) |
| **NoBoard** | Kanban boards with a Gantt view |
| **ONLYOFFICE** | Documents, spreadsheets, presentations (docx, xlsx, pptx), with the AI Tools tab |

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
        ▼  Cloudflare (DNS, proxy, WAF; Worker on /nomail-upload/*)
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

[AGPL-3.0](LICENSE). The software listed in [NOTICE.md](NOTICE.md) keeps its own copyright and
licences. Trademarks belong to their owners.
