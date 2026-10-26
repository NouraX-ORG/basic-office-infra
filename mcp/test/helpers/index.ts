/**
 * Shared test helpers: the typed env, calling the whole Worker, dev tokens, raw MCP posts and an
 * MCP SDK client wired to the Worker. Tests run in workerd with the dev environment's bindings.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { env as rawEnv, exports } from "cloudflare:workers";
import type { NxEnv } from "../../src/env";
import { FakeNc } from "../fake-nc/index";

export const env = rawEnv as unknown as NxEnv;
export const ORIGIN = "http://localhost:8787";
export const QA = { a: "qa-t1-91", b: "qa-t1-92" } as const;
export const QA_PASS: Record<string, string> = {
	"qa-t1-91": "FAKEAPPPASS-qa-t1-91-0123456789abcdef",
	"qa-t1-92": "FAKEAPPPASS-qa-t1-92-0123456789abcdef",
};

const worker = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;

export function call(path: string, init?: RequestInit): Promise<Response> {
	return worker.fetch(new Request(path.startsWith("http") ? path : `${ORIGIN}${path}`, { redirect: "manual", ...init }));
}

/** A fake with both QA accounts, installed as the fetch spy. */
export function fakeWithQa(): FakeNc {
	const fake = new FakeNc();
	fake.addUser({ uid: QA.a, password: QA_PASS[QA.a] as string, displayName: "QA t1 91", email: "qa-t1-91@example.invalid" });
	fake.addUser({ uid: QA.b, password: QA_PASS[QA.b] as string, displayName: "QA t1 92", email: "qa-t1-92@example.invalid" });
	fake.install();
	return fake;
}

export interface DevTokens {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	scope: string;
	connection_id: string;
}

export async function devToken(uid: string, opts: { scopes?: string[]; apps?: string[] } = {}): Promise<DevTokens> {
	const res = await call("/dev/token", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ uid, ...opts }),
	});
	if (res.status !== 200) throw new Error(`dev token failed: ${res.status} ${await res.text()}`);
	return (await res.json()) as DevTokens;
}

/** A raw JSON-RPC POST to /mcp. */
export function mcpPost(token: string | null, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	const h: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers };
	if (token) h.authorization = `Bearer ${token}`;
	return call("/mcp", { method: "POST", headers: h, body: typeof body === "string" ? body : JSON.stringify(body) });
}

/** Reads a JSON-RPC response that may be plain JSON or an SSE stream with data: lines. */
export async function rpcResult(res: Response): Promise<Record<string, unknown>> {
	const text = await res.text();
	const ct = res.headers.get("content-type") ?? "";
	if (ct.includes("text/event-stream")) {
		const datas = text
			.split(/\r?\n/)
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).trim())
			.filter(Boolean);
		for (const d of datas) {
			const j = JSON.parse(d) as Record<string, unknown>;
			if ("result" in j || "error" in j) return j;
		}
		throw new Error(`no JSON-RPC result in SSE: ${text.slice(0, 200)}`);
	}
	return JSON.parse(text) as Record<string, unknown>;
}

export const INIT_2024 = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

/** An MCP SDK client connected to the Worker with a bearer token. */
export async function sdkClient(token: string, opts: { mode?: "legacy" | "auto" | { pin: string }; protocolVersion?: string } = {}): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
		fetch: (input: RequestInfo | URL, init?: RequestInit) => worker.fetch(new Request(input as RequestInfo, init)),
		requestInit: { headers: { authorization: `Bearer ${token}` } },
		...(opts.protocolVersion ? { protocolVersion: opts.protocolVersion } : {}),
	});
	const client = new Client({ name: "nourax-test", version: "1.0.0" }, { versionNegotiation: { mode: opts.mode ?? "legacy" } });
	await client.connect(transport);
	return client;
}

/** The framed text block's payload (between the data markers). */
export function framedPayload(text: string): string {
	const m = /<<<nx-data ([0-9a-f]{16})>>>\n([\s\S]*)\n<<<end nx-data \1>>>$/.exec(text);
	if (!m) throw new Error(`not framed: ${text.slice(0, 200)}`);
	return m[2] as string;
}
