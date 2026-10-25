# Nourax AI for the Assistant: the Assistant app (assistant) with its OpenAI-style provider app
# (integration_openai), pointed at the relay (compose service "ai-relay", ai-relay/relay.py), which
# sends every request to NIG for the signed-in person. People see no keys and no AI settings, only
# nourax-* models are used, and each request counts against that person's Nourax AI budget. Until NIG's
# key is in place the Assistant answers "Nourax AI is not available yet." How it works, and what to do
# when NIG's key arrives: docs/assistant.md.
# Sourced by scripts/configure.sh with its helpers (occ, dc, log, secret_path, have_secret) after
# 50-apps.sh, whose nourax_app it uses. To run only this step on the server:
#   sudo bash -c '. scripts/lib.sh; load_env; . scripts/configure.d/50-apps.sh; . scripts/configure.d/50-assistant.sh'
# Safe to run again.
# SPDX-License-Identifier: AGPL-3.0-or-later

# The one changed line of integration_openai 5.0.0 (NOTICE.md). Upstream sends the account id as
# "user" only to api.openai.com; NIG needs it on every request to charge the right person, so
#   if ($userId !== null && $this->isUsingOpenAi()) {   becomes   if ($userId !== null) {
# Only the release file with the first checksum is changed (sed, as www-data). Any other file is
# left alone with a WARNING; the relay then gets no user and answers "not available yet", so nobody is
# charged wrongly. occ app:update puts the original file back and the next run of this step patches it
# again. The admin overview's code check lists this one file.
ASSISTANT_OAI_ORIGINAL=ce14a031f931cba63a3898d2c01d2718ef265c8b7f41951ed17810ae8ca34140
ASSISTANT_OAI_PATCHED=46586b91a42844b8bfc23961da3ce252825abf6bc10c884bb7ee723051bf4072

# What the Assistant's chat is told about itself (upstream: "you, Nextcloud Assistant").
ASSISTANT_CHAT_INSTRUCTIONS='This is a conversation in a specific language between the user and you, Nourax AI, the assistant of Nourax Workspace. You are a kind, polite and helpful AI that helps the user to the best of its abilities. If you do not understand something, you will ask for clarification. Detect the language that the user is using. Make sure to use the same language in your response. Do not mention the language explicitly. Format your answers properly in markdown.'
ASSISTANT_TITLE_INSTRUCTIONS='This is a conversation between the user and Nourax AI. Generate a suitable title for the conversation that summarizes it. Detect the language of the conversation. The title that you output should be in the same language as the conversation. Output only the title in plain text, nothing else. Do not mention the language explicitly. For example, if the conversation is about trees in sweden but is written in Spanish, the title could be "Àrboles en Suecia", if it was in English, the title could be "Trees in Sweden". Do not write the title in e.g. Swedish just because Sweden is mentioned in the conversation.'

# assistant_newer_than_start SERVICE FILE...
# True when one of the files changed after the service's container started. A running container
# keeps seeing the old copy of a bind-mounted file that was replaced (git pull, secrets.sh), so the
# container must then be made again.
assistant_newer_than_start() {
	local service="$1" id started newest
	shift
	id="$(dc ps -q "$service" 2>/dev/null)" || id=""
	[ -n "$id" ] || return 0
	started="$(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$id")" +%s 2>/dev/null)" || return 0
	newest="$(stat -c %Y "$@" | sort -n | tail -n 1)"
	[ "$newest" -gt "$started" ]
}

# assistant_up SERVICE FILE...
# Starts the service, or makes it again when one of the files is newer than its container.
assistant_up() {
	local service="$1" out
	if assistant_newer_than_start "$@"; then
		out="$(dc up -d --no-deps --force-recreate "$service" 2>&1)" || { log "  WARNING: $service did not start: $out"; return 1; }
		log "  $service started (again) with the current files"
	else
		out="$(dc up -d --no-deps "$service" 2>&1)" || { log "  WARNING: $service did not start: $out"; return 1; }
	fi
}

# oai_set KEY VALUE lazy|fast
# One integration_openai setting, stored exactly as the app stores it (always a string; "lazy" or not),
# otherwise the app reads its default instead.
oai_set() {
	local lazy=--no-lazy
	[ "$3" = lazy ] && lazy=--lazy
	occ config:app:set integration_openai "$1" --value="$2" --type=string "$lazy" --no-interaction >/dev/null
}

