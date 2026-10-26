/**
 * The NoDrive client bound to one person (DESIGN 8.3 and 18.3). Every call:
 * - goes through the egress allowlist with Basic uid:app-password (the uid always comes from the
 *   vault, never from tool input);
 * - sends OCS-APIRequest and format=json on OCS and Deck;
 * - never follows redirects, never sends cookies;
 * - times out after 20 s (40 s for conversions) and retries once after 1 s on 502/503/504 for
 *   GET, PROPFIND, REPORT and SEARCH (never for a conversion: one costs up to 40 s);
 * - runs at most 4 at a time per tool call;
 * - stops when the tool's 60 s budget is over: the handler's signal aborts the call in flight and
 *   every call after it, so a timed-out tool sends nothing more (fix round 3).
 * On a 401 it makes exactly one probe (GET cloud/user). If that also fails, the credential is dead:
 * the error carries deadCredential, isDead() turns true, and the handler ends the connection even
 * when a caller swallowed the error (the 401 circuit breaker, 8.5).
 */
import type { NxConfig, NxEnv } from "../env";
import { b64, utf8 } from "../core/bytes";
import { egress, readCapped, readCappedJson, readCappedText } from "../core/egress";
import { ToolError } from "../core/errors";
import { LIMITS } from "../core/limits";
import type { XmlFragment } from "../core/xml";
import { mapStatus } from "./errors";
import { type DavResponse, parseMultistatus } from "./multistatus";

export interface NcCredential {
	loginName: string;
	appPassword: string;
}

export interface NcStats {
	calls: number;
	lastStatus?: number;
	/** Requests sent with a method that can change something (not GET, HEAD, PROPFIND, REPORT, SEARCH). */
	writes?: number;
	/**
	 * Such requests whose outcome NoDrive didn't state: the fetch failed or was cancelled, or the
	 * answer was a 5xx. A 2xx or 4xx is an answer about that request.
	 */
	uncertainWrites?: number;
	/** Such requests sent and not answered yet. */
	writesInFlight?: number;
}

export interface NcOptions {
	env: NxEnv;
	cfg: NxConfig;
	uid: string;
	cred: NcCredential;
	rid?: string;
	clientIp?: string;
	signal?: AbortSignal;
	stats?: NcStats;
	/** One conversion at a time and 20 an hour per person (vault lease). */
	convertSlot?: () => Promise<{ release(): Promise<void> }>;
}

export interface RequestOptions {
	headers?: Record<string, string>;
	body?: BodyInit | null;
	timeoutMs?: number;
	/** Statuses the caller handles itself (no error is thrown for them). */
	allow?: readonly number[];
	/** For messages: a path or name from the tool's input. */
	what?: string;
	precondition?: "if-match" | "if-none-match";
	/** Never retried on 502/503/504, even for GET (a conversion: one can take 40 s). */
	noRetry?: boolean;
}

export interface CloudUser {
	id: string;
	displayName: string | null;
	email: string | null;
	language: string | null;
	locale: string | null;
	timezone: string | null;
	/**
	 * The account's groups, or null when NoDrive didn't send a list of strings. NC 35.0.2 always sends
	 * one (AUserDataOCSController); null makes the admin refusal fail closed (auth/connect.ts).
	 */
	groups: string[] | null;
	quota: { used: number; free: number | null; total: number | null; relative: number | null; quota: number | null };
}

