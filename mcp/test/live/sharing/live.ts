/**
 * Lane B's live helpers (DESIGN 17.6): its own dev server (default http://localhost:8810), dev
 * tokens for its QA people, MCP calls in the plain and the ONLYOFFICE request shapes, an SDK client
 * for the 2026-07-28 era, and a brand scan of every output.
 *
 * QA people (made by test/live/sharing/qa-setup.sh through the admin API, because privacy between
 * organisations is on): qa-t1-211 and qa-t1-212 share organisation qa-t1-b-org-1 and team
 * qa-t1-b-team-1; qa-t1-213 is in another organisation and must stay out of reach.
 *
 * Fixture files are made straight over WebDAV as qa-t1-211 (the DESIGN allows test setup outside
 * the tools), in a new folder /MCP-QA-B-<run>/. The app password is read from the dev env file
 * (NX_DEV_ENV_FILE) into memory only; it is never printed. Nothing is deleted except the shares and
 * links these cases make, through sharing_delete itself (the rule-3 exception).
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import { brandScan } from "../_shared/client";

// The shared runner by default (fix round 3); lane B's own config sets NX_LIVE_BASE to :8810.
export const BASE = process.env.NX_LIVE_BASE ?? "http://localhost:8787";
export const A = process.env.NX_LIVE_UID_B1 ?? "qa-t1-211";
export const B = process.env.NX_LIVE_UID_B2 ?? "qa-t1-212";
export const OTHER = process.env.NX_LIVE_UID_B3 ?? "qa-t1-213";
export const ORG = "qa-t1-b-org-1";
export const TEAM = "qa-t1-b-team-1";
export const RUN = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
export const ROOT = `/MCP-QA-B-${RUN}`;
const DRIVE = "https://drive.nourax.org";

export const ALL = ["workspace.read", "workspace.write", "workspace.remove", "workspace.share"];

export interface Result {
	isError?: boolean;
	content: { type: string; text: string }[];
	// biome-ignore lint/suspicious/noExplicitAny: free-form results in tests
	structuredContent: Record<string, any>;
	_meta?: Record<string, { code?: string }>;
}

export async function devToken(uid: string, scopes: string[] = ALL): Promise<string> {
	const res = await fetch(`${BASE}/dev/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid, scopes }) });
	if (!res.ok) throw new Error(`dev token for ${uid}: ${res.status}`);
	return ((await res.json()) as { access_token: string }).access_token;
}

let rid = 1;

/** One JSON-RPC call. `onlyoffice` sends what ONLYOFFICE Desktop 10 sends: no Accept header. */
export async function rpc(token: string, method: string, params: unknown, opts: { onlyoffice?: boolean } = {}): Promise<{ status: number; json: Record<string, unknown>; raw: string }> {
	const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}` };
	if (!opts.onlyoffice) headers.accept = "application/json, text/event-stream";
	const res = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params }) });
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

/**
 * tools/call; every answer is brand-scanned. The person's own limits are real here (share: 10 a
 * minute, 30 a day, counted per call), so a rate_limited answer is waited out once, as a polite
 * client would. Run each live session on a fresh --persist-to directory to start the day at zero.
 *
 * `brand: "own"` is for lists that also show the person's older items (sharing_list): the raw
 * answer is not scanned here, and the case checks it with brandScanOwn instead.
 */
export async function call(token: string, name: string, args: Record<string, unknown>, opts: { onlyoffice?: boolean; brand?: "all" | "own" } = {}): Promise<Result> {
	for (let attempt = 0; ; attempt++) {
		const r = await rpc(token, "tools/call", { name, arguments: args }, opts);
		if (opts.brand !== "own") brandScan(name, r.raw);
		if (r.status !== 200 || !r.json.result) throw new Error(`${name}: HTTP ${r.status} ${r.raw.slice(0, 300)}`);
		const result = r.json.result as Result & { _meta?: Record<string, { code?: string; retry_after_seconds?: number }> };
		const meta = result._meta?.["nourax/error"];
		if (attempt === 0 && meta?.code === "rate_limited" && (meta.retry_after_seconds ?? 61) <= 65) {
			await new Promise((res) => setTimeout(res, ((meta.retry_after_seconds ?? 61) + 1) * 1000));
			continue;
		}
		return result;
	}
}

export function code(r: Result): string | undefined {
	return r._meta?.["nourax/error"]?.code;
}

/**
 * The brand check for a list whose items include the person's older data. Everything this lane's
 * code writes must be clean: the summary and notice lines, every field outside the list, and
 * every item this run made (ids in `own`). An older item may hold the upstream brand in its own
 * name: the board app's welcome board puts a sample image whose file name carries the brand into
 * /Deck and shares it with its card (deck's FilesAppService, DEFAULT_SAMPLE_FILE). That is the
 * person's data, which our tools show as it is (a path must stay real); Task 3 stops new accounts
 * getting that board, so it is reported here, not failed. Returns the ids of the older items that
 * matched.
 */
export function brandScanOwn(where: string, r: Result, listKey: string, own: string[]): string[] {
	const lines = (r.content[0]?.text ?? "").split("\n");
	brandScan(`${where} (summary and notice)`, lines.slice(0, 2).join("\n"));
	const { [listKey]: list, ...rest } = r.structuredContent;
	brandScan(`${where} (fields outside ${listKey})`, JSON.stringify(rest));
	const older: string[] = [];
	for (const item of (list ?? []) as { share_id: string }[]) {
		if (own.includes(item.share_id)) brandScan(`${where} (share ${item.share_id}, made by this run)`, JSON.stringify(item));
		else {
			try {
				brandScan(where, JSON.stringify(item));
			} catch {
				older.push(item.share_id);
			}
		}
	}
	if (older.length) console.warn(`${where}: older shares of the person show the upstream brand in their own names (user data, not this lane's text): ${older.join(", ")}`);
	return older;
}

