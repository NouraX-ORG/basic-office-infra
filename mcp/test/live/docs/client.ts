/**
 * Lane C's live helpers: dev tokens and tool calls against the dev server on NX_LIVE_PORT, waiting
 * out the per-person rate limits the way a client should (retry_after_seconds), a brand scan of
 * every output, and direct WebDAV calls as the QA account for setup, downloads and clean-up. The
 * QA app password is read from the dev env file and never printed.
 */
import { readFileSync } from "node:fs";
import { brandScan } from "../_shared/client";

// 8820 under lane C's own config (which sets NX_LIVE_PORT); 8787 under core's runner.
export const PORT = process.env.NX_LIVE_PORT ?? "8787";
export const BASE = `http://localhost:${PORT}`;
export const UID = process.env.NX_LIVE_UID ?? "qa-t1-c-documents-1";
export const DRIVE = "https://drive.nourax.org";
export const RUN = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
export const FOLDER = `/MCP-QA-${RUN}-docs`;

export interface LiveResult {
	content: { type: string; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	_meta?: { "nourax/error"?: { code: string; retry_after_seconds?: number } };
}

let token: string | null = null;

export async function devToken(): Promise<string> {
	if (token) return token;
	const res = await fetch(`${BASE}/dev/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid: UID }) });
	if (!res.ok) throw new Error(`dev token: ${res.status} ${await res.text()}`);
	token = ((await res.json()) as { access_token: string }).access_token;
	return token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One tools/call. Rate limits are waited out (up to three times); every output is brand-scanned. */
export async function tool(name: string, args: Record<string, unknown>, headers: Record<string, string> = {}): Promise<LiveResult & { raw: string; ms: number }> {
	for (let attempt = 0; ; attempt++) {
		const started = Date.now();
		const res = await fetch(`${BASE}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${await devToken()}`, ...headers },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
		});
		const raw = await res.text();
		const ms = Date.now() - started;
		// wrangler dev reloads when files in the shared worktree change (other lanes edit src/ at the
		// same time); a request cut by that reload is sent again.
		if (raw.startsWith("Your worker restarted") && attempt < 3) {
			await sleep(3000);
			continue;
		}
		if (res.status === 429 && attempt < 3) {
			await sleep((Number(res.headers.get("retry-after") ?? "30") + 1) * 1000);
			continue;
		}
		let json: { result?: LiveResult; error?: unknown } = {};
		if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
			for (const line of raw.split(/\r?\n/)) if (line.startsWith("data:")) json = JSON.parse(line.slice(5)) as typeof json;
		} else {
			try {
				json = JSON.parse(raw) as typeof json;
			} catch {
				throw new Error(`${name}: HTTP ${res.status}, not JSON: ${raw.slice(0, 200)}`);
			}
		}
		if (!json.result) throw new Error(`${name}: HTTP ${res.status} ${raw.slice(0, 300)}`);
		const err = json.result._meta?.["nourax/error"];
		if (json.result.isError && err?.code === "rate_limited" && attempt < 3) {
			await sleep(((err.retry_after_seconds ?? 30) + 1) * 1000);
			continue;
		}
		brandScan(name, raw);
		return { ...json.result, raw, ms };
	}
}

/** Another JSON-RPC call (tools/list), returning its result. */
export async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
	const res = await fetch(`${BASE}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${await devToken()}` },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const raw = await res.text();
	let json: { result?: unknown } = {};
	if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
		for (const line of raw.split(/\r?\n/)) if (line.startsWith("data:")) json = JSON.parse(line.slice(5)) as typeof json;
	} else json = JSON.parse(raw) as typeof json;
	if (json.result === undefined) throw new Error(`${method}: HTTP ${res.status} ${raw.slice(0, 300)}`);
	brandScan(method, raw);
	return json.result;
}

/** A successful result's structuredContent (throws with the message otherwise). */
export function data(r: LiveResult): Record<string, unknown> {
	if (r.isError) throw new Error(`tool failed: ${r.content[0]?.text}`);
	return r.structuredContent as Record<string, unknown>;
}

/** The framed payload of a result. */
export function payload(r: LiveResult): string {
	const m = /<<<nx-data ([0-9a-f]{16})>>>\n([\s\S]*)\n<<<end nx-data \1>>>$/.exec(r.content[0]?.text ?? "");
	if (!m) throw new Error("not framed");
	return m[2] as string;
}

function qaPassword(): string {
	const file = process.env.NX_DEV_ENV_FILE;
	if (!file) throw new Error("NX_DEV_ENV_FILE is not set");
	const line = readFileSync(file, "utf8")
		.split(/\r?\n/)
		.find((l) => l.startsWith("DEV_QA_ACCOUNTS="));
	const map = JSON.parse((line ?? "").slice("DEV_QA_ACCOUNTS=".length)) as Record<string, string>;
	const pass = map[UID];
	if (!pass) throw new Error(`no app password for ${UID} in the dev env file`);
	return pass;
}

function davUrl(path: string): string {
	return `${DRIVE}/remote.php/dav/files/${encodeURIComponent(UID)}${path
		.split("/")
		.map((s) => encodeURIComponent(s))
		.join("/")}`;
}

/** Direct WebDAV as the QA account (setup, downloads and clean-up only). */
export async function dav(method: string, path: string, body?: Uint8Array | string, headers: Record<string, string> = {}): Promise<Response> {
	const auth = `Basic ${btoa(`${UID}:${qaPassword()}`)}`;
	return fetch(davUrl(path), { method, headers: { authorization: auth, ...headers }, ...(body !== undefined ? { body: body as BodyInit } : {}) });
}

// ------------------------------------------------------------------ hostile test files
//
// Hostile test files (bombs, damaged packages, SSRF probes, templates built to use up memory) must
// never stay in an account (2026-10-25: two bomb files a verifier left in a QA account were picked
// up by the search indexer and crashed Elasticsearch every 2 minutes). So:
// - they go only into HOSTILE, a folder holding a `.noindex` file, which the search indexer skips
//   (files_fulltextsearch 35's FilesService::isNodeIndexable, read on the server);
// - every case that uploads one deletes it for good right after its check, in a `finally` that also
//   runs when the check fails (withHostile): a DAV DELETE moves it to the trash, and the trash entry
//   is then deleted too (rule-3 exception: objects our own test made, in our own QA account);
// - afterAll purges HOSTILE as a whole as well, in case a purge failed.

/** The folder for hostile test files: it holds a `.noindex` file, so the search indexer skips it. */
export const HOSTILE = `${FOLDER}/hostile`;

/** Makes HOSTILE with its `.noindex` file. */
export async function makeHostileFolder(): Promise<void> {
	const mk = await dav("MKCOL", HOSTILE);
	if (mk.status !== 201) throw new Error(`MKCOL ${HOSTILE}: ${mk.status}`);
	const put = await dav("PUT", `${HOSTILE}/.noindex`, "", { "content-type": "text/plain" });
	if (put.status !== 201) throw new Error(`PUT ${HOSTILE}/.noindex: ${put.status}`);
}

const TRASH = `${DRIVE}/remote.php/dav/trashbin/${encodeURIComponent(UID)}/trash`;

function decodeXml(s: string): string {
	return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** The trash entries (their DAV hrefs) whose original location is `path`. */
async function trashEntriesFor(path: string): Promise<string[]> {
	const auth = `Basic ${btoa(`${UID}:${qaPassword()}`)}`;
	const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:prop><nc:trashbin-original-location/></d:prop></d:propfind>';
	const res = await fetch(TRASH, { method: "PROPFIND", headers: { authorization: auth, depth: "1", "content-type": "application/xml" }, body });
	if (res.status !== 207) throw new Error(`trash PROPFIND: ${res.status}`);
	const xml = await res.text();
	const want = path.replace(/^\/+/, "");
	const out: string[] = [];
	for (const m of xml.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)) {
		const r = m[1] as string;
		const href = /<d:href>([^<]+)<\/d:href>/.exec(r)?.[1];
		const loc = /<nc:trashbin-original-location>([^<]*)<\/nc:trashbin-original-location>/.exec(r)?.[1];
		if (href && loc !== undefined && decodeXml(loc) === want) out.push(href);
	}
	return out;
}

/**
 * Deletes a test file or folder for good: DELETE (to the trash), then its trash entries. Never
 * throws, so clean-up can't hide the check's own failure; a problem is returned for the caller.
 */
export async function purge(path: string): Promise<{ purged: number; problem?: string }> {
	try {
		const del = await dav("DELETE", path);
		if (![204, 404].includes(del.status)) return { purged: 0, problem: `DELETE: ${del.status}` };
		const auth = `Basic ${btoa(`${UID}:${qaPassword()}`)}`;
		let purged = 0;
		for (const href of await trashEntriesFor(path)) {
			const res = await fetch(new URL(href, DRIVE), { method: "DELETE", headers: { authorization: auth } });
			if (res.status !== 204) return { purged, problem: `trash DELETE: ${res.status}` };
			purged++;
		}
		return { purged };
	} catch (e) {
		return { purged: 0, problem: e instanceof Error ? e.message : String(e) };
	}
}

/** Problems seen while purging hostile files, and how many were purged; afterAll checks both. */
export const purgeLog = { problems: [] as string[], purged: 0, uploaded: 0 };

/**
 * Uploads a hostile test file into HOSTILE, runs the check, and deletes the file for good right
 * after, also when the check fails. `also` names files the check makes in HOSTILE (outputs), which
 * are purged the same way.
 */
export async function withHostile<T>(name: string, bytes: Uint8Array | string, mime: string, check: (path: string) => Promise<T>, also: string[] = []): Promise<T> {
	const path = `${HOSTILE}/${name}`;
	return purgedAfter([name, ...also], async () => {
		const put = await dav("PUT", path, bytes, { "content-type": mime });
		if (put.status !== 201) throw new Error(`PUT ${path}: ${put.status}`);
		purgeLog.uploaded++;
		return check(path);
	});
}

/** Runs `fn`, then deletes the named files in HOSTILE for good, also when `fn` fails. */
export async function purgedAfter<T>(names: string[], fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} finally {
		for (const n of names) {
			const p = `${HOSTILE}/${n}`;
			const r = await purge(p);
			purgeLog.purged += r.purged;
			if (r.problem) purgeLog.problems.push(`${p}: ${r.problem}`);
		}
	}
}

export { brandScan };
