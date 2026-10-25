# Search inside files: the fulltextsearch apps put the text of documents into Elasticsearch
# (compose service "elasticsearch") and add its results to the normal search box. What people get,
# the accounts and the memory it needs: docs/search-and-antivirus.md.
# Sourced by scripts/configure.sh with its helpers (occ, dc, log, secret_path, have_secret) after
# 50-apps.sh, whose nourax_app it uses. Safe to run again.
# SPDX-License-Identifier: AGPL-3.0-or-later

# es_api METHOD PATH
# One request to Elasticsearch as its "elastic" superuser, from inside its own container. The body
# (for PUT and POST) comes from stdin and the answer goes to stdout; an error answer fails the call.
# The password is read there from /run/secrets and written by printf, a shell builtin, into a 0600
# curl config file, so it never shows on a command line. The file is removed afterwards.
es_api() {
	dc exec -T elasticsearch bash -c '
		set -eu
		umask 077
		cfg="$(mktemp)"
		trap "rm -f \"$cfg\"" EXIT
		printf "user = \"elastic:%s\"\n" "$(</run/secrets/elasticsearch_password)" > "$cfg"
		if [ "$1" = GET ]; then
			curl -sS --fail-with-body -K "$cfg" "http://localhost:9200$2"
		else
			curl -sS --fail-with-body -K "$cfg" -X "$1" -H "Content-Type: application/json" \
				--data-binary @- "http://localhost:9200$2"
		fi
	' es_api "$1" "$2"
}

