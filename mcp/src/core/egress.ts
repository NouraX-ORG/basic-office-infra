/**
 * The egress allowlist (DESIGN 8.4). This is the only module that may call fetch; a test greps
 * src/ for any other call. Anything not listed throws EgressDenied, which is always a bug.
 *
 * Because global_fetch_strictly_public is off, calls to drive.nourax.org reach the origin directly
 * and skip the WAF. This table, the admin refusal and the UUID rule are what keep the Worker away
 * from the locked paths (/login, /settings, /ocs/.../cloud/users and groups, any ONLYOFFICE host).
 */
import { config, type NxConfig, type NxEnv } from "../env";
import { USER_AGENT } from "../version";
import { ToolError } from "./errors";
import { LIMITS } from "./limits";
import { parseXml, type XmlEl } from "./xml";

export class EgressDenied extends Error {
	constructor(readonly reason: string) {
		super(`egress denied: ${reason}`);
		this.name = "EgressDenied";
	}
}

export interface EgressCtx {
	env: NxEnv;
	/** The person whose credential is in use. `{uid}` path segments must equal it. */
	uid?: string;
	rid?: string;
	/** The MCP client's CF-Connecting-IP. Sent as x-real-ip, never invented. */
	clientIp?: string;
	signal?: AbortSignal;
}

export interface EgressInit {
	method: string;
	headers?: Record<string, string>;
	body?: BodyInit | null;
	timeoutMs?: number;
}

type Host = "drive" | "supabase" | "nomail";

interface Rule {
	id: string;
	host: Host;
	methods: readonly string[];
	/** Tested against the URL's pathname (as sent). `{uid}` is the encoded, regex-escaped uid. */
	path: string;
	/** Query strings allowed on this rule. */
	query?: boolean;
	/** Credentials (Authorization) must not be sent on this rule. */
	noCredentials?: boolean;
	/** For MOVE and COPY: allowed Destination pathnames. */
	destination?: string;
	/** Extra check of the request body (SEARCH scope). */
	searchScope?: boolean;
	/** MKCOL must make a plain calendar (RFC 5689 body): never a subscription to an outside address. */
	mkcolCalendar?: boolean;
	/** Methods that are allowed only on a narrower path. */
	narrow?: Record<string, string>;
}

const DAV = "/remote\\.php/dav";

