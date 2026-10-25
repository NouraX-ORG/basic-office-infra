# Licensed software

Nourax Workspace is built from the software below, used under its licences. The names identify
the software and its copyright holders, as the licences require; they are not part of the
Nourax Workspace brand, and none of their owners is affiliated with or endorses Nourax Workspace.

The Docker images are pulled unchanged from their publishers. Nourax Workspace configures and
themes them and switches some bundled apps off (`scripts/configure.sh`), which makes it a
modified version of the file server. Any change Nourax makes to third-party code is published in
this repository.

| Software | Used as | Licence | Source |
|---|---|---|---|
| Nextcloud Server 35 | Files, sharing, WebDAV/CalDAV/CardDAV, web interface | AGPL-3.0-or-later | https://github.com/nextcloud/server |
| Nextcloud Docker image | Container build of the file server | AGPL-3.0 | https://github.com/nextcloud/docker |
| Nextcloud Calendar, Contacts, Deck | NoCalendar, NoContacts, NoBoard | AGPL-3.0-or-later | https://github.com/nextcloud |
| Custom CSS (`theming_customcss`) | Theme CSS from the app store | AGPL-3.0-or-later | https://github.com/juliushaertl/theming_customcss |
| ONLYOFFICE Docs Community Edition 10 | Document, spreadsheet and presentation editors | AGPL-3.0 with additional terms | https://github.com/ONLYOFFICE/DocumentServer |
| ONLYOFFICE AI plugin | The AI tab in the editors (`scripts/onlyoffice-plugins.sh`), modified to use Nourax AI only (`scripts/patch-ai-plugin.py`) | AGPL-3.0 | https://github.com/ONLYOFFICE/onlyoffice.github.io |
| ONLYOFFICE connector | Links the file server and ONLYOFFICE Docs | AGPL-3.0 | https://github.com/ONLYOFFICE/onlyoffice-nextcloud |
| PostgreSQL 18 | Database | PostgreSQL Licence | https://www.postgresql.org |
| Redis 8 | Cache and file locking | AGPL-3.0 / RSALv2 / SSPLv1 (tri-licence) | https://github.com/redis/redis |
| cloudflared | Cloudflare Tunnel connector | Apache-2.0 | https://github.com/cloudflare/cloudflared |
| nc_Gantt 2.4.1 (`nc_gantt`, by fds2610) | NoGantt, the project planner; its texts reworded by theme translation overrides (`scripts/configure.d/55-gantt.sh`) | AGPL-3.0-or-later | https://codeberg.org/fds2610/NC-Gantt |
| Team Folders (`groupfolders`) 23 | Team folders shared by a group (`scripts/configure.d/50-apps.sh`) | AGPL-3.0-or-later | https://github.com/nextcloud/groupfolders |
| ClamAV 1.5 (official `clamav/clamav` image) | The virus scanner (compose service `clamav`, `config/clamav/`) | GPL-2.0-only | https://github.com/Cisco-Talos/clamav |
| Antivirus for files (`files_antivirus`) 6.5 | Sends uploads to ClamAV and refuses infected files (`scripts/configure.d/50-virus-scanner.sh`) | AGPL-3.0-or-later | https://github.com/nextcloud/files_antivirus |
| Elasticsearch 9.5 (official `elasticsearch` image) | The search engine for search inside files (compose service `elasticsearch`, `config/elasticsearch/`), used only inside this service | Elastic License 2.0 (binaries); source also AGPL-3.0 or SSPL-1.0 | https://github.com/elastic/elasticsearch |
| Full text search (`fulltextsearch`, `fulltextsearch_elasticsearch`, `files_fulltextsearch`) 35 | Indexes the text of files and NoBoard cards and adds the results to the search box (`scripts/configure.d/50-search.sh`) | AGPL-3.0-or-later | https://github.com/nextcloud/fulltextsearch |
| Tasks (`tasks`) 0.18 | NoTasks, the to-do lists (`scripts/configure.d/50-apps.sh`) | AGPL-3.0-or-later | https://github.com/nextcloud/tasks |
| Notes (`notes`) 6.1 | NoNotes, the Markdown notes (`scripts/configure.d/50-apps.sh`) | AGPL-3.0-or-later | https://github.com/nextcloud/notes |
| Forms (`forms`) 5.4 | NoForms, forms and surveys (`scripts/configure.d/50-apps.sh`) | AGPL-3.0-or-later | https://github.com/nextcloud/forms |

ONLYOFFICE Docs is shown under its own name in the editors, as its licence asks.

"Nextcloud" and "ONLYOFFICE" are trademarks of Nextcloud GmbH and Ascensio System SIA.

The Nourax name and logo (`branding/nourax-logo.png`) belong to Nourax and are not covered by the
AGPL licence of this repository's own files.
