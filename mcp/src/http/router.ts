/**
 * The outer router (DESIGN 2.2 step 1): request id, Host check, https only, rate limits for the
 * OAuth endpoints, pages and /mcp, our Origin policy and CORS on /mcp, the root protected-resource
 * metadata path, /healthz and /assets, then the OAuth provider. One log line per request.
 *
 * Unauthenticated work is limited per IP before the provider runs, because checking a bearer token
 * costs a KV read: RL_IP for /mcp and /oauth/token, RL_TOKEN per IP and client_id, RL_REGISTER per
 * IP. Every one of these counts an IPv6 caller by its /64 (fix round 3: RL_IP and RL_TOKEN used the
 * full address, so one /64 could rotate past them). /oauth/token and /oauth/register bodies are read
 * here, at most 16 KB, and handed on.
 *
 * An exception answers in the shape the caller reads: JSON-RPC on /mcp, OAuth JSON on /oauth/* and
 * /.well-known/*, and the HTML error page elsewhere. The req line carries the protocol era and the
 * client kind that the MCP handler noted (rid.ts).
 *
 * Fix round 2: every path under /mcp/ is refused before the provider (it would otherwise reach the
 * MCP handler without the Origin policy, CORS and RL_IP); /authorize has its own budget (RL_AUTHZ);
 * registrations and new sign-ins have exact daily caps (the Quota object); the page, /authorize and
 * registration limits count an IPv6 caller by its /64.
 */
import { devActive, devMisconfigured } from "../auth/dev-guard";
import { grantExists, grantOfToken } from "../auth/grants";
import { providerFor } from "../auth/provider";
import { config, type NxConfig, type NxEnv } from "../env";
import { egress } from "../core/egress";
import { log } from "../core/log";
import { allowRate } from "../core/ratelimit";
import { ADMIT_HEADER, beginAdmission, endAdmission } from "../auth/dcr-cap";
import { ipBucket } from "../vault/quota";
import { vaultFor } from "../vault/vault";
import { BUILD, VERSION } from "../version";
import { applyCors, BodyTooLarge, jsonRpcError, originPolicy, readBodyBytes } from "./guards";
import { assetResponse, errorPage, securityHeaders } from "./html";
import { ridOf, setRid, takeReqNotes } from "./rid";
import { newId } from "../core/bytes";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PRM_ROOT = "/.well-known/oauth-protected-resource";
/** Token, revocation and registration requests are small; anything bigger is refused unread. */
export const OAUTH_BODY_MAX = 16 * 1024;

function routeLabel(path: string): string {
	if (path === "/mcp") return "/mcp";
	// Refused sub-paths of the endpoint (log values may not contain "*").
	if (path.startsWith("/mcp/")) return "/mcp/sub";
	if (path.startsWith("/.well-known/")) return path.length < 60 ? path : "/.well-known/other";
	for (const p of ["/oauth/token", "/oauth/register", "/authorize", "/callback", "/connect/cancel", "/connect", "/healthz", "/assets", "/connections", "/dev"]) {
		if (path === p || path.startsWith(`${p}/`)) return p;
	}
	return path === "/" ? "/" : "other";
}

function clientIp(request: Request): string {
	return request.headers.get("cf-connecting-ip") ?? "local";
}

/** client_id from Basic auth, else from the (already read) form body. */
export function tokenClientId(request: Request, form: URLSearchParams): string {
	const auth = request.headers.get("authorization");
	if (auth?.toLowerCase().startsWith("basic ")) {
		try {
			const dec = atob(auth.slice(6).trim());
			const i = dec.indexOf(":");
			if (i > 0) return decodeURIComponent(dec.slice(0, i)).slice(0, 80);
		} catch {
			// fall through
		}
	}
	return (form.get("client_id") ?? "none").slice(0, 80);
}

function slowDown(what: string): Response {
	return Response.json({ error: "slow_down", error_description: `Too many ${what}. Try again in a minute.` }, { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } });
}

