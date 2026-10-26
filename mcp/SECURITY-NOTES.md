# Security notes (core lane, 2026-10-25)

Supply-chain checks from DESIGN 3.2, done before the first deploy. Re-run them when a pin changes.

## `@cloudflare/workers-oauth-provider` 1.2.3 to 1.2.4: diff review

Command: `npm diff --diff=@cloudflare/workers-oauth-provider@1.2.3 --diff=@cloudflare/workers-oauth-provider@1.2.4`
(193 lines: `dist/oauth-provider.js`, `package.json`, `docs/migration-1.x.md`, `skills/migrate-to-1.x/SKILL.md`).

**Verdict: safe; keep 1.2.4.** The only code change is in how a refresh request's `resource`
parameter is checked:
- The token endpoint no longer runs `validateTokenRequestResourceIndicator` for `refresh_token`
  grants. The same check now happens inside `resolveTokenResource` instead: a provided `resource`
  that names no configured resource, names several, or differs from the grant's still fails with
  `invalid_target` (`findRequestedResource` refuses arrays with more than one value).
- A grant bound to a resource this server no longer serves now fails with `invalid_grant` (was
  `invalid_target` when the refresh named a resource). Conformant clients then sign in again
  instead of retrying forever.
- No audience can be widened: `audience` is still the grant's stored, configured resource.
- Everything else is the version string, a dev-dependency bump (`@modelcontextprotocol/conformance`)
  and documentation.

Fallback if a problem turns up later: pin 1.2.3 (2026-10-07); every API used here exists there.

## `npm audit`

- `npm audit --omit=dev`: **0 vulnerabilities** in what ships in the Worker.
- Dev-only findings (never bundled; they run on this PC for builds and tests):
  - `undici` 7.29.1 (high, via `miniflare` and `wrangler`): EventSource parser memory use, SRI
    token case, unhandled error on many content-encodings. Only local dev and tests use it.
  - `zod` 4.6.5 nested in `@cloudflare/vitest-plugin` (high, `<4.6.6`): test runner only. The
    Worker uses `zod` 4.6.7.
  - The fix npm offers is a breaking downgrade (`--force`); left as is. Same versions as office-ai.

## Install scripts

`npm ci --ignore-scripts` is the only install command. Packages that declare install scripts are
all dev-only: `esbuild` and `workerd` (binary checks; their platform binaries come from optional
packages) and `fsevents` (macOS only). Nothing in the production dependency tree needs a script.

## Bundle

`node scripts/predeploy.mjs --bundle-only` (part of `npm test`) builds the production bundle the way
a deploy does and refuses dev-only code in it.
- With core only (one tool built): **978.6 KiB, 249.5 KiB gzipped** (`minify: true`); after fix
  round 1, **987.4 KiB, 252.3 KiB gzipped**; after fix round 2, **992.4 KiB, 254.1 KiB gzipped**.
- Every build is stamped with the git commit (`--define __NX_BUILD__`), which `/healthz` shows as
  `version`; predeploy checks the stamp is in the bundle.
- No `nodejs_compat` flag is needed: the bundle has no `node:` imports.
- Lane C adds `unpdf` (about 2.4 MB, imported only on first use). The Workers Paid limit is 10 MB
  gzipped; the predeploy output shows the size on every run.
- `global_fetch_strictly_public` stays off on purpose (DESIGN 0.5); the predeploy guard refuses it.

## Facts checked in workerd (DESIGN 23, core items)

