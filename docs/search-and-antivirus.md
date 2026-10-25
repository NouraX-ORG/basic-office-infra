# Search inside files and the virus scanner

Two add-ons that run as their own services next to the file server. Both are internal: neither
publishes a port, and only the containers of this stack can reach them.

| Part | Service | What runs | Set up by |
|---|---|---|---|
| Virus scanner | `clamav` (clamd on TCP 3310) | ClamAV 1.5.4 (`clamav/clamav:1.5.4_base`), the files_antivirus app 6.5.0 and our helper app `nourax_antivirus` | `compose.yaml`, `config/clamav/`, `nextcloud-apps/nourax_antivirus/`, `scripts/configure.d/50-virus-scanner.sh` |
| Search inside files | `elasticsearch` (HTTP on 9200), and `jobs` for indexing new files | Elasticsearch 9.5.5 (`elasticsearch:9.5.5`), the apps fulltextsearch 35.0.1, fulltextsearch_elasticsearch 35.0.1 and files_fulltextsearch 35.0.0 | `compose.yaml`, `config/elasticsearch/`, `scripts/configure.d/50-search.sh` |

The memory of the whole server, which service the kernel stops first when memory runs out, and
the sizes to set after the upgrade to 8 GB are at the end:
[Memory of the whole server, and the move to 8 GB](#memory-of-the-whole-server-and-the-move-to-8-gb).

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
(`FRESHCLAM_CHECKS` in `.env`, 2 when it is not set), downloads only the changes, and tells clamd
to load them. The first start downloads the whole set (about 110 MB) into the `clamav_db` volume;
later starts reuse it.

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

**After the upgrade to 8 GB:** `CLAMAV_MEM_LIMIT=3g` in `.env`, and in `config/clamav/`
`ConcurrentDatabaseReload` (clamd.conf) and `TestDatabases` (freshclam.conf) `yes`, so scans no
longer pause during reloads and new signatures are test-loaded first (each needs a second copy of
the signatures in memory, about 1 GB). The steps for all services together:
[After the upgrade to 8 GB](#after-the-upgrade-to-8-gb-needs-the-owners-yes).

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

## Search inside files

People find files by the words inside them, in the normal search box at the top of every page
(the magnifier, or Ctrl+K). Next to the usual results (file names, contacts, events, boards) a
section **Full Text Search** lists the documents whose text contains the words. Each result shows
the sentence that matched and the file's folder and name; clicking it opens the file.

Elasticsearch keeps the index. The fulltextsearch app runs the indexing and answers the search
box; fulltextsearch_elasticsearch talks to Elasticsearch; files_fulltextsearch reads the files.
NoBoard (Deck) adds its cards to the same index by itself, so card texts are found there too.

### What is found, and by whom

| | |
|---|---|
| File types | Plain text and Markdown (`.txt`, `.md` and every other `text/…` type), PDF, Word, Excel and PowerPoint (`.docx`, `.xlsx`, `.pptx` and the old `.doc`, `.xls`, `.ppt`), OpenDocument (`.odt`, `.ods`, `.odp`). Elasticsearch's built-in `attachment` step (Apache Tika) takes the text out; no plugin is needed. |
| Size | Files up to 20 MB (`files_size`, from `SEARCH_MAX_FILE_MB` in `.env`). Bigger files are still found by name through the normal file search. |
| Not indexed | What is inside zip files (`files_zip` off) and external storage (switched off on this server). Images have no text to index (no OCR). |
| Where | Everyone's own files and team folders (`files_local`, `files_group_folders`). |
| Who finds a file | Only people who can open it: the owner, the people and groups it is shared with, and the members of its team folder. The index stores who may see each document, and the file server checks every hit again for the person searching. A share that is removed, or a file that is deleted, stops showing at once (the second check), and the index itself follows at the next run. |

Results show as *(files) The sentence that matched …* with the folder and file name below it, and
*(deck) …* for cards. The "(files)" label comes from the app and can't be set. None of these texts
names the upstream product. NoBoard's welcome board, made on a person's first visit, has cards that
do (see the `deck` row in docs/branding.md); those cards were already found by NoBoard's own
search, and now also here.

### How fast new files are found

Every new, changed, shared, moved or deleted file goes on a waiting list in the database. The list
is worked through:

- by the compose service **`jobs`**, 2 minutes after each run ends. Its program is
  `config/elasticsearch/index-queue.sh`, which starts the app's own indexing job at once. A run with
  nothing waiting takes a second or two. Between runs only that small script and `sleep` are in
  memory (a permanent `occ fulltextsearch:live` process would hold memory and ask the database
  every 3 seconds);
- by the same job in the cron container every 12 minutes, if `jobs` is not running.

`jobs` is the file server's own image with the same files and settings as the cron container
(`extends: cron` in `compose.yaml`), but it runs our script instead of crond, as `www-data`, with
its own memory limit (`JOBS_MEM_LIMIT`, 384m) and a higher OOM score (500). So reading a big
document for the index never takes memory from the file server: if a run ever needs more, only
that run stops (PHP's limit in this container is 512M; the container may use as much swap as its
limit first). A `docker compose stop` lets a run that has started finish (up to 2 minutes). Its
health check says *unhealthy* only when no run has started for 65 minutes (a run is stopped after
an hour).

Two runs never overlap: the app lets only one indexing run work at a time, and another one stops
at once. Measured: three new files were found 92–93 seconds after their upload; the longest wait
is about two and a half minutes (the 2-minute pause plus the run).

```
sudo docker compose ps jobs                     # running, healthy
sudo docker compose logs --tail 20 jobs         # problems are logged here; the next run tries again
sudo docker compose restart jobs                # run it now (the first run starts at once)
sudo docker compose up -d --no-deps jobs        # start it (after a change to compose.yaml or .env)
```

Until 2026-10-25 a host timer, `nourax-search-index.timer`, did this work. `50-search.sh` switches
it off if it is still on, so the two never both run; its unit files stay in `/etc/systemd/system`
until the owner deletes them.

### The first index, and indexing everything again

`50-search.sh` starts a full index of all stored files once, in the background, when the index
`nourax_drive` does not exist yet (in `jobs` when it runs, otherwise in the file server). On
2026-10-25 that took 30 seconds for the 104 files and cards on the server; indexing all 123 again
in `jobs` took 11 seconds. To index everything again (after a problem, or after changing what is
indexed):

```
sudo docker compose exec -T jobs php occ fulltextsearch:index --no-readline   # every person's files and NoBoard cards again, in jobs' memory limit
OCC fulltextsearch:check                 # the settings, with the password shown as ********
```

The index is made from the files, so it is not in the backups. If the `elasticsearch_data` volume
is ever lost, start the service again and run `sudo scripts/configure.sh`: the first index runs again.

### Our settings

Set by `scripts/configure.d/50-search.sh` on every `sudo scripts/configure.sh`. The step does
nothing until the two secrets exist and Elasticsearch says healthy.

| App | Setting | Value | Why |
|---|---|---|---|
| fulltextsearch | `search_platform` | `OCA\FullTextSearch_Elasticsearch\Platform\ElasticSearchPlatform` | Elasticsearch is the engine |
| fulltextsearch | `app_navigation` | `false` | No extra page in the app menu; results show in the search box |
| fulltextsearch_elasticsearch | `elastic_index` | `nourax_drive` | Our index; the account may only use `nourax_drive*` |
| fulltextsearch_elasticsearch | `elastic_host` | `http://nourax_drive:…@elasticsearch:9200` | Stored encrypted (sensitive), written from stdin |
| files_fulltextsearch | `files_local`, `files_group_folders` | on | People's files and team folders |
| files_fulltextsearch | `files_office`, `files_pdf` | on | Office files and PDF |
| files_fulltextsearch | `files_zip`, `files_external` | off, 0 | See above |
| files_fulltextsearch | `files_size` | `SEARCH_MAX_FILE_MB` from `.env`, `20` (MB) when it is not set | Larger files are found by name only |
| files_fulltextsearch | `files_open_result_directly` | on | A result opens the file, not its folder |

Elasticsearch itself (`compose.yaml`): one node (`discovery.type: single-node`), security on, plain
HTTP inside the compose network, machine learning, Watcher and the GeoIP download off, heap
`ES_JAVA_HEAP`, limit `ES_MEM_LIMIT`, `oom_score_adj: 600`, data in the `elasticsearch_data`
volume. The JVM's own log has only warnings and goes to `docker compose logs elasticsearch`
(`-Xlog:disable -Xlog:all=warning:stderr:…`, Elastic's documented way for Docker) instead of the
default GC log files inside the container, which can grow to 2 GB and whose file cache counts
against the container's limit. `MALLOC_ARENA_MAX=2` keeps fewer C memory pools for its many
threads, so less memory is used outside the Java heap. In `config/elasticsearch/`: `index-template.json` (no replicas for `nourax_drive*`, so the
single node stays green) and `role-nourax_drive.json`. Its log says *"Transport SSL must be enabled
if security is enabled"* at every start: with one node that check is only a warning, and nothing
outside the stack can reach the node.

### Accounts and passwords

| Account | Used by | May do |
|---|---|---|
| `elastic` (built-in superuser) | Only `50-search.sh`, from inside the Elasticsearch container | Everything |
| `nourax_drive` (role `nourax_drive`) | The file server | Read and write the `nourax_drive*` indexes; set the `attachment` text pipeline; read the cluster status |

The passwords are the secrets `elasticsearch_password` and `elasticsearch_drive_password`
(`sudo scripts/secrets.sh gen …`). The image refuses a password file that others can read, so
`elasticsearch_password` is kept at `0640` (`50-search.sh` sets it again on every run; the image
runs as uid 1000 in group 0, which can still read it). The file server's address, password
included, is stored encrypted in the app settings; `occ config:list` shows
`***REMOVED SENSITIVE VALUE***`.

Two places still show that address in clear text, to admins only:

- `occ fulltextsearch_elasticsearch:configure` (without arguments) prints it. Use
  `OCC fulltextsearch:check` instead, which hides the password;
- the admin page *Administration settings > Full text search* (behind Cloudflare's owner-IP rule).

To ask Elasticsearch something by hand, as the superuser, without the password on a command line:

```
sudo bash -c '. scripts/lib.sh; . <(sed -n "/^es_api()/,/^}/p" scripts/configure.d/50-search.sh); es_api GET "/_cat/indices?v" </dev/null'
```

To change the passwords:

```
sudo scripts/secrets.sh gen elasticsearch_drive_password --rotate && sudo scripts/configure.sh
sudo scripts/secrets.sh gen elasticsearch_password --rotate && sudo chmod 0640 /etc/nourax/secrets/elasticsearch_password
sudo docker compose up -d --force-recreate elasticsearch   # the image reads the superuser password only into a new container
```

### Memory

`config/elasticsearch/memory-report.sh` shows the memory of the server and of the add-ons:
`free -m`, `/proc/swaps`, `docker stats`, and for `elasticsearch`, `clamav` and `jobs` what the
kernel counts for each container (limit, use now, highest use, *program* memory that is not file
cache, swap, how often it was at its limit, OOM kills), plus Elasticsearch's Java heap. It prints
a WARNING when a container's program memory and swap pass 90% of its limit, or when the kernel
stopped one.

```
sudo config/elasticsearch/memory-report.sh                  # a report now; reads only
# Before and after Elasticsearch (search inside files is off for about 3 minutes), under the lock:
sudo flock -w 1800 /run/nourax-deploy.lock config/elasticsearch/memory-report.sh --around-start qa-t5-1 WORD1 WORD2
```

`--around-start` stops `elasticsearch` and `jobs`, waits a minute and reports *before*; then starts
both, indexes every file again in `jobs`, searches each word as the given person and reports
*after*. Measured that way on 2026-10-25 (05:43–05:47 UTC) on the 3.7 GB server:

| `free -m` | Used | Free | Buffers and cache | Available | Swap used |
|---|---|---|---|---|---|
| Before: Elasticsearch and `jobs` stopped for a minute (05:44:53) | 1024 MB | 1330 MB | 1892 MB | 2795 MB | 1169 MB |
| After: both running, all 123 documents indexed again (11 seconds), 2 searches (05:46:55) | 1854 MB | 397 MB | 1995 MB | 1965 MB | 1169 MB |

| `docker stats` | Before | After |
|---|---|---|
| elasticsearch (limit 1 GiB) | stopped | 873.8 MiB |
| jobs (limit 384 MiB) | stopped | 1.3 MiB |
| clamav (limit 1.56 GiB) | 102.4 MiB | 102.4 MiB |
| app | 350.1 MiB | 343.7 MiB |
| onlyoffice | 125.1 MiB | 125.5 MiB |
| db | 37.2 MiB | 37.2 MiB |
| cloudflared | 33.5 MiB | 32.7 MiB |
| redis | 4.8 MiB | 4.8 MiB |
| cron | 1.5 MiB | 1.5 MiB |

`/proc/swaps` both times: `/swapfile`, size 4194300 kB, used 1198044 kB. So search inside files
takes about 830 MB of the server's memory, nearly all of it Elasticsearch. Swap does not go down
when Elasticsearch stops because very little of it is Elasticsearch's. It was filled between 04:40
and 04:50 UTC (sar: from 180 MB to 1.1 GB, while the virus scanner's large-upload tests ran; about
3.4 GB were written to the disk in those ten minutes, swap included), before Elasticsearch ever
started: its data volume was made at 04:53:07. The kernel moved memory that was rarely used to
swap, mostly ClamAV's signatures and part of the editors. Swap by service at 10:44 UTC (each
container's `memory.swap.current`, now the report's *swap by service* line): clamav 880 MiB,
onlyoffice 271, elasticsearch 29, db 11, all the others 3. Both keep working (clamd answered
`VERSION` in 0.4 seconds and a clean upload was scanned and stored in 0.9 seconds afterwards); the
first scans after a quiet time are a little slower while the signatures come back from swap.

**What fills Elasticsearch's 1 GiB.** The Java heap (512 MiB) is taken in full at the start
(`-XX:+AlwaysPreTouch`, Elastic's default), so it never grows. Outside the heap, measured with
`jcmd` after 5 hours (10:40 UTC): the loaded classes (*metaspace*, 196 MiB for about 42,000
classes from Elasticsearch's built-in modules), compiled code (45 MiB) and C memory (threads,
garbage collector, the Java compiler: 138 MiB in use). Together that is the *program* memory; the
rest of the limit is file cache for the index files, which the kernel gives back first.

C memory that Java frees is not given back to the system by itself: after 5 hours glibc kept
80 MiB of freed memory, mostly left over from the Java compiler. `-XX:TrimNativeHeapInterval=60000`
(a standard JDK option, in `ES_JAVA_OPTS` since fix round 2) gives it back once a minute. The same
trim done once by hand (`jcmd … System.trim_native_heap`, 10:46 UTC) took the program memory from
909 MiB to 859 MiB (*RSS+Swap: 969M->918M*). The option takes effect when the container is next
made (`sudo docker compose up -d --no-deps elasticsearch`, or `memory-report.sh --around-start`).

| Elasticsearch container | Before this fix (05:30, 37 minutes after its start) | After (06:01, 16 minutes after its start, two rounds of test uploads) |
|---|---|---|
| Program memory | 946 MiB | 888 MiB |
| Times at the limit (the kernel took back file cache) | 279 | 0 |
| Java threads | 75 | 61 |
| OOM kills, swap | 0, 0 | 0, 0 |

The fix of 2026-10-25 took two things out of that limit: the GC log files (their writes filled
the file cache and pushed the container to its limit again and again) and part of the C memory
(`MALLOC_ARENA_MAX=2`).

**Why it is not stopped before the upgrade.** The heap cannot grow, so only the part outside it
grows a little as more code is compiled (909 MiB after 5 hours against 888 MiB after 16 minutes,
before the trim option). If the program memory ever reaches the limit, the kernel
first moves Elasticsearch's own rarely used memory to swap (Docker lets a container use as much
swap as its limit), so search gets slower; it would be stopped only at 2 GiB. If memory runs out
on the whole server, the kernel stops Elasticsearch first (`oom_score_adj` 600, `jobs` 500,
ClamAV 400), never the database or the file server. The search box then shows no full-text results
until it is back; nothing else stops. Watch for the report's WARNING lines, its *swap* column and
its *swap by service* line.

**`jobs`:** 1–2 MiB between runs; 89 MiB at the most while it indexed every file again and the
test uploads below (`memory.peak`), never at its limit.

**After the upgrade to 8 GB:** in `.env` `ES_JAVA_HEAP=1g`, `ES_MEM_LIMIT=2g`, `JOBS_MEM_LIMIT=512m`
and `SEARCH_MAX_FILE_MB=25` (about a minute without full-text results while Elasticsearch starts
again). The steps for all services together:
[After the upgrade to 8 GB](#after-the-upgrade-to-8-gb-needs-the-owners-yes). With more than about
100,000 documents, or files much bigger than 25 MB, give Elasticsearch more heap (at most half of
its limit).

### Licences and versions

- Elasticsearch 9.5.5 from the official Docker Hub image `elasticsearch:9.5.5` (released
  2026-10-23, digest `sha256:da9e6fed4949f114c526cf51f5130fed9e30fe9f03a2ea7bf64ccbdc129fca8c`;
  9.5.3 is the fallback). Its binaries are under the Elastic License 2.0, which allows using it
  inside our own service; it forbids offering Elasticsearch itself to others as a hosted service,
  which we don't. The source is also available under AGPL-3.0.
- Why 9.x: fulltextsearch_elasticsearch 35.0.1 uses the elasticsearch-php 9.5.0 client, with 8.19.0
  kept only as a fallback. The README line "only compatible with Elasticsearch 8" is from version 26.
- files_fulltextsearch: the app store has 35.0.0 (stable, 2026-09-18) next to 35.0.0-beta.1, and
  occ installs the newest, so the stable 35.0.0 is what runs. No beta is used.
- The three apps' texts that name the upstream product are their app-store descriptions and the
  wiki note on the admin page (admins only); Task 3's text sweep rewrites them.

### Tests

All on 2026-10-25 through `https://drive.nourax.org`, with the QA accounts `qa-t5-1` and `qa-t5-2`
(members of the group `qa-t5-team` and its team folder) and `qa-t5-3` (not a member). Searches use
the search box's API, `GET /ocs/v2.php/search/providers/fulltextsearch/search?term=WORD` with
`OCS-APIRequest: true`. Each test file had its own made-up word only in its text, never in its name.

| Test | Result |
|---|---|
| Elasticsearch | `9.5.5`, cluster `nourax-search` green, one node; index `nourax_drive` green with 1 shard and 0 replicas; port 9200 not open on the server (`ss -ltn` shows none) and not published (`docker inspect`) |
| Search providers for a person | `fulltextsearch` is listed next to `files`, `search-deck-card-board`, `contacts`, `calendar` and the others |
| A word only inside a `.docx` and a `.pdf` (`qa-t5-1`) | Found 17 seconds after the upload: 2 results, *(files) Invoice summary for … and the shared keyword … on page one.* (`t5-search/invoice-e.pdf`) and *(files) Shared keyword … appears here.* (`t5-search/report-a.docx`) |
| One word each in `.xlsx`, `.pptx`, `.odt`, `.txt`, `.md` | Each found, with its sentence (*Paper ordered from …*, *Next step: talk to … about the launch*, *Meeting minutes: … agreed to the plan.*, *Call back … on Monday.*, *The owner is …*) |
| The same words as `qa-t5-2` and `qa-t5-3` | 0 results |
| A `.docx` in the team folder | Found by `qa-t5-1` and `qa-t5-2` (`qa-t5-team-folder/team-plan-h.docx`); 0 results for `qa-t5-3`. Its index entry has `groups: ["qa-t5-team"]` |
| The `.docx` shared with `qa-t5-3` | Found by `qa-t5-3` (as `report-a.docx`) at the next run; the `.pdf`, not shared, still 0 |
| The share removed | 0 results for `qa-t5-3` at once; at the next run the index entry's `users` list was empty again |
| A `.txt` changed (new text) | The new word found after 78 seconds; the old word 0 results |
| A file deleted | 0 results at once; at the next run its index entry was gone (`found: false`) |
| A result's link (`/f/611`) | 303 to the file in NoDrive with `openfile=true` |
| Settings | `occ config:list` shows `elastic_host` as `***REMOVED SENSITIVE VALUE***`; in the database it starts with `$AppConfigEncryption$`; `occ fulltextsearch:check` shows `http://nourax_drive:********@elasticsearch:9200` |
| Container settings | `docker inspect`: memory 1073741824 (1g), OOM score 600 |
| The service `jobs` (fix of 2026-10-25) | `docker compose ps jobs`: *Up (healthy)*; `docker inspect`: memory 402653184 (384m), swap limit 805306368, OOM score 500, user `www-data`, program `/bin/bash /opt/nourax/jobs/index-queue.sh`; between runs only `bash` (3 MB) and `sleep` run in it. The host timer is disabled and inactive |
| New files through `jobs` (fix of 2026-10-25) | A `.docx` and a `.pdf` (`qa-t5-1`) and a `.docx` in the team folder, each with a new word: all three found 92–93 seconds after the upload, each with its sentence (*(files) Fix round check: the word … is only inside this document.*, *(files) Invoice note for the fix round: … appears on page one.*, *(files) Team plan for the fix round: … belongs to the team folder.*). The team file found by `qa-t5-2` too; all three words 0 results for `qa-t5-3`; the `.docx` and `.pdf` words 0 results for `qa-t5-2` |
| Memory before and after (fix of 2026-10-25) | `memory-report.sh --around-start`, see Memory above |
| No password in the process list (fix round 2) | A watcher (root, on the server) read the whole process list, containers included, every 45–75 ms and counted the samples holding either Elasticsearch password or any of 10 other secrets, never printing one. During `es_api` calls and the memory report (read-only, 10:45 UTC): 198 samples in 8.7 seconds, `es_api`'s curl caught in 37 of them, 0 samples with a password. The same watch during a full `scripts/configure.sh` run waits for the owner's go (it changes the live server) |
| Freed C memory (fix round 2) | `jcmd … System.native_heap_info`: 80 MiB freed but kept after 5 hours; one `System.trim_native_heap`: program memory 909 → 859 MiB. Search answers were the same afterwards (`qa-t5-1` finds its `.docx`, `.pdf` and team words, `qa-t5-2` only the team word, `qa-t5-3` none) |

## Memory of the whole server, and the move to 8 GB

Today's server has 3.7 GB of memory and 4 GB of swap. The owner moves it to 8 GB in a day or two;
until then the add-ons run with small limits. This part has the report to watch, what was measured,
what happens when memory runs out, what to do if it gets too tight, and the sizes for 8 GB.

### The memory report

```
cd /opt/nourax/basic-office-infra
sudo config/elasticsearch/memory-report.sh                 # reads only; a LABEL as the first word is printed in the header
```

It prints `free -m`, `/proc/swaps`, `docker stats`, each container's memory limit and OOM score
(`docker inspect`), what the kernel counts for each add-on (`elasticsearch`, `clamav`, `jobs`,
`ai-relay`, `ai-worker`), the swap of every service, the 5 biggest processes
(`ps -eo rss,comm --sort=-rss`), Elasticsearch's Java heap, and a last line with the memory check
for the time before the upgrade (see [If memory gets too tight](#if-memory-gets-too-tight)).
`--around-start` (see [Memory](#memory) under search) stops and starts Elasticsearch, so it needs
the deploy lock.

### Measured on 2026-10-25

With every service running, on the nearly empty drive (813 entries in the search index), first
with nobody testing ("idle", 16:08:03 UTC), then straight after one search inside files and one
EICAR upload as `qa-t5-1` ("test load", 16:08:21 UTC). The search for *invoice* answered in 1.1
seconds with 5 results; the EICAR upload was refused in 0.9 seconds (HTTP 415, *Virus
Eicar-Test-Signature is detected in the file. Upload cannot be completed.*, then 404 for that path).

| `free -m` (MB) | Used | Free | Buffers and cache | Available | Swap used (of 4095) |
|---|---|---|---|---|---|
| Idle | 2859 | 327 | 1092 | 959 | 712 |
| Test load | 2816 | 365 | 1097 | 1002 | 711 |

`/proc/swaps`: `/swapfile`, size 4194300 kB, used 729640 kB (idle) and 728616 kB (test load).

| `docker stats` (MiB) | Limit | Idle | Test load | OOM score |
|---|---|---|---|---|
| clamav | 1600m | 956.0 | 956.6 | 400 |
| elasticsearch | 1g | 677.0 | 678.5 | 600 |
| app | none | 447.3 | 466.9 | 0 |
| onlyoffice | none | 166.5 | 166.6 | 0 |
| db | none | 72.7 | 75.6 | 0 |
| ai-worker | 320m | 53.2 | 53.2 | 500 |
| cloudflared | none | 31.5 | 32.7 | 0 |
| redis | none | 10.9 | 10.9 | 0 |
| ai-relay | 64m | 10.5 | 10.5 | 300 |
| cron | none | 2.4 | 2.4 | 0 |
| jobs | 384m | 2.0 | 2.0 | 500 |

The limit and OOM score columns are the report's `docker inspect` lines, the same both times. Each
add-on may also use as much swap as its limit (*with swap* is twice the limit); the others have no
limit. The rest of the idle report:

```
--- memory limit and OOM score of each container (docker inspect), highest score first
nourax-workspace-elasticsearch-1   limit  1024m  with swap  2048m  OOM score 600
nourax-workspace-ai-worker-1       limit   320m  with swap   640m  OOM score 500
nourax-workspace-jobs-1            limit   384m  with swap   768m  OOM score 500
nourax-workspace-clamav-1          limit  1600m  with swap  3200m  OOM score 400
nourax-workspace-ai-relay-1        limit    64m  with swap   128m  OOM score 300
nourax-workspace-app-1             limit   none  with swap   none  OOM score 0
nourax-workspace-cloudflared-1     limit   none  with swap   none  OOM score 0
nourax-workspace-cron-1            limit   none  with swap   none  OOM score 0
nourax-workspace-db-1              limit   none  with swap   none  OOM score 0
nourax-workspace-onlyoffice-1      limit   none  with swap   none  OOM score 0
nourax-workspace-redis-1           limit   none  with swap   none  OOM score 0
--- add-ons, in MiB (program = memory that is not file cache)
elasticsearch  limit  1024  now   681  highest  1010  program   639  file cache    9  swap  343  at limit 0 times  OOM kills 0
elasticsearch  WARNING: program memory and swap are over 90% of the limit - see docs/search-and-antivirus.md, Memory
clamav         limit  1600  now   956  highest  1248  program   939  file cache    8  swap    6  at limit 0 times  OOM kills 0
jobs           limit   384  now     4  highest    93  program     0  file cache    2  swap    0  at limit 0 times  OOM kills 0
ai-relay       limit    64  now    12  highest    31  program     6  file cache    3  swap    4  at limit 0 times  OOM kills 0
ai-worker      limit   320  now    53  highest    67  program    51  file cache    0  swap    0  at limit 0 times  OOM kills 0
--- swap by service, in MiB: ai-relay 4  ai-worker 0  app 15  clamav 6  cloudflared 2  cron 0  db 13  elasticsearch 343  jobs 0  onlyoffice 274  redis 2
--- the 5 biggest processes (resident memory, in MiB; processes in containers included)
   942  clamd
   651  java
   149  apache2
   139  apache2
   128  apache2
--- Elasticsearch Java, in MiB
heap used 338 of 512, outside the heap 296, threads 61
--- memory check: available 1106 MB (tight under 150), swap used 712 MB (tight over 1536 and growing)
```

Under the test load the same lines read: the 5 biggest processes `clamd` 943, `java` 653 and
`apache2` 152, 139 and 137 MiB; heap used 354 of 512; Elasticsearch's program memory 640 and swap
342 MiB; memory check *available 992 MB, swap used 711 MB*.

What this shows:

- One search and one virus check hardly move memory: the file server took about 20 MB more for
  the moment, Elasticsearch 1.5 MB, ClamAV less than 1 MB.
- About 1 GB stays available with everything running. Swap holds about 0.7 GB, nearly all of it
  Elasticsearch's (343 MiB) and the editors' (274 MiB): memory they rarely read, which the kernel
  moved out. Both keep working.
- The report's WARNING for Elasticsearch is expected on this server: its program memory plus its
  swap are just over 90% of its 1 GiB, because its Java heap is taken in full at the start. It was
  at its limit 0 times and never stopped; the kernel would stop it only at 2 GiB (its limit plus as
  much swap). It goes away with the 8 GB sizes.
- Half an hour earlier (15:41 UTC) the numbers were close: 915 MB available, 476 MB of swap,
  Elasticsearch 848.5 MiB with 133 MiB in swap. Which memory is in swap moves; the total does not
  keep growing.
- The Elasticsearch container running now was made at 05:44 UTC, before the option that gives
  freed C memory back (`-XX:TrimNativeHeapInterval=60000`, see [Memory](#memory)) was added to
  `compose.yaml`. It takes effect the next time the container is made, which the 8 GB step below
  does. It was not made again now because people were searching at the time (Task 1 was testing its
  content search tool). `sudo docker compose up -d --no-deps elasticsearch`, under the lock, does it
  any time (2–3 minutes without results from inside files).

### Which service the kernel stops first

When the whole server runs out of memory, the kernel stops the process with the highest OOM score
first. The add-ons have higher scores and their own limits, so the kernel stops search first and
never the database or the file server:

| Order | Service | OOM score | Limit today | If the kernel stops it |
|---|---|---|---|---|
| 1 | `elasticsearch` | 600 | 1g | Search inside files shows no results until it is back (it starts again by itself, 2–3 minutes); file-name search keeps working; nothing is lost |
| 2 | `jobs`, `ai-worker` | 500 | 384m, 320m | New files wait for the cron container's 12-minute turn; AI tasks wait up to 5 minutes; both start again by themselves |
| 3 | `clamav` | 400 | 1600m | Uploads are refused (*No connection to anti virus*) for the minute it needs to load again |
| 4 | `ai-relay` | 300 | 64m | The Assistant says it is busy for a few seconds |
| last | `db`, `app`, `cron`, `onlyoffice`, `redis`, `cloudflared` | 0 | none | — |

The plan for this step had `jobs` and `ai-relay` at 200. The live values above were set when those
services were added; they keep the order that matters: search first, the database last.

### If memory gets too tight

Before the upgrade, memory is too tight when the report's memory check shows **under 150 MB
available**, or **over 1.5 GB of swap used** and still more in a second report 10 minutes later.
Then the fallback is to stop the search engine until the upgrade. Stopping is not deleting (the
index stays in its volume), but tell the owner first.

```
cd /opt/nourax/basic-office-infra
sudo flock -w 1800 /run/nourax-deploy.lock docker compose stop elasticsearch
```

- What changes: search inside files pauses; the normal search by file name keeps working.
  Elasticsearch's memory (about 680–850 MB, plus its swap) is free. `jobs` and the cron container
  log a failed indexing run every few minutes (`docker compose logs jobs`); that does no harm.
  `scripts/configure.sh` still runs: its search step logs *skipped* and the run carries on
  (tested, see below).
- Undo (after the upgrade, or when memory allows):

  ```
  sudo flock -w 1800 /run/nourax-deploy.lock docker compose up -d --no-deps elasticsearch
  sudo docker compose ps elasticsearch      # wait until it says (healthy), 2-3 minutes
  sudo flock -w 1800 /run/nourax-deploy.lock docker compose exec -d -u www-data jobs php occ fulltextsearch:index '{"errors":"ignore"}' --no-readline
  ```

  The last command reads again the files that came or changed while the engine was stopped,
  including those whose indexing failed then (`"errors":"ignore"` makes the app try them again
  instead of skipping them).
- Test: a word inside a new `.docx` is found again within about 3 minutes (the search tests above).

### After the upgrade to 8 GB (needs the owner's yes)

The upgrade itself costs money, so it is the owner's step. Afterwards one commit and a few `.env`
lines raise the sizes. Only `clamav`, `elasticsearch` and `jobs` are made again; `app`, `cron`,
`db`, `redis`, `onlyoffice`, `cloudflared`, `ai-relay` and `ai-worker` are not touched.

| Setting | Where | Today (3.7 GB) | 8 GB |
|---|---|---|---|
| `CLAMAV_MEM_LIMIT` | `.env` | `1600m` | `3g` |
| `ConcurrentDatabaseReload` | `config/clamav/clamd.conf` (commit) | `no` | `yes`: scans no longer wait during a reload (a second copy of the signatures, about 1 GB more for that minute) |
| `TestDatabases` | `config/clamav/freshclam.conf` (commit) | `no` | `yes`: new signatures are test-loaded before clamd takes them |
| `ES_JAVA_HEAP` | `.env` | `512m` | `1g` |
| `ES_MEM_LIMIT` | `.env` | `1g` | `2g` |
| `JOBS_MEM_LIMIT` | `.env` | `384m` | `512m` (room for bigger documents) |
| `SEARCH_MAX_FILE_MB` | `.env` (new; 20 when it is not set) | `20` | `25` |
| `FRESHCLAM_CHECKS` | `.env` (new; 2 when it is not set) | `2` | `4`, optional: new signatures every 6 hours |
| `AI_RELAY_MEM_LIMIT`, `AI_WORKER_MEM_LIMIT` | `.env` | `64m`, `320m` | unchanged |

Expected use on 8 GB: ClamAV about 1 GB (2 GB for the minute of a reload), Elasticsearch about
1.5 GB (the 1 GB heap is taken at the start), everything else as today (about 0.9 GB), so about
3.5 GB with room to spare. The add-ons' limits add up to 5.9 GB.

1. The commit (in a checkout of the repo, pushed to `main`):

   ```
   sed -i 's/^ConcurrentDatabaseReload no$/ConcurrentDatabaseReload yes/' config/clamav/clamd.conf
   sed -i 's/^TestDatabases no$/TestDatabases yes/' config/clamav/freshclam.conf
   ```

   Also reword the comment above each line (each says why it is off on the small server), and
   commit as *ClamAV: reload next to the old signatures and test new ones, for the 8 GB server*.
2. On the server, the `.env` lines with the new sizes, then the three services and the settings:

   ```
   cd /opt/nourax/basic-office-infra
   sudo flock -w 1800 /run/nourax-deploy.lock git pull -q --ff-only
   sudo cp -p .env .env.before-8gb
   sudo sed -i -E -e 's/^CLAMAV_MEM_LIMIT=.*/CLAMAV_MEM_LIMIT=3g/' -e 's/^ES_JAVA_HEAP=.*/ES_JAVA_HEAP=1g/' \
   	-e 's/^ES_MEM_LIMIT=.*/ES_MEM_LIMIT=2g/' -e 's/^JOBS_MEM_LIMIT=.*/JOBS_MEM_LIMIT=512m/' .env
   sudo grep -q '^SEARCH_MAX_FILE_MB=' .env || echo 'SEARCH_MAX_FILE_MB=20' | sudo tee -a .env >/dev/null
   sudo sed -i 's/^SEARCH_MAX_FILE_MB=.*/SEARCH_MAX_FILE_MB=25/' .env
   # optional: sudo grep -q '^FRESHCLAM_CHECKS=' .env || echo 'FRESHCLAM_CHECKS=4' | sudo tee -a .env >/dev/null
   sudo grep -E '^(CLAMAV_MEM_LIMIT|ES_JAVA_HEAP|ES_MEM_LIMIT|JOBS_MEM_LIMIT|SEARCH_MAX_FILE_MB|FRESHCLAM_CHECKS)=' .env
   sudo flock -w 1800 /run/nourax-deploy.lock docker compose up -d --no-deps clamav elasticsearch jobs
   sudo docker compose ps clamav elasticsearch jobs     # wait until all three say (healthy), 1-3 minutes
   sudo flock -w 1800 /run/nourax-deploy.lock scripts/configure.sh
   ```

   While `clamav` loads again (about a minute) uploads are refused with *No connection to anti
   virus*; search inside files has no results for 2–3 minutes. Files of 20–25 MB stored before the
   change are read again only when they change; to read them now:
   `sudo docker compose exec -d -u www-data jobs php occ fulltextsearch:index '{"force":true}' --no-readline`
   (every file again; about a minute on today's drive).
3. Undo: `sudo cp -p .env.before-8gb .env`, revert the commit (`git revert`, push, pull on the
   server), then the same `docker compose up -d --no-deps clamav elasticsearch jobs` and
   `scripts/configure.sh`, under the lock.
4. Test:
   - `sudo config/elasticsearch/memory-report.sh "after the move to 8 GB"`: limits `3072m`,
     `2048m` and `512m`, heap `of 1024`, no WARNING line;
   - `OCC config:app:get files_fulltextsearch files_size` prints `25`;
   - the clamd `VERSION` line, and `echo RELOAD | nc localhost 3310` in the `clamav` container
     followed by a normal upload, which is now stored at once instead of after a wait;
   - the tests of the virus scanner (an EICAR upload refused, a normal file stored) and of search
     inside files (a word inside a `.docx` and a `.pdf` found, not found by another person).

### Tests (memory, Talk guard, configure.sh)

All on 2026-10-25 on the live server.

| Test | Result |
|---|---|
| `bash -n` on every `scripts/configure.d/50-*.sh` and `config/elasticsearch/memory-report.sh` | no errors |
| `docker compose config -q` after the pull | no errors; `docker compose config --hash clamav` equals the running container's `com.docker.compose.config-hash` label, so `FRESHCLAM_CHECKS` from `.env` (still 2) changes nothing and ClamAV was not made again |
| `scripts/configure.sh`, twice in a row (15:41 and 15:48 UTC) | exit 0 in 206 and 209 seconds; no `WARNING` or `ERROR` line; both runs printed the same steps and messages (only the counts of index entries differ); both contain *Talk (spreed) is off (not installed)* |
| A third run, straight after (15:53 UTC) | exit 0 in 282 seconds, the same messages |
| `scripts/configure.sh` with ClamAV shown as stopped (15:58 UTC) | exit 0 in 287 seconds; the scanner step logged *WARNING: ClamAV is not answering, so uploads are refused until it does* and *skipped: the scanner settings and test stay as they are*; every later step ran (`55-gantt.sh`, `60-nomail-api.sh`, `60-org-privacy.sh`, *configure done*) |
| `scripts/configure.sh` with ClamAV and Elasticsearch both shown as stopped (16:05 UTC) | exit 0 in 170 seconds; the search step logged *skipped: Elasticsearch is not running or still starting*, the scanner step as above, and every later step ran |
| Memory report, idle and under the test load | see [Measured on 2026-10-25](#measured-on-2026-10-25) |
| `sudo scripts/check-branding.sh /etc/nourax/qa/qa-t5-1.netrc --server`, from `main` (`c0248d4`), at the end of Task 5 (16:15 UTC) | l10n 8713 checked, theming 73, share 18, dav 4, errors 18, config 1, mail 4: 0 FAIL each. pages: 44 checked, 37 SKIP (the pages Cloudflare opens only from the owner's address), 4 FAIL, all one hit: `qa-t5-1`'s own NoBoard welcome board, *Welcome to Nextcloud Deck!*, made on its first visit before the branding app switched welcome boards off. That is people's data, so it stays (docs/branding.md lists it); nothing from this step shows on a page |
| The QA accounts at the end of Task 5 (16:17 UTC) | `OCC user:disable` for `qa-t5-1`, `qa-t5-2` and `qa-t5-3`; `OCC user:info` shows `"enabled":false` for each, and `OCC user:list --disabled` lists all three. WebDAV with `qa-t5-1`'s app password then answers 503 *OC\User\DisabledUserException: Account disabled* (how the server refuses a disabled account); `status.php` 200. Their files, the group `qa-t5-team` and its team folder stay; deleting them needs the owner's yes |
| The containers at the end | `app` and `cron` made at 02:00 UTC, `db`, `redis`, `onlyoffice` and `cloudflared` on 23 October; all six started at 03:31:49 UTC, when the server restarted itself after a kernel update. Task 5 did not make any of them again or restart them. New in Task 5: `clamav`, `elasticsearch`, `jobs`, `ai-relay` and `ai-worker` |

*Shown as stopped:* for those two runs a stand-in `docker` program, first in `PATH`, answered
`docker compose ps … clamav|elasticsearch` with nothing and `docker compose exec … clamav|elasticsearch`
with an error, as Docker does for a stopped service; every other call went to the real Docker.
The services themselves were not stopped: a stopped ClamAV refuses every upload, a stopped
Elasticsearch takes search inside files away from everyone, and other people were uploading and
searching at the time. `docker compose ps` showed both *Up (healthy)* throughout.
