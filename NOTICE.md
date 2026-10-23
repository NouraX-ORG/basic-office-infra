# Credits and third-party software

Nourax Workspace is a deployment of the following software. This repository does not contain or
modify their source code; the Docker images are pulled unchanged from their official publishers.

| Software | Used as | Licence | Source |
|---|---|---|---|
| Nextcloud Server 35 | Files, sharing, WebDAV/CalDAV/CardDAV, web interface | AGPL-3.0-or-later | https://github.com/nextcloud/server |
| Nextcloud Docker image | Container build of Nextcloud | AGPL-3.0 | https://github.com/nextcloud/docker |
| Nextcloud Calendar, Contacts, Deck, Mail | NoCalendar, NoContacts, NoBoard, Mail | AGPL-3.0-or-later | https://github.com/nextcloud |
| Custom CSS (`theming_customcss`) | Theme CSS from the app store | AGPL-3.0-or-later | https://github.com/juliushaertl/theming_customcss |
| ONLYOFFICE Docs Community Edition 10 | Document, spreadsheet and presentation editors | AGPL-3.0 with additional terms | https://github.com/ONLYOFFICE/DocumentServer |
| ONLYOFFICE AI plugin | The "AI Tools" tab in the editors (downloaded unchanged by `scripts/onlyoffice-plugins.sh`) | AGPL-3.0 | https://github.com/ONLYOFFICE/onlyoffice.github.io |
| ONLYOFFICE connector for Nextcloud | Links Nextcloud and ONLYOFFICE Docs | AGPL-3.0 | https://github.com/ONLYOFFICE/onlyoffice-nextcloud |
| PostgreSQL 18 | Database | PostgreSQL Licence | https://www.postgresql.org |
| Redis 8 | Cache and file locking | AGPL-3.0 / RSALv2 / SSPLv1 (tri-licence) | https://github.com/redis/redis |
| cloudflared | Cloudflare Tunnel connector | Apache-2.0 | https://github.com/cloudflare/cloudflared |

ONLYOFFICE Docs is shown under its own name in the editors, as its licence asks.

"Nextcloud" and the Nextcloud logo are trademarks of Nextcloud GmbH. "ONLYOFFICE" is a trademark
of Ascensio System SIA. Nourax Workspace is not affiliated with or endorsed by either company.

The Nourax name and logo (`branding/nourax-logo.png`) belong to Nourax and are not covered by the
AGPL licence of this repository's own files.
