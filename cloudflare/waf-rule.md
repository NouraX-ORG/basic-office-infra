# WAF custom rules

Zone `nourax.org` is on the Free plan (5 custom rules; NoMail's rule uses one). This deployment adds
**two** rules, placed after NoMail's rule. Action of both: **Block**.

| # | Rule | Id |
|---|---|---|
| 1 | Login, admin and office only from the owner's IP | `1f4cc937db19427d9a3233b987e151d5` |
| 2 | Office server-to-server and info paths closed to the internet | `4b382b6caf57475fa9fb4bc2d63c90cd` |

## Rule 1: login, admin and office only from the owner's IP

Description: `Nourax Workspace: login, admin and office only from the owner's IP`

```
(http.host eq "office.nourax.org" and not ip.src in {77.102.150.30})
or
(http.host eq "drive.nourax.org" and not ip.src in {77.102.150.30}
 and (starts_with(http.request.uri.path, "/login")
   or starts_with(http.request.uri.path, "/index.php/login")
   or starts_with(http.request.uri.path, "/lostpassword")
   or starts_with(http.request.uri.path, "/index.php/lostpassword")
   or starts_with(http.request.uri.path, "/settings")
   or starts_with(http.request.uri.path, "/index.php/settings")
   or starts_with(http.request.uri.path, "/ocs/v1.php/cloud/users")
   or starts_with(http.request.uri.path, "/ocs/v2.php/cloud/users")
   or starts_with(http.request.uri.path, "/ocs/v1.php/cloud/groups")
   or starts_with(http.request.uri.path, "/ocs/v2.php/cloud/groups"))
 and not http.request.uri.path in {"/login/v2" "/login/v2/poll" "/index.php/login/v2" "/index.php/login/v2/poll"})
```

## What stays open to everyone, and why

| Path | Who needs it | Protection |
|---|---|---|
| `/s/…`, `/index.php/s/…`, `/public.php/…` and the page assets | Anyone with a share link, email image proxies | Unguessable share token, optional password, Nextcloud brute-force throttling |
| `/remote.php/dav/…` (files, calendars, contacts, chunked uploads) | Phone and desktop apps away from home, NoMail's server | App password only (`token_auth_enforced`); brute-force throttling |
| `/ocs/v2.php/apps/files_sharing/…`, `/ocs/v2.php/cloud/user`, `/ocs/v2.php/core/apppassword` | NoMail's server | App password |
| `/index.php/login/v2` and `/index.php/login/v2/poll` (exact paths) | NoMail's server starts and polls the "Connect Drive" flow | Starting a flow grants nothing; finishing it needs the login page, which is locked |
| `/nomail-upload/…` | NoMail page in the owner's browser (runs the `nodrive-upload` Worker) | Sealed upload ticket |

Everything interactive is locked: the login page (including the page that approves a new phone,
desktop app or NoMail connection), password reset, all settings pages and the user/group admin API.
A browser that already has a session keeps working away from home; a new login needs the owner's IP.
ONLYOFFICE (`office.nourax.org`) is fully locked: the editors only open from the owner's IP.

Because the lock covers only interactive pages, **NoMail's Edge Functions need no secret header
and no Access token**: every path they call is in the table above.

## Rule 2: office server-to-server and info paths closed to the internet

Description: `Nourax Workspace: office server-to-server and info paths closed to the internet`
Added 2026-10-24. It applies to everyone, the owner included, and stays when rule 1's IP lock on
`office.nourax.org` is lifted for other users.

ONLYOFFICE Docs answers more than the editors need. NoDrive calls the conversion, command and
health services over the Docker network (`http://onlyoffice/`), so the public address never needs
them. The browser needs only the editor files, the plugin files, `plugins.json`/`themes.json`, the
editing connection (`/<version>/doc/<key>/c/`), `/cache/files/` (signed links),
`/downloadas`, `/savefile`, `/upload`, `/printfile`, `/downloadfile` and the Nourax AI relay
(`/nourax-ai/`).

The Free plan has no regular expressions, so each path is matched with `wildcard`
(case-insensitive), at the root or after the version prefix (`/10.0.0-<tag>/`). The paths are
anchored on full segments because the AI plugin's own files contain `/internal/`, and
`/cache/files/` is left out because its last segment is the document's title.

```
http.host eq "office.nourax.org" and not starts_with(http.request.uri.path, "/cache/files/") and (
 http.request.uri.path in {"/" "/index.html"}
 or http.request.uri.path wildcard r"/welcome*"
 or http.request.uri.path wildcard r"*/welcome"
 or http.request.uri.path wildcard r"*/welcome/*"
 or http.request.uri.path wildcard r"/example*"
 or http.request.uri.path wildcard r"/info*"
 or http.request.uri.path wildcard r"*/info/info.json"
 or http.request.uri.path wildcard r"/internal*"
 or http.request.uri.path wildcard r"*/internal/cluster/*"
 or http.request.uri.path wildcard r"*/internal/connections/*"
 or http.request.uri.path wildcard r"*/healthcheck"
 or http.request.uri.path wildcard r"*/healthcheck/"
 or http.request.uri.path wildcard r"*/convertservice.ashx"
 or http.request.uri.path wildcard r"*/convertservice.ashx/"
 or http.request.uri.path wildcard r"*/converter"
 or http.request.uri.path wildcard r"*/converter/*"
 or http.request.uri.path wildcard r"*/commandservice.ashx"
 or http.request.uri.path wildcard r"*/commandservice.ashx/"
 or http.request.uri.path wildcard r"*/command"
 or http.request.uri.path wildcard r"*/command/"
 or http.request.uri.path wildcard r"*/docbuilder"
 or http.request.uri.path wildcard r"*/docbuilder/*"
 or http.request.uri.path wildcard r"*/convert-to"
 or http.request.uri.path wildcard r"*/convert-to/*"
 or http.request.uri.path wildcard r"*/hosting/*"
 or http.request.uri.path wildcard r"*/wopi/files/*"
 or http.request.uri.path wildcard r"*/dummycallback"
 or http.request.uri.path wildcard r"*/dummycallback/"
 or http.request.uri.path wildcard r"*/ai-proxy"
 or http.request.uri.path wildcard r"*/ai-proxy/*"
)
```

| Closed | What it is |
|---|---|
| `/`, `/index.html`, `/welcome…` | ONLYOFFICE's start page (names the product and version) |
| `/example…` | The demo app (not running) |
| `/info…`, `/internal…` | Statistics and cluster controls (ONLYOFFICE's nginx also allows them only locally) |
| `/healthcheck` | Health check; NoDrive uses the internal address |
| `ConvertService.ashx`, `/converter`, `CommandService.ashx`, `/command`, `/docbuilder` | Server-to-server API (needs the shared secret anyway) |
| `/lool`/`/cool` `convert-to`, `/hosting/…`, `/wopi/files/…` | WOPI (switched off) |
| `/dummyCallback` | Test endpoint |
| `/ai-proxy` | ONLYOFFICE's own AI proxy; Nourax AI uses its own relay instead |

Checked on 2026-10-24 from the owner's IP:
- **Still 200:** `api.js`, the editor page, the sdkjs bundle, a font, the AI plugin's `internal/` files, `plugins.json`, `themes.json`, the editing connection and `/baseurl`.
- **Now 403:** all 27 closed paths, at the root, with the version prefix, in other letter cases and with a trailing slash.
- **Connector:** `occ onlyoffice:documentserver --check` still reports "successfully connected".

## When the home IP changes

Edit the IP in both this rule and NoMail's rule (Cloudflare dashboard → nourax.org → Security →
Security rules), and in the server firewall (`sudo ufw allow from <new-ip> to any port 22 proto tcp`,
then delete the old rule). Re-check with `curl -s https://api.ipify.org`.
