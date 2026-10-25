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
	occ config:app:set files_antivirus av_mode --value=daemon
	occ config:app:set files_antivirus av_host --value=clamav
	occ config:app:set files_antivirus av_port --value=3310 --type=integer
	# At most 100 MiB per stream, below clamd's StreamMaxLength of 110M; a bigger file is sent in
	# several streams. No size limit for scanning.
	occ config:app:set files_antivirus av_stream_max_length --value=104857600 --type=integer
	occ config:app:set files_antivirus av_max_file_size --value=-1 --type=integer
	# Files already stored are scanned again in the background (new signatures); a find there is
	# only logged and shown in the file owner's activity list. Deleting needs the owner's yes: see
	# docs/search-and-antivirus.md.
	occ config:app:set files_antivirus av_infected_action --value=only_log
	occ config:app:set files_antivirus av_background_scan --value=true --type=boolean
	# No scanner, no upload.
	occ config:app:set files_antivirus av_block_unreachable --value=true --type=boolean
	nourax_app files_antivirus 6.5.0
	# Scans a plain text and an EICAR test string held in memory; nothing is stored.
	if occ files_antivirus:test; then
		log "  scanner test passed"
	else
		log "  WARNING: files_antivirus:test failed - see: docker compose logs clamav"
	fi
fi