export interface NcClient {
	readonly uid: string;
	readonly origin: string;
	readonly stats: NcStats;
	/** Low level: any allowlisted path on the drive host ("/ocs/...", "/remote.php/dav/..."). */
	request(method: string, pathAndQuery: string, opts?: RequestOptions): Promise<Response>;
	dav: {
		propfind(davPath: string, depth: 0 | 1, body: XmlFragment | string, opts?: RequestOptions): Promise<DavResponse[]>;
		report(davPath: string, body: XmlFragment | string, opts?: RequestOptions & { depth?: 0 | 1 }): Promise<DavResponse[]>;
		search(body: XmlFragment | string, opts?: RequestOptions): Promise<DavResponse[]>;
		proppatch(davPath: string, body: XmlFragment | string, opts?: RequestOptions): Promise<DavResponse[]>;
		get(davPath: string, opts?: RequestOptions): Promise<Response>;
		put(davPath: string, body: BodyInit, opts?: RequestOptions): Promise<Response>;
		move(fromDavPath: string, toDavPath: string, opts?: RequestOptions & { overwrite?: boolean }): Promise<Response>;
		copy(fromDavPath: string, toDavPath: string, opts?: RequestOptions & { overwrite?: boolean }): Promise<Response>;
		mkcol(davPath: string, body?: XmlFragment | string, opts?: RequestOptions): Promise<Response>;
		mkcalendar(davPath: string, body: XmlFragment | string, opts?: RequestOptions): Promise<Response>;
		delete(davPath: string, opts?: RequestOptions): Promise<Response>;
	};
	ocs: {
		get<T = unknown>(path: string, query?: Record<string, string | string[] | number | boolean>, opts?: RequestOptions): Promise<T>;
		post<T = unknown>(path: string, body?: Record<string, unknown>, opts?: RequestOptions): Promise<T>;
		put<T = unknown>(path: string, body?: Record<string, unknown>, opts?: RequestOptions): Promise<T>;
		delete<T = unknown>(path: string, query?: Record<string, string>, opts?: RequestOptions): Promise<T>;
	};
	deck: {
		/** REST under /index.php/apps/deck/api/v1.0 (path starts with "/boards"). */
		rest<T = unknown>(method: "GET" | "POST" | "PUT", path: string, body?: Record<string, unknown>, opts?: RequestOptions): Promise<T>;
		/** OCS under /ocs/v2.php/apps/deck/api/v1.0 (path starts with "/cards/{id}/"). */
		ocs<T = unknown>(method: "GET" | "POST" | "PUT", path: string, body?: Record<string, unknown>, opts?: RequestOptions): Promise<T>;
	};
	/**
	 * GET /ocs/v2.php/cloud/user, once per client. `opts` (a shorter timeout, no retry) apply to the
	 * request this call starts; a failed one is forgotten, so the next call asks again.
	 */
	cloudUser(opts?: RequestOptions): Promise<CloudUser>;
	/** Raw bytes of a response, capped. */
	readBytes(res: Response, maxBytes: number): Promise<Uint8Array>;
	readText(res: Response, maxBytes?: number): Promise<string>;
	/** The conversion slot hook (used by officeConvert). */
	readonly convertSlot?: NcOptions["convertSlot"];
	/** True once the 401 probe failed: the credential is dead (8.5), whoever caught the error. */
	isDead(): boolean;
}

const RETRYABLE_METHODS = new Set(["GET", "PROPFIND", "REPORT", "SEARCH"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "PROPFIND", "REPORT", "SEARCH", "OPTIONS"]);

/**
 * At most `max` calls run at once (DESIGN 29.8). A finished call hands its slot straight to the next
 * waiter, so `active` never drops in between: had it dropped, a new caller arriving before the woken
 * waiter ran could take the slot too, and max + 1 calls would run. Exported for its test.
 */
export class Semaphore {
	private active = 0;
	private queue: (() => void)[] = [];
	constructor(private readonly max: number) {}
	/** How many calls hold a slot now (tests). */
	get running(): number {
		return this.active;
	}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active < this.max) this.active++;
		// Woken by a finished call, which passed its slot on without giving it back.
		else await new Promise<void>((r) => this.queue.push(r));
		try {
			return await fn();
		} finally {
			const next = this.queue.shift();
			if (next) next();
			else this.active--;
		}
	}
}

