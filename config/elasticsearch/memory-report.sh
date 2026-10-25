#!/usr/bin/env bash
# Memory of the server and of the add-on services (search engine, virus scanner, jobs).
#   sudo config/elasticsearch/memory-report.sh [LABEL]
#       One report: free -m, /proc/swaps, docker stats, the add-ons' memory as the kernel counts
#       it (limit, use, highest use, times at the limit, OOM kills, swap) and Elasticsearch's heap.
#   sudo config/elasticsearch/memory-report.sh --around-start [USER WORD...]
#       Before and after Elasticsearch: stops the services "elasticsearch" and "jobs", waits a
#       minute, reports "before"; starts both again, indexes all files again (in "jobs"), searches
#       each WORD as USER, waits half a minute and reports "after". Search inside files is off for
#       about 3 minutes. It changes the server, so run it under the deploy lock (see the docs).
# Reads only; nothing is printed that is secret. Explained in docs/search-and-antivirus.md, "Memory".
# SPDX-License-Identifier: AGPL-3.0-or-later

. "$(dirname "$0")/../../scripts/lib.sh"
need_root
# es_api (one request to Elasticsearch as its superuser, password never on a command line).
# shellcheck disable=SC1090
. <(sed -n '/^es_api()/,/^}/p' "$REPO_DIR/scripts/configure.d/50-search.sh")

# cgroup_line SERVICE: the container's memory as its cgroup (v2) counts it, in MiB.
cgroup_line() {
	local id dir
	id="$(dc ps -q "$1" 2>/dev/null)"
	if [ -z "$id" ]; then
		printf '%-14s not running\n' "$1"
		return 0
	fi
	id="$(docker inspect -f '{{.Id}}' "$id")"
	dir="/sys/fs/cgroup/system.slice/docker-$id.scope"
	if [ ! -r "$dir/memory.current" ]; then
		printf '%-14s no cgroup v2 numbers\n' "$1"
		return 0
	fi
	awk -v svc="$1" \
		-v max="$(cat "$dir/memory.max")" -v cur="$(cat "$dir/memory.current")" \
		-v peak="$(cat "$dir/memory.peak" 2>/dev/null || echo 0)" \
		-v swap="$(cat "$dir/memory.swap.current" 2>/dev/null || echo 0)" \
		-v atmax="$(awk '$1 == "max" {print $2}' "$dir/memory.events")" \
		-v oom="$(awk '$1 == "oom_kill" {print $2}' "$dir/memory.events")" \
		'$1 == "anon" {anon = $2} $1 == "file" {file = $2}
		END {
			m = 1048576
			lim = (max == "max") ? "none" : sprintf("%d", max / m)
			printf "%-14s limit %5s  now %5d  highest %5d  program %5d  file cache %4d  swap %4d  at limit %s times  OOM kills %s\n",
				svc, lim, cur / m, peak / m, anon / m, file / m, swap / m, atmax, oom
			# Program memory near the limit: the container swaps and slows down before the kernel
			# would stop it (at its limit plus as much swap again).
			if (max != "max" && anon + swap > 0.9 * max)
				printf "%-14s WARNING: program memory and swap are over 90%% of the limit - see docs/search-and-antivirus.md, Memory\n", svc
			if (oom > 0)
				printf "%-14s WARNING: stopped by the kernel %s times at its limit\n", svc, oom
		}' "$dir/memory.stat"
}

report() {
	printf '\n===== %s: %s (up %s)\n' "$1" "$(date -u '+%Y-%m-%d %H:%M:%SZ')" "$(uptime -p | sed 's/^up //')"
	echo '--- free -m'
	free -m
	echo '--- /proc/swaps'
	cat /proc/swaps
	echo '--- docker stats --no-stream'
	docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.CPUPerc}}'
	echo '--- add-ons, in MiB (program = memory that is not file cache)'
	for svc in elasticsearch clamav jobs; do
		cgroup_line "$svc"
	done
	if [ "$(dc ps --format '{{.Health}}' elasticsearch 2>/dev/null)" = healthy ]; then
		echo '--- Elasticsearch Java, in MiB'
		es_api GET '/_nodes/_local/stats/jvm?filter_path=nodes.*.jvm.mem,nodes.*.jvm.threads' </dev/null \
			| jq -r '.nodes[].jvm | "heap used \(.mem.heap_used_in_bytes / 1048576 | floor) of \(.mem.heap_max_in_bytes / 1048576 | floor), outside the heap \(.mem.non_heap_committed_in_bytes / 1048576 | floor), threads \(.threads.count)"' \
			|| echo 'Elasticsearch did not answer'
	fi
}

# wait_healthy SERVICE SECONDS
wait_healthy() {
	local end=$((SECONDS + $2))
	until [ "$(dc ps --format '{{.Health}}' "$1" 2>/dev/null)" = healthy ]; do
		[ "$SECONDS" -lt "$end" ] || { log "WARNING: $1 is not healthy after $2 seconds"; return 1; }
		sleep 5
	done
}

if [ "${1:-}" != --around-start ]; then
	report "${1:-now}"
	exit 0
fi
shift
user="${1:-}"
[ "$#" -eq 0 ] || shift

log "stopping elasticsearch and jobs (search inside files is off until they are back)"
dc stop jobs elasticsearch
sleep 60
report "before: Elasticsearch and jobs stopped for a minute"

log "starting elasticsearch"
dc up -d --no-deps elasticsearch
wait_healthy elasticsearch 300 || true
log "starting jobs"
dc up -d --no-deps jobs
log "indexing all files again, in jobs"
# Only one indexing run at a time: the first run of jobs' own loop goes first.
for try in 1 2 3; do
	sleep 20
	start=$SECONDS
	# Its progress panel goes to stderr; the exit code says whether it ran.
	if dc exec -T -u www-data jobs timeout 10m php occ fulltextsearch:index --no-readline >/dev/null 2>&1; then
		log "  done in $((SECONDS - start)) seconds; index nourax_drive: $(es_api GET /nourax_drive/_count </dev/null | jq -r '.count') documents"
		break
	fi
	log "  WARNING: the full index did not run (try $try of 3) - another run may still be busy"
done
for word in "$@"; do
	n="$(dc exec -T -u www-data jobs php occ fulltextsearch:search "$user" "$word" --output=json | jq '[.[] | length] | add // 0')" || n=error
	log "  search as $user: $n results"
done
sleep 30
report "after: Elasticsearch running, all files indexed, searches done"
