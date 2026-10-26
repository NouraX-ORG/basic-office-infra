/**
 * Nourax Workspace MCP server (Worker nourax-workspace-mcp). Design: mcp/DESIGN.md.
 * fetch: the router (src/http/router.ts). scheduled (03:17 UTC): the OAuth library's purge and a
 * sweep of expired desktop-key records.
 */
import { providerFor } from "./auth/provider";
import type { NxEnv } from "./env";
import { log } from "./core/log";
import { handleRequest } from "./http/router";

export { ConnectFlow } from "./vault/connect-flow";
export { Quota } from "./vault/quota";
export { Vault } from "./vault/vault";

const PURGE_CURSOR = "cron:purge-cursor:v1";

async function nightly(env: NxEnv): Promise<void> {
	const started = Date.now();
	try {
		const cursor = (await env.OAUTH_KV.get(PURGE_CURSOR)) ?? undefined;
		const r = await providerFor(env).purgeExpiredData(env, { batchSize: 50, ...(cursor ? { cursor } : {}) });
		if (r.done) await env.OAUTH_KV.delete(PURGE_CURSOR);
		else if (r.cursor) await env.OAUTH_KV.put(PURGE_CURSOR, r.cursor, { expirationTtl: 7 * 86400 });
		log({ t: "cron", job: "purge", ok: true, n: r.grantsPurged + r.tokensPurged, ms: Date.now() - started });
	} catch {
		log({ t: "cron", job: "purge", ok: false, ms: Date.now() - started });
	}
	const sweepStarted = Date.now();
	try {
		// Desktop-key records carry a KV TTL; this removes any whose own expiry has passed earlier.
		let removed = 0;
		const list = await env.OAUTH_KV.list({ prefix: "ct:", limit: 200 });
		const now = Math.floor(Date.now() / 1000);
		for (const k of list.keys) {
			const raw = await env.OAUTH_KV.get(k.name);
			if (!raw) continue;
			try {
				const rec = JSON.parse(raw) as { expiresAt?: number };
				if (typeof rec.expiresAt === "number" && rec.expiresAt < now) {
					await env.OAUTH_KV.delete(k.name);
					removed++;
				}
			} catch {
				await env.OAUTH_KV.delete(k.name);
				removed++;
			}
		}
		log({ t: "cron", job: "desktop_keys", ok: true, n: removed, ms: Date.now() - sweepStarted });
	} catch {
		log({ t: "cron", job: "desktop_keys", ok: false, ms: Date.now() - sweepStarted });
	}
}

export default {
	fetch: (request, env, ctx) => handleRequest(request, env as unknown as NxEnv, ctx),
	scheduled: (_controller, env, ctx) => {
		ctx.waitUntil(nightly(env as unknown as NxEnv));
	},
} satisfies ExportedHandler<Env>;
