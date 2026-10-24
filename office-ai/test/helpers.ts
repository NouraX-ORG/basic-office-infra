import { vi } from "vitest";
import { type Env, handle } from "../src/relay";
import { base64urlEncode } from "../src/session";

export const INSTANCE = "ocabc123def4";
export const MASTER_SECRET = "test-onlyoffice-secret-0123456789abcdef0123456789";

/** Document Server's derivation: HMAC-SHA256(session secret, "editor-session") as lowercase hex. */
export async function deriveSessionKey(master = MASTER_SECRET): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(master), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("editor-session")));
	return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function testEnv(overrides: Partial<Env> = {}): Promise<Env> {
	return {
		NIG_URL: "https://nig.test/v1/chat/completions",
		ALLOWED_MODELS: "nourax-smart,nourax-long-context",
		FEATURE: "office",
		MAX_BODY_BYTES: "4096",
		EDITOR_SESSION_KEY: await deriveSessionKey(),
		NEXTCLOUD_INSTANCE_ID: INSTANCE,
		NIG_SERVICE_KEY: "nig-office-service-key",
		...overrides,
	};
}

/** A payload shaped like DocService's fillJwtByConnection output. */
export function sessionPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const now = Math.floor(Date.now() / 1000);
	return {
		document: { key: "doc-123", permissions: { edit: true } },
		editorConfig: {
			mode: "edit",
			user: { id: `${INSTANCE}_5224252b-4938-4a86-a276-54bbae5d5b49`, name: "Hammad", index: 1 },
			ds_view: false,
			ds_sessionTimeConnect: Date.now(),
		},
		iat: now,
		exp: now + 3600,
		...overrides,
	};
}

export async function signToken(payload: Record<string, unknown>, key?: string, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }): Promise<string> {
	const enc = (value: unknown) => base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
	const unsigned = `${enc(header)}.${enc(payload)}`;
	const hmac = await crypto.subtle.importKey("raw", new TextEncoder().encode(key ?? (await deriveSessionKey())), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(unsigned)));
	return `${unsigned}.${base64urlEncode(mac)}`;
}

/** The body the AI plugin sends to the proxy (engine.js buildProxyRequest). */
export function envelope(data: Record<string, unknown>, target = "/nourax-ai/v1/chat/completions"): string {
	return JSON.stringify({
		target,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		data: JSON.stringify(data),
	});
}

export const CHAT = { model: "nourax-smart", messages: [{ role: "user", content: "Summarise this" }] };

export async function call(
	path: string,
	options: { method?: string; token?: string | null; body?: string; env?: Env } = {},
): Promise<Response> {
	const headers = new Headers();
	const token = options.token === undefined ? await signToken(sessionPayload()) : options.token;
	if (token !== null) headers.set("Authorization", `Bearer ${token}`);
	const request = new Request(`https://office.test/nourax-ai${path}`, {
		method: options.method ?? "POST",
		headers,
		body: options.body,
	});
	return handle(request, options.env ?? (await testEnv()));
}

export interface UpstreamCall {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
}

/** Replaces outbound fetch (NIG) with scripted replies, recording each request. */
export function mockNig(replies: Array<Response | Error>): UpstreamCall[] {
	const calls: UpstreamCall[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input as RequestInfo, init);
		calls.push({ url: request.url, headers: request.headers, body: (await request.json()) as Record<string, unknown> });
		const next = replies.shift();
		if (next === undefined) throw new Error(`unexpected extra call: ${request.method} ${request.url}`);
		if (next instanceof Error) throw next;
		return next;
	});
	return calls;
}

export function nigError(status: number, code: string, message = "detail"): Response {
	return Response.json({ error: { code, message } }, { status });
}

export async function errorOf(res: Response): Promise<{ code: string; message: string }> {
	return ((await res.json()) as { error: { code: string; message: string } }).error;
}