function encodeQuery(query: Record<string, string | string[] | number | boolean> | undefined): string {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(query ?? {})) {
		if (Array.isArray(v)) for (const x of v) q.append(k, x);
		else q.append(k, String(v));
	}
	if (!q.has("format")) q.set("format", "json");
	return q.toString();
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export function createNcClient(o: NcOptions): NcClient {
	const origin = o.cfg.driveOrigin;
	const stats: NcStats = o.stats ?? { calls: 0 };
	const sem = new Semaphore(LIMITS.ncConcurrency);
	const basic = `Basic ${b64(utf8(`${o.cred.loginName}:${o.cred.appPassword}`))}`;
	let probe: Promise<boolean> | null = null;
	let dead = false;
	let me: Promise<CloudUser> | null = null;

	/** The tool's budget is over (the handler's signal): nothing more is sent. */
	function stopIfAborted(): void {
		if (o.signal?.aborted) throw new ToolError("timeout");
	}

	async function send(method: string, pathAndQuery: string, opts: RequestOptions): Promise<Response> {
		if (dead) throw new ToolError("reconnect_required", undefined, { deadCredential: true });
		const headers: Record<string, string> = { authorization: basic, ...(opts.headers ?? {}) };
		const url = `${origin}${pathAndQuery}`;
		let attempt = 0;
		const writing = !SAFE_METHODS.has(method);
		for (;;) {
			stopIfAborted();
			stats.calls++;
			if (writing) {
				stats.writes = (stats.writes ?? 0) + 1;
				stats.writesInFlight = (stats.writesInFlight ?? 0) + 1;
			}
			let res: Response;
			try {
				res = await sem.run(() =>
					egress(
						{ env: o.env, uid: o.uid, rid: o.rid, clientIp: o.clientIp, signal: o.signal },
						url,
						{ method, headers, body: opts.body ?? null, timeoutMs: opts.timeoutMs },
					),
				);
			} catch (e) {
				if (writing) stats.uncertainWrites = (stats.uncertainWrites ?? 0) + 1;
				throw e;
			} finally {
				if (writing) stats.writesInFlight = Math.max(0, (stats.writesInFlight ?? 1) - 1);
			}
			if (writing && res.status >= 500) stats.uncertainWrites = (stats.uncertainWrites ?? 0) + 1;
			stats.lastStatus = res.status;
			if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt === 0 && RETRYABLE_METHODS.has(method) && !opts.noRetry) {
				attempt++;
				await res.body?.cancel();
				await sleep(1000);
				continue;
			}
			return res;
		}
	}

	async function checkProbe(): Promise<boolean> {
		if (!probe) {
			probe = (async () => {
				const res = await send("GET", "/ocs/v2.php/cloud/user?format=json", { headers: { "ocs-apirequest": "true", accept: "application/json" } });
				await res.body?.cancel();
				return res.status !== 401;
			})();
		}
		return probe;
	}

	async function request(method: string, pathAndQuery: string, opts: RequestOptions = {}): Promise<Response> {
		const res = await send(method, pathAndQuery, opts);
		if (opts.allow?.includes(res.status)) return res;
		if (res.status === 401) {
			await res.body?.cancel();
			const alive = await checkProbe();
			if (!alive) {
				dead = true;
				throw new ToolError("reconnect_required", "This assistant's access to NoDrive has ended. Reconnect it.", {
					deadCredential: true,
					upstreamStatus: 401,
				});
			}
			throw new ToolError("permission_denied", opts.what ? `The person isn't allowed to do that with ${opts.what}.` : undefined, { upstreamStatus: 401 });
		}
		if (res.status >= 300) {
			let detail: string | undefined;
			try {
				detail = (await readCappedText(res, 64 * 1024)).slice(0, 2000);
			} catch {
				detail = undefined;
			}
			const err = mapStatus(res.status, { method, what: opts.what, precondition: opts.precondition, retryAfter: res.headers.get("retry-after") });
			if (detail === undefined) throw err;
			throw new ToolError(err.code, err.message, {
				hint: err.hint,
				retryAfterSec: err.retryAfterSec,
				upstreamStatus: res.status,
				detail,
			});
		}
		return res;
	}

	const xmlHeaders = (extra?: Record<string, string>): Record<string, string> => ({ "content-type": "application/xml; charset=utf-8", ...(extra ?? {}) });
	const bodyOf = (b: XmlFragment | string) => (typeof b === "string" ? b : b.xml);

	async function multistatus(method: string, davPath: string, body: XmlFragment | string, opts: RequestOptions, depth?: 0 | 1): Promise<DavResponse[]> {
		const headers = xmlHeaders(opts.headers);
		if (depth !== undefined) headers.depth = String(depth);
		const res = await request(method, davPath, { ...opts, headers, body: bodyOf(body) });
		if (res.status === 204) return [];
		return parseMultistatus(await readCappedText(res, LIMITS.davXmlBytes));
	}

	async function ocsCall<T>(method: string, path: string, query: Record<string, string | string[] | number | boolean> | undefined, body: Record<string, unknown> | undefined, opts: RequestOptions): Promise<T> {
		const qs = encodeQuery(query);
		const headers: Record<string, string> = { "ocs-apirequest": "true", accept: "application/json", ...(opts.headers ?? {}) };
		let payload: string | undefined;
		if (body !== undefined) {
			headers["content-type"] = "application/json";
			payload = JSON.stringify(body);
		}
		const res = await request(method, `${path}?${qs}`, { ...opts, headers, body: payload });
		const json = await readCappedJson<{ ocs?: { meta?: { statuscode?: number; message?: string }; data?: unknown } }>(res);
		if (!json || typeof json !== "object" || !json.ocs) throw new ToolError("upstream_unavailable", "NoDrive's answer couldn't be read.");
		return json.ocs.data as T;
	}

	async function deckRest<T>(method: string, path: string, body: Record<string, unknown> | undefined, opts: RequestOptions): Promise<T> {
		const headers: Record<string, string> = { "ocs-apirequest": "true", accept: "application/json", ...(opts.headers ?? {}) };
		let payload: string | undefined;
		if (body !== undefined) {
			headers["content-type"] = "application/json";
			payload = JSON.stringify(body);
		}
		const res = await request(method, `/index.php/apps/deck/api/v1.0${path}`, { ...opts, headers, body: payload });
		return readCappedJson<T>(res);
	}

	const client: NcClient = {
		uid: o.uid,
		origin,
		stats,
		convertSlot: o.convertSlot,
		request,
		dav: {
			propfind: (p, depth, body, opts = {}) => multistatus("PROPFIND", p, body, opts, depth),
			report: (p, body, opts = {}) => multistatus("REPORT", p, body, opts, opts.depth),
			search: (body, opts = {}) => multistatus("SEARCH", "/remote.php/dav/", body, opts),
			proppatch: (p, body, opts = {}) => multistatus("PROPPATCH", p, body, opts),
			get: (p, opts = {}) => request("GET", p, opts),
			put: (p, body, opts = {}) => request("PUT", p, { ...opts, body }),
			move: (from, to, opts = {}) =>
				request("MOVE", from, { ...opts, headers: { destination: `${origin}${to}`, overwrite: opts.overwrite ? "T" : "F", ...(opts.headers ?? {}) } }),
			copy: (from, to, opts = {}) =>
				request("COPY", from, { ...opts, headers: { destination: `${origin}${to}`, overwrite: opts.overwrite ? "T" : "F", ...(opts.headers ?? {}) } }),
			mkcol: (p, body, opts = {}) =>
				request("MKCOL", p, body === undefined ? opts : { ...opts, headers: xmlHeaders(opts.headers), body: bodyOf(body) }),
			mkcalendar: (p, body, opts = {}) => request("MKCALENDAR", p, { ...opts, headers: xmlHeaders(opts.headers), body: bodyOf(body) }),
			delete: (p, opts = {}) => request("DELETE", p, opts),
		},
		ocs: {
			get: (path, query, opts = {}) => ocsCall("GET", path, query, undefined, opts),
			post: (path, body, opts = {}) => ocsCall("POST", path, undefined, body ?? {}, opts),
			put: (path, body, opts = {}) => ocsCall("PUT", path, undefined, body ?? {}, opts),
			delete: (path, query, opts = {}) => ocsCall("DELETE", path, query, undefined, opts),
		},
		deck: {
			rest: (method, path, body, opts = {}) => deckRest(method, path, body, opts),
			ocs: (method, path, body, opts = {}) =>
				ocsCall(method, `/ocs/v2.php/apps/deck/api/v1.0${path}`, undefined, method === "GET" ? undefined : (body ?? {}), opts),
		},
		cloudUser(opts = {}) {
			if (!me) {
				me = (async () => {
					const d = await ocsCall<Record<string, unknown>>("GET", "/ocs/v2.php/cloud/user", undefined, undefined, opts);
					return parseCloudUser(d);
				})();
				me.catch(() => {
					me = null;
				});
			}
			return me;
		},
		readBytes: (res, maxBytes) => readCapped(res, maxBytes),
		readText: (res, maxBytes = LIMITS.davXmlBytes) => readCappedText(res, maxBytes),
		isDead: () => dead,
	};
	return client;
}

function num(v: unknown): number | null {
	const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
	return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

export function parseCloudUser(d: Record<string, unknown>): CloudUser {
	const q = (d.quota ?? {}) as Record<string, unknown>;
	const quotaRaw = num(q.quota);
	const unlimited = quotaRaw !== null && quotaRaw < 0;
	const free = num(q.free);
	return {
		id: String(d.id ?? ""),
		displayName: str(d.displayname) ?? str(d["display-name"]),
		email: str(d.email),
		language: str(d.language),
		locale: str(d.locale),
		timezone: str(d.timezone),
		// Never [] for a missing or odd shape: that would read as "not an admin".
		groups: Array.isArray(d.groups) && d.groups.every((g) => typeof g === "string") ? [...(d.groups as string[])] : null,
		quota: {
			used: num(q.used) ?? 0,
			free: unlimited || free === null || free < 0 ? null : free,
			total: unlimited ? null : num(q.total),
			relative: unlimited ? null : num(q.relative),
			quota: quotaRaw,
		},
	};
}
