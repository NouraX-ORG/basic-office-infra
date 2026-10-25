# Search inside files and the virus scanner

Two add-ons that run as their own services next to the file server. Both are internal: neither
publishes a port, and only the containers of this stack can reach them.

| Part | Service | What runs | Set up by |
|---|---|---|---|
| Virus scanner | `clamav` (clamd on TCP 3310) | ClamAV 1.5.4 (`clamav/clamav:1.5.4_base`), the files_antivirus app 6.5.0 and our helper app `nourax_antivirus` | `compose.yaml`, `config/clamav/`, `nextcloud-apps/nourax_antivirus/`, `scripts/configure.d/50-virus-scanner.sh` |

In the commands below, `OCC` means, on the server:

```
cd /opt/nourax/basic-office-infra
OCC() { sudo docker compose exec -T -u www-data app php occ "$@"; }
```

## Virus scanner

ClamAV checks the files people put into NoDrive. The files_antivirus app hands each upload to
clamd while it arrives and refuses it when ClamAV finds something. Our helper app
`nourax_antivirus` scans uploads in parts as soon as they are joined, and refuses infected ones
the same way. A timer on the server scans the files that could not be checked during the upload,
and every file again after 28 days with the newest signatures. Those later finds are only
logged: nothing stored is ever deleted automatically (switching that on needs the owner's yes,
see below).

### What is scanned, and when

| What | When | If ClamAV finds something |
|---|---|---|
| A file uploaded in one piece: web page uploads up to 50 MiB, the desktop and phone apps for smaller files, WebDAV `PUT`, files the editors save (same path, not tested separately) | While it arrives | The upload is refused (HTTP 415) and nothing is stored |
| A file uploaded in parts, up to 256 MiB (web page uploads over 50 MiB, big files from the desktop and phone apps) | Right after R2 joins the parts, before the upload is answered | The upload is refused (HTTP 415) and the file is removed |
| A file uploaded in parts over 256 MiB, or any upload in parts made while ClamAV was not answering | Within about 15 minutes, by the stored-file scan | The file stays; the find is logged and shown in the owner's Activity |
| Every stored file | Again 28 days after its last scan | Logged and shown, the file stays |
| NoMail attachments | When NoMail asks (`POST /v1/scan`, [docs/nomail-api.md](nomail-api.md)) | NoMail decides |

Why uploads in parts need their own scan: the file server sends each part straight to the R2
bucket, and R2 joins the parts itself, so the content of the finished file never passes through
files_antivirus. `nourax_antivirus` therefore reads the joined file back from R2 and streams it
to clamd while the upload's last request (the WebDAV `MOVE`) still waits for its answer. That
takes a few seconds per 100 MiB (250 MiB: the `MOVE` took 27 seconds, see "Tests"). Cloudflare
gives up on a request after 100 seconds, so only files up to 256 MiB are scanned this way
(`chunked_scan_max_size`); bigger ones are left to the stored-file scan, as before.

Team folders are scanned the same way as everyone's own files.

### What people see

- **An infected upload** fails with HTTP 415 and the message
  *"Virus Eicar-Test-Signature is detected in the file. Upload cannot be completed."* (the
  signature name changes with what was found; the message is translated). NoDrive's Activity
  list then says *"File containing Eicar-Test-Signature detected"* with *"The file has been
  removed"*. The file is not stored. This is the same for uploads in one piece and in parts.

  Without `nourax_antivirus` the message was lost: with R2 the object store wraps the virus
  error in a generic one, and the server answered `400 Bad Request` with its generic
  *"Expected filesize of … but read … and wrote … -1 byte …"* text, which names the upstream
  product. The helper app takes the virus message back out. That generic text still exists in
  the server for real network failures; it is one of the l10n strings Task 3's branding sweep
  rewrites (`scripts/check-branding.sh --server` lists it under `apps/dav`).
- **An infected file uploaded over an existing file with the same name**: the upload is refused
  and the existing file is removed as well, without going to Deleted files. This is how
  files_antivirus works when the files live in object storage, and the helper app does the same
  for uploads in parts. The old content is kept as a version: upload any file with the same name
  again, open its Versions and restore the older one (tested: the new upload listed the old
  17-byte version).