/**
 * A registration through the library, with the daily cap (DESIGN 14) taken inside its registration
 * callback (auth/dcr-cap.ts): after the library and our policy have accepted the metadata, right
 * before the one KV write. A malformed or refused registration never uses the cap (section 30.1).
 */
async function registerClient(provider: ReturnType<typeof providerFor>, request: Request, env: NxEnv, ctx: ExecutionContext, ip: string): Promise<Response> {
	const id = beginAdmission(env, ip);
	let res: Response;
	let retryAfterSec: number | null;
	try {
		const headers = new Headers(request.headers);
		headers.set(ADMIT_HEADER, id);
		const admitted = new Request(request, { headers });
		setRid(admitted, ridOf(request));
		res = await provider.fetch(admitted, env, ctx);
	} finally {
		retryAfterSec = endAdmission(id);
	}
	if (retryAfterSec === null) return res;
	const out = new Response(res.body, res);
	out.headers.set("retry-after", String(retryAfterSec));
	out.headers.set("cache-control", "no-store");
	return out;
}

/** Reads a small OAuth body once (at most 16 KB, chunked included) and rebuilds the request around it. */
async function bufferSmallBody(request: Request): Promise<{ request: Request; bytes: Uint8Array } | Response> {
	let bytes: Uint8Array;
	try {
		bytes = await readBodyBytes(request, OAUTH_BODY_MAX);
	} catch (e) {
		if (e instanceof BodyTooLarge) return Response.json({ error: "invalid_request", error_description: "The request is too large." }, { status: 413, headers: { "cache-control": "no-store" } });
		return Response.json({ error: "invalid_request", error_description: "The request body couldn't be read." }, { status: 400, headers: { "cache-control": "no-store" } });
	}
	const headers = new Headers(request.headers);
	headers.delete("content-length");
	// Internal only: never taken from the caller (auth/dcr-cap.ts sets its own).
	headers.delete(ADMIT_HEADER);
	const rebuilt = new Request(request.url, { method: request.method, headers, body: bytes });
	setRid(rebuilt, ridOf(request));
	return { request: rebuilt, bytes };
}

/**
 * After an RFC 7009 revocation: if the token named a grant that existed just before, ask that
 * person's vault to check the grant once KV's edge cache has expired, and end the connection if the
 * grant is gone. The pre-check keeps forged tokens from waking a vault for any uid.
 */
async function noteRevocation(env: NxEnv, g: { uid: string; grantId: string }, rid: string): Promise<void> {
	try {
		const found = await vaultFor(env, g.uid).grantMayHaveEnded(g.grantId);
		if (found) log({ t: "auth", rid, ev: "client_revoked" });
	} catch {
		// The vault's daily grant check ends it anyway.
	}
}

async function healthz(request: Request, env: NxEnv, cfg: NxConfig): Promise<Response> {
	const url = new URL(request.url);
	const body: Record<string, unknown> = { status: "ok", version: BUILD, release: VERSION };
	if (url.searchParams.get("deep") === "1") {
		if (!(await allowRate(env.RL_PAGES, `healthz:${clientIp(request)}`))) return Response.json({ status: "slow_down" }, { status: 429 });
		const started = Date.now();
		try {
			const res = await egress({ env }, `${cfg.driveOrigin}/status.php`, { method: "GET", headers: { accept: "application/json" }, timeoutMs: 8000 });
			await res.body?.cancel();
			body.drive = res.ok ? "ok" : "unreachable";
		} catch {
			body.drive = "unreachable";
		}
		body.drive_ms = Date.now() - started;
	}
	return Response.json(body, { headers: { "cache-control": "no-store" } });
}