/** The table from DESIGN 8.4. Order matters only for readability. */
export const RULES: readonly Rule[] = [
	{
		id: "dav-files",
		host: "drive",
		methods: ["PROPFIND", "GET", "PUT", "MKCOL", "MOVE", "COPY", "PROPPATCH", "REPORT", "DELETE"],
		path: `^${DAV}/files/{uid}(?:/.*)?$`,
		destination: `^${DAV}/files/{uid}/.+$`,
	},
	{
		id: "dav-trash",
		host: "drive",
		methods: ["PROPFIND", "MOVE"],
		path: `^${DAV}/trashbin/{uid}/trash(?:/.*)?$`,
		destination: `^${DAV}/trashbin/{uid}/restore/[^/]+$`,
	},
	{
		id: "dav-versions",
		host: "drive",
		methods: ["PROPFIND", "MOVE", "PROPPATCH"],
		path: `^${DAV}/versions/{uid}/versions/\\d+(?:/[^/]+)?/?$`,
		destination: `^${DAV}/versions/{uid}/restore/target$`,
	},
	{ id: "dav-search", host: "drive", methods: ["SEARCH"], path: `^${DAV}/?$`, searchScope: true },
	{
		id: "dav-calendars",
		host: "drive",
		// MKCOL (an extended MKCOL, RFC 5689) makes a task list; workerd's fetch refuses the MKCALENDAR
		// method itself ("Invalid HTTP method string", DESIGN 27.8), so that row was dropped in fix
		// round 3 and MKCOL added, for tasks_create (src/tools/tasks/new-list.ts).
		methods: ["PROPFIND", "REPORT", "GET", "PUT", "MKCOL", "MOVE", "DELETE"],
		path: `^${DAV}/calendars/{uid}(?:/.*)?$`,
		destination: `^${DAV}/calendars/{uid}/(?!trashbin/)[^/]+/[^/]+\\.ics$`,
		// One event object only; never a whole calendar and never the calendar trash. MKCOL only one
		// level below the home, never the trash, inbox or outbox, and only a plain calendar.
		narrow: {
			DELETE: `^${DAV}/calendars/{uid}/(?!trashbin/)[^/]+/[^/]+\\.ics$`,
			MOVE: `^${DAV}/calendars/{uid}/(?!trashbin/)[^/]+/[^/]+\\.ics$`,
			PUT: `^${DAV}/calendars/{uid}/(?!trashbin/)[^/]+/[^/]+$`,
			MKCOL: `^${DAV}/calendars/{uid}/(?!(?:trashbin|inbox|outbox)/?$)[^/]+/?$`,
		},
		mkcolCalendar: true,
	},
	{
		id: "dav-addressbooks",
		host: "drive",
		methods: ["PROPFIND", "REPORT", "GET", "PUT", "MKCOL"],
		path: `^${DAV}/addressbooks/users/{uid}(?:/.*)?$`,
	},
	{ id: "dav-principal", host: "drive", methods: ["PROPFIND"], path: `^${DAV}/principals/users/{uid}/?$` },
	{
		id: "ocs-shares",
		host: "drive",
		methods: ["GET", "POST", "PUT", "DELETE"],
		path: "^/ocs/v2\\.php/apps/files_sharing/api/v1/shares(?:/\\d+)?$",
		query: true,
	},
	{ id: "ocs-sharees", host: "drive", methods: ["GET"], path: "^/ocs/v2\\.php/apps/files_sharing/api/v1/sharees$", query: true },
	{
		id: "ocs-search",
		host: "drive",
		methods: ["GET"],
		path: "^/ocs/v2\\.php/search/providers(?:/[A-Za-z0-9_.-]{1,64}/search)?$",
		query: true,
	},
	{
		id: "ocs-cloud",
		host: "drive",
		methods: ["GET"],
		path: "^/ocs/v2\\.php/(?:cloud/user|cloud/capabilities|core/navigation/apps)$",
		query: true,
	},
	{ id: "ocs-apppassword", host: "drive", methods: ["DELETE"], path: "^/ocs/v2\\.php/core/apppassword$", query: true },
	{
		// Only the routes the boards tools (and lane G's board check) build: list and read boards,
		// stacks and cards; create a card; update, assign and unassign a card. Never board create,
		// rename, archive or delete, labels, or the board sharing list (acl), which would let
		// workspace.write share a board without workspace.share (lane E fix round 1).
		id: "deck-rest",
		host: "drive",
		methods: ["GET", "POST", "PUT"],
		path: "^/index\\.php/apps/deck/api/v1\\.0/boards(?:/\\d{1,12}(?:/stacks(?:/archived|/\\d{1,12}/cards(?:/\\d{1,12}(?:/(?:assignUser|unassignUser))?)?)?)?)?$",
		narrow: {
			GET: "^/index\\.php/apps/deck/api/v1\\.0/boards(?:/\\d{1,12}(?:/stacks(?:/archived|/\\d{1,12}/cards/\\d{1,12})?)?)?$",
			POST: "^/index\\.php/apps/deck/api/v1\\.0/boards/\\d{1,12}/stacks/\\d{1,12}/cards$",
			PUT: "^/index\\.php/apps/deck/api/v1\\.0/boards/\\d{1,12}/stacks/\\d{1,12}/cards/\\d{1,12}(?:/(?:assignUser|unassignUser))?$",
		},
	},
	{
		id: "deck-ocs",
		host: "drive",
		methods: ["GET", "POST", "PUT"],
		path: "^/ocs/v2\\.php/apps/deck/api/v1\\.0/cards/\\d+/(?:comments|reorder)$",
		query: true,
	},
	// Lane G (NoGantt, nc_gantt 2.4.1, DESIGN 25.4): its OCS API as the person. Never a project or
	// task DELETE (25.6), the calendar-feed (.ics) token routes, the admin routes (holidays, work
	// schedules, work calendars, settings), Talk, knowledge, attachments, resources or baselines.
	{
		id: "gantt-read",
		host: "drive",
		methods: ["GET"],
		path: "^/ocs/v2\\.php/apps/nc_gantt/api/v1/(?:projects(?:/\\d{1,12}(?:/(?:tasks|subprojects|milestones|shares|critical-path|rollup|report/delta))?)?|my-tasks)$",
		query: true,
	},
	{
		id: "gantt-create",
		host: "drive",
		methods: ["POST"],
		path: "^/ocs/v2\\.php/apps/nc_gantt/api/v1/(?:projects(?:/\\d{1,12}/(?:tasks|milestones|dependencies|shares))?|tasks/\\d{1,12}/(?:deck-links|deck-cards)|structure-import|changes/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/revert)$",
		query: true,
	},
	{ id: "gantt-update", host: "drive", methods: ["PUT"], path: "^/ocs/v2\\.php/apps/nc_gantt/api/v1/(?:projects|tasks)/\\d{1,12}$", query: true },
	{ id: "gantt-delete", host: "drive", methods: ["DELETE"], path: "^/ocs/v2\\.php/apps/nc_gantt/api/v1/shares/\\d{1,12}$", query: true },
	{ id: "files-recent", host: "drive", methods: ["GET"], path: "^/index\\.php/apps/files/api/v1/recent/?$", query: true },
	{ id: "office-downloadas", host: "drive", methods: ["GET"], path: "^/index\\.php/apps/onlyoffice/downloadas$", query: true },
	{
		id: "login-flow",
		host: "drive",
		methods: ["POST"],
		path: "^/(?:index\\.php/)?login/v2(?:/poll)?$",
		noCredentials: true,
	},
	{ id: "status", host: "drive", methods: ["GET"], path: "^/status\\.php$", noCredentials: true },
	{ id: "supabase-token", host: "supabase", methods: ["POST"], path: "^/auth/v1/oauth/token$" },
	{ id: "supabase-jwks", host: "supabase", methods: ["GET"], path: "^/auth/v1/\\.well-known/jwks\\.json$", noCredentials: true },
	{ id: "nomail", host: "nomail", methods: ["GET", "POST"], path: "^{nomailBase}/v1/(?:tools|call)$" },
];

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const UID_RE = /^[A-Za-z0-9_.@-]{1,64}$/;

