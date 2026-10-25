# Search inside files and the virus scanner

Two add-ons that run as their own services next to the file server. Both are internal: neither
publishes a port, and only the containers of this stack can reach them.

| Part | Service | What runs | Set up by |
|---|---|---|---|
| Virus scanner | `clamav` (clamd on TCP 3310) | ClamAV 1.5.4 (`clamav/clamav:1.5.4_base`), the files_antivirus app 6.5.0 and our helper app `nourax_antivirus` | `compose.yaml`, `config/clamav/`, `nextcloud-apps/nourax_antivirus/`, `scripts/configure.d/50-virus-scanner.sh` |
| Search inside files | `elasticsearch` (HTTP on 9200), and `jobs` for indexing new files | Elasticsearch 9.5.5 (`elasticsearch:9.5.5`), the apps fulltextsearch 35.0.1, fulltextsearch_elasticsearch 35.0.1 and files_fulltextsearch 35.0.0 | `compose.yaml`, `config/elasticsearch/`, `scripts/configure.d/50-search.sh` |

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
| Size | Files up to 20 MB (`files_size`). Bigger files are still found by name through the normal file search. |
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
at once.

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
`nourax_drive` does not exist yet (in `jobs` when it runs, otherwise in the file server). On 2026-10-25 that took 30 seconds for the 104 files and cards
on the server. To index everything again (after a problem, or after changing what is indexed):

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
| files_fulltextsearch | `files_size` | `20` (MB) | Larger files are found by name only |
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

Measured on 2026-10-25 on the 3.7 GB server, before Elasticsearch (04:48) and after it was running
with the first index done and the tests below (05:07):

| | Used | Available | Swap used |
|---|---|---|---|
| Before | 1925 MB | 1894 MB | 193 MB |
| After | 1905 MB | 1914 MB | 1170 MB |

| Elasticsearch container | |
|---|---|
| Memory (container) | 964 MiB of the 1 GiB limit |
| Of that, the process's own memory | 926 MB: Java heap 410 of 512 MB in use, 291 MB outside the heap; the rest is file cache |
| OOM kills | 0 |

Starting Elasticsearch made the kernel move memory that was rarely used to swap: about 810 MB of
ClamAV's signatures and 270 MB of the editors. Both keep working (clamd answered `VERSION` in
0.4 seconds and a clean upload was scanned and stored in 0.9 seconds afterwards); the first scans
after a quiet time are a little slower while the signatures come back from swap.

If Elasticsearch reaches its limit, it is not stopped at once: Docker lets a container use as much
swap as its limit, so it slows down first. If memory runs out on the whole server, the kernel stops
Elasticsearch first (`oom_score_adj` 600, ClamAV 400), never the database or the file server. The
search box then shows no full-text results until it is back; nothing else stops.

**After the upgrade to 8 GB:** in `.env` set `ES_JAVA_HEAP=1g` and `ES_MEM_LIMIT=2g`, then
`sudo docker compose up -d elasticsearch` (about a minute without full-text results). With more
than about 100,000 documents, or files much bigger than 20 MB, give it more heap (at most half of
the limit).

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
| Timer | Runs every 2 minutes 10 seconds (runs at 04:56:11, 04:58:21, 05:00:31, 05:02:39) |
| Container settings | `docker inspect`: memory 1073741824 (1g), OOM score 600 |