export async function handleRequest(request: Request, env: NxEnv, ctx: ExecutionContext): Promise<Response> {
	const started = Date.now();
	const rid = newId();
	setRid(request, rid);
	const url = new URL(request.url);
	let res: Response;
	let originScheme: string | undefined;
	try {
		res = await route(request, env, ctx, url, (s) => {
			originScheme = s;
		});
	} catch {
		res = failureResponse(url.pathname);
	}
	const out = new Response(res.body, res);
	out.headers.set("x-request-id", rid);
	const notes = takeReqNotes(rid);
	log({
		t: "req",
		rid,
		route: routeLabel(url.pathname),
		method: request.method,
		status: out.status,
		ms: Date.now() - started,
		colo: (request as { cf?: { colo?: string } }).cf?.colo,
		era: notes?.era,
		cli: notes?.cli,
		origin_scheme: originScheme,
	});
	return out;
}

/** The answer to an exception, in the shape each kind of caller reads (fix round 3). */
export function failureResponse(path: string): Response {
	if (path === "/mcp" || path.startsWith("/mcp/")) return jsonRpcError(500, -32603, "Something went wrong. Try again in a minute.");
	if (path.startsWith("/oauth/") || path.startsWith("/.well-known/")) {
		return Response.json({ error: "server_error", error_description: "Something went wrong. Try again in a minute." }, { status: 500, headers: { "cache-control": "no-store" } });
	}
	return errorPage("Something went wrong", "Try again in a minute.", 500);
}

