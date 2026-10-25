# Virus scanner: the files_antivirus app sends every upload to ClamAV (compose service "clamav")
# and refuses infected files. What people see and how it behaves: docs/search-and-antivirus.md.
# Sourced by scripts/configure.sh with its helpers (occ, dc, log) after 50-apps.sh, whose
# nourax_app it uses. Safe to run again.
# SPDX-License-Identifier: AGPL-3.0-or-later

log "virus scanner (files_antivirus with ClamAV)"
# While the app can't reach ClamAV it refuses every upload (av_block_unreachable below), so it is
# only switched on once clamd answers. After a start clamd needs a few minutes to load its
# signatures, and the very first start downloads them first.
if ! dc exec -T clamav clamdcheck.sh >/dev/null 2>&1; then
	if occ app:list --output=json | jq -e '.enabled.files_antivirus != null' >/dev/null; then
		log "  WARNING: ClamAV is not answering, so uploads are refused until it does - see: docker compose ps clamav"
	else
		log "  ClamAV is not running or still loading, so files_antivirus stays off. Start it with"
		log "  'docker compose up -d clamav', wait until 'docker compose ps clamav' says healthy, then run configure.sh again"
	fi
else
	log "  $(dc exec -T clamav sh -c 'echo VERSION | nc localhost 3310' || echo 'ClamAV version unknown')"
	# The settings go in before the app is switched on, so it never runs with its defaults (those
	# look for a clamscan program, which the file server doesn't have, and refuse the upload).
	occ config:app:set files_antivirus av_mode --value=daemon --type=string
	occ config:app:set files_antivirus av_host --value=clamav --type=string
	occ config:app:set files_antivirus av_port --value=3310 --type=integer
	# At most 100 MiB per stream, below clamd's StreamMaxLength of 110M; a bigger file is sent in
	# several streams. No size limit for scanning.
	occ config:app:set files_antivirus av_stream_max_length --value=104857600 --type=integer
	occ config:app:set files_antivirus av_max_file_size --value=-1 --type=integer
	# Files already stored are scanned again in the background (new signatures); a find there is
	# only logged and shown in the file owner's activity list. Deleting needs the owner's yes: see
	# docs/search-and-antivirus.md.
	occ config:app:set files_antivirus av_infected_action --value=only_log --type=string
	occ config:app:set files_antivirus av_background_scan --value=true --type=boolean
	# No scanner, no upload.
	occ config:app:set files_antivirus av_block_unreachable --value=true --type=boolean
	nourax_app files_antivirus 6.5.0
	# The app's own test scans a plain text and the EICAR test string, both held in memory, so
	# nothing is stored. Its third step adds letters after the EICAR string. ClamAV follows the
	# EICAR rule that only spaces and line ends may follow it, so that step always says "not
	# detected" here and is left out of the check.
	test_out="$(occ files_antivirus:test 2>&1 || true)"
	printf '%s\n' "$test_out"
	if [[ "$test_out" == *"Scanning regular text: ✓"* && "$test_out" == *"Scanning EICAR test file: ✓"* ]]; then
		log "  scanner test passed: clean text accepted, EICAR test string found"
	else
		log "  WARNING: the scanner test failed - see: docker compose logs clamav"
	fi

	# Big uploads arrive in parts, which the object storage joins without the app seeing the data,
	# so those files are scanned after the upload. The app's own background job can't be relied on
	# here: with object storage it counts version and editor files that it can never open as "not
	# scanned yet", takes the same 10 of them on every run and never gets to new files. The full
	# scan command has no such limit, so a host timer runs it every 15 minutes.
	if [ -d /run/systemd/system ]; then
		if install -m 0644 "$REPO_DIR"/config/clamav/nourax-virus-scan.{service,timer} /etc/systemd/system/ \
			&& systemctl daemon-reload && systemctl enable --now nourax-virus-scan.timer; then
			log "  stored-file scan every 15 minutes: nourax-virus-scan.timer $(systemctl is-active nourax-virus-scan.timer)"
		else
			log "  WARNING: nourax-virus-scan.timer could not be switched on - see: systemctl status nourax-virus-scan.timer"
		fi
	else
		log "  WARNING: no systemd here, so run 'occ files_antivirus:background-scan' every 15 minutes another way"
	fi
fi