- **A find by the stored-file scan**: the file stays where it is. The owner's Activity says
  *"File /path/name is infected with …"*, and the server log has
  `Infected file found (during background scan)`.
- **ClamAV not answering** (stopped, restarting, or out of memory): every upload in one piece is
  refused with *"No connection to anti virus. Upload cannot be completed."* (HTTP 415), and
  nothing is stored. No scanner, no upload. An upload in parts is kept (its data is already
  stored by then) and left to the stored-file scan. After a restart clamd answers again within
  about 30 seconds.

None of these texts names the upstream product.

### Our settings

Set by `scripts/configure.d/50-virus-scanner.sh` on every `sudo scripts/configure.sh`. The step
only switches the app on once clamd answers, because the app refuses all uploads while it can't
reach ClamAV.

| Setting | Value | Why |
|---|---|---|
| `av_mode`, `av_host`, `av_port` | `daemon`, `clamav`, `3310` | clamd over TCP inside the compose network |
| `av_stream_max_length` | `104857600` (100 MiB) | Below clamd's `StreamMaxLength 110M`; a bigger file goes in several streams |
| `av_max_file_size` | `-1` | No file is too big to scan |
| `av_infected_action` | `only_log` | Finds by the stored-file scan are logged, never deleted |
| `av_background_scan` | `true` | The stored-file scan is on (upload scanning is always on) |
| `av_block_unreachable` | `true` | Uploads are refused while ClamAV is down |
| `nourax_antivirus` `chunked_scan_max_size` | `268435456` (256 MiB) | Biggest upload in parts that is scanned before the upload is answered; `0` switches that scan off |

A changed setting reaches the web server within 3 seconds (it keeps app settings that long).

clamd itself (`config/clamav/clamd.conf`, mounted read-only): TCP 3310 with no `TCPAddr`, on the
container's own addresses, and no published port, so only this stack's containers reach it;
`MaxThreads 4`; `StreamMaxLength`/`MaxFileSize 110M`;
`MaxScanSize 400M`; `ConcurrentDatabaseReload no`; `SelfCheck 3600`; logs in
`/var/log/clamav/clamd.log` inside the container, rotated at 5 MB.

The image's own `CLAMD_CONF_*` variables are not used: its start script appends them to the
config file again on every start. After a change to a file in `config/clamav/`, run
`sudo docker compose restart clamav` (a `git pull` replaces the file, and the running container
keeps reading the old one until it starts again). Uploads are refused for the 30 seconds or so
that clamd needs to load.

### The helper app (`nourax_antivirus`)

files_antivirus was written for files on the server's own disk. With R2 three things went wrong,
and `nextcloud-apps/nourax_antivirus` (our app, switched on by `50-virus-scanner.sh`) puts them
right. It has no pages and nothing to set apart from `chunked_scan_max_size`.

