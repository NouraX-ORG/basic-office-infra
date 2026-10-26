/**
 * Lane D's live helpers (DESIGN 17.6). They talk to a running `wrangler dev --env dev` at
 * NX_LIVE_BASE (default core's http://localhost:8787; lane D's own runs use :8830) and act as the
 * lane's QA accounts through /dev/token. Only test setup and clean-up use NoDrive directly, with the
 * QA app passwords from the dev env file (NX_DEV_ENV_FILE, in the scratchpad, never in the repo):
 * they make this run's own QA calendars and remove them, and nothing else (the rule-3 exception).
 */
import { readFileSync } from "node:fs";
import { BASE, brandScan, RUN } from "../_shared/client";

export const LIVE_BASE = process.env.NX_LIVE_BASE ?? BASE;
/**
 * The lane's QA people (brief section 4 names: qa-t<task>-<n>). With privacy between organisations
 * on they must share a group to find and invite each other.
 * - Brief section 7 asks for an org: or team: group, which only the admin API can fill, and it
 *   refuses local password accounts (uid_not_oidc). qa-setup.sh (next to this file, run under the
 *   deploy lock) therefore makes three API people in organisation qa-t1-d-calendar-tasks:
 *   qa-t1-261 organises, qa-t1-262 and qa-t1-263 are invited. Set NX_LIVE_D_UID=qa-t1-261,
 *   NX_LIVE_D_UID2=qa-t1-262 and NX_LIVE_D_UID3=qa-t1-263 once it has run (review fix round 2).
 * - Until then the defaults are DESIGN 16.3's local accounts qa-t1-26 (organises) and qa-t1-24,
 *   who share the plain QA group qa-t1-26-24 (review fix round 1), and there is no third person.
 * qa-t1-30, the design's isolation target, shares no group with any of them, so it stands for
 * someone outside the organisation.
 */
export const ORGANIZER = process.env.NX_LIVE_D_UID ?? "qa-t1-26";
export const ATTENDEE = process.env.NX_LIVE_D_UID2 ?? "qa-t1-24";
export const THIRD: string | null = process.env.NX_LIVE_D_UID3 ?? null;
export const OUTSIDER = process.env.NX_LIVE_D_OUTSIDER ?? "qa-t1-30";
export const DRIVE = "https://drive.nourax.org";
export const ALL = ["workspace.read", "workspace.write", "workspace.remove", "workspace.share"];
/** This run's id for collection names: core's minute stamp plus a random part (a removed calendar keeps its name while in the trash). */
export const RUN_ID = `${RUN}${Math.random().toString(36).slice(2, 6)}`;

export async function token(uid: string, scopes: string[] = ALL): Promise<string> {
	const res = await fetch(`${LIVE_BASE}/dev/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid, scopes }) });
	if (!res.ok) throw new Error(`dev token for ${uid}: ${res.status}`);
	return ((await res.json()) as { access_token: string }).access_token;
}

export interface Result {
	content: { text: string }[];
	structuredContent: Record<string, unknown>;
	isError?: boolean;
	_meta?: Record<string, { code?: string }>;
}

/** One tools/call; every output is brand-scanned (brief rule 6). */
export async function tool(tok: string, name: string, args: Record<string, unknown> = {}): Promise<Result> {
	const res = await fetch(`${LIVE_BASE}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
	});
	const raw = await res.text();
	brandScan(name, raw);
	let json: Record<string, unknown> = {};
	if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
		for (const line of raw.split(/\r?\n/)) if (line.startsWith("data:")) json = JSON.parse(line.slice(5)) as Record<string, unknown>;
	} else json = JSON.parse(raw) as Record<string, unknown>;
	if (!json.result) throw new Error(`${name}: HTTP ${res.status} ${raw.slice(0, 300)}`);
	return json.result as Result;
}

export async function toolNames(tok: string): Promise<string[]> {
	const res = await fetch(`${LIVE_BASE}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${tok}` },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
	});
	const raw = await res.text();
	brandScan("tools/list", raw);
	let json = "";
	if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
		for (const line of raw.split(/\r?\n/)) if (line.startsWith("data:")) json = line.slice(5);
	} else json = raw;
	return ((JSON.parse(json) as { result: { tools: { name: string }[] } }).result.tools ?? []).map((t) => t.name);
}

