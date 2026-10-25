# Extra apps

Apps added on top of the base workspace. They all come from the app store and are installed and
switched on by `scripts/configure.d/50-apps.sh` (run by `sudo scripts/configure.sh`).

The app store always gives the newest release for this server version; occ can't choose one. So
the script logs each app's version and prints a `WARNING` when it is not the release we tested:

| App id | Shown as | Tested release | Licence |
|---|---|---|---|
| `groupfolders` | Team folders | 23.0.1 | AGPL-3.0-or-later |

In the commands below, `OCC` means, on the server:

```
cd /opt/nourax/basic-office-infra
OCC() { sudo docker compose exec -T -u www-data app php occ "$@"; }
```

## Team folders

A team folder belongs to the workspace, not to one person. An admin gives one or more groups access
to it. Every member then sees it at the top level of their NoDrive, and the files stay there when
someone leaves the group. People outside those groups don't see it at all.

- **The name is the folder's place.** A team folder called `Sales` shows as `/Sales` in every
  member's NoDrive. Renaming the team folder renames it for everyone. A member can't rename or
  move it themselves.
- **Rights per group:** read, write (edit and create), share and delete. In the API they are bits:
  read 1, edit 2, create 4, delete 8, share 16. 31 means all of them, and it is what a group gets
  when it is added.
- **Our settings:** advanced permissions (rights per subfolder or per person) stay off, and there
  is no quota. Both can be set per folder later.
- **Storage:** each team folder is a storage of its own in the database
  (`object::store:object::groupfolder:<id>.amazon::nourax-drive`), and its files are objects in the
  same R2 bucket `nourax-drive` as everyone else's (`urn:oid:<file id>`). The nightly backups cover them. Each team folder has its own
  trash and version history; the app's background jobs expire old ones.
- **Where people see it:** in NoDrive, in the file list and under "Team folders" in the left
  column. Admins manage them under Administration settings, "Team folders" (the admin pages only
  open from the owner's IP, WAF rule 1).

- **Names on screen:** what members see (the folder itself and the "Team folders" view) names no
  upstream product. The admin page has a few app-store texts that do (the delegation note and the
  app description); only admins see them, and the branding sweep (`docs/branding.md`) covers them.

Team folders for real teams are made by Task 6 (`docs/teams.md`) through the app's API or occ.

### occ commands

```
OCC groupfolders:create "Sales"                         # prints the new folder's id
OCC groupfolders:group <id> <group> read write share delete   # give a group access; list the rights
OCC groupfolders:group <id> <group> read                # the same group, read only
OCC groupfolders:group <id> <group> --delete            # take a group's access away (files stay)
OCC groupfolders:quota <id> 50GB                        # or: unlimited
OCC groupfolders:rename <id> "Sales team"
OCC groupfolders:list --output=json                     # all team folders, groups and rights
OCC groupfolders:list --user <uid>                      # the ones one person can see
```

`groupfolders:group` with no rights gives read only.

**Deleting a team folder deletes all its files, versions and trash.** It is never done by an
agent: it needs the owner's yes (`OCC groupfolders:delete <id>`).

### HTTP API

For Task 6. All paths are under `https://drive.nourax.org/index.php/apps/groupfolders`. Every call
sends the header `OCS-APIRequest: true` and asks for JSON (`Accept: application/json` or
`?format=json`). Only admins (or people the admins delegate in the Team folders settings) may
change anything. Bodies are form fields or JSON.

| Call | Body | What it does |
|---|---|---|
| `GET /folders` | | All team folders (admins); for others only their own |
| `GET /folders/{id}` | | One team folder |
| `POST /folders` | `mountpoint` | Make a team folder; the answer has its `id` |
| `POST /folders/{id}/groups` | `group` | Give a group access, with all rights (31) |
| `POST /folders/{id}/groups/{group}` | `permissions` (number) | Change a group's rights |
| `DELETE /folders/{id}/groups/{group}` | | Take a group's access away (files stay) |
| `POST /folders/{id}/quota` | `quota` (bytes; `-3` = no limit) | Set the size limit |
| `POST /folders/{id}/mountpoint` | `mountpoint` | Rename it |
| `DELETE /folders/{id}` | | Delete it with all its files: owner-yes only |

A folder in the answer (inside `ocs.data`) looks like
`{"id":1,"mount_point":"Sales","quota":-3,"acl":false,"size":24,"groups":{"sales":31},…}`
(`-3`: no limit).

**Errors come back with HTTP 200.** These routes answer in the old OCS style: the HTTP status is
200 and the real result is `ocs.meta.statuscode` (100 = OK, 403, 404, …) with a message in
`ocs.meta.message`. Check that field, not the HTTP status.

**Password confirmation.** Every call that changes something (all except the two `GET`s) is marked
"password confirmation required". A request signed in with an app password can't confirm a
password, so the server refuses it: `ocs.meta.statuscode` 403, "Password confirmation is
required" (tested on 2026-10-25 with a QA app password; this check runs before the admin check, so
an admin's app password gets the same answer). Two ways that work:

- **In the server (recommended for Task 6's `nourax_api` app):** call the app's own service
  `OCA\GroupFolders\Folder\FolderManager`: `createFolder($mountPoint): int`,
  `addApplicableGroup($id, $gid)`, `setGroupPermissions($id, $gid, $permissions)`,
  `setFolderQuota($id, $bytes)`, `renameFolder($id, $mountPoint)`, `getFolder($id)`,
  `mountPointExists($mountPoint)`. It isn't a public API, so check it again when the app's major
  version changes.
- **From a script on the server:** the `occ` commands above.

The browser admin page works too, because a browser session confirms the password in a dialog.
