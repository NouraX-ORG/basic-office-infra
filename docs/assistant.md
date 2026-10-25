# Nourax AI in the Assistant

The **Assistant** (the Nourax AI button in the top bar, and the AI actions in NoDrive and the text
editor) uses Nourax AI only:
- people see no keys and no AI settings;
- only the `nourax-*` models are used;
- every request counts against the signed-in person's Nourax AI budget in NIG, the same budget the
  editors and NoMail use.

Until NIG's side is ready (section "When NIG's key arrives"), everything is set up and the Assistant
answers **"Nourax AI is not available yet."** instead of an error.

```
Browser: Assistant (top bar), NoDrive, text editor
   │  the task goes into the file server's task list (database)
   ▼
ai-worker (compose service): occ taskprocessing:worker picks it up within 2 seconds
   │  integration_openai 5.0.0, provider "Nourax AI" (one line patched: always sends "user")
   │  POST http://ai-relay:8080/v1/chat/completions
   │  Authorization: Bearer <ai_relay_token>   body: model nourax-smart, user = account id, messages
   ▼
ai-relay (compose service, ai-relay/relay.py), inside the compose network only
   │  1. checks the token (constant time), "user" in NIG's format, the model is a nourax-* one
   │  2. keeps only chat fields, adds NIG's key and X-Nourax-Feature: assistant
   │  3. turns every refusal or failure into a plain answer (HTTP 200)
   ▼
NIG  https://nig.nourax.org/v1/chat/completions   service "assistant" (budgets, prices, logs: NIG repo)
```

With "Log in with Nourax" the account id is the Supabase account UUID, the same `user` NoMail and the
editors send, so one person has one budget.

## Why this route

The editors' relay (Worker `nourax-office-ai` on `office.nourax.org/nourax-ai/*`, docs/office-ai.md)
can't be used from the server: WAF rule 1 lets only the owner's IP reach `office.nourax.org`, and the
server is not that IP. Options we compared on 2026-10-25:

| Option | Result |
|---|---|
| (a) The file server straight to `nig.nourax.org` with the NIG key in integration_openai | integration_openai 5.0.0 sends `user` only to api.openai.com (`OpenAiAPIService.php`: `if ($userId !== null && $this->isUsingOpenAi())`), and NIG answers 400 `user_required` without it. With the patch it would work, but NIG's 401/429/5xx would show as "Nourax AI API error: … Contact your system administrator", and the NIG key would sit in the file server's database |
| (b1) A second Worker on a new route | Needs the owner's yes (a route, or a change to WAF rule 1), still needs the patch, adds a hop |
| (c) Our own AI provider app for the file server | The cleanest in the long run (no patch), but a much bigger build. Kept as the upgrade path |
| **(b2) A small relay on the server, plus a one-line patch** | **Chosen.** The NIG key stays in one container, people get plain messages, the models and fields are fixed, nothing outside the server changes |

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Assistant 4.0.0 (`assistant`) | app store | The Assistant window, chat, and the AI actions in NoDrive and the text editor |
| OpenAI and LocalAI integration 5.0.0 (`integration_openai`) | app store | The AI provider behind the Assistant, pointed at the relay; text tasks only |
| The patch | `scripts/configure.d/50-assistant.sh` | One line, so `user` is sent on every request (below) |
| Relay | `ai-relay/relay.py`, compose service `ai-relay` | Python 3.13 standard library, image `python:3.13.16-alpine3.24`, as `nobody`, read-only, no capabilities, 64 MB limit |
| Worker | `ai-relay/ai-worker.sh`, compose service `ai-worker` | Runs the tasks at once. Without it a task waits for the cron container, up to 5 minutes |
| Settings | `scripts/configure.d/50-assistant.sh` | Everything below; run by `scripts/configure.sh` |
| Tests | `ai-relay/test/` | 16 tests of the relay against a stand-in for NIG (`mock_nig.py`) |

## What 50-assistant.sh sets

