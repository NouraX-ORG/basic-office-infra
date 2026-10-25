#!/usr/bin/env bash
# Makes new and changed files searchable within about two minutes. It runs the full-text app's own
# indexing job (OCA\FullTextSearch\Cron\Index) now, instead of waiting for its 12-minute turn in the
# cron container. The job only reads the files on its waiting list, so a run with nothing waiting
# takes a second or two and no process stays in memory between runs.
# Run by nourax-search-index.service (installed by scripts/configure.d/50-search.sh); see
# docs/search-and-antivirus.md. It never fails the timer: a problem is logged and the next run tries again.
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/../../scripts/lib.sh"

# The job's id changes only when the app is installed again, so it is looked up on every run.
if ! job="$(occ background-job:list --class='OCA\FullTextSearch\Cron\Index' --output=json | jq -r '.[0].id // empty')"; then
	log "WARNING: the file server did not answer - see: docker compose ps app"
	exit 0
fi
if [ -z "$job" ]; then
	log "no full-text indexing job found (fulltextsearch is not enabled) - nothing to do"
	exit 0
fi
# Another indexing run (the cron container's turn, or a full index) makes this one stop at once.
if ! occ background-job:execute --force-execute "$job" >/dev/null; then
	log "WARNING: the indexing job $job failed - see: docker compose logs app"
fi
exit 0