/**
 * Stops shares this run made (the rule-3 exception), checking every answer: an error result is
 * not success. A rate limit is waited out; "not found" means already stopped. Returns the ids
 * that may still be active.
 */
export async function stopAll(token: string, ids: string[]): Promise<string[]> {
	const left: string[] = [];
	for (const id of ids) {
		let done = false;
		for (let attempt = 0; attempt < 3 && !done; attempt++) {
			let r: Result;
			try {
				r = await call(token, "sharing_delete", { share_id: id });
			} catch {
				await new Promise((res) => setTimeout(res, 2000));
				continue;
			}
			const c = code(r);
			if (!r.isError || c === "not_found") done = true;
			else if (c === "rate_limited") {
				const wait = Math.min((r._meta?.["nourax/error"] as { retry_after_seconds?: number } | undefined)?.retry_after_seconds ?? 61, 65);
				await new Promise((res) => setTimeout(res, (wait + 1) * 1000));
			} else await new Promise((res) => setTimeout(res, 2000));
		}
		if (!done) left.push(id);
	}
	return left;
}

/** An OCS request as a QA person, for fixtures only (for example a link made without an expiry date). */
export async function ocsAs(uid: string, method: string, path: string, body?: Record<string, string>): Promise<{ status: number; data: Record<string, unknown> }> {
	const res = await fetch(`${DRIVE}${path}${path.includes("?") ? "&" : "?"}format=json`, {
		method,
		headers: {
			authorization: `Basic ${btoa(`${uid}:${appPassword(uid)}`)}`,
			"ocs-apirequest": "true",
			accept: "application/json",
			...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
		},
		body: body ? new URLSearchParams(body).toString() : undefined,
	});
	const text = await res.text();
	let data: Record<string, unknown> = {};
	try {
		data = ((JSON.parse(text) as { ocs?: { data?: Record<string, unknown> } }).ocs?.data ?? {}) as Record<string, unknown>;
	} catch {
		// not JSON
	}
	return { status: res.status, data };
}

export function ok(r: Result, what: string): Result {
	if (r.isError) throw new Error(`${what}: ${r.content[0]?.text}`);
	return r;
}

export async function sdk(token: string): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
	const client = new Client({ name: "nourax-live-b", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
	await client.connect(transport);
	return client;
}

/** The QA account's app password, from the dev env file; kept in memory only. */
function appPassword(uid: string): string {
	const file = process.env.NX_DEV_ENV_FILE;
	if (!file) throw new Error("Set NX_DEV_ENV_FILE to the lane's dev env file.");
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		if (!line.startsWith("DEV_QA_ACCOUNTS=")) continue;
		const map = JSON.parse(line.slice("DEV_QA_ACCOUNTS=".length).replace(/^'|'$/g, "")) as Record<string, string>;
		const p = map[uid];
		if (p) return p;
	}
	throw new Error(`no app password for ${uid} in the dev env file`);
}