| Setting | Value | Why |
|---|---|---|
| integration_openai `url` | `http://ai-relay:8080/v1` | The relay, not an AI company |
| `api_key` | the `ai_relay_token` secret (stored encrypted, put in through stdin) | The file server's password for the relay. It is not the NIG key |
| `service_name` | `Nourax AI` | The provider name the Assistant shows |
| `default_completion_model_id` | `nourax-smart` (`NOURAX_AI_MODEL` in `.env`) | One model for every text task |
| `max_tokens`, `request_timeout` | 8192, 120 s | Room for long answers; the relay gives up on NIG after 110 s |
| `llm_provider_enabled`, `translation_provider_enabled` | on | Chat, summary, headline, topics, reformulate, proofread, change tone, translate and the other text tools |
| pictures, speech, files to the AI (`t2i_`, `stt_`, `tts_provider_enabled`, `multimodal_*_enabled`) | off | NIG offers chat only |
| task types `core:text2speech`, `core:audio2audio:chat`, `core:audio2audio:translate`, `core:contextagent:audio-interaction`, `assistant:text2sticker`, `core:text2text:chatwithtools`, `core:text2text:multimodal-chatwithtools` | switched off (`occ taskprocessing:task-type:set-enabled TYPE 0`) | The apps offer them anyway. With "multimodal chat with tools" on, the Assistant's chat would send its messages in that form; off, it sends plain text |
| Assistant `text_to_image_picker_enabled`, `text_to_sticker_picker_enabled`, `speech_to_text_picker_enabled` | 0 | Nothing would answer them |
| Assistant `chat_user_instructions`, `chat_user_instructions_title` | the upstream text with "Nourax AI" | Upstream tells the model it is "Nextcloud Assistant" |
| Theme CSS block `NouraxAssistant50` | hides the personal settings section "Assistant" (`/settings/user/ai`) | It holds the Assistant's own options and a field for one's own AI key |

The apps' names on screen come from the branding sweep (Task 3's rules turn the upstream "… Assistant"
into "Nourax AI"). The line `assistant=Nourax AI` in `config/nextcloud/app-labels.d/50-apps.conf` is
for an app-menu entry; Assistant 4.0.0 has none (it opens from the top bar).

## The patch

File `custom_apps/integration_openai/lib/Service/OpenAiAPIService.php` of release 5.0.0:

```
-		if ($userId !== null && $this->isUsingOpenAi()) {
+		if ($userId !== null) {
```

- It is applied only when the file has the release checksum
  `ce14a031f931cba63a3898d2c01d2718ef265c8b7f41951ed17810ae8ca34140`; afterwards it is
  `46586b91a42844b8bfc23961da3ce252825abf6bc10c884bb7ee723051bf4072`.
- Any other file (a new release) is left alone with a WARNING. The relay then gets no `user` and
  answers "Nourax AI is not available yet.", and logs why. Nobody is charged wrongly.
- `occ app:update integration_openai` puts the original file back. Run `sudo scripts/configure.sh`
  afterwards; for a new release, check the line, then put its checksums in `50-assistant.sh`.
- The admin overview's code check (`occ integrity:check-app integration_openai`) lists this one file
  as changed. That is expected.
- Licence: AGPL-3.0; the change is published here (NOTICE.md).

## Messages people can see

The relay answers each of these as a normal reply (HTTP 200, header `X-Nourax-Notice`), so the
Assistant shows the sentence, and the file server never retries a 429 by waiting.

