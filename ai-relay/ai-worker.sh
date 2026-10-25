#!/bin/bash
# Entry point of the compose service "ai-worker": runs the Assistant's AI tasks as soon as they are
# asked for. Without it they wait for the cron container, up to 5 minutes (docs/assistant.md).
# It runs Nextcloud's own worker (occ taskprocessing:worker), which looks for a new task every 2
# seconds and ends after 5 minutes, so settings and app updates are picked up; this loop then
# starts it again. A task that has started is finished before the container stops (SIGTERM).
# Same image, files and settings as "cron" (extends), as www-data.
# SPDX-License-Identifier: AGPL-3.0-or-later

set -u

ALIVE=/tmp/nourax-ai-worker.alive   # the healthcheck looks at its age
stop=0
child=0

on_stop() {
	stop=1
	if [ "$child" -gt 0 ]; then
		kill -TERM "$child" 2>/dev/null || true
	fi
}
trap on_stop TERM INT

cd /var/www/html || exit 1
while [ "$stop" -eq 0 ]; do
	touch "$ALIVE"
	php occ taskprocessing:worker --timeout=300 --interval=2 &
	child=$!
	# wait returns early when a signal arrives; wait again until the worker has really ended.
	while kill -0 "$child" 2>/dev/null; do
		wait "$child" || true
	done
	child=0
	[ "$stop" -eq 0 ] || break
	# A short pause, so a worker that fails at once (database down) does not spin.
	sleep 5 &
	wait $! || true
done
exit 0