async function route(request: Request, env: NxEnv, ctx: ExecutionContext, url: URL, noteScheme: (s: string) => void): Promise<Response> {
	let cfg: NxConfig;
	try {
		cfg = config(env);
	} catch {
		return new Response("misconfigured", { status: 503 });
	}
	if (devMisconfigured(env)) {
		log({ t: "auth", ev: "dev_misconfigured" });
		return new Response("misconfigured", { status: 503 });
	}
	const isLoopback = LOOPBACK.has(url.hostname);
	const devLoopback = cfg.env === "dev" && isLoopback;

	// The Host comes first, so nothing (not even the https redirect) is answered for another host.
	if (url.host !== cfg.publicHost) return new Response("Misdirected request", { status: 421, headers: { "content-type": "text/plain" } });

	// Plain http reaches the Worker (Always Use HTTPS is off for the zone): never serve it.
	if (url.protocol === "http:" && !devLoopback) {
		if (request.method === "GET" && !url.pathname.startsWith("/mcp") && !url.pathname.startsWith("/oauth/")) {
			// Built from PUBLIC_ORIGIN, never from the request's own Host.
			return new Response(null, { status: 308, headers: { location: `${cfg.publicOrigin}${url.pathname}${url.search}` } });
		}
		return new Response("Use https://", { status: 400, headers: { "content-type": "text/plain" } });
	}

	const path = url.pathname;
	// One MCP endpoint. The library treats every path under /mcp/ as its API route too, and would
	// answer it without our Origin policy, CORS and RL_IP, so those paths end here (fix round 2).
	if (path.startsWith("/mcp/")) return jsonRpcError(404, -32601, "Not found. The MCP endpoint is /mcp.");
	const asset = (request.method === "GET" || request.method === "HEAD") && assetResponse(path);
	if (asset) return asset;
	if (path === "/healthz" && request.method === "GET") return healthz(request, env, cfg);

	const provider = providerFor(env);
	const ip = clientIp(request);
	// Every per-IP limit counts an IPv6 caller by its /64 (an IPv4 address as itself).
	const site = ipBucket(ip);

	if (path === PRM_ROOT) {
		// The library answers only /.well-known/oauth-protected-resource/mcp; serve the same JSON here.
		const alias = new URL(url);
		alias.pathname = `${PRM_ROOT}/mcp`;
		return provider.fetch(new Request(alias.toString(), request), env, ctx);
	}

	if (path === "/oauth/register" && request.method === "POST") {
		if (!(await allowRate(env.RL_REGISTER, `reg:${site}`))) {
			log({ t: "auth", ev: "rate_limited", reason: "register" });
			return slowDown("registrations");
		}
		const buffered = await bufferSmallBody(request);
		if (buffered instanceof Response) return withApiHeaders(buffered, devLoopback);
		// Each registration is a KV write: an exact daily cap (Quota object) bounds them, counted only
		// for registrations that are stored (section 30.1).
		return withApiHeaders(await registerClient(provider, buffered.request, env, ctx, ip), devLoopback);
	}
	if (path === "/oauth/token" && request.method === "POST") {
		// Per IP first, so rotating client_ids doesn't escape the limit; then per IP and client_id,
		// so nobody elsewhere can use up another client's budget.
		if (!(await allowRate(env.RL_IP, `tok:${site}`))) {
			log({ t: "auth", ev: "rate_limited", reason: "token_ip" });
			return slowDown("token requests");
		}
		const buffered = await bufferSmallBody(request);
		if (buffered instanceof Response) return withApiHeaders(buffered, devLoopback);
		const form = new URLSearchParams(new TextDecoder().decode(buffered.bytes));
		if (!(await allowRate(env.RL_TOKEN, `tok:${site}|${tokenClientId(request, form)}`))) {
			log({ t: "auth", ev: "rate_limited", reason: "token" });
			return slowDown("token requests");
		}
		// RFC 7009 revocation (the library's test: a token and no grant_type).
		const revoked = !form.get("grant_type") && form.get("token") ? grantOfToken(form.get("token")) : null;
		const existed = revoked ? await grantExists(env.OAUTH_KV, revoked.uid, revoked.grantId).catch(() => false) : false;
		const res = await provider.fetch(buffered.request, env, ctx);
		if (revoked && existed && res.status === 200) await noteRevocation(env, revoked, ridOf(request));
		return withApiHeaders(res, devLoopback);
	}

	if (path === "/mcp") {
		const origin = originPolicy(request, cfg);
		if (!origin.ok) return jsonRpcError(403, -32000, "This origin isn't allowed.");
		if (origin.scheme) noteScheme(origin.scheme);
		if (request.method === "OPTIONS") return applyCors(new Response(null, { status: 204 }), origin.cors, true);
		// Per IP (an IPv6 caller by its /64) before the token check (a KV read). Generous: several
		// people can share an AI app's IP.
		if (!(await allowRate(env.RL_IP, `mcp:${site}`))) {
			log({ t: "auth", ev: "rate_limited", reason: "mcp_ip" });
			return applyCors(jsonRpcError(429, -32000, "Too many requests. Try again in a minute.", { "retry-after": "60" }), origin.cors);
		}
		const res = await provider.fetch(request, env, ctx);
		return applyCors(res, origin.cors);
	}

	// /authorize has its own, smaller budget: each new sign-in writes a transaction to KV.
	const isAuthorize = path === "/authorize";
	const isPage = path === "/" || path === "/callback" || path.startsWith("/connect");
	if ((isAuthorize || isPage) && !(__NX_DEV_AUTH__ && devActive(env, request))) {
		const allowed = isAuthorize ? await allowRate(env.RL_AUTHZ, `authz:${site}`) : await allowRate(env.RL_PAGES, `page:${site}`);
		if (!allowed) {
			if (isAuthorize) log({ t: "auth", ev: "rate_limited", reason: "authorize" });
			const slow = errorPage("Slow down", "Too many requests. Try again in a minute.", 429);
			slow.headers.set("retry-after", "60");
			return slow;
		}
	}

	const res = await provider.fetch(request, env, ctx);
	if (path.startsWith("/.well-known/") || path.startsWith("/oauth/")) return withApiHeaders(res, devLoopback);
	return res;
}

/** Our security headers on the library's JSON answers (it sets its own cache-control). */
function withApiHeaders(res: Response, devLoopback: boolean): Response {
	const out = new Response(res.body, res);
	for (const [k, v] of Object.entries(securityHeaders({ https: !devLoopback }))) {
		if (k !== "cache-control" || !out.headers.has("cache-control")) out.headers.set(k, v);
	}
	return out;
}
