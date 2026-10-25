# Suspicious login and audit log. Both apps ship with the server:
# - suspicious_login learns from where each person usually signs in and warns them (a notification)
#   when a sign-in comes from an address that does not fit;
# - admin_audit writes sign-ins, file actions, shares and account, group and app changes to an
#   audit log on the server.
# Where the log is, how to read it and what it holds: docs/apps.md, "Suspicious login" and "Audit log".
# Sourced by scripts/configure.sh with its helpers (occ, dc, log). Safe to run again.
# SPDX-License-Identifier: AGPL-3.0-or-later

nourax_audit() {
	# What reaches the audit log. admin_audit writes at the INFO level (1), below the server's log
	# level (2, warnings and worse, in zz-nourax.config.php), so without a log condition nothing is
	# written. "matches" sets the level by app and by text (config.sample.php); the first match wins:
	# 1. occ commands ("Console command executed: ...") are left out (level 4, fatal only). Their
	#    arguments can hold secrets - configure.sh hands the ONLYOFFICE key to occ as one - and the
	#    log is a plain file. What occ changes in accounts, groups, apps and shares is still logged
	#    through those actions' own lines.
	# 2. "Login attempt: ..." is left out too. It comes before every sign-in, and every request with
	#    an app password (phones, desktop, NoMail) is a sign-in, so it was 62% of the lines in our
	#    test; each attempt also ends in a "Login successful" or "Login failed" line, which stay.
	# 3. everything else from admin_audit is written (INFO).
	# The upstream docs' simpler 'apps' => ['admin_audit'] is not used: it is checked before
	# "matches" and would let those lines through. The condition is set before the app is switched
	# on, so an occ line is never written. occ can't set a nested list in one step, so a short PHP
	# call replaces the whole value at once, read from stdin.
	local want have
	want='{"matches":[{"apps":["admin_audit"],"message":"Console command executed:","loglevel":4},{"apps":["admin_audit"],"message":"Login attempt: \"","loglevel":4},{"apps":["admin_audit"],"loglevel":1}]}'
	have="$(occ config:system:get log.condition --output=json 2>/dev/null || true)"
	if [ "$(jq -cS . <<<"${have:-null}" 2>/dev/null || true)" = "$(jq -cS . <<<"$want")" ]; then
		log "  log condition for the audit log already set"
	else
		# An older value is replaced, not merged; it is not printed (it could hold a shared secret).
		[ -z "$have" ] || log "  replacing a different log.condition"
		if ! printf '%s' "$want" | dc exec -T -u www-data app php -r '
			require "/var/www/html/lib/base.php";
			$value = json_decode(stream_get_contents(STDIN), true, 8, JSON_THROW_ON_ERROR);
			\OCP\Server::get(\OCP\IConfig::class)->setSystemValue("log.condition", $value);
		'; then
			log "  WARNING: the log condition could not be set, so admin_audit stays off - see: docker compose logs app"
			return 0
		fi
		log "  log condition set: admin_audit at INFO, occ command and sign-in attempt lines left out"
	fi

	# Rotation. The server's job rotates nextcloud.log every hour and admin_audit's job rotates
	# audit.log every 3 hours, both when the file is over log_rotate_size: the file is renamed to
	# .1 (replacing the older .1) and a new one is started. 50 MiB (default 100 MiB). The size is
	# only checked when the job runs, so a busy server takes the audit log past 50 MiB by up to 3
	# hours of lines first (measured sizes: docs/apps.md, "Rotation"). The audit log stays at its
	# default place, <datadirectory>/audit.log
	# (/var/www/html/data/audit.log, in the "nextcloud" volume): admin_audit's rotation job does not
	# read logfile_audit, so a log set there would never be rotated.
	if [ "$(occ config:system:get log_rotate_size 2>/dev/null || true)" != 52428800 ]; then
		occ config:system:set log_rotate_size --type=integer --value=52428800 >/dev/null
	fi
	log "  logs rotated at 50 MiB, one older copy kept"

	# Both apps ship with the server (so no app-store download); the versions are the ones of the
	# tested server, 35.0.2. Another version is only logged.
	local entry id pinned have_version
	for entry in suspicious_login:13.0.0 admin_audit:2.0.0; do
		id="${entry%%:*}" pinned="${entry#*:}"
		have_version="$(occ app:list --output=json | jq -r --arg a "$id" '.enabled[$a] // empty')" || have_version=""
		if [ -z "$have_version" ]; then
			if ! occ app:enable "$id" >/dev/null; then
				log "  WARNING: $id could not be enabled - see: docker compose logs app"
				continue
			fi
			have_version="$(occ app:list --output=json | jq -r --arg a "$id" '.enabled[$a] // empty')" || have_version=""
		fi
		if [ "$have_version" = "$pinned" ]; then
			log "  $id $have_version"
		else
			log "  WARNING: $id is ${have_version:-not enabled}, tested $pinned"
		fi
	done

	# The apps' own background jobs, registered when they are switched on: suspicious_login moves new
	# sign-ins into its table every hour (ETLJob) and trains its models once a day in the night window
	# (TrainJobIpV4, TrainJobIpV6; maintenance_window_start = 1, so 01:00-06:00 UTC, after one first
	# run straight away); admin_audit's Rotate job rotates the audit log. A missing one is only logged.
	local job count missing=""
	for job in 'OCA\SuspiciousLogin\BackgroundJob\ETLJob' 'OCA\SuspiciousLogin\BackgroundJob\TrainJobIpV4' \
		'OCA\SuspiciousLogin\BackgroundJob\TrainJobIpV6' 'OCA\AdminAudit\BackgroundJobs\Rotate'; do
		count="$(occ background-job:list --class="$job" --output=json 2>/dev/null | jq 'length' 2>/dev/null)" || count=0
		if [ "${count:-0}" -lt 1 ]; then
			missing="$missing ${job##*\\}"
		fi
	done
	if [ -n "$missing" ]; then
		log "  WARNING: background jobs not registered:$missing - switch the app off and on again"
	else
		log "  background jobs registered: sign-in data hourly, training nightly, audit log rotation"
	fi
}

log "suspicious login and audit log (suspicious_login, admin_audit)"
nourax_audit
unset -f nourax_audit