export function code(r: Result): string | undefined {
	return r._meta?.["nourax/error"]?.code;
}

function appPassword(uid: string): string {
	const file = process.env.NX_DEV_ENV_FILE;
	if (!file) throw new Error("Set NX_DEV_ENV_FILE to the dev env file in the scratchpad.");
	const line = readFileSync(file, "utf8")
		.split(/\r?\n/)
		.find((l) => l.startsWith("DEV_QA_ACCOUNTS="));
	const map = JSON.parse(line ? line.slice("DEV_QA_ACCOUNTS=".length) : "{}") as Record<string, string>;
	const pass = map[uid];
	if (!pass) throw new Error(`${uid} is not in DEV_QA_ACCOUNTS`);
	return pass;
}

/** Direct NoDrive DAV, for setup and clean-up of this run's own QA objects only. */
export async function dav(uid: string, method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<number> {
	const auth = `Basic ${btoa(`${uid}:${appPassword(uid)}`)}`;
	const res = await fetch(`${DRIVE}${path}`, { method, headers: { authorization: auth, "content-type": "application/xml; charset=utf-8", ...headers }, body, redirect: "manual" });
	await res.arrayBuffer();
	return res.status;
}

/** Direct NoDrive DAV GET of one of this run's own objects, as text (setup and checks only). */
export async function davText(uid: string, path: string): Promise<{ status: number; text: string }> {
	const auth = `Basic ${btoa(`${uid}:${appPassword(uid)}`)}`;
	const res = await fetch(`${DRIVE}${path}`, { headers: { authorization: auth }, redirect: "manual" });
	return { status: res.status, text: await res.text() };
}

export function calPath(uid: string, cal: string): string {
	return `/remote.php/dav/calendars/${encodeURIComponent(uid)}/${cal}/`;
}

/**
 * The lane's fixed QA collections. They are made once (extended MKCOL) and kept: NoCalendar allows
 * only 10 new calendars an hour per account, so a collection per run would soon be refused (429,
 * seen live). Each run cleans up only its own items, found by RUN_ID in their titles.
 */
export const QA_CAL = process.env.NX_LIVE_D_CAL ?? "mcp-qa-d";
export const QA_CAL2 = process.env.NX_LIVE_D_CAL2 ?? "mcp-qa-d2";
export const QA_TASKS = process.env.NX_LIVE_D_TASKS ?? "mcp-qa-dt";

/** Shares one of `owner`'s calendars with `sharee`, read-only (true) or takes the share away (false). Test setup only. */
export async function shareCalendar(owner: string, cal: string, sharee: string, on: boolean): Promise<number> {
	const who = `<d:href>principal:principals/users/${sharee}</d:href>`;
	const body = `<?xml version="1.0" encoding="utf-8"?><o:share xmlns:d="DAV:" xmlns:o="http://owncloud.org/ns">${on ? `<o:set>${who}</o:set>` : `<o:remove>${who}</o:remove>`}</o:share>`;
	return dav(owner, "POST", calPath(owner, cal), body);
}

/** Makes a QA collection unless it is there already. */
export async function ensureCollection(uid: string, cal: string, name: string, comps: ("VEVENT" | "VTODO")[]): Promise<void> {
	const body = `<?xml version="1.0" encoding="utf-8"?><d:mkcol xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>${name}</d:displayname><cal:supported-calendar-component-set>${comps.map((c) => `<cal:comp name="${c}"/>`).join("")}</cal:supported-calendar-component-set></d:prop></d:set></d:mkcol>`;
	const st = await dav(uid, "MKCOL", calPath(uid, cal), body);
	if (st === 429) throw new Error(`MKCOL ${cal}: NoCalendar's limit of new calendars an hour was reached; try again later.`);
	if (st !== 201 && st !== 405) throw new Error(`MKCOL ${cal}: ${st}`);
}
