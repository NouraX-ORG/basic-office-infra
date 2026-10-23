# WAF custom rule: login, admin and office only from the owner's IP

Zone `nourax.org` is on the Free plan (5 custom rules; NoMail's rule uses one). This deployment adds
**one** rule, placed after NoMail's rule. Action: **Block**.

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

## When the home IP changes

Edit the IP in both this rule and NoMail's rule (Cloudflare dashboard → nourax.org → Security →
Security rules), and in the server firewall (`sudo ufw allow from <new-ip> to any port 22 proto tcp`,
then delete the old rule). Re-check with `curl -s https://api.ipify.org`.