| What went wrong with R2 | What the helper app does |
|---|---|
| The virus message of a refused upload was lost, and people got a generic size-mismatch error | A storage wrapper on the object store passes the virus message on, so the upload gets 415 with it |
| Uploads in parts were never scanned while they arrived | The same wrapper reads the joined file back and scans it before the upload is answered (up to 256 MiB) |
| The stored-file scan got stuck: it counted version, trash, editor and upload-leftover entries (which it can never open) as "not scanned yet" and picked the same ones on every run, so a capped run (`--max N`, or the app's own cron job) never reached new files. On the live server there were 43 such entries | It enters those entries as scanned: every 5 minutes (cron job), before each timer run, and on every `configure.sh` |

The third point follows the app's own rule: it leaves out everything outside `files/` in a
person's storage, but only recognises a person's storage by the name `home::…`. With R2 those
storages are `object::user:…`, and team folders `object::store:object::groupfolder:…`. A trash
item put back into `files/` is scanned again with the 28-day rescan.

```
OCC nourax_antivirus:skip-internal                  # enter such entries now ("entered N ...")
OCC config:app:get nourax_antivirus chunked_scan_max_size
```

### The stored-file scan (`nourax-virus-scan.timer`)

Files that could not be checked while they arrived (uploads in parts over 256 MiB, or made while
ClamAV was not answering) and every file 28 days after its last scan are scanned by
`occ files_antivirus:background-scan`. Two things run it:

- the app's own background job, in the cron container, a batch of files at a time;
- a host timer from `config/clamav/`, installed by `50-virus-scanner.sh`, that runs the full
  command without a limit 15 minutes after each run ends (and `nourax_antivirus:skip-internal`
  just before it).

```
systemctl list-timers nourax-virus-scan.timer       # next run
sudo systemctl start nourax-virus-scan.service      # run it now
journalctl -u nourax-virus-scan.service -n 20       # what the last runs did ("scanned N files")
OCC files_antivirus:status                          # files waiting for a scan
OCC files_antivirus:background-scan --max 20 -v     # scan up to 20 waiting files now, by name
```

### Signatures

freshclam runs in the same container. It checks for new signatures twice a day
(`FRESHCLAM_CHECKS=2` in `compose.yaml`), downloads only the changes, and tells clamd to load
them. The first start downloads the whole set (about 110 MB) into the `clamav_db` volume; later
starts reuse it.

The date of the newest signatures is in clamd's `VERSION` answer:

```
sudo docker compose exec -T clamav sh -c 'echo VERSION | nc localhost 3310'
ClamAV 1.5.4/28163/Sat Oct 24 06:26:10 2026
```

That is the engine version, the number of the daily signature file, and its date. The NoMail
API's `GET /v1/health` gives the same date as `signatures`. freshclam's log:
`sudo docker compose logs clamav | grep -i daily`.

### Memory and reloads

| | Today (3.7 GB server) |
|---|---|
| clamd with all signatures loaded | about 950–975 MB (container) |
| Container limit (`CLAMAV_MEM_LIMIT` in `.env`) | 1600m |
| OOM score | `oom_score_adj: 400`, so the kernel stops ClamAV before the database or the file server |
| Loading after a start or a server reboot | 25–30 seconds; the very first start also downloads the signatures (4 seconds here) |
| Reload after a signature update | Scans wait about 45 seconds; memory stays at the normal level |

`ConcurrentDatabaseReload no` makes clamd drop the old signatures and load the new ones in
place (measured: 28 MB at the lowest, 974 MB at the highest). During that time it scans nothing:
a scan sent right after a `RELOAD` waited 46 seconds and then answered. The file server waits up
to 60 seconds for an answer, so an upload in that minute is only slower; if a reload ever took
longer, that upload would be refused and has to be tried again. Reloads come at most twice a day.
Loading a second copy next to the first, which is clamd's default, would need about twice the
memory. For the same reason freshclam's own test load of new signatures is off
(`TestDatabases no` in `config/clamav/freshclam.conf`).

Memory of the whole server, before ClamAV and after it was running with the app set up (the
editors' container also grew after the reboot in between):

| | Used | Available | Swap used |
|---|---|---|---|
| Before (03:15) | 1247 MB | 2572 MB | 5 MB |
| After (03:41) | 2067 MB | 1751 MB | 0 MB |

**After the upgrade to 8 GB:** set `CLAMAV_MEM_LIMIT=3000m` in `.env`; in `config/clamav/` change
`ConcurrentDatabaseReload` (clamd.conf) and `TestDatabases` (freshclam.conf) to `yes`, so scans no
longer pause during reloads and new signatures are test-loaded first (each needs a second copy of
the signatures in memory, about 1 GB); then `sudo docker compose up -d clamav`.

### Switching on deletion (needs the owner's yes)

Today a file that the stored-file scan finds infected stays where it is. To have such files
deleted instead:

1. In `scripts/configure.d/50-virus-scanner.sh`, change `av_infected_action --value=only_log` to
   `--value=delete`, commit, and run `sudo scripts/configure.sh` on the server.
2. What changes: the stored-file scan deletes each infected file for good. It does not go to
   Deleted files, and the owner's Activity says *"The file has been removed"*. Upload refusals
   don't change.
3. Undo: set it back to `only_log` and run `configure.sh` again (files already deleted stay
   deleted).
4. Test: the scan before the upload is answered would refuse the test file, so switch it off for
   the test: `OCC config:app:set nourax_antivirus chunked_scan_max_size --value=0 --type=integer`
   and wait 3 seconds. As a QA account, upload the EICAR test string in parts (see "Tests"), run
   `sudo systemctl start nourax-virus-scan.service`, and check that the file is gone. Then set
   `chunked_scan_max_size` back to `268435456`.

### For the NoMail API (Task 6)

clamd answers on `clamav:3310` inside the compose network. Use `zINSTREAM` with chunks of at most
a few MB each and at most 110 MB per stream (`StreamMaxLength`); more and clamd closes the
connection with `INSTREAM size limit exceeded`. `VERSION` gives the signature date. During a
reload a scan waits (see above), so allow a read timeout of at least 120 seconds.

### Tests

The EICAR test string is built on the server (from two halves, or from the string written
backwards), so it is never stored on a PC (Windows Defender would remove it). An upload in parts
is the WebDAV chunked upload that the web page and the desktop and phone apps use for big files:
`MKCOL` of an upload folder, a `PUT` per part, then `MOVE` of `.file` to the target. All tests
ran on 2026-10-25 as the QA account `qa-t5-1` through `https://drive.nourax.org/remote.php/dav`;
the test files were removed afterwards:

| Test | Result |
|---|---|
| clamd `VERSION`, asked from the file server's container | `ClamAV 1.5.4/28163/Sat Oct 24 06:26:10 2026` |
| `OCC files_antivirus:test` | regular text ✓, EICAR ✓; its third step (EICAR with letters after it) shows ❌ and the command exits 1, because ClamAV follows the EICAR rule (see `50-virus-scanner.sh`) |
| A normal file, one `PUT` | 201, and it reads back unchanged |
| EICAR, one `PUT` | 415, body *Virus Eicar-Test-Signature is detected in the file. Upload cannot be completed.*, no "Nextcloud" in it; not stored (404); Activity: *File containing Eicar-Test-Signature detected* / *The file has been removed*; log: `Infected file deleted. Eicar-Test-Signature` |
| EICAR over an existing file | 415 with the same text; the existing file is gone (404) and not in Deleted files; its old content is kept as a version |
| EICAR into a team folder | 415 with the same text, not stored (404) |
| A normal 12 MiB file in three parts, to the person's files and to a team folder | `MOVE` 201; reads back unchanged; entered as scanned |
| A normal 250 MiB file in five 50 MiB parts | `MOVE` 201 after 27.4 seconds (reading back and scanning); reads back unchanged |
| EICAR in parts: new file, into a team folder, over an existing file | `MOVE` 415 with the same text, not stored (404); Activity as above; log `Infected file deleted. … (upload in parts)` |
| `DELETE` of the upload folder after a refused `MOVE` (what a client does to clean up) | 204 |
| EICAR in parts with `chunked_scan_max_size` 0 (as for a file over 256 MiB), then `OCC files_antivirus:background-scan --max 20 -v` | `MOVE` 201, stored; the command printed `scanning /qa-t5-1/files/t5-av/fix-bg-eicar.txt`, `scanned 1 files`; log `Infected file found (during background scan)`; the file stays (207, EICAR md5); Activity *File /t5-av/fix-bg-eicar.txt is infected with Eicar-Test-Signature* |
| Stuck entries | Before: 43 version, editor and upload entries were "not scanned yet". `skip-internal` entered 43; afterwards `OCC files_antivirus:status` says 0 unscanned files, and new version entries were entered by the 5-minute cron job by themselves |
| Upload while ClamAV is stopped | 415 *No connection to anti virus. Upload cannot be completed.*, not stored; 201 again 30 seconds after the restart |
| A 95 MB stream straight to clamd (NoMail's largest) | `stream: OK` in 7.3 seconds |
| A 120 MB stream | `INSTREAM size limit exceeded. ERROR` |
| `RELOAD`, then a scan | The scan answered after 46 seconds; memory 28 MB to 974 MB |
| Port 3310 on the server itself | `sudo ss -ltn \| grep -c ':3310'` prints 0 |
| Container settings | `docker inspect` shows memory 1677721600 (1600m) and OOM score 400 |
| Automatic server reboot (unattended upgrades) | ClamAV healthy again about a minute after boot, signatures reused from the volume |