nourax_assistant() {
	local model="${NOURAX_AI_MODEL:-nourax-smart}" health dir file have i key patched=0
	case "$model" in
		nourax-smart | nourax-long-context | nourax-fast) ;;
		*) log "  WARNING: NOURAX_AI_MODEL=$model is not a Nourax model; using nourax-smart"; model=nourax-smart ;;
	esac

	# 1. The relay's two secrets. ai_relay_token: the file server's password for the relay, made here.
	#    nig_assistant_key: NIG's key for the "assistant" service; it says "unset" until NIG's side puts
	#    the real key in (docs/assistant.md, "When NIG's key arrives"). Neither value is printed.
	have_secret ai_relay_token || bash "$REPO_DIR/scripts/secrets.sh" gen ai_relay_token
	have_secret nig_assistant_key || printf 'unset' | bash "$REPO_DIR/scripts/secrets.sh" put nig_assistant_key

	# 2. The relay, then a look at it from the file server's side (the same address the app uses).
	assistant_up ai-relay "$REPO_DIR/ai-relay/relay.py" "$(secret_path ai_relay_token)" "$(secret_path nig_assistant_key)" || return 0
	health=""
	for i in $(seq 1 15); do
		health="$(dc exec -T app curl -sf --max-time 5 http://ai-relay:8080/healthz 2>/dev/null)" && break
		sleep 2
	done
	if [ -z "$health" ]; then
		log "  WARNING: the relay does not answer on http://ai-relay:8080 - see: docker compose logs ai-relay"
		return 0
	fi
	log "  relay: $(jq -r '"NIG key \(.nig_key), stream \(.stream), version \(.version)"' <<<"$health")"

	# 3. integration_openai's settings, before it is switched on, so its first request already goes to
	#    the relay. Text tasks only (chat, summary, headline, translation and the other text tools), one
	#    model for all of them; no pictures, speech or files sent to the AI (NIG offers chat only).
	#    service_name is what the Assistant shows as the provider ("Nourax AI").
	oai_set url "http://ai-relay:8080/v1" fast
	oai_set service_name "Nourax AI" lazy
	oai_set default_completion_model_id "$model" lazy
	oai_set chat_endpoint_enabled 1 lazy
	oai_set use_max_completion_tokens_param 0 lazy
	oai_set max_tokens 8192 lazy
	oai_set request_timeout 120 lazy   # the relay gives up on NIG after 110 seconds
	oai_set use_basic_auth 0 lazy
	oai_set llm_provider_enabled 1 fast
	oai_set translation_provider_enabled 1 fast
	for key in t2i_provider_enabled stt_provider_enabled tts_provider_enabled multimodal_image_enabled 		multimodal_audio_enabled multimodal_video_enabled multimodal_document_enabled; do
		oai_set "$key" 0 fast
	done

	# 4. The two apps. Their names on screen come from the branding sweep ("Nourax AI" for the upstream
	#    "<name> Assistant"); the line assistant=Nourax AI in app-labels.d/50-apps.conf is for an app-menu
	#    entry, which this release does not have (it opens from the top bar).
	log "  apps: integration_openai, assistant"
	nourax_app integration_openai 5.0.0
	nourax_app assistant 4.0.0

	# 5. After the install, because the apps' first-install steps rewrite these keys: the relay token as
	#    integration_openai's "API key", and the Assistant's own settings.
	#    The token goes in from stdin and is stored encrypted (sensitive), so it never shows in a process
	#    list or in 'occ config:list'. It is marked sensitive before the value is written.
	if ! dc exec -T -u www-data app php -r '
			require "/var/www/html/lib/base.php";
			$config = \OCP\Server::get(\OCP\IAppConfig::class);
			$app = "integration_openai";
			$key = "api_key";
			if (!$config->hasKey($app, $key, null)) {
				$config->setValueString($app, $key, "", lazy: true);
			}
			$config->updateSensitive($app, $key, true);
			$config->setValueString($app, $key, trim(stream_get_contents(STDIN)), lazy: true);
		' < "$(secret_path ai_relay_token)"; then
		log "  WARNING: the relay token could not be saved for integration_openai - see: docker compose logs app"
		return 0
	fi
	log "  integration_openai: relay http://ai-relay:8080/v1, model $model, text tasks only"
	#    The Assistant: no picture, sticker or speech pickers (nothing would answer them), and its chat
	#    calls itself Nourax AI.
	for key in text_to_image_picker_enabled text_to_sticker_picker_enabled speech_to_text_picker_enabled; do
		occ config:app:set assistant "$key" --value=0 --type=string --lazy --no-interaction >/dev/null
	done
	occ config:app:set assistant chat_user_instructions --value="$ASSISTANT_CHAT_INSTRUCTIONS" --type=string --lazy --no-interaction >/dev/null
	occ config:app:set assistant chat_user_instructions_title --value="$ASSISTANT_TITLE_INSTRUCTIONS" --type=string --lazy --no-interaction >/dev/null
	#    Task types that need speech, pictures, files or tools: the two apps offer them whatever the
	#    settings above say (speech, stickers, voice chat), and the Assistant's chat would send its
	#    messages as "multimodal chat with tools" when that is offered. They are switched off with the
	#    server's own task-type switch (Administration settings > Artificial intelligence), so the
	#    chat sends plain text and nobody picks a tool that cannot answer. The server keeps its list
	#    of task types for up to a minute. Back on: occ taskprocessing:task-type:set-enabled TYPE 1
	for key in core:text2speech core:audio2audio:chat core:audio2audio:translate core:contextagent:audio-interaction \
		assistant:text2sticker core:text2text:chatwithtools core:text2text:multimodal-chatwithtools; do
		occ taskprocessing:task-type:set-enabled "$key" 0 >/dev/null
	done
	log "  assistant: text tools only, the chat calls itself Nourax AI"

	# 6. The patch (see the top of this file).
	dir="$(occ app:getpath integration_openai 2>/dev/null)" || dir=""
	if [ -z "$dir" ]; then
		log "  WARNING: integration_openai is not installed, so it is not patched"
	else
		file="$dir/lib/Service/OpenAiAPIService.php"
		have="$(dc exec -T app sha256sum "$file" 2>/dev/null | cut -d' ' -f1)" || have=""
		if [ "$have" = "$ASSISTANT_OAI_ORIGINAL" ]; then
			dc exec -T -u www-data app sed -i \
				's/^\t\tif (\$userId !== null && \$this->isUsingOpenAi()) {$/\t\tif ($userId !== null) {/' "$file"
			have="$(dc exec -T app sha256sum "$file" 2>/dev/null | cut -d' ' -f1)" || have=""
			patched=1
		fi
		case "$have" in
			"$ASSISTANT_OAI_PATCHED") log "  integration_openai sends the account id to the relay (patched $([ "$patched" = 1 ] && echo now || echo before))" ;;
			*) log "  WARNING: $file is not the 5.0.0 release file (sha256 ${have:-unreadable}), so it is NOT patched."
			   log "  The Assistant answers 'Nourax AI is not available yet' until this step knows that release (docs/assistant.md)" ;;
		esac
	fi

	# 7. No AI settings for people: the personal settings section "Assistant" (/settings/user/ai) holds
	#    the Assistant's own options and a field for one's own AI key; both are hidden, with their
	#    menu entry. A key someone sets anyway (through the app's API) only breaks their own Assistant:
	#    the relay refuses it. configure.sh writes the theme CSS fresh before this file runs; an older
	#    copy of the block is dropped anyway, so running this file on its own does not add it twice.
	local css block
	block='/* NouraxAssistant50:start - Nourax AI (scripts/configure.d/50-assistant.sh) */