| Situation | Message | `X-Nourax-Notice` |
|---|---|---|
| NIG's key not set yet (`nig_assistant_key` says `unset`), or NIG refuses it (401) | Nourax AI is not available yet. | `not_configured` |
| No `user` in the request (patch missing) | Nourax AI is not available yet. | `not_configured` |
| Account id not in NIG's format (letters, digits, `. _ : -`, first a letter or digit, 128 at most) | Nourax AI is not available for this account. | `bad_user` |
| A model other than the three `nourax-*` ones, or NIG answers 403 | That AI model is not available. Please choose another one. | `model_not_allowed` |
| NIG 429 `budget_exceeded` | You have reached your Nourax AI limit for now. Please try again later. | `budget_exceeded` |
| NIG 4xx `upstream_rejected` | Nourax AI could not process this request: (NIG's message) | `upstream_rejected` |
| Any other NIG 4xx, or a request the relay can't read | Nourax AI could not read this request. | `bad_request` |
| Request over 8 MB | This request is too large for Nourax AI. Try a shorter text. | `too_large` |
| NIG 5xx, timeout (110 s) or no connection | Nourax AI is busy. Please try again in a moment. | `busy` |

Only when the relay itself is down does the Assistant show its own error ("Nourax AI API error: AI
backend is currently not reachable…").

## Secrets (never in git, never shown)

| Secret file in `/etc/nourax/secrets` | Made by | Used by |
|---|---|---|
| `ai_relay_token` | `50-assistant.sh` (`secrets.sh gen`), 48 characters | The relay (to let the file server in) and integration_openai's `api_key` |
| `nig_assistant_key` | `50-assistant.sh` writes `unset`; the real key comes from NIG's side | The relay only. It never reaches the file server |

A running container keeps the old copy of a secret file that was replaced, so `50-assistant.sh`
makes the relay again when `relay.py` or one of its secrets is newer than the container.

## When NIG's key arrives

NIG's side is in `handoffs/2026-10-25-workspace-assistant-to-nig.md`: a service `assistant` and one
key, set in NIG (`SERVICE_KEY_ASSISTANT`) and piped into the server in the same shell:

```
printf %s "$key" | ssh -i ~/.ssh/nourax_workspace_ed25519 -o BatchMode=yes -o IdentitiesOnly=yes nourax@57.129.185.78 \
  'cd /opt/nourax/basic-office-infra && sudo flock -w 1800 /run/nourax-deploy.lock bash -c "scripts/secrets.sh put nig_assistant_key && docker compose up -d --no-deps --force-recreate ai-relay"'
```

Then check: `docker compose exec -T app curl -s http://ai-relay:8080/healthz` says `"nig_key":"set"`, a
QA account's Assistant chat answers, and the relay log has a line with `"status":200`.

**Streaming.** The relay asks NIG for whole answers (`AI_RELAY_STREAM=off`), so every call carries its
token count and is charged. NIG adds `include_usage` to streamed calls only for its custom providers;
until NIG confirms streamed Workers AI calls are charged too, streaming stays off. The Assistant then
shows each answer when it is complete. To switch on: `AI_RELAY_STREAM=on` in `.env`, then
`docker compose up -d --no-deps ai-relay`.

**Thinking.** `nourax-smart` thinks before it answers. When a whole answer starts with
`<think>…</think>`, the relay moves that part to `reasoning_content`, which the Assistant shows apart
from the reply.

## Logs

`docker compose logs ai-relay`: one line per request, never the prompt or the reply:

```
{"t":"2026-10-25T13:07:41Z","user":"qa-t5-1","model":"nourax-smart","stream":false,"notice":"not_configured","ms":2,"reason":"no NIG key yet (secret nig_assistant_key)"}
```

With NIG: `"status":200` and the time in `ms`; on errors also `nig_code`.

## Memory (2026-10-25, 3.7 GB server)

| | Before | After |
|---|---|---|
| `ai-relay` | – | 15 MB of 64 MB |
| `ai-worker` | – | 61 MB of 320 MB (one PHP process; it asks the database every 2 seconds, 0.3 % CPU) |
| `free -m` available | 1755 MB | 1736 MB |

For an 8 GB server the same limits are enough: `AI_RELAY_MEM_LIMIT=64m`, `AI_WORKER_MEM_LIMIT=320m`.
For more AI tasks at the same time, run a second worker (`docker compose up -d --scale ai-worker=2`);
each one handles one task at a time.

## Tested on 2026-10-25

| Test | Result |
|---|---|
| `python -I ai-relay/test/test_relay.py` on this PC (Python 3.12) and in `python:3.13.16-alpine3.24` on the server | 16 tests OK: token, user, models, field filter, key, every NIG error, NIG down or slow, streaming both ways, thinking, bad and big bodies |
| Patch on the server | file sha256 `46586b91…4072`; `php -l` clean; `occ integrity:check-app integration_openai` lists only `lib/Service/OpenAiAPIService.php` |
| `qa-t5-1`: `POST /ocs/v2.php/taskprocessing/schedule` type `core:text2text:chat`, with and without `preferStreaming` | `STATUS_SUCCESSFUL` after 1–2 s, output "Nourax AI is not available yet."; relay log `"user":"qa-t5-1","model":"nourax-smart","notice":"not_configured"` |
| `qa-t5-1`: Assistant chat (`/ocs/v2.php/apps/assistant/chat/new_session`, `new_message`, `generate`, `check_generation`) | reply "Nourax AI is not available yet." after 3 s |
| `qa-t5-1`: `GET /ocs/v2.php/taskprocessing/tasktypes` | 13 text task types; no speech, picture, sticker or tool types |
| Relay to the real NIG, from the `ai-relay` container (`http.client`, certificate check on) | `GET /health` 200 `{"status":"ok"}`; `POST /v1/chat/completions` without a key: 401 `unauthorized`. Cloudflare refuses Python's default user agent (error 1010); the relay sends `nourax-ai-relay` |
| A test relay and the NIG stand-in on the compose network, called from the `app` container | NIG got `Authorization: Bearer <its key>`, `X-Nourax-Feature: assistant`, body keys `messages, model, temperature, user` only (`n`, `logit_bias`, `stream` dropped); 429 became the limit message; `<think>` moved to `reasoning_content`. Both test containers were removed |
| `scripts/check-branding.sh … --server --only l10n,pages` | l10n: 8713 checked, 0 FAIL (the two new apps included). pages: one FAIL outside this feature, NoBoard's welcome board title of the QA account |
| `GET /apps/assistant/` as `qa-t5-1` | 200, title "Nourax Workspace" |

## Undo

- Switch off: `occ app:disable assistant` and `occ app:disable integration_openai`, then
  `docker compose stop ai-relay ai-worker`. Nothing is deleted; the chats stay in the database.
- Back on: `sudo scripts/configure.sh`.
- The task types: `occ taskprocessing:task-type:set-enabled TYPE 1`.

## Later

- Our own AI provider app (option c above) would drop the patch and could send the person's
  organisation too (`X-Nourax-Org`, for per-organisation budgets).
- Pictures and speech, once NIG offers them: switch on the matching settings and task types, and add
  the endpoints to the relay.
