/**
 * Helpers for live cases (DESIGN 17.6): dev tokens, raw MCP posts in the ONLYOFFICE shape, an SDK
 * client in either era, a brand scan of every output, and clean-up bookkeeping. Each lane works only
 * inside its own /MCP-QA-<run>/ folder and its own QA calendar, address book and board, and cleans up
 * only what it created (the rule-3 exception).
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export const BASE = "http://localhost:8787";
export const RUN = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
export const QA_FOLDER = `/MCP-QA-${RUN}`;

export interface DevTokens {
	access_token: string;
	refresh_token?: string;
	connection_id: string;
	scope: string;
}

export async function devToken(uid: string, opts: { scopes?: string[]; apps?: string[] } = {}): Promise<DevTokens> {
	const res = await fetch(`${BASE}/dev/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid, ...opts }) });
	if (!res.ok) throw new Error(`dev token: ${res.status} ${await res.text()}`);
	return (await res.json()) as DevTokens;
}

export async function rpc(token: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown>; raw: string }> {
	const res = await fetch(`${BASE}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
		body: JSON.stringify(body),
	});
	const raw = await res.text();
	let json: Record<string, unknown> = {};
	if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
		for (const line of raw.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			const j = JSON.parse(line.slice(5)) as Record<string, unknown>;
			if ("result" in j || "error" in j) json = j;
		}
	} else if (raw) json = JSON.parse(raw) as Record<string, unknown>;
	return { status: res.status, json, raw };
}

export async function sdk(token: string, mode: "legacy" | "auto" = "legacy"): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
	const client = new Client({ name: "nourax-live", version: "1.0.0" }, { versionNegotiation: { mode } });
	await client.connect(transport);
	return client;
}

const N = ["next", "cloud"];
const BRAND = [new RegExp(`${N[0]}[ -]?${N[1]}`, "i"), /#0082c9/i, /#00679e/i];

/** Fails when any output a person could see names the upstream brand (brief rule 6). */
export function brandScan(where: string, text: string): void {
	for (const re of BRAND) if (re.test(text)) throw new Error(`brand rule 6: ${where} matches ${re}`);
}