function compile(pattern: string, uid: string | undefined, nomailBase: string): RegExp | null {
	if (pattern.includes("{uid}")) {
		if (!uid || !UID_RE.test(uid)) return null;
		pattern = pattern.replaceAll("{uid}", escapeRe(encodeURIComponent(uid)));
	}
	pattern = pattern.replaceAll("{nomailBase}", escapeRe(nomailBase));
	return new RegExp(pattern);
}

/** Every path segment, decoded, must not be "." or ".." or hide a "/" or "\". */
function segmentsSafe(pathname: string): boolean {
	for (const raw of pathname.split("/")) {
		if (!raw) continue;
		let seg: string;
		try {
			seg = decodeURIComponent(raw);
		} catch {
			return false;
		}
		if (seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\") || seg.includes("\u0000")) return false;
	}
	return true;
}

/**
 * Which table rows may apply to this URL. A NoMail base URL may live on the Supabase host (an Edge
 * Function such as https://<project>.supabase.co/functions/v1/mcp-tools, the brief's example), so
 * that host can match both the NoMail rows and the Supabase rows; their paths never overlap.
 */
function hostKinds(cfg: NxConfig, url: URL): Host[] {
	const kinds: Host[] = [];
	if (url.host === cfg.driveHost && url.protocol === "https:") kinds.push("drive");
	if (cfg.nomailHost && url.host === cfg.nomailHost) {
		if (url.protocol === "https:") kinds.push("nomail");
		else if (cfg.env === "dev" && url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) kinds.push("nomail");
	}
	if (url.host === cfg.supabaseHost && url.protocol === "https:") kinds.push("supabase");
	return kinds;
}

function hostKind(cfg: NxConfig, url: URL): Host | null {
	return hostKinds(cfg, url)[0] ?? null;
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const lower = name.toLowerCase();
	for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
	return undefined;
}

/** Throws EgressDenied unless the request matches a rule. Exported for the allowlist tests. */
export function checkEgress(cfg: NxConfig, rawUrl: string, init: EgressInit, uid?: string): string {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new EgressDenied("bad_url");
	}
	if (url.username || url.password) throw new EgressDenied("userinfo");
	if (url.hash) throw new EgressDenied("fragment");
	const kinds = hostKinds(cfg, url);
	if (kinds.length === 0) throw new EgressDenied("host");
	if (!segmentsSafe(url.pathname)) throw new EgressDenied("segment");
	const method = init.method.toUpperCase();
	const nomailBase = cfg.nomailToolsUrl ? new URL(cfg.nomailToolsUrl).pathname.replace(/\/+$/, "") : "/__none__";
	for (const rule of RULES) {
		if (!kinds.includes(rule.host) || !rule.methods.includes(method)) continue;
		const re = compile(rule.path, uid, nomailBase);
		if (!re || !re.test(url.pathname)) continue;
		if (rule.narrow?.[method]) {
			const nre = compile(rule.narrow[method] as string, uid, nomailBase);
			if (!nre || !nre.test(url.pathname)) throw new EgressDenied(`${rule.id}:narrow`);
		}
		if (url.search && !rule.query) throw new EgressDenied(`${rule.id}:query`);
		const auth = headerValue(init.headers, "authorization");
		if (rule.noCredentials && auth) throw new EgressDenied(`${rule.id}:credentials`);
		if (headerValue(init.headers, "cookie")) throw new EgressDenied(`${rule.id}:cookie`);
		if (method === "MOVE" || method === "COPY") {
			const dest = headerValue(init.headers, "destination");
			if (!dest || !rule.destination) throw new EgressDenied(`${rule.id}:destination`);
			let d: URL;
			try {
				d = new URL(dest);
			} catch {
				throw new EgressDenied(`${rule.id}:destination`);
			}
			const dre = compile(rule.destination, uid, nomailBase);
			if (d.host !== url.host || d.protocol !== url.protocol || d.search || d.hash || !segmentsSafe(d.pathname) || !dre?.test(d.pathname)) {
				throw new EgressDenied(`${rule.id}:destination`);
			}
		}
		if (rule.searchScope) checkSearchScope(init.body, uid);
		if (rule.mkcolCalendar && method === "MKCOL") checkCalendarMkcol(init.body);
		return rule.id;
	}
	throw new EgressDenied(`no_rule:${kinds.join("+")}:${method}`);
}