#assistant_prefs, #openai_prefs,
li:has(> a[href$="/settings/user/ai"]), a[href$="/settings/user/ai"] { display: none !important; }
/* NouraxAssistant50:end */'
	css="$(occ config:app:get theming_customcss customcss || true)"
	css="$(printf '%s\n' "$css" | sed '/\/\* NouraxAssistant50:start/,/\/\* NouraxAssistant50:end \*\//d')"
	occ config:app:set theming_customcss customcss --value="$css"$'\n'"$block" --no-lazy --no-interaction >/dev/null
	occ config:app:set theming_customcss cachebuster --value="$(date +%s)"
	log "  personal AI settings hidden"

	# 8. The worker that runs AI tasks at once. Made again when its script changed, or when the patch
	#    was put in just now (a running worker keeps the code it started with for up to 5 minutes).
	if [ "$patched" = 1 ] && [ -n "$(dc ps -q ai-worker 2>/dev/null)" ]; then
		dc restart ai-worker >/dev/null 2>&1 || true
	fi
	assistant_up ai-worker "$REPO_DIR/ai-relay/ai-worker.sh" || return 0
	log "  ai-worker: $(dc ps --format '{{.Status}}' ai-worker 2>/dev/null)"

	if [ "$(jq -r .nig_key <<<"$health")" = set ]; then
		log "  Nourax AI is on: requests go to NIG"
	else
		log "  Nourax AI waits for NIG's key: people get 'Nourax AI is not available yet.' (docs/assistant.md)"
	fi
}

log "Nourax AI for the Assistant (assistant, integration_openai, relay to NIG)"
nourax_assistant
unset -f nourax_assistant oai_set assistant_up assistant_newer_than_start
unset ASSISTANT_OAI_ORIGINAL ASSISTANT_OAI_PATCHED ASSISTANT_CHAT_INSTRUCTIONS ASSISTANT_TITLE_INSTRUCTIONS
