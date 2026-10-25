# Search inside files and the virus scanner

Two add-ons that run as their own services next to the file server. Both are internal: neither
publishes a port, and only the containers of this stack can reach them.

| Part | Service | What runs | Set up by |
|---|---|---|---|
| Virus scanner | `clamav` (clamd on TCP 3310) | ClamAV 1.5.4 (`clamav/clamav:1.5.4_base`) and the files_antivirus app 6.5.0 | `compose.yaml`, `config/clamav/`, `scripts/configure.d/50-virus-scanner.sh` |

In the commands below, `OCC` means, on the server:

```
cd /opt/nourax/basic-office-infra
OCC() { sudo docker compose exec -T -u www-data app php occ "$@"; }
```

## Virus scanner

ClamAV checks the files people put into NoDrive. The files_antivirus app hands each upload to
clamd while it arrives and refuses it when ClamAV finds something. A timer on the server scans
the files that could not be checked during the upload, and every file again after 28 days with
the newest signatures. Those later finds are only logged: nothing stored is ever deleted
automatically (switching that on needs the owner's yes, see below).

### What is scanned, and when

| What | When | If ClamAV finds something |
|---|---|---|
| A file uploaded in one piece: web page uploads up to 50 MiB, the desktop and phone apps for smaller files, WebDAV `PUT`, files the editors save (same path, not tested separately) | While it arrives | The upload is refused and nothing is stored |
| A file uploaded in parts (web page uploads over 50 MiB, big files from the desktop app) | Within about 15 minutes after the upload, by the stored-file scan | The file stays; the find is logged and shown in the owner's Activity |
| Every stored file | Again 28 days after its last scan | Logged and shown, the file stays |
| NoMail attachments | When NoMail asks (`POST /v1/scan`, [docs/nomail-api.md](nomail-api.md)) | NoMail decides |

Why uploads in parts are checked later: the file server sends each part straight to the R2
bucket, and R2 joins the parts itself, so the content of the finished file never passes through
the app. This was tested (see "Tests" below): an EICAR test file uploaded in parts was stored,
and the next stored-file scan found it and logged it.

Team folders are scanned the same way as everyone's own files.

### What people see

- **An infected upload** fails. NoDrive's Activity list then says
  *"File containing Eicar-Test-Signature detected"* with *"The file has been removed"* (the
  signature name changes with what was found). The file is not stored.

  The error text that comes back with the failed upload is not the virus message. The app's
  message (*"Virus … is detected in the file. Upload cannot be completed."*) is lost on its way
  through the object storage, and the server answers `400 Bad Request` with its generic
  *"Expected filesize of … but read … and wrote … -1 byte …"* text. That text still names the
  upstream product; the branding sweep (Task 3, `docs/branding.md`) rewrites it.
- **An infected file uploaded over an existing file with the same name**: the upload is refused
  and the existing file is removed as well, without going to Deleted files. This is how the app
  works when the files live in object storage. The old content is kept as a version: upload any
  file with the same name again, open its Versions and restore the older one (tested: the new
  upload listed the old 17-byte version).
- **A find by the stored-file scan**: the file stays where it is. The owner's Activity says
  *"File /path/name is infected with …"*, and the server log has
  `Infected file found (during background scan)`.
- **ClamAV not answering** (stopped, restarting, or out of memory): every upload is refused with
  *"No connection to anti virus. Upload cannot be completed."* (HTTP 415), and nothing is
  stored. No scanner, no upload. After a restart clamd answers again within about 30 seconds.

None of these texts names the upstream product, apart from the generic upload error above.

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

clamd itself (`config/clamav/clamd.conf`, mounted read-only): TCP 3310 with no `TCPAddr`, on the
container's own addresses, and no published port, so only this stack's containers reach it;
`MaxThreads 4`; `StreamMaxLength`/`MaxFileSize 110M`;
`MaxScanSize 400M`; `ConcurrentDatabaseReload no`; `SelfCheck 3600`; logs in
`/var/log/clamav/clamd.log` inside the container, rotated at 5 MB.

The image's own `CLAMD_CONF_*` variables are not used: its start script appends them to the
config file again on every start.

### The stored-file scan (`nourax-virus-scan.timer`)

The app has a background job of its own, run by the cron container, but it does not work with
object storage: it counts version files, editor files and upload leftovers (which it can never
open) as "not scanned yet", picks the same 10 of them on every run and never reaches new files.
On the live server it found 41 such entries, more than enough to block it for good.

The full scan command has no such limit, so `50-virus-scanner.sh` installs a host timer from
`config/clamav/` that runs it 15 minutes after each run ends:

```
systemctl list-timers nourax-virus-scan.timer       # next run
sudo systemctl start nourax-virus-scan.service      # run it now
journalctl -u nourax-virus-scan.service -n 20       # what the last runs did ("scanned N files")
OCC files_antivirus:status                          # files waiting for a scan
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
4. Test: as a QA account, upload the EICAR test string in parts (see "Tests"), run
   `sudo systemctl start nourax-virus-scan.service`, and check that the file is gone.

### For the NoMail API (Task 6)

clamd answers on `clamav:3310` inside the compose network. Use `zINSTREAM` with chunks of at most
a few MB each and at most 110 MB per stream (`StreamMaxLength`); more and clamd closes the
connection with `INSTREAM size limit exceeded`. `VERSION` gives the signature date. During a
reload a scan waits (see above), so allow a read timeout of at least 120 seconds.

### Tests

The EICAR test string is built on the server from two halves, so it is never stored on a PC
(Windows Defender would remove it). All tests ran on 2026-10-25 as the QA account `qa-t5-1`
through `https://drive.nourax.org/remote.php/dav`:

| Test | Result |
|---|---|
| clamd `VERSION`, asked from the file server's container | `ClamAV 1.5.4/28163/Sat Oct 24 06:26:10 2026` |
| `OCC files_antivirus:test` | regular text ✓, EICAR ✓ (its third step, see `50-virus-scanner.sh`) |
| A normal file, one `PUT` | 201, and it reads back unchanged |
| EICAR, one `PUT` | 400 with the generic text, not stored (404); Activity: *File containing Eicar-Test-Signature detected*; log: `Infected file deleted. Eicar-Test-Signature` |
| EICAR over an existing file | 400; the existing file is gone (404) and not in Deleted files; its old content is kept as a version |
| EICAR into a team folder | 400, not stored |
| EICAR uploaded in parts (chunked upload, as for big files) | 201, stored; the timer's next run: `scanned 1 files`, log `Infected file found (during background scan)`, the file stays, Activity: *File /t5-av/chunked-eicar-2.txt is infected with Eicar-Test-Signature* |
| The app's own cron job | The next 10 files it would take were all version and editor files (none of them the new upload), as described above |
| Upload while ClamAV is stopped | 415 *No connection to anti virus. Upload cannot be completed.*, not stored; 201 again 30 seconds after the restart |
| A 95 MB stream straight to clamd (NoMail's largest) | `stream: OK` in 7.3 seconds |
| A 120 MB stream | `INSTREAM size limit exceeded. ERROR` |
| `RELOAD`, then a scan | The scan answered after 46 seconds; memory 28 MB to 974 MB |
| Port 3310 on the server itself | `sudo ss -ltn \| grep -c ':3310'` prints 0 |
| Container settings | `docker inspect` shows memory 1677721600 (1600m) and OOM score 400 |
| Automatic server reboot (unattended upgrades) | ClamAV healthy again about a minute after boot, signatures reused from the volume |
