#!/usr/bin/env bash
# Memory of the server and of the add-on services (search engine, virus scanner, jobs, Nourax AI).
#   sudo config/elasticsearch/memory-report.sh [LABEL]
#       One report: free -m, /proc/swaps, docker stats, every container's memory limit and OOM
#       score, how often each container started again by itself and how it last stopped, the
#       out-of-memory crashes in the add-ons' logs of the last 24 hours, the add-ons' memory as the
#       kernel counts it (limit, use, highest use, times at the limit, OOM kills, swap), the swap of
#       every service, the 5 biggest processes, Elasticsearch's heap and heap dump files, and the
#       free disk. A WARNING line says when a service crashed or started again by itself in the last
#       24 hours, or when memory or disk is too tight for the time before the upgrade
#       (docs/search-and-antivirus.md, "If memory gets too tight").
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

# cgroup_dir SERVICE: the directory of the service's running container in the cgroup (v2) tree,
# or nothing when it is not running.
cgroup_dir() {
	local id
	id="$(dc ps -q "$1" 2>/dev/null)"
	[ -n "$id" ] || return 0
	id="$(docker inspect -f '{{.Id}}' "$id")"
	printf '/sys/fs/cgroup/system.slice/docker-%s.scope' "$id"
}

# cgroup_line SERVICE: the container's memory as its cgroup (v2) counts it, in MiB.
cgroup_line() {
	local dir
	dir="$(cgroup_dir "$1")"
	if [ -z "$dir" ]; then
		printf '%-14s not running\n' "$1"
		return 0
	fi
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

# restart_lines: for every container of the stack, how often Docker started it again by itself
# (RestartCount, counted from when the container was made), its state, the exit code of its last
# stop, whether the kernel stopped it at its limit (OOMKilled), and when it last started and was
# made. These are the numbers that show a crash loop: the kernel's counters in the add-on lines
# start from 0 again at every restart, and a Java heap crash is not a kernel OOM kill at all.
restart_lines() {
	local id now
	now="$(date -u +%s)"
	for id in $(dc ps -aq 2>/dev/null); do
		docker inspect -f '{{.Name}} {{.RestartCount}} {{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} {{.State.StartedAt}} {{.Created}}' "$id"
	done | sort | while read -r name rc state code oomk started made; do
		name="${name#/}"
		printf '%-34s restarts %4s  %-10s last exit code %3s  kernel OOM kill %-5s  started %s  made %s\n' \
			"$name" "$rc" "$state" "$code" "$oomk" "${started%.*}Z" "${made%.*}Z"
		if [ "$rc" -gt 0 ]; then
			if [ $((now - $(date -u -d "$started" +%s))) -lt 86400 ]; then
				echo "WARNING: $name was started again by itself $rc times since it was made; the last time in the last 24 hours - see docs/search-and-antivirus.md, \"Restarts and crashes\""
			else
				echo "  (note: $name was started again by itself $rc times since it was made, the last time over a day ago)"
			fi
		fi
		# A stopped or restarting container keeps the exit code of its last stop: 3 is Java's own
		# stop when its heap is full (-XX:+ExitOnOutOfMemoryError), 137 a forced stop (SIGKILL),
		# most often the kernel at the container's limit.
		if [ "$state" != running ]; then
			case "$code" in
				3) echo "WARNING: $name stopped because its Java heap was full (exit code 3)" ;;
				137) echo "WARNING: $name was stopped by force (exit code 137), most often by the kernel at its memory limit" ;;
			esac
		fi
		[ "$oomk" != true ] || echo "WARNING: $name was stopped by the kernel at its memory limit (OOMKilled)"
	done
}

# log_crashes SERVICE TEXT WHAT: how often TEXT is in the service's log of the last 24 hours, and
# when it was there last. WHAT names it in the line.
log_crashes() {
	local lines n last
	lines="$(dc logs --no-log-prefix --timestamps --since 24h "$1" 2>&1 | grep -F -- "$2" || true)"
	n=0
	[ -z "$lines" ] || n="$(printf '%s\n' "$lines" | wc -l)"
	if [ "$n" -eq 0 ]; then
		printf '%-14s %s: 0\n' "$1" "$3"
		return 0
	fi
	last="$(printf '%s\n' "$lines" | tail -n 1 | cut -d' ' -f1)"
	printf '%-14s %s: %s, the last at %s\n' "$1" "$3" "$n" "${last%.*}Z"
	echo "WARNING: $1: $3 $n times in the last 24 hours - see docs/search-and-antivirus.md, \"Restarts and crashes\""
}

