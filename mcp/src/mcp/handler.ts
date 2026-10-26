/**
 * The /mcp API handler (DESIGN 2.2 step 3), called by the OAuth provider after the bearer token
 * (or a desktop key) checked out, with ctx.props (decrypted) and ctx.auth.
 *
 *  1. POST only (GET and DELETE: 405).   2. Content-Type application/json (415).
 *  3. The Accept shim (ONLYOFFICE).      4. Body read once, at most 4 MiB (413), parsed once;
 *                                           a JSON-RPC batch array gets 400 -32600.
 *  5. RL_MCP per person (429).           6. Vault.open() in one round trip: credential, upstream,
 *                                           scopes, apps and the per-person limits.
 *  7. The gate: 403 insufficient_scope (step-up) or a not_available stub.
 *  8. The SDK's createMcpHandler with the request context in authInfo.extra.nx.
 *  9. A dead NoDrive credential (8.5): the vault row stops being usable and its app password's
 *     revocation is queued (fix round 4: a 401 may come from a disabled account, whose passwords
 *     come back when it is re-enabled), the grant is revoked, and 401 tells the client to reconnect.
 *     The client's own flag (nc.isDead()) counts too, so a dead credential found by a call whose
 *     error was swallowed (the time-zone lookup, a best-effort read) still ends the connection.
 * Origin checks and CORS run in the router, before the provider.
 *
 * The NoDrive client gets this request's abort signal; the tool wrapper fires it when the 60 s
 * budget is over, so a timed-out tool stops sending (fix round 3).
 *
 * The person's time zone is no longer looked up here before every call (fix round 4): runTool
 * looks it up, inside the tool's budget, only for the tools that read times (src/mcp/zone.ts).
 */
import { insufficientScope, type OAuthHelpers, type OAuthResourceAuth } from "@cloudflare/workers-oauth-provider";
import { config, type NxConfig, type NxEnv } from "../env";
import { fromB64url, sha256Hex } from "../core/bytes";
import { ToolError } from "../core/errors";
import { LIMITS } from "../core/limits";
import { cliOf, log, pseudonym } from "../core/log";
import { allowRate } from "../core/ratelimit";
import { acceptShim, BodyTooLarge, isJsonContentType, jsonRpcError, readBody } from "../http/guards";
import { noteReq, ridOf } from "../http/rid";
import { createNc } from "../nc/index";
import type { NcStats } from "../nc/client";
import { revokeDesktopKeyByHash } from "../auth/conn-tokens";
import { vaultFor } from "../vault/vault";
import { catalogEntry, type Scope } from "./catalog";
import type { GrantProps, RequestCtx } from "./context";
import { mcpHttp } from "./factory";
import { effectiveScopes, gateCall } from "./gate";
import { limitMessage } from "./register";
import { mailContext } from "./mail-ctx";

type ApiCtx = ExecutionContext & { props: GrantProps; auth: OAuthResourceAuth };

function invalidToken(cfg: NxConfig, description: string): Response {
	return new Response(JSON.stringify({ error: "invalid_token", error_description: description }), {
		status: 401,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
			"www-authenticate": `Bearer realm="OAuth", error="invalid_token", error_description="${description}", resource_metadata="${cfg.publicOrigin}/.well-known/oauth-protected-resource/mcp"`,
		},
	});
}

/** The JSON-RPC method and, for tools/call, the tool name of a single message. */
export function peekMessage(body: unknown): { method: string; tool?: string; batch: boolean } {
	if (Array.isArray(body)) {
		const first = body.find((m) => m && typeof m === "object" && (m as { method?: unknown }).method === "tools/call") ?? body[0];
		const p = peekMessage(first ?? {});
		return { ...p, batch: true };
	}
	if (!body || typeof body !== "object") return { method: "", batch: false };
	const m = body as { method?: unknown; params?: { name?: unknown } };
	const method = typeof m.method === "string" ? m.method : "";
	const tool = method === "tools/call" && typeof m.params?.name === "string" ? m.params.name : undefined;
	return { method, tool, batch: false };
}

/** The zone lookup moved to src/mcp/zone.ts (fix round 4); re-exported for its old importers. */
export { resolveZone } from "./zone";