/**
 * A CardDAV request as a QA person, for fixtures only (fix round 3): a card made "in another app"
 * with shapes the tools can't write (PREF, a second type, a tel: uri, very long fields). A jCard
 * body goes as application/vcard+json; the answer's status and body (a GET's jCard) come back.
 */
export async function cardDav(uid: string, method: "PUT" | "GET", book: string, card: string, jcard?: unknown): Promise<{ status: number; body: string }> {
	const url = `${DRIVE}/remote.php/dav/addressbooks/users/${encodeURIComponent(uid)}/${encodeURIComponent(book)}/${encodeURIComponent(card)}`;
	const headers: Record<string, string> = { authorization: `Basic ${btoa(`${uid}:${appPassword(uid)}`)}`, accept: "application/vcard+json" };
	if (jcard !== undefined) {
		headers["content-type"] = "application/vcard+json; charset=utf-8";
		headers["if-none-match"] = "*";
	}
	const res = await fetch(url, { method, headers, body: jcard === undefined ? undefined : JSON.stringify(jcard) });
	return { status: res.status, body: await res.text() };
}

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * The size in bytes of the REPORT contacts_search sends, run straight as a QA person on the first
 * of their address books whose name starts with `bookPrefix` (read-only; only the size is kept).
 * It measures what the tool's per-book read cap (1 MiB) is set against.
 */
export async function reportSize(uid: string, bookPrefix: string, query: string): Promise<{ book: string; bytes: number }> {
	const home = `${DRIVE}/remote.php/dav/addressbooks/users/${encodeURIComponent(uid)}/`;
	const auth = `Basic ${btoa(`${uid}:${appPassword(uid)}`)}`;
	const pf = await fetch(home, {
		method: "PROPFIND",
		headers: { authorization: auth, depth: "1", "content-type": "application/xml; charset=utf-8" },
		body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
	});
	const listing = await pf.text();
	const prefix = `/remote.php/dav/addressbooks/users/${encodeURIComponent(uid)}/`;
	const books = [...listing.matchAll(/<d:href>([^<]+)<\/d:href>/g)]
		.map((m) => m[1] as string)
		.filter((h) => h.startsWith(prefix) && h.length > prefix.length)
		.map((h) => decodeURIComponent(h.slice(prefix.length).replace(/\/$/, "")));
	const book = books.find((b) => b.startsWith(bookPrefix));
	if (!book) throw new Error(`${uid} has no address book starting with ${bookPrefix}`);
	const q = xmlEsc(query);
	const match = (name: string) => `<card:prop-filter name="${name}"><card:text-match collation="i;unicode-casemap" match-type="contains">${q}</card:text-match></card:prop-filter>`;
	const body = `<?xml version="1.0" encoding="UTF-8"?><card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data content-type="application/vcard+json" version="4.0"><card:prop name="UID"/><card:prop name="FN"/><card:prop name="N"/><card:prop name="EMAIL"/><card:prop name="TEL"/><card:prop name="ORG"/></card:address-data></d:prop><card:filter test="anyof">${["FN", "N", "EMAIL", "TEL", "ORG"].map(match).join("")}</card:filter><card:limit><card:nresults>25</card:nresults></card:limit></card:addressbook-query>`;
	const res = await fetch(`${home}${encodeURIComponent(book)}/`, {
		method: "REPORT",
		headers: { authorization: auth, depth: "1", "content-type": "application/xml; charset=utf-8" },
		body,
	});
	if (res.status !== 207) throw new Error(`REPORT on ${book} answered ${res.status}`);
	return { book, bytes: (await res.arrayBuffer()).byteLength };
}

/** A WebDAV request as a QA person, for fixtures only. */
export async function dav(uid: string, method: string, path: string, body?: string): Promise<number> {
	const url = `${DRIVE}/remote.php/dav/files/${encodeURIComponent(uid)}${path
		.split("/")
		.map((s) => encodeURIComponent(s))
		.join("/")}`;
	const res = await fetch(url, {
		method,
		headers: { authorization: `Basic ${btoa(`${uid}:${appPassword(uid)}`)}`, "content-type": "text/plain; charset=utf-8" },
		body,
	});
	await res.arrayBuffer();
	return res.status;
}
