# nourax-workspace-mcp

The Nourax Workspace MCP server: a Cloudflare Worker that lets AI assistants (Claude, ChatGPT,
ONLYOFFICE Desktop Editors and other MCP clients) work in a person's Nourax Workspace, acting only
as that signed-in person. The design is in [DESIGN.md](DESIGN.md); how to connect and operate it
will be in [docs/mcp.md](../docs/mcp.md).

Planned address: `https://mcp.nourax.org/mcp` (the custom domain is the owner's decision; until it
exists the deployed Worker can't be reached at all).

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Entry: fetch (router) and the nightly cron |
| `src/http/` | Router, front checks (https, Host, Origin, Accept, sizes), pages shell, cookies |
| `src/auth/` | OAuth provider config, consent, DCR policy, "Log in with Nourax" (optional), Login Flow v2 connect step, desktop keys, sessions, dev-only auth |
| `src/vault/` | `Vault` (one per person, encrypted app passwords and upstream tokens, limits), `ConnectFlow` and `Quota` (one in all: exact daily caps on new sign-ins and client registrations) Durable Objects |
| `src/core/` | Tool framework, shapes, framing, errors, logs, paths, XML, cursors, time, ids, egress allowlist |
| `src/nc/` | The NoDrive client (DAV, OCS, Deck, files primitives, sharees, capabilities, conversion) |
| `src/mcp/` | The `/mcp` handler, per-request server factory, gate, instructions and the frozen tool catalogue |
| `src/tools/` | Tools, one module per lane, listed in `registry.ts` |
| `test/` | Unit, protocol and contract tests (workerd); `test/live/` runs against drive.nourax.org |

## Commands

```
npm ci --ignore-scripts
npm test              # unit, protocol and contract tests, then the production bundle check
npm run typecheck
npm run test:live     # needs NX_DEV_ENV_FILE (the dev env file in the scratchpad) and QA accounts
npm run tool-docs     # the tool table for docs/mcp.md
npm run deploy        # the deploy guard, then wrangler deploy (top-level config only, no routes)
```

Local dev: `npx wrangler dev --env dev --ip 127.0.0.1 --port 8787 --env-file <scratchpad file>`.
Dev values never enter the repo, and dev-only code is stripped from the production bundle.

## Licence

AGPL-3.0-or-later, like the rest of this repo. Third-party components are listed in `NOTICE.md`
at the repo root.