export const mcpApiHandler = {
	async fetch(request: Request, env: NxEnv, ctx: ApiCtx): Promise<Response> {
		const cfg = config(env);
		const rid = ridOf(request);
		if (request.method !== "POST") {
			return jsonRpcError(405, -32000, "Method not allowed.", { allow: "POST, OPTIONS" });
		}
		if (!isJsonContentType(request)) return jsonRpcError(415, -32000, "Content-Type must be application/json.");
		let text: string;
		try {
			text = await readBody(request, LIMITS.mcpBodyBytes);
		} catch (e) {
			if (e instanceof BodyTooLarge) return jsonRpcError(413, -32000, "The request is too large (4 MiB at most).");
			return jsonRpcError(400, -32700, "The request body couldn't be read.");
		}
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return jsonRpcError(400, -32700, "Parse error.");
		}
		// One JSON-RPC message per POST. MCP removed batching in 2025-06-18; the SDK's legacy lane would
		// still run up to 100 calls from one array while the limits below count only one (DESIGN 14).
		if (Array.isArray(body)) {
			log({ t: "auth", rid, ev: "batch_refused" });
			return jsonRpcError(400, -32600, "Batch requests aren't supported. Send one JSON-RPC message per request.");
		}

		const props = ctx.props;
		if (!props || props.v !== 1 || typeof props.uid !== "string" || typeof props.connectionId !== "string" || typeof props.vaultKey !== "string") {
			return invalidToken(cfg, "This connection is no longer valid");
		}
		const canStepUp = props.kind !== "desktop";
		if (canStepUp && ctx.auth.userId !== undefined && ctx.auth.userId !== props.uid) return invalidToken(cfg, "This connection is no longer valid");

		if (!(await allowRate(env.RL_MCP, `mcp:${await sha256Hex(props.uid)}`))) {
			log({ t: "auth", rid, ev: "rate_limited", reason: "rl_mcp" });
			return jsonRpcError(429, -32000, "Too many requests. Try again in a minute.", { "retry-after": "30" });
		}

		const peek = peekMessage(body);
		const entry = peek.tool ? catalogEntry(peek.tool) : undefined;
		const bucket = peek.tool?.startsWith("mail_") ? "mail" : (entry?.bucket ?? "read");
		const weight = peek.method === "tools/call" ? 1 : 0;
		const vault = vaultFor(env, props.uid);
		let useKey: Uint8Array;
		try {
			useKey = fromB64url(props.vaultKey);
		} catch {
			return invalidToken(cfg, "This connection is no longer valid");
		}
		let open: Awaited<ReturnType<typeof vault.open>>;
		try {
			open = await vault.open(props.connectionId, useKey, { bucket, weight });
		} catch (e) {
			log({ t: "auth", rid, ev: "vault_unavailable", reason: e instanceof Error ? e.name : "unknown" });
			return jsonRpcError(503, -32000, "Nourax Workspace is busy. Try again in a minute.", { "retry-after": "30" });
		}
		if (!open.ok) {
			if (open.reason === "rate_limited" || open.reason === "daily_limit") {
				return jsonRpcError(429, -32000, limitMessage(open.reason), { "retry-after": String(open.retryAfterSec ?? 60) });
			}
			log({ t: "auth", rid, ev: open.reason === "needs_reconnect" ? "needs_reconnect" : "revoked", reason: open.reason });
			await endAccess(env, ctx, props);
			return invalidToken(cfg, "This connection has ended. Connect again");
		}
		if (open.uid !== props.uid) return invalidToken(cfg, "This connection is no longer valid");

		const scopes: Scope[] = effectiveScopes(ctx.auth.scope, open.scopes, canStepUp);
		const stats: NcStats = { calls: 0 };
		const clientIp = request.headers.get("cf-connecting-ip") ?? undefined;
		const leaseName = "convert";
		// Fired by the tool wrapper when the 60 s budget is over: no NoDrive call starts after that.
		const ncAbort = new AbortController();
		const nc = createNc({
			env,
			cfg,
			uid: open.uid,
			cred: open.cred,
			rid,
			clientIp,
			signal: ncAbort.signal,
			stats,
			convertSlot: async () => {
				// The lease lasts as long as one conversion may (plus a little), so a conversion cut off by
				// the tool budget, whose release may never run, doesn't block the next one for long.
				const l = await vault.lease(leaseName, Math.ceil(LIMITS.convertTimeoutMs / 1000) + 5, LIMITS.convertPerHour);
				if (!l.ok) {
					throw new ToolError("rate_limited", l.reason === "busy" ? "Another conversion is running for this person. Try again in a moment." : "This person reached 20 conversions this hour.", {
						retryAfterSec: l.retryAfterSec,
					});
				}
				return { release: () => vault.releaseLease(leaseName, l.token) };
			},
		});
		const rc: RequestCtx = {
			rid,
			env,
			cfg,
			startedAt: Date.now(),
			cli: cliOf(request.headers.get("user-agent"), open.clientLabel),
			clientIp,
			auth: ctx.auth,
			props,
			uid: open.uid,
			connectionId: props.connectionId,
			canStepUp,
			scopes,
			apps: open.apps,
			open,
			vault,
			useKey,
			nc,
			ncAbort,
			stats,
			zone: cfg.defaultTimeZone,
			zoneKnown: true,
			mail: mailContext({ env, cfg, rid, open, scopes, apps: open.apps, vault, connectionId: props.connectionId, useKey }),
			method: peek.method,
			toolName: peek.tool,
			deadCredential: false,
			inBytes: text.length,
		};

		noteReq(rid, { cli: rc.cli });

		const decision = gateCall(rc, peek.tool);
		if (decision.kind === "step_up") {
			return insufficientScope(ctx.auth, [...new Set([...scopes, decision.needed])], "This connection needs more permission for that tool");
		}
		if (decision.kind === "not_available") rc.gated = { name: decision.name, error: decision.error };
		if (open.limited && peek.method === "tools/call") {
			rc.blocked = new ToolError(open.limited.reason, limitMessage(open.limited.reason, open.limited.limit), { retryAfterSec: open.limited.retryAfterSec });
		}
		const headers = acceptShim(request.headers);
		headers.delete("content-length");
		const sdkRequest = new Request(request.url, { method: "POST", headers });
		const response = await mcpHttp.fetch(sdkRequest, {
			parsedBody: body,
			authInfo: {
				token: ctx.auth.token,
				clientId: ctx.auth.clientId ?? `desktop:${props.connectionId}`,
				scopes,
				expiresAt: ctx.auth.expiresAt,
				resource: new URL(cfg.resource),
				resourceMetadataUrl: `${cfg.publicOrigin}/.well-known/oauth-protected-resource/mcp`,
				extra: { nx: rc },
			},
		});

		// Legacy answers may be SSE streams that finish after this point; results are capped at
		// 60,000 characters and we send no progress notifications, so buffer the whole answer first.
		// Only then is it known whether the NoDrive credential died during the call (8.5).
		const buffered = await response.arrayBuffer();
		if (rc.deadCredential || nc.isDead()) return deadCredential(env, ctx, props, rid, open.uid, cfg);
		const out = new Response(buffered, { status: response.status, headers: response.headers });
		out.headers.delete("content-length");
		return out;
	},
};

/** The NoDrive credential is dead (8.5): mark the record, end the token side, answer 401. */
async function deadCredential(env: NxEnv, ctx: ApiCtx, props: GrantProps, rid: string, uid: string, cfg: NxConfig): Promise<Response> {
	log({ t: "auth", rid, ev: "needs_reconnect", who: await pseudonym(env, uid, 12), reason: "dead_credential" });
	await vaultFor(env, props.uid)
		.markNeedsReconnect(props.connectionId, "dead_credential")
		.catch(() => undefined);
	await endAccess(env, ctx, props);
	return invalidToken(cfg, "Access to NoDrive has ended. Connect again");
}

/** Ends the token side of a connection whose vault record is gone or dead. */
async function endAccess(env: NxEnv, ctx: ApiCtx, props: GrantProps): Promise<void> {
	try {
		if (props.kind === "desktop") {
			await revokeDesktopKeyByHash(env, await sha256Hex(ctx.auth.token));
			return;
		}
		const helpers = env.OAUTH_PROVIDER as OAuthHelpers | undefined;
		const grantId = props.grantId;
		if (helpers && grantId) await helpers.revokeGrant(grantId, props.uid);
	} catch {
		// Best effort: the vault already refuses this connection.
	}
}