/**
 * An MKCOL under the calendar home must make a plain calendar: a d:mkcol whose resourcetype is
 * exactly d:collection and cal:calendar. Sabre would also make a subscription (cs:subscribed with a
 * source address that NoDrive then fetches), so anything else is refused.
 */
function checkCalendarMkcol(body: BodyInit | null | undefined): void {
	if (typeof body !== "string") throw new EgressDenied("mkcol:body");
	let root: XmlEl;
	try {
		root = parseXml(body, { maxBytes: 16 * 1024 });
	} catch {
		throw new EgressDenied("mkcol:xml");
	}
	if (root.ns !== "DAV:" || root.local !== "mkcol") throw new EgressDenied("mkcol:root");
	const types: string[] = [];
	let source = false;
	const walk = (el: XmlEl) => {
		if (el.ns === "DAV:" && el.local === "resourcetype") for (const c of el.children) types.push(`{${c.ns}}${c.local}`);
		if (el.local === "source" || el.local === "subscribed") source = true;
		for (const c of el.children) walk(c);
	};
	walk(root);
	const want = ["{DAV:}collection", "{urn:ietf:params:xml:ns:caldav}calendar"];
	if (source || types.length !== 2 || !want.every((t) => types.includes(t))) throw new EgressDenied("mkcol:type");
}