| Check | Result | Where |
|---|---|---|
| SDK 2.3.1 input-validation failure | An `isError` result with the SDK's terse "Input validation error: ..." text. We hand the SDK a pass-through schema that still publishes the real JSON Schema, and validate with zod ourselves, so people get `invalid_input` naming the field and `_meta["nourax/error"]`. | `src/mcp/register.ts`, `test/tools/workspace/whoami.test.ts` |
| Where `CacheHint` is set | `ServerOptions.cacheHints["tools/list"] = { ttlMs: 60000, cacheScope: "private" }` (2026 era only) | `src/mcp/factory.ts` |
| `fromJsonSchema` on workerd | Works with the bundled `@cfworker/json-schema` validator, no `eval` | `test/mcp/sdk-facts.test.ts` |
| `define` per environment, `migrations` in `env.dev` | `define` is per environment (false at the top, true in `env.dev`); `migrations` is inherited by `env.dev` (wrangler's own config reader) | `wrangler.jsonc` |
| Root PRM path | Not answered by the library (404); the router serves the same JSON at `/.well-known/oauth-protected-resource` | `src/http/router.ts`, `test/mcp/discovery-transport.test.ts` |
| AES-KW and HKDF in workerd | Both work; wrong keys fail | `test/vault/vault.test.ts` |
| Rate-limit namespace ids 7101 to 7106 | Not used by any other Worker config in this account's code (office-ai, nodrive-upload, NIG have none); 7105 (`RL_IP`) was accepted by the deploy of fix round 1; 7106 (`RL_AUTHZ`, fix round 2) answered 10 then 429 under `wrangler dev` | repo search, deploy output, live check |
| A second migration (`v2`, `new_sqlite_classes: ["Quota"]`) | Inherited by `env.dev` like `v1`; `wrangler types` and the test pool pick up the `QUOTA` binding | `wrangler.jsonc`, `test/auth/quota.test.ts` |
| `completeAuthorization` with scopes beyond the request | Accepted (consent can add `workspace.remove`) | `test/auth/flow.test.ts` |
| `ctx.auth.scope` for `resolveExternalToken` | Always `[]`, with no userId or clientId; desktop keys take their scopes from the vault record | library source, `test/mcp/gate-desktop.test.ts` |
| Refresh tokens without `offline_access` | Issued anyway | `test/mcp/sdk-facts.test.ts` |
| Login Flow v2 `loginName` for Nourax accounts | Equals the uid: user_oidc creates the session with `loginName = uid` (`LoginController.php:694-695`), and every token row of a UUID account on the server has `uid = login_name` | server, read-only |
| Library CORS | The library adds `Access-Control-Allow-Origin: <any origin>` to `/mcp` answers; the router replaces it with our Origin policy | `src/http/guards.ts` |
| SSE answers | Legacy answers may stream; the handler buffers them (results are capped) so a dead credential found during the call still becomes a 401 | `src/mcp/handler.ts` |

## Fix round 1 (2026-10-25): review findings and what changed

Two reviews (security and spec) found the problems below. Each is fixed at its cause and has a test.

| Finding | Fix | Test |
|---|---|---|
| **High.** The consent POST was refused in every real browser: pages sent `Referrer-Policy: no-referrer`, under which browsers send `Origin: null` on form POSTs (Fetch spec; MDN "Effect on the Origin header"), and the check wanted our exact Origin | Pages now send `Referrer-Policy: same-origin` (still nothing to other sites), so same-origin form POSTs carry our Origin. `sameOrigin()` also uses Fetch Metadata: `Sec-Fetch-Site`, when sent, must be `same-origin`; `Origin: null` or no Origin counts only together with `Sec-Fetch-Site: same-origin` (a forbidden header that pages can't set). Lane F's POSTs use the same helper. | `test/auth/flow.test.ts` (nine browser header shapes); scripted check against `wrangler dev` (16 of 16) |
| **Medium.** JSON-RPC batches ran up to 100 tool calls while the per-person limits and daily caps counted one | Any array body on `/mcp` gets 400 with -32600 before the limits or the vault are touched. MCP removed batching in 2025-06-18. | `test/mcp/discovery-transport.test.ts` (no NoDrive call, no counter moves); live test |
| **Medium.** Remembered consent gave every app (the library's cookie keeps only scopes) | Our own HMAC cookie `__Host-nx-consent-apps` (subkey `consent-apps`, same key and lifetime as the library's) keeps the ticked apps; the page is skipped only when both are found, otherwise it is shown again | `test/auth/flow.test.ts` (only Files kept; cookie removed or tampered: page shown) |
| PKCE was optional for self-registered confidential clients | `/authorize` refuses any request without an S256 `code_challenge`, checked again on the POST. What the browser sees (corrected in fix round 2): confidential clients get a local page with no redirect; public clients get the library's RFC 6749 error redirect (`error=invalid_request`, never a code), followed only while the redirect URI is still on `ALLOWED_REDIRECTS` | `test/auth/flow.test.ts` |
| No per-IP limit before the token check on `/mcp` and `/oauth/token`; `RL_TOKEN` keyed by a client_id the caller picks; the token body was read unbounded when chunked | `RL_IP` (namespace 7105, 1,200/min per IP) before the provider on `/mcp` and `/oauth/token`; `RL_TOKEN` keyed by IP and client_id; token and registration bodies read once, 16 KB at most (chunked too), then handed on | `test/mcp/discovery-transport.test.ts` (no KV read when limited, with a positive control) |
| After 24 failed revocations the row was dropped while its app password still worked | Never dropped while it may work: retried with backoff up to once a day, `revoke_stuck` logged. A revoke-wrap that can never open (secret rotated) goes to the owner's `unrevoked` list, shown on `/connections` | `test/vault/vault.test.ts` |
| A client's RFC 7009 revocation, a purge, or an unexchanged code left the vault row (and app password) until the 14-day idle alarm | The grant id is bound at completion; the vault alarm checks each OAuth row's grant (`grant:<uid>:<grantId>`) after 1 hour and then daily; after a revocation that named a grant which existed just before, the router asks for the check 2 minutes later (past KV's 60-second edge cache). A KV error ends nothing. | `test/auth/flow.test.ts`, `test/vault/vault.test.ts`, `test/auth/grants.test.ts` (pins the library's layout) |
| `NX_REVOKE_SECRET` had no run-time check (an empty secret would make a public KEK) | `revokeKek` refuses a missing or short secret; `createConnection` refuses before changing anything; pending revocations wait for the secret; `/authorize` and the connect step answer 503 before NoDrive makes an app password | `test/vault/vault.test.ts`, `test/auth/flow.test.ts` |
| `env.dev` used the production KV namespace | `env.dev` has its own namespace `nourax-workspace-mcp-dev-OAUTH_KV` (`dbb1c57f6ca247ff9eec0b7e9d545201`), also the top-level `preview_id`; predeploy refuses equal ids | predeploy refused a temporary equal-id config |
| Drive-only mode: a grant link sent to someone else connects the sender's app to their account | The app password and grant-page name is now a plain "AI app (label)"; `/connect` says to grant only what you started yourself; NoDrive's page already warns. Residual risk stated in DESIGN 22: turning on "Log in with Nourax" closes it. `docs/mcp.md` (lane F) must say so. | `test/auth/flow.test.ts` |
| A NoMail base URL on the Supabase host (an Edge Function) was always refused by egress | That host can match the NoMail rows and the Supabase rows; their paths never overlap | `test/core/egress.test.ts` |
| CSP `form-action` blocked Cancel's redirect back to the app | The consent page lists the app's allowlisted redirect origin in `form-action` | `test/auth/flow.test.ts`; scripted check |
| The 403 step-up wasn't tested through the whole Worker | A test replaces lane B's module with a stand-in `sharing_create_link` and checks the 403, the scopes and `resource_metadata` in both eras | `test/mcp/step-up.test.ts` |
| The preflight lacked the 2026-07-28 headers | `Mcp-Method` and `Mcp-Name` allowed | `test/mcp/discovery-transport.test.ts`; live test |
| The http-to-https redirect ran before the Host check and used the request's Host | Host first (421), and the redirect is built from `PUBLIC_ORIGIN` | `test/mcp/discovery-transport.test.ts` |
| `/healthz` showed the package version, not the build | `version` is the git commit stamped by predeploy (`release` keeps 0.1.0) | `test/mcp/discovery-transport.test.ts`; predeploy |

Not done here: a click-through in a real browser. Only Task 3 may drive a browser in this run; the
header shapes browsers send are covered by the tests and the scripted check above, and the
integration step should click Continue and Cancel once on `http://localhost:8787` (or, after
owner-yes item 1, on `https://mcp.nourax.org`).

## Fix round 2 (2026-10-25): review findings and what changed

The second security and spec reviews found the eight problems below. Each is fixed at its cause
(or, for the PRM scopes, kept as a recorded decision) and has a test. All 244 tests pass, and a
scripted check against `wrangler dev` on :8787 as QA accounts qa-t1-21 and qa-t1-22 (real NoDrive)
passed every line.

| Finding | Fix | Test |
|---|---|---|
| **Medium.** Paths under `/mcp/` (`/mcp/`, `/mcp/x`, ...) reached the MCP handler without our Origin policy, CORS and `RL_IP`; the library echoed any Origin. The library's `matchApiRoute` treats a full-URL `apiRoute` as a prefix. | The router answers every path under `/mcp/` with 404 (JSON-RPC -32601, no CORS headers) before the provider runs, for every method; logged as route `/mcp/sub`. `/mcp` itself is unchanged. | `test/mcp/discovery-transport.test.ts` (POST and OPTIONS, three Origins, four paths, no NoDrive call); live check |
| **Medium.** A missing or short `NX_SECRET` made `Vault.open()` treat the failed unwrap as a rotated key: every connection was revoked and wiped on its next call | The vault checks `NX_SECRET` before any unwrap (`VaultSecretMissing`, event `setup_fault`, reason `nx_secret`): `/mcp` answers 503 with `Retry-After: 30` and nothing changes. `createConnection` checks it before replacing an older connection; the duplicate guard, mail cache and upstream refresh refuse the same way. Only a failed unwrap under a valid pepper is a rotation. | `test/vault/vault.test.ts` (missing, empty, short: rows stay active, no DELETE sent; a different valid secret still ends the connection); `test/mcp/discovery-transport.test.ts` (503 through the Worker, then the same token works) |
| Any 403 or 404 on the revoke call counted as "already gone" | `revokeAnswerGone()`: only 401, or 403 with an OCS JSON body whose `ocs.meta.statuscode` is 403 or 997, counts (fix round 4: a 401 no longer counts, because a disabled account answers 401 for every app password and re-enabling it brings them back; see DESIGN 9.3). NC 35.0.2's `AppPasswordController::deleteAppPassword` (read on the server) throws 403 only for "no app password in use" and "could not remove apptoken". A plain 404 (the tunnel's `http_status:404` catch-all), a Cloudflare block page or odd JSON keeps the row queued. | `test/vault/vault.test.ts` (ten answer shapes; a plain-text 404 keeps the row, then NoDrive's OCS 403 lets it go) |
| The admin refusal failed open if `cloud/user` had no `groups` | `parseCloudUser` gives `groups: null` unless it is a list of strings; `checkIdentity` then refuses (502, event `groups_unreadable`) and the new app password is revoked | `test/auth/flow.test.ts` (five bad shapes through the whole connect step; parser cases) |
| The `POST /authorize` body was unbounded when chunked (`request.formData()`) | `readSmallForm()` (`src/http/guards.ts`): `application/x-www-form-urlencoded` only (else 415), at most 16 KB declared or streamed (else 413), parsed with `URLSearchParams`. The consent helpers read only cookies, so nothing else changed. Lane F's `/connections` forms must use it too (DESIGN 18.3). | `test/auth/flow.test.ts` (17 KB declared, 64 KB chunked, three other types, a small chunked form); live check (256 KB chunked: 413) |
| Denial of wallet: unauthenticated KV writes (DCR registrations, and `beginConsent` on every `GET /authorize`) at 60/min per IP could pass Paid's included million writes a month | `RL_AUTHZ` (namespace 7106): 10/min per IP on `/authorize`, GET and POST. A new `Quota` Durable Object (migration `v2`) keeps exact daily caps, as Cloudflare's docs advise for strict limits: sign-ins 100 per IP and 3,000 in all, registrations 200 per IP and 1,000 in all, counted for valid requests before anything is written; 429 with `Retry-After` at a cap, 503 if the object is down (fail closed). Caller keys are HMACs of the IP (IPv6 by /64), never IPs. `RL_PAGES`, `RL_AUTHZ` and `RL_REGISTER` count IPv6 by /64 too. Residual risk in DESIGN 22; an optional free WAF rate-limiting rule is owner-yes item 8. | `test/auth/quota.test.ts` (caps, buckets, no IP stored, isolate memo, 429 and 503 with no KV write); `test/mcp/discovery-transport.test.ts` (keys, 429 before any KV read); live check (10 answered, then 429) |
| Protected-resource metadata lists only `workspace.read` in `scopes_supported` | Kept, as a recorded decision: the current MCP spec (2026-07-28, Scope Selection Strategy) says PRM `scopes_supported` "is intended to represent the minimal set of scopes necessary for basic functionality", with more by step-up, and that servers SHOULD NOT list `offline_access` there. The library builds it from `requiredScopes` for that reason. The AS metadata lists all seven. DESIGN 6.1 now says so. | `test/mcp/discovery-transport.test.ts` (both PRM paths); live check |
| Public clients without PKCE got the library's error redirect, not the local page the notes described; that redirect was followed before our allowlist recheck | The notes now describe both cases. The redirect (RFC 6749 4.1.2.1, no code) is followed only while the redirect URI is still on `ALLOWED_REDIRECTS`; otherwise a local page. | `test/auth/flow.test.ts` (redirect while allowlisted; local page after the allowlist shrank); live check |

## Third system review (2026-10-26): security findings and what changed

Details and the source each fix was checked against are in DESIGN section 30.

| Finding | Fix | Test |
|---|---|---|
| Registrations used a unit of the daily cap before the body was parsed or checked, and five networks could use up the day's 1,000, leaving the AI vendors' servers 2 a day each | The unit is taken inside the library's registration callback, after its checks and ours and right before its one KV write (`src/auth/dcr-cap.ts`); caps 30 per network, 3,000 in all, reserve 5 (100 networks to use up a day) | `test/auth/quota.test.ts` (refused and malformed bodies count nothing, a forged admission header is replaced, five networks leave a sixth its full cap, 429 and 503 with `Retry-After` and no KV write) |
| The WAF pass cookie was one fixed value for every connect, so owner-yes item 2 didn't stop grant-link phishing as claimed | `__Secure-nx-wafflow` with `Path=/login/v2/flow/<login token>` binds the pass to one flow; `__Secure-nx-wafpass` is `Path=/login/v2`, never `/`; item 2's expression, its risks (a cookie planted by any nourax.org host) and `docs/mcp.md` 7.3 rewritten | `test/pages/connections.test.ts` (paths, attributes, two flows share no path, cancel clears the flow's own cookies) |
| The consent page's Cancel redirected without re-checking `ALLOWED_REDIRECTS` | Checked; when the list shrank, the local "Sign-in cancelled" page with no `Location` | `test/auth/flow.test.ts` |
| Any 400 or 401 from Supabase's token endpoint ended mail for good, setup faults and outages included | Supabase's error code is read (as in supabase/auth v2.197.0): only a dead session ends mail; a wrong client id or secret is a logged setup fault; the rest is transient; both keep the sealed refresh token | `test/vault/upstream-refresh.test.ts` |