report() {
	printf '\n===== %s: %s (up %s)\n' "$1" "$(date -u '+%Y-%m-%d %H:%M:%SZ')" "$(uptime -p | sed 's/^up //')"
	echo '--- free -m'
	free -m
	echo '--- /proc/swaps'
	cat /proc/swaps
	echo '--- docker stats --no-stream'
	docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.CPUPerc}}'
	# Highest OOM score first: when the whole server runs out of memory, the kernel stops the
	# process with the highest score first. 0 is the normal score (db, app, cron, onlyoffice, ...).
	echo '--- memory limit and OOM score of each container (docker inspect), highest score first'
	for id in $(dc ps -q 2>/dev/null); do
		docker inspect -f '{{.Name}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.OomScoreAdj}}' "$id"
	done | sort -k4,4nr -k1,1 | awk '
		function mib(b) { return (b <= 0) ? "none" : sprintf("%dm", b / 1048576) }
		{ name = $1; sub("^/", "", name)
		  printf "%-34s limit %6s  with swap %6s  OOM score %s\n", name, mib($2), mib($3), $4 }'
	echo '--- restarts and crashes of each container (docker inspect: RestartCount, State)'
	restart_lines
	# Out-of-memory crashes the kernel does not count: Java's own stop when the search engine's heap
	# is full, and a PHP run that needed more than its PHP_MEMORY_LIMIT.
	echo '--- out-of-memory crashes in the logs of the last 24 hours'
	log_crashes elasticsearch 'Terminating due to java.lang.OutOfMemoryError' 'Java heap full, Elasticsearch stopped'
	log_crashes jobs 'Allowed memory size of' 'PHP memory limit reached'
	log_crashes ai-worker 'Allowed memory size of' 'PHP memory limit reached'
	echo '--- add-ons, in MiB (program = memory that is not file cache; the kernel counts from 0 again at each restart)'
	for svc in elasticsearch clamav jobs ai-relay ai-worker; do
		cgroup_line "$svc"
	done
	# Whose memory is in swap: the swap used above, per running service (swap stays used after the
	# memory was needed elsewhere, until the service reads that memory again or restarts).
	local line="" dir
	for svc in $(dc ps --format '{{.Service}}' 2>/dev/null); do
		dir="$(cgroup_dir "$svc")"
		[ -r "$dir/memory.swap.current" ] || continue
		line+="$svc $(( $(<"$dir/memory.swap.current") / 1048576 ))  "
	done
	echo "--- swap by service, in MiB: ${line:-no cgroup v2 numbers}"
	echo '--- the 5 biggest processes (resident memory, in MiB; processes in containers included)'
	ps -eo rss,comm --sort=-rss | awk 'NR > 1 && NR <= 6 { printf "%6d  %s\n", $1 / 1024, $2 }'
	if [ "$(dc ps --format '{{.Health}}' elasticsearch 2>/dev/null)" = healthy ]; then
		echo '--- Elasticsearch Java, in MiB'
		es_api GET '/_nodes/_local/stats/jvm?filter_path=nodes.*.jvm.mem,nodes.*.jvm.threads' </dev/null \
			| jq -r '.nodes[].jvm | "heap used \(.mem.heap_used_in_bytes / 1048576 | floor) of \(.mem.heap_max_in_bytes / 1048576 | floor), outside the heap \(.mem.non_heap_committed_in_bytes / 1048576 | floor), threads \(.threads.count)"' \
			|| echo 'Elasticsearch did not answer'
	fi
	# Heap dumps (java_pid*.hprof): the JVM writes one, the size of its heap, each time the heap is
	# full, unless -XX:-HeapDumpOnOutOfMemoryError (compose.yaml). They stay in the container's own
	# layer until the container is made again. Since Elasticsearch 9.1 they go to logs/, before to data/.
	if [ "$(dc ps --format '{{.State}}' elasticsearch 2>/dev/null)" = running ]; then
		local sizes n_dumps
		if sizes="$(dc exec -T elasticsearch find /usr/share/elasticsearch/logs /usr/share/elasticsearch/data \
			-maxdepth 1 -name '*.hprof' -printf '%s\n' 2>/dev/null)"; then
			n_dumps="$(printf '%s' "$sizes" | grep -c . || true)"
			echo "--- Elasticsearch heap dump files (*.hprof): $n_dumps, $(printf '%s\n' "$sizes" | awk '{ s += $1 } END { printf "%d", s / 1048576 }') MiB"
			if [ "$n_dumps" -gt 0 ]; then
				echo 'WARNING: heap dump files fill the disk - see docs/search-and-antivirus.md, "Restarts and crashes"'
			fi
		else
			echo '--- Elasticsearch heap dump files (*.hprof): could not be read'
		fi
	fi
	# Too tight for the time before the upgrade: under 150 MB available, or over 1.5 GB of swap that
	# keeps growing (one report can't tell growing, so it asks for a second one).
	local avail swap_used
	avail="$(free -m | awk '$1 == "Mem:" { print $7 }')"
	swap_used="$(free -m | awk '$1 == "Swap:" { print $3 }')"
	echo "--- memory check: available ${avail} MB (tight under 150), swap used ${swap_used} MB (tight over 1536 and growing)"
	if [ "$avail" -lt 150 ]; then
		echo 'WARNING: under 150 MB available - see docs/search-and-antivirus.md, "If memory gets too tight"'
	fi
	if [ "$swap_used" -gt 1536 ]; then
		echo 'WARNING: over 1.5 GB of swap used - run this report again in 10 minutes; if it is still growing,'
		echo '         see docs/search-and-antivirus.md, "If memory gets too tight"'
	fi
	# The disk holds the containers, their logs and the swap file; the files themselves are in R2.
	local disk_free
	disk_free="$(df -BG --output=avail / | awk 'NR == 2 { sub("G", ""); print $1 }')"
	echo "--- disk check: ${disk_free} GB free on / (tight under 5)"
	if [ "$disk_free" -lt 5 ]; then
		echo 'WARNING: under 5 GB free on the disk - see docs/search-and-antivirus.md, "Restarts and crashes"'
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
