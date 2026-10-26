/**
 * Front checks on /mcp (DESIGN 5.2).
 * Origin: no Origin is fine (server-to-server). An http(s) Origin must be on the allowlist and then
 * gets CORS headers; any other http(s) Origin gets 403. "null" and non-web schemes (ONLYOFFICE's
 * onlyoffice-proxy:) are allowed on /mcp only, with no CORS headers: a bearer token is still needed,
 * and a browser can't attach one cross-site without passing our CORS check.
 */
import type { NxConfig } from "../env";
import { LIMITS } from "../core/limits";

export type OriginDecision = { ok: true; cors: string | null; scheme?: string } | { ok: false };

const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function originPolicy(request: Request, cfg: NxConfig): OriginDecision {
	const origin = request.headers.get("origin");
	if (origin === null || origin === "") return { ok: true, cors: null };
	if (origin === "null") return { ok: true, cors: null, scheme: "null" };
	let u: URL;
	try {
		u = new URL(origin);
	} catch {
		return { ok: false };
	}
	if (u.protocol === "http:" || u.protocol === "https:") {
		if (u.host === cfg.publicHost && u.protocol === new URL(cfg.publicOrigin).protocol) return { ok: true, cors: origin, scheme: u.protocol.slice(0, -1) };
		if (cfg.env === "dev" && DEV_HOSTS.has(u.hostname === "::1" ? "[::1]" : u.hostname)) return { ok: true, cors: origin, scheme: u.protocol.slice(0, -1) };
		return { ok: false };
	}
	const scheme = u.protocol.slice(0, -1).toLowerCase();
	if (!/^[a-z][a-z0-9+.-]{0,31}$/.test(scheme)) return { ok: false };
	return { ok: true, cors: null, scheme };
}

export const CORS_EXPOSE = "WWW-Authenticate, Retry-After, X-Request-Id, Mcp-Session-Id, Mcp-Protocol-Version";
/** Mcp-Method and Mcp-Name: the 2026-07-28 Streamable HTTP headers (every POST, and tools/call). */
export const CORS_ALLOW_HEADERS = "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-Id, X-Request-Id";

/** Replaces whatever CORS headers the library added with ours (or none). */
export function applyCors(res: Response, cors: string | null, preflight = false): Response {
	const out = new Response(res.body, res);
	for (const h of [
		"access-control-allow-origin",
		"access-control-allow-methods",
		"access-control-allow-headers",
		"access-control-expose-headers",
		"access-control-max-age",
		"access-control-allow-credentials",
	]) {
		out.headers.delete(h);
	}
	if (cors) {
		out.headers.set("access-control-allow-origin", cors);
		out.headers.set("access-control-expose-headers", CORS_EXPOSE);
		const vary = out.headers.get("vary");
		if (!vary?.toLowerCase().includes("origin")) out.headers.set("vary", vary ? `${vary}, Origin` : "Origin");
		if (preflight) {
			out.headers.set("access-control-allow-methods", "POST, OPTIONS");
			out.headers.set("access-control-allow-headers", CORS_ALLOW_HEADERS);
			out.headers.set("access-control-max-age", "600");
		}
	}
	return out;
}

/** application/json, with or without parameters. */
export function isJsonContentType(request: Request): boolean {
	const ct = request.headers.get("content-type");
	if (!ct) return false;
	return ct.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/** ONLYOFFICE sends no Accept; the SDK's legacy lane would answer 406 (5.2). */
export function acceptShim(headers: Headers): Headers {
	const out = new Headers(headers);
	const accept = (out.get("accept") ?? "").toLowerCase();
	if (!(accept.includes("application/json") && accept.includes("text/event-stream"))) {
		out.set("accept", "application/json, text/event-stream");
	}
	return out;
}

export class BodyTooLarge extends Error {}

/** Reads the body once, at most `max` bytes. */
export async function readBody(request: Request, max: number = LIMITS.mcpBodyBytes): Promise<string> {
	return new TextDecoder().decode(await readBodyBytes(request, max));
}

/** Reads the body once as bytes, at most `max` (declared or streamed, chunked included). */
export async function readBodyBytes(request: Request, max: number): Promise<Uint8Array> {
	const declared = Number(request.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > max) throw new BodyTooLarge();
	if (!request.body) return new Uint8Array(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			throw new BodyTooLarge();
		}
		chunks.push(value);
	}
	const buf = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		buf.set(c, off);
		off += c.byteLength;
	}
	return buf;
}

/** Our own HTML forms are small; anything bigger is refused unread (fix round 2). */
export const FORM_BODY_MAX = 16 * 1024;

/** The body isn't an HTML form (application/x-www-form-urlencoded). */
export class NotAForm extends Error {}

/**
 * Reads one of our own HTML form posts: application/x-www-form-urlencoded only, at most `max`
 * bytes (declared or streamed, chunked included). Never request.formData(), which reads a body of
 * any size. Throws BodyTooLarge or NotAForm. Used by the consent POST and lane F's /connections.
 */
export async function readSmallForm(request: Request, max: number = FORM_BODY_MAX): Promise<URLSearchParams> {
	const ct = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (ct !== "application/x-www-form-urlencoded") {
		await request.body?.cancel().catch(() => undefined);
		throw new NotAForm();
	}
	const bytes = await readBodyBytes(request, max);
	return new URLSearchParams(new TextDecoder().decode(bytes));
}

/** A JSON-RPC error body with an HTTP status. */
export function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
	});
}
