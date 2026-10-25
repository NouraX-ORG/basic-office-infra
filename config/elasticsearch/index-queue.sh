#!/usr/bin/env bash
# Makes new and changed files searchable within about two minutes. It runs the full-text app's own
# indexing job (OCA\FullTextSearch\Cron\Index) 2 minutes after each run ends, instead of waiting for
# its 12-minute turn in the cron container. The job only reads the files on its waiting list, so a
# run with nothing waiting takes a second or two, and between runs only this script and sleep are
# in memory.
# It is the main program of the compose service "jobs" (same image and files as the file server,
# but its own memory limit) and runs as www-data for as long as that container runs. A problem is
# logged (docker compose logs jobs) and the next run tries again. Why: docs/search-and-antivirus.md.
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

interval="${SEARCH_INDEX_INTERVAL:-120}"   # seconds from the end of one run to the start of the next
alive=/tmp/nourax-jobs.alive               # touched before every run; the healthcheck reads its age

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
occ() { php /var/www/html/occ "$@"; }

# Only inside the file server's image: the server itself has no occ to call.
if [ ! -f /var/www/html/occ ]; then
	log "ERROR: this runs inside the compose service 'jobs' only - see: docker compose ps jobs" >&2
	exit 1
fi

# docker compose stop: a run that has started is finished first (bash runs the trap when it
# returns); a pause between runs ends at once.
trap 'log "stopping"; exit 0' TERM INT

log "search index of new and changed files: every ${interval} seconds"
waiting_logged=""
while :; do
	touch "$alive"
	# The job's id changes only when the app is installed again, so it is looked up every time.
	if ! json="$(occ background-job:list --class='OCA\FullTextSearch\Cron\Index' --output=json)"; then
		log "WARNING: the file server did not answer - see: docker compose logs jobs app"
		json='[]'
	fi
	job="$(printf '%s' "$json" | php -r '$j = json_decode(stream_get_contents(STDIN), true); echo is_array($j) ? ($j[0]["id"] ?? "") : "";')" || job=""
	if [ -n "$job" ]; then
		waiting_logged=""
		# Another indexing run (the cron container's turn, or a full index) makes this one stop at
		# once. Over an hour means something hangs: it is stopped and the next run starts again.
		if ! timeout 1h php /var/www/html/occ background-job:execute --force-execute "$job" >/dev/null; then
			log "WARNING: the indexing job $job failed or took over an hour - see: docker compose logs app"
		fi
	elif [ -z "$waiting_logged" ]; then
		log "no full-text indexing job found (fulltextsearch is not enabled yet) - waiting for it"
		waiting_logged=yes
	fi
	sleep "$interval" &
	wait $! || true
done
