// Nourax AI relay for the ONLYOFFICE editors (office.nourax.org/nourax-ai/*).
//
// The AI plugin runs in "server settings" mode (scripts/patch-ai-plugin.py): it shows no keys and no
// settings, and sends every AI request here as an envelope { target, method, headers, data } with the
// editor-session token as "Authorization: Bearer". This Worker checks that token (session.ts), takes
// the user from it, keeps only chat requests for the allowed models and forwards them to NIG with the
// "office" service key and `user` set to that user, so the usage counts against that person's
// Nourax AI budget. The key never reaches the browser. Nothing is stored; prompts are not logged.
//
// Routes:
//   GET  /nourax-ai/health   {"status":"ok"}
//   POST /nourax-ai/proxy    the plugin's envelope; answers with NIG's reply (streamed when asked)
// SPDX-License-Identifier: AGPL-3.0-or-later

import { importSessionKey, SessionError, verifySession } from "./session";

export interface Env {
	/** NIG's chat endpoint, e.g. https://nig.nourax.org/v1/chat/completions */
	NIG_URL: string;
	/** Comma-separated friendly model names the editors may use. */
	ALLOWED_MODELS: string;
	/** Sent to NIG as X-Nourax-Feature. */
	FEATURE: string;
	/** Largest request accepted, in bytes. */
	MAX_BODY_BYTES: string;
	/** Secret: HMAC-SHA256(ONLYOFFICE session secret, "editor-session") as hex. */
	EDITOR_SESSION_KEY?: string;
	/** Secret: Nextcloud's instanceid. */
	NEXTCLOUD_INSTANCE_ID?: string;
	/** Secret: NIG's key for the "office" service. */
	NIG_SERVICE_KEY?: string;
}

const PREFIX = "/nourax-ai";

/** OpenAI chat fields passed on to NIG; anything else (n, logit_bias, user, ...) is dropped. */
const CHAT_FIELDS = [
	"messages",
	"stream",
	"stream_options",
	"temperature",
	"top_p",
	"max_tokens",
	"max_completion_tokens",
	"stop",
	"presence_penalty",
	"frequency_penalty",
	"seed",
	"response_format",
	"tools",
	"tool_choice",
] as const;

const MESSAGES = {
	not_configured: "Nourax AI is not available yet.",
	no_session: "Please reopen the document to use Nourax AI.",
	bad_session: "Please reopen the document to use Nourax AI.",
	expired: "Your editing session has expired. Please reopen the document to use Nourax AI.",
	guest: "Sign in to Nourax Workspace to use Nourax AI.",
	ai_disabled: "Nourax AI is switched off for this document.",
	bad_user: "Nourax AI is not available for this account.",
	too_large: "This request is too large for Nourax AI. Try a shorter selection.",
	bad_request: "Nourax AI could not read this request.",
	unsupported: "This AI feature is not available in Nourax Workspace.",
	model_not_allowed: "That AI model is not available in Nourax Workspace.",
	budget_exceeded: "You have reached your Nourax AI limit for now. Please try again later.",
	busy: "Nourax AI is busy. Please try again in a moment.",
} as const;