nourax_search() {
	if ! have_secret elasticsearch_password || ! have_secret elasticsearch_drive_password; then
		log "  skipped: first run 'sudo scripts/secrets.sh gen elasticsearch_password' and"
		log "  'sudo scripts/secrets.sh gen elasticsearch_drive_password', then 'docker compose up -d elasticsearch'"
		return 0
	fi
	# The image refuses a password file that others can read (it allows 400, 440, 600 or 640), and
	# secrets.sh writes 0644, also with --rotate. Elasticsearch runs as uid 1000 in group 0 (root),
	# so 0640 root:root is still readable for it.
	chmod 0640 "$(secret_path elasticsearch_password)"
	if [ "$(dc ps --format '{{.Health}}' elasticsearch 2>/dev/null)" != healthy ]; then
		log "  skipped: Elasticsearch is not running or still starting, so search inside files is not set up (again)."
		log "  Start it with 'docker compose up -d elasticsearch', wait until 'docker compose ps elasticsearch'"
		log "  says healthy (2-3 minutes), then run configure.sh again"
		return 0
	fi
	log "  $(es_api GET / </dev/null | jq -r '"Elasticsearch \(.version.number), cluster \(.cluster_name)"' || echo 'WARNING: Elasticsearch did not answer')"

	# The engine side: no replicas for our index (one node), and an account for the file server that
	# may only use its own index and the text-extraction ("attachment") pipeline.
	local es_dir="$REPO_DIR/config/elasticsearch"
	if ! es_api PUT /_index_template/nourax_drive < "$es_dir/index-template.json" >/dev/null \
		|| ! es_api PUT /_security/role/nourax_drive < "$es_dir/role-nourax_drive.json" >/dev/null \
		|| ! printf '{"password":"%s","roles":["nourax_drive"],"full_name":"Nourax Workspace file server"}' \
			"$(<"$(secret_path elasticsearch_drive_password)")" | es_api PUT /_security/user/nourax_drive >/dev/null; then
		log "  WARNING: the index template, role or account could not be set - see: docker compose logs elasticsearch"
		return 0
	fi
	log "  index template, role and account nourax_drive set"

	nourax_app fulltextsearch 35.0.1
	nourax_app fulltextsearch_elasticsearch 35.0.1
	nourax_app files_fulltextsearch 35.0.0
	if ! occ app:list --output=json | jq -e '.enabled | has("fulltextsearch") and has("fulltextsearch_elasticsearch") and has("files_fulltextsearch")' >/dev/null; then
		log "  WARNING: the three full-text apps are not all enabled, so the rest of this step is skipped"
		return 0
	fi

	# Nextcloud side. The search platform, and no extra "Full text search" page in the app menu:
	# results show in the normal search box.
	if ! occ fulltextsearch:configure \
		'{"search_platform":"OCA\\FullTextSearch_Elasticsearch\\Platform\\ElasticSearchPlatform","app_navigation":false}' >/dev/null \
		|| ! occ config:app:set fulltextsearch_elasticsearch elastic_index --value=nourax_drive --type=string --lazy >/dev/null; then
		log "  WARNING: the search platform could not be set - see: docker compose logs app"
		return 0
	fi
	# The address with the file server's password goes in from stdin and is stored encrypted
	# (sensitive), so it never shows in a process list or in 'occ config:list'. It is marked sensitive
	# before the real value is written, so that is never stored unencrypted. The app's own command,
	# fulltextsearch_elasticsearch:configure, is not used: it prints the address, password included.
	if ! printf 'http://nourax_drive:%s@elasticsearch:9200' "$(<"$(secret_path elasticsearch_drive_password)")" \
		| dc exec -T -u www-data app php -r '
			require "/var/www/html/lib/base.php";
			$config = \OCP\Server::get(\OCP\IAppConfig::class);
			$app = "fulltextsearch_elasticsearch";
			$key = "elastic_host";
			if (!$config->hasKey($app, $key, null)) {
				$config->setValueString($app, $key, "", lazy: true);
			}
			$config->updateSensitive($app, $key, true);
			$config->setValueString($app, $key, trim(stream_get_contents(STDIN)), lazy: true);
		'; then
		log "  WARNING: the search engine address could not be saved - see: docker compose logs app"
		return 0
	fi
	# What is indexed: everyone's own files and team folders (not external storage, which is off);
	# plain text and Markdown, PDF and office files (docx, xlsx, pptx, odt and the others); not the
	# inside of zip files. Files over SEARCH_MAX_FILE_MB (.env, 20 MB if not set) are found by name
	# only. A result opens the file itself.
	local max_mb="${SEARCH_MAX_FILE_MB:-20}"
	if ! [[ "$max_mb" =~ ^[1-9][0-9]{0,2}$ ]]; then
		log "  WARNING: SEARCH_MAX_FILE_MB=$max_mb is not a number of MB from 1 to 999; using 20"
		max_mb=20
	fi
	if ! occ files_fulltextsearch:configure \
		'{"files_local":true,"files_group_folders":true,"files_external":0,"files_office":true,"files_pdf":true,"files_zip":false,"files_size":'"$max_mb"',"files_open_result_directly":true}' >/dev/null; then
		log "  WARNING: what to index could not be set - see: docker compose logs app"
		return 0
	fi
	log "  search platform Elasticsearch, index nourax_drive; files and team folders, office, PDF and text, up to $max_mb MB"

	# The first index: every file that is already stored. Later files are added by the waiting list
	# (below). It runs in the background, in the service "jobs" when it runs (its own memory limit),
	# otherwise in the file server; how far it got: docs/search-and-antivirus.md.
	# Only Elasticsearch's own "no such index" (404 index_not_found_exception) starts it. Any other
	# error (the engine restarting, out of memory, a timeout) only logs "skipped": a full index of
	# every file then would add load at the worst moment, and the next run checks again.
	local indexer=app count_json
	[ "$(dc ps --format '{{.State}}' jobs 2>/dev/null)" != running ] || indexer=jobs
	if count_json="$(es_api GET /nourax_drive/_count </dev/null 2>/dev/null)"; then
		log "  index nourax_drive exists: $(jq -r '.count' <<<"$count_json") documents"
	elif ! jq -e '.status == 404 and .error.type == "index_not_found_exception"' <<<"$count_json" >/dev/null 2>&1; then
		log "  skipped: Elasticsearch did not say whether the index nourax_drive exists, so no first index"
		log "  is started now (the next configure run checks again) - see: docker compose logs elasticsearch"
	elif dc exec -d -u www-data "$indexer" php occ fulltextsearch:index --no-readline; then
		log "  first index of all stored files started in the background (in '$indexer')"
	else
		log "  WARNING: the first index could not be started - run: occ fulltextsearch:index --no-readline"
	fi

	# New, changed, shared and moved files go on a waiting list; the compose service "jobs" works
	# through it 2 minutes after each run ends (the app's own job does so only every 12 minutes).
	# An earlier version of this step used a host timer for that. It is switched off here so the
	# two never both run; its unit files stay in /etc/systemd/system (deleting them needs the owner).
	if [ -d /run/systemd/system ] && { systemctl is-enabled --quiet nourax-search-index.timer 2>/dev/null \
		|| systemctl is-active --quiet nourax-search-index.timer 2>/dev/null; }; then
		if systemctl disable --now nourax-search-index.timer 2>/dev/null; then
			log "  old host timer nourax-search-index.timer switched off (the service 'jobs' does its work now)"
		else
			log "  WARNING: the old host timer could not be switched off - run: systemctl disable --now nourax-search-index.timer"
		fi
	fi
	if [ "$(dc ps --format '{{.State}}' jobs 2>/dev/null)" = running ]; then
		log "  waiting list indexed every 2 minutes by the service 'jobs' ($(dc ps --format '{{.Status}}' jobs))"
	else
		log "  WARNING: the service 'jobs' is not running, so new files wait up to 12 minutes for the"
		log "  cron container. Start it with 'docker compose up -d --no-deps jobs'"
	fi
}

log "search inside files (fulltextsearch with Elasticsearch)"
nourax_search