/** A DAV SEARCH body must be scoped to /files/{uid} or below, and nothing else. */
function checkSearchScope(body: BodyInit | null | undefined, uid: string | undefined): void {
	if (typeof body !== "string" || !uid) throw new EgressDenied("search:body");
	let root: XmlEl;
	try {
		root = parseXml(body, { maxBytes: 256 * 1024 });
	} catch {
		throw new EgressDenied("search:xml");
	}
	const scopes: XmlEl[] = [];
	const walk = (el: XmlEl) => {
		if (el.ns === "DAV:" && el.local === "scope") scopes.push(el);
		for (const c of el.children) walk(c);
	};
	walk(root);
	if (scopes.length === 0) throw new EgressDenied("search:no_scope");
	const base = `/files/${encodeURIComponent(uid)}`;
	for (const scope of scopes) {
		const hrefs = scope.children.filter((c) => c.ns === "DAV:" && c.local === "href");
		if (hrefs.length !== 1) throw new EgressDenied("search:scope");
		const s = (hrefs[0] as XmlEl).text.trim();
		if (!(s === base || s.startsWith(`${base}/`)) || !segmentsSafe(s)) throw new EgressDenied("search:scope");
	}
}

/**
 * The one fetch. Applies the allowlist, the timeout, `redirect: "manual"` and `cache: "no-store"`,
 * a fixed User-Agent and x-real-ip. Cookies are never sent and Set-Cookie is ignored by callers.
 */
export async function egress(ctx: EgressCtx, url: string, init: EgressInit): Promise<Response> {
	const cfg = config(ctx.env);
	checkEgress(cfg, url, init, ctx.uid);
	const headers = new Headers(init.headers ?? {});
	if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
	if (ctx.rid) headers.set("x-request-id", ctx.rid);
	headers.delete("cookie");
	headers.delete("x-real-ip");
	const loopbackIp = ctx.clientIp === "127.0.0.1" || ctx.clientIp === "::1";
	if (ctx.clientIp && !loopbackIp && hostKind(cfg, new URL(url)) === "drive") headers.set("x-real-ip", ctx.clientIp);
	const timeout = AbortSignal.timeout(init.timeoutMs ?? LIMITS.ncTimeoutMs);
	const signal = ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout;
	return globalThis.fetch(url, {
		method: init.method.toUpperCase(),
		headers,
		body: init.body ?? null,
		redirect: "manual",
		cache: "no-store",
		signal,
	});
}

/** Reads a response body up to `maxBytes`. Larger bodies stop reading and give too_large. */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
	const declared = Number(res.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) {
		await res.body?.cancel();
		throw new ToolError("too_large", "The answer was larger than this connector reads.");
	}
	if (!res.body) return new Uint8Array(0);
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new ToolError("too_large", "The answer was larger than this connector reads.");
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.byteLength;
	}
	return out;
}

export async function readCappedText(res: Response, maxBytes: number): Promise<string> {
	return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(await readCapped(res, maxBytes));
}

export async function readCappedJson<T = unknown>(res: Response, maxBytes: number = LIMITS.jsonBytes): Promise<T> {
	const text = await readCappedText(res, maxBytes);
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new ToolError("upstream_unavailable", "The server's answer couldn't be read.");
	}
}