export async function handle(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const route = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : null;
	if (request.method === "GET" && route === "/health") return json(200, { status: "ok" });
	if (route !== "/proxy") return fail(404, "not_found", "Unknown path");
	if (request.method !== "POST") return fail(405, "method_not_allowed", "Use POST");

	if (!env.EDITOR_SESSION_KEY || !env.NEXTCLOUD_INSTANCE_ID) {
		console.error("office-ai: EDITOR_SESSION_KEY or NEXTCLOUD_INSTANCE_ID is not set (tools/set-secrets.sh)");
		return fail(503, "not_configured", MESSAGES.not_configured);
	}

	let uid: string;
	try {
		const key = await importSessionKey(env.EDITOR_SESSION_KEY);
		({ uid } = await verifySession(request.headers.get("Authorization"), key, env.NEXTCLOUD_INSTANCE_ID));
	} catch (err) {
		if (!(err instanceof SessionError)) throw err;
		console.log(JSON.stringify({ event: "refused", reason: err.code }));
		const status = err.code === "guest" || err.code === "ai_disabled" || err.code === "bad_user" ? 403 : 401;
		return fail(status, err.code, MESSAGES[err.code]);
	}
	// Checked after the session, so the editor side can be tested before NIG's key is in place.
	if (!env.NIG_SERVICE_KEY) {
		console.error(JSON.stringify({ event: "no_nig_key", uid }));
		return fail(503, "not_configured", MESSAGES.not_configured);
	}

	const maxBytes = Number(env.MAX_BODY_BYTES);
	if (Number(request.headers.get("Content-Length") ?? 0) > maxBytes) return fail(413, "too_large", MESSAGES.too_large);
	const raw = await request.arrayBuffer();
	if (raw.byteLength > maxBytes) return fail(413, "too_large", MESSAGES.too_large);

	const chat = readEnvelope(new TextDecoder().decode(raw));
	if (chat === "unsupported") return fail(400, "unsupported", MESSAGES.unsupported);
	if (chat === null) return fail(400, "bad_request", MESSAGES.bad_request);

	const allowed = env.ALLOWED_MODELS.split(",").map((m) => m.trim()).filter(Boolean);
	if (typeof chat.model !== "string" || !allowed.includes(chat.model)) {
		return fail(403, "model_not_allowed", MESSAGES.model_not_allowed);
	}
	const body: Record<string, unknown> = { model: chat.model, user: uid };
	for (const field of CHAT_FIELDS) if (chat[field] !== undefined) body[field] = chat[field];

	let upstream: Response;
	try {
		upstream = await fetch(env.NIG_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.NIG_SERVICE_KEY}`,
				"Content-Type": "application/json",
				"X-Nourax-Feature": env.FEATURE,
			},
			body: JSON.stringify(body),
		});
	} catch {
		console.log(JSON.stringify({ event: "nig_unreachable", uid, model: chat.model }));
		return fail(502, "busy", MESSAGES.busy);
	}
	console.log(JSON.stringify({ event: "ai", uid, model: chat.model, stream: body.stream === true, status: upstream.status }));

	if (upstream.ok) {
		const headers = new Headers({
			"Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
			"Cache-Control": "no-store",
		});
		return new Response(upstream.body, { status: upstream.status, headers });
	}
	return fromNig(upstream);
}

/** The plugin's envelope: `target` is the provider address it would have called, `data` the JSON body. */
function readEnvelope(text: string): Record<string, unknown> | "unsupported" | null {
	const envelope = parseObject(text);
	if (!envelope || typeof envelope.target !== "string") return null;
	if (envelope.method !== undefined && envelope.method !== "POST") return "unsupported";
	let target: URL;
	try {
		target = new URL(envelope.target, "https://nourax-ai.invalid");
	} catch {
		return null;
	}
	// The provider address in our settings is a label; only the endpoint matters, and only chat is offered.
	if (!target.pathname.endsWith("/chat/completions")) return "unsupported";
	const data = typeof envelope.data === "string" ? parseObject(envelope.data) : asObject(envelope.data);
	if (!data || !Array.isArray(data.messages)) return null;
	return data;
}

async function fromNig(upstream: Response): Promise<Response> {
	let code = "";
	let message = "";
	try {
		const parsed = (await upstream.json()) as { error?: { code?: string; message?: string } };
		code = parsed.error?.code ?? "";
		message = parsed.error?.message ?? "";
	} catch {
		// not JSON
	}
	if (upstream.status === 429 && code === "budget_exceeded") return fail(429, "budget_exceeded", MESSAGES.budget_exceeded);
	if (upstream.status === 401) {
		console.error("office-ai: NIG refused the service key (check NIG_SERVICE_KEY and SERVICE_KEY_OFFICE)");
		return fail(503, "not_configured", MESSAGES.not_configured);
	}
	if (upstream.status === 403) return fail(403, "model_not_allowed", MESSAGES.model_not_allowed);
	if (upstream.status >= 400 && upstream.status < 500 && code === "upstream_rejected") {
		return fail(upstream.status, code, `Nourax AI could not process this request: ${message}`);
	}
	if (upstream.status >= 400 && upstream.status < 500) {
		console.error(`office-ai: NIG answered ${upstream.status} ${code}: ${message}`);
		return fail(400, "bad_request", MESSAGES.bad_request);
	}
	return fail(502, "busy", MESSAGES.busy);
}

function parseObject(text: string): Record<string, unknown> | undefined {
	try {
		return asObject(JSON.parse(text));
	} catch {
		return undefined;
	}
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

function fail(status: number, code: string, message: string): Response {
	return json(status, { error: { code, message } });
}
