/**
 * Lane E's live helpers (DESIGN 17.6). Under the shared `npm run test:live` they use core's runner
 * on :8787 and its env file (NX_DEV_ENV_FILE); lane E's own config (vitest.e.config.ts) sets
 * NX_LIVE_BASE to its server on :8840 and NX_E_ENV_FILE to its own env file (fix round 3: the shared
 * command couldn't run these). The env files are in the scratchpad, never in the repo. Same shapes as
 * test/live/_shared/client.ts. Never prints a token or a password.
 */
import { readFileSync } from "node:fs";

export const BASE = process.env.NX_LIVE_BASE ?? "http://localhost:8787";
export const DRIVE = "https://drive.nourax.org";
export const RUN = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);

/** upstream: true makes core's dev route seed a made-up "Log in with Nourax" session, so mail is active. */
export async function devToken(uid: string, opts: { scopes?: string[]; apps?: string[]; upstream?: boolean } = {}): Promise<{ access_token: string }> {
	const res = await fetch(`${BASE}/dev/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid, ...opts }) });
	if (!res.ok) throw new Error(`dev token: HTTP ${res.status}`);
	return (await res.json()) as { access_token: string };
}

export async function rpc(token: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown>; raw: string }> {
	const res = await fetch(`${BASE}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers },
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

export interface Result {
	content: { text: string }[];
	structuredContent: Record<string, unknown>;
	isError?: boolean;
	_meta?: Record<string, { code: string }>;
}

const N = ["next", "cloud"];
const BRAND = [new RegExp(`${N[0]}[ -]?${N[1]}`, "i"), /#0082c9/i, /#00679e/i];

/** Fails when any output a person could see names the upstream brand (brief rule 6). */
export function brandScan(where: string, text: string): void {
	for (const re of BRAND) if (re.test(text)) throw new Error(`brand rule 6: ${where} matches ${re}`);
}

/** One tools/call, brand-scanned. */
export async function tool(token: string, name: string, args: unknown, headers: Record<string, string> = {}): Promise<Result> {
	const r = await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, headers);
	if (r.status !== 200 || !r.json.result) throw new Error(`${name}: HTTP ${r.status} ${r.raw.slice(0, 200)}`);
	brandScan(name, r.raw);
	return r.json.result as Result;
}

/** One value from lane E's dev env file (kept in memory only, never printed). */
export function envValue(name: string): string {
	const file = process.env.NX_E_ENV_FILE ?? process.env.NX_DEV_ENV_FILE;
	if (!file) throw new Error("Set NX_DEV_ENV_FILE (or NX_E_ENV_FILE for lane E's own run) to the dev env file in the scratchpad.");
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		if (!line.startsWith(`${name}=`)) continue;
		const v = line.slice(name.length + 1);
		return /^['"]/.test(v) ? v.slice(1, -1) : v;
	}
	throw new Error(`${name} isn't in the env file`);
}

/** QA app passwords from the env file, for test setup straight through the Deck API (17.6). */
function qaPassword(uid: string): string {
	const p = (JSON.parse(envValue("DEV_QA_ACCOUNTS")) as Record<string, string>)[uid];
	if (!p) throw new Error(`no QA password for ${uid}`);
	return p;
}

/** Deck REST or OCS as a QA account, for setup and for checking what the server really stored. */
export async function deck<T = unknown>(uid: string, method: string, path: string, body?: unknown): Promise<T> {
	const url = path.startsWith("/ocs/") ? `${DRIVE}${path}${path.includes("?") ? "&" : "?"}format=json` : `${DRIVE}/index.php/apps/deck/api/v1.0${path}`;
	const res = await fetch(url, {
		method,
		headers: {
			authorization: `Basic ${btoa(`${uid}:${qaPassword(uid)}`)}`,
			"ocs-apirequest": "true",
			accept: "application/json",
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		redirect: "manual",
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`deck ${method} ${path}: HTTP ${res.status}`);
	const j = text ? (JSON.parse(text) as unknown) : null;
	return (path.startsWith("/ocs/") ? (j as { ocs: { data: T } }).ocs.data : j) as T;
}
