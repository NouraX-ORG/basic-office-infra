# Nourax AI in the editors

The editors' **AI** tab (chat, summarise, translate, text checks) uses Nourax AI only. People see
no keys and no AI settings. Each request counts against the signed-in person's Nourax AI budget in
NIG, the same budget NoMail uses.

```
Editor (browser), AI plugin in "server settings" mode
   │  POST https://office.nourax.org/nourax-ai/proxy
   │  Authorization: Bearer <editor-session token from ONLYOFFICE>
   ▼
Worker nourax-office-ai (office-ai/), on route office.nourax.org/nourax-ai/*
   │  1. checks the token's signature, expiry and session marker
   │  2. user = Nextcloud user id from the token (with Nourax sign-in: the account id)
   │  3. keeps only chat requests for the allowed models
   │  4. adds NIG's "office" service key (never sent to the browser)
   ▼
NIG  https://nig.nourax.org/v1/chat/completions   (budgets, prices, logs: owned by the NIG repo)
```

## Pieces

| Piece | Where | What it does |
|---|---|---|
| AI plugin 3.2.3 | `scripts/onlyoffice-plugins.sh` | Downloads the official plugin at a pinned release and checks its checksum |
| Plugin patch | `scripts/patch-ai-plugin.py` | Puts in the settings below, so the Settings button and every key field stay hidden. Also stops the AI configuration window opening and drops the Image menu |
| Settings | `config/onlyoffice/ai-plugin-settings.json` | Relay address, the "Nourax AI" provider, models and which model each action uses |
| Relay | `office-ai/` (Worker `nourax-office-ai`) | Checks the session, sets the user, forwards to NIG, turns NIG errors into plain messages |
| WAF | `cloudflare/waf-rule.md` | Rule 1 limits `office.nourax.org` (relay included) to the owner's IP for now. Rule 2 closes ONLYOFFICE's own `/ai-proxy` |

Models and actions: Chat → `nourax-smart`; Summarization, Translation and text checks →
`nourax-long-context`; `nourax-fast` can be picked in the chat. No image, OCR or vision models.

## Who is who

ONLYOFFICE Docs 10 gives each open document a session token (HS256, 30 days). It is signed with
`HMAC-SHA256(session secret, "editor-session")` written as hex, not with the secret itself
(DocService `fillJwtByConnection`, Common `utils.deriveSecret`). The relay holds only that derived
key, so it cannot sign documents, conversions or commands.

The Nextcloud connector sends signed-in users as `<instanceid>_<uid>`. The relay strips the prefix
and sends `uid` to NIG as `user`:
- With Nourax sign-in (user_oidc, `mapping-uid=sub`), `uid` is the Supabase account id. That is the
  same value NoMail sends, so one person has one budget.
- Guests on share links have no such id. They get "Sign in to Nourax Workspace to use Nourax AI."

## Secrets of the relay (never in git, never shown)

| Secret | Set by | From |
|---|---|---|
| `EDITOR_SESSION_KEY` | `office-ai/tools/set-secrets.sh` | Worked out on the server from ONLYOFFICE's secret (`scripts/office-ai-secret.sh`) and piped into `wrangler secret put` |
| `NEXTCLOUD_INSTANCE_ID` | same script | `occ config:system:get instanceid` |
| `NIG_SERVICE_KEY` | the NIG side | Generated once, piped into both this Worker and NIG's `SERVICE_KEY_OFFICE` |

Run `set-secrets.sh` again after changing the ONLYOFFICE secret. Open editors then need reopening.

## Messages people can see

| Situation | Message |
|---|---|
| Budget used up (NIG 429 `budget_exceeded`) | You have reached your Nourax AI limit for now. Please try again later. |
| Session missing, wrong or expired | Please reopen the document to use Nourax AI. |
| Guest on a share link | Sign in to Nourax Workspace to use Nourax AI. |
| Relay or NIG key not set up | Nourax AI is not available yet. |
| NIG or the model is down | Nourax AI is busy. Please try again in a moment. |

## Risks we accept

- **A stolen session token** (for example from a hacked browser) can spend that person's budget
  until the token expires (30 days) or the document is reopened. Budgets cap the damage.
- **Anyone controlling the Cloudflare account** could read traffic or change the relay. The same is
  true for every Nourax site.

## Change things

- **Models or actions:** edit `config/onlyoffice/ai-plugin-settings.json`. If you add a model, also
  add it to `ALLOWED_MODELS` in `office-ai/wrangler.jsonc` and to NIG's `office` service. Then on
  the server run `git pull && sudo scripts/onlyoffice-plugins.sh`, and from `office-ai/` run
  `npm test && npm run deploy`.
- **Newer plugin:** change `AI_RELEASE`/`AI_SHA256` in `scripts/onlyoffice-plugins.sh` and run it.
  If the patch no longer fits, the script stops and installs nothing.
- **Watch it working:** from `office-ai/`, run `npx wrangler tail nourax-office-ai`. Each request
  logs one line with the user id, model and NIG's status. Prompts are never logged.
