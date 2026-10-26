/**
 * Lane G's live helpers (DESIGN 17.6 and 25). Under the shared `npm run test:live` they use core's
 * runner on :8787 and its env file (NX_DEV_ENV_FILE); lane G's own config (vitest.g.config.ts) sets
 * NX_LIVE_BASE to its server on :8860 (or NX_G_PORT) and NX_G_ENV_FILE to its own env file (fix
 * round 3). Direct calls to drive.nourax.org (test set-up and the privacy comparison of 25.2) use the
 * QA app passwords from that env file. Nothing here prints a token or a password.
 */
import { readFileSync } from "node:fs";

export const BASE = process.env.NX_LIVE_BASE ?? (process.env.NX_G_PORT ? `http://localhost:${process.env.NX_G_PORT}` : "http://localhost:8787");
export const DRIVE = "https://drive.nourax.org";
export const RUN = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
export const ME = "qa-t1-g-gantt-1";
export const PEER = "qa-t1-g-gantt-3";
export const OUTSIDER = "qa-t1-g-gantt-2";

/** What wrangler dev answers (503, text/plain) when a file change reloads the Worker while a request is in flight. */
const RESTARTED = "Your worker restarted mid-request";
export let restartsWaitedOut = 0;

/**
 * One POST to the local dev server. The lanes share one folder, so another lane's edit can reload
 * wrangler dev in the middle of a call (DESIGN 25.8): that answer, or a refused connection while it
 * starts again, is waited out (2 s) and the request sent once more. Nothing else is retried.
 */
async function post(path: string, init: { headers: Record<string, string>; body: string }): Promise<{ status: number; raw: string; type: string }> {
	for (let attempt = 0; ; attempt++) {
		try {
			const res = await fetch(`${BASE}${path}`, { method: "POST", ...init });
			const raw = await res.text();
			if (attempt === 0 && res.status === 503 && raw.startsWith(RESTARTED)) {
				restartsWaitedOut++;
				console.info(`live lane G: wrangler dev reloaded during ${path}; sending it once more`);
				await new Promise((done) => setTimeout(done, 2000));
				continue;
			}
			return { status: res.status, raw, type: res.headers.get("content-type") ?? "" };
		} catch (e) {
			const refused = String((e as { cause?: { code?: string } })?.cause?.code ?? "") === "ECONNREFUSED";
			if (attempt > 0 || !refused) throw e;
			restartsWaitedOut++;
			await new Promise((done) => setTimeout(done, 2000));
		}
	}
}

export async function devToken(uid: string, opts: { scopes?: string[]; apps?: string[] } = {}): Promise<string> {
	const res = await post("/dev/token", { headers: { "content-type": "application/json" }, body: JSON.stringify({ uid, ...opts }) });
	if (res.status !== 200) throw new Error(`dev token: HTTP ${res.status}`);
	return (JSON.parse(res.raw) as { access_token: string }).access_token;
}

export async function rpc(token: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown>; raw: string }> {
	const res = await post("/mcp", {
		headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
		body: JSON.stringify(body),
	});
	const raw = res.raw;
	let json: Record<string, unknown> = {};
	if (res.type.includes("text/event-stream")) {
		for (const line of raw.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			const j = JSON.parse(line.slice(5)) as Record<string, unknown>;
			if ("result" in j || "error" in j) json = j;
		}
	} else if (raw && res.type.includes("json")) json = JSON.parse(raw) as Record<string, unknown>;
	// Any other body (a plain-text 503, say) leaves json empty, so call() names the status and the text.
	return { status: res.status, json, raw };
}

export interface Result {
	content: { text: string }[];
	structuredContent: Record<string, any>;
	isError?: boolean;
	_meta?: Record<string, { code?: string; retry_after_seconds?: number }>;
}

export const outputs: string[] = [];

/**
 * One tools/call in the ONLYOFFICE request shape (no Accept header), brand-scanned. A run makes
 * more than the 30 writes a minute one person may make, so a rate_limited answer is waited out
 * once, as a client would (retry_after_seconds, at most 65 seconds).
 */
export async function call(token: string, name: string, args: Record<string, unknown>): Promise<Result> {
	for (let attempt = 0; ; attempt++) {
		const r = await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { accept: "" });
		if (r.status !== 200 || !r.json.result) throw new Error(`${name}: HTTP ${r.status} ${r.raw.slice(0, 300)}`);
		outputs.push(r.raw);
		brandScan(name, r.raw);
		const result = r.json.result as Result;
		const err = result._meta?.["nourax/error"];
		// Core's daily caps (PER_DAY: 30 share actions, 500 writes) count in the dev server's local
		// state, so repeated runs on one day use them up: say so, rather than fail on a missing field.
		if (err?.code === "daily_limit") {
			throw new Error(`${name}: the local dev state reached a daily cap (${result.content[0]?.text ?? ""}); set NX_G_STATE_DIR to a fresh folder`);
		}
		if (attempt > 0 || err?.code !== "rate_limited") return result;
		const wait = Math.min(65, Math.max(1, Number(err.retry_after_seconds ?? 30)));
		console.info(`live lane G: ${name} was rate limited; waiting ${wait} s once`);
		await new Promise((done) => setTimeout(done, wait * 1000));
	}
}

/** The error text of a result, for assertion messages. */
export function why(r: Result): string {
	return r.isError ? `${code(r)}: ${r.content[0]?.text ?? ""}` : "ok";
}

export function code(r: Result): string | undefined {
	return r._meta?.["nourax/error"]?.code;
}

const N = ["next", "cloud"];
const BRAND = [new RegExp(`${N[0]}[ -]?${N[1]}`, "i"), /#0082c9/i, /#00679e/i];

/** Fails when any output a person could see names the upstream brand or shows its blue (brief rule 6). */
export function brandScan(where: string, text: string): void {
	for (const re of BRAND) if (re.test(text)) throw new Error(`brand rule 6: ${where} matches ${re}`);
}

/** The QA app passwords from lane G's env file (DEV_QA_ACCOUNTS), for direct set-up calls. */
function passwords(): Record<string, string> {
	const file = process.env.NX_G_ENV_FILE ?? process.env.NX_DEV_ENV_FILE;
	if (!file) throw new Error("Set NX_DEV_ENV_FILE (or NX_G_ENV_FILE for lane G's own run)");
	const line = readFileSync(file, "utf8")
		.split(/\r?\n/)
		.find((l) => l.startsWith("DEV_QA_ACCOUNTS="));
	if (!line) throw new Error("DEV_QA_ACCOUNTS is missing from the env file");
	return JSON.parse(line.slice("DEV_QA_ACCOUNTS=".length)) as Record<string, string>;
}

function basic(uid: string): string {
	const p = passwords()[uid];
	if (!p) throw new Error(`no app password for ${uid}`);
	return `Basic ${btoa(`${uid}:${p}`)}`;
}

/** A direct call to drive.nourax.org as a QA account (set-up and checks only, never through the Worker). */
export async function direct(uid: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
	const res = await fetch(`${DRIVE}${path}`, {
		method,
		headers: { authorization: basic(uid), "ocs-apirequest": "true", accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
		body: body === undefined ? undefined : JSON.stringify(body),
		redirect: "manual",
	});
	const text = await res.text();
	let json: any = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = null;
	}
	return { status: res.status, json };
}

/** The OCS data of a direct call. */
export function ocsData(r: { json: any }): any {
	return r.json?.ocs?.data;
}
