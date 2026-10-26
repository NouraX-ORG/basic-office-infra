/**
 * The caller side of NoMail tool-provider contract v1 (brief section 5, DESIGN 13), lane E.
 *
 * Listing: GET {NOMAIL_TOOLS_URL}/v1/tools with the person's upstream Supabase token (never the MCP
 * token), X-Nourax-Tools-Key and X-Request-Id; 8 s; 1 MB; {"version":1,"tools":[…]}. The validated
 * list is cached per connection in the vault, encrypted, and served for min(300 s, max-age), 300 s
 * when there is no max-age. The contract's 5-minute private cache is the rule: NoMail sends
 * "Cache-Control: no-store" on every answer and counts list requests against the same 60-a-minute
 * limit as calls, so no-store and no-cache don't turn this copy off (see freshnessOf). The entry
 * itself is kept a day so a change of the tool set can be noticed and logged; it is never served
 * after its freshness ends. Three failures in a row hide mail tools for 60 s (the circuit); any
 * answer the contract names (a list, a call result, 403, 404, 413, 429) ends a run of failures. A
 * 429 on the list is NoMail asking to slow down, not a failure: mail tools are hidden for its
 * Retry-After (5 minutes at most), and calls meanwhile answer rate_limited without asking NoMail.
 * workspace_overview reads only the cached entry and never loads the list (DESIGN 13.2).
 *
 * Calls: POST {base}/v1/call {name, arguments}; 25 s; 1 MB each way. Caller rules (brief 5):
 * 1. a 403 body's code says in plain words why mail is missing; TOOLS_KEY_INVALID is logged as a
 *    setup fault;
 * 2. one upstream refresh at a time per person: the vault refreshes single-flight per connection,
 *    calls in this isolate that saw a 401 with the same token share one refresh, and a request
 *    whose 401 comes after another request already stored a new token reuses that token (the vault
 *    compares the token that got the 401 with the stored one). Only the vault saying the session is
 *    dead ends mail for the connection (reconnect_needed): a second 401 after a refresh that worked
 *    is a fault on NoMail's side, counted toward the circuit, and mail stays on (DESIGN 29.6);
 * 3. no automatic retry after a timeout or a 5xx (mail_send_draft is not idempotent); the only
 *    retry is the single one after a 401. For a tool that changes mail, any answer that may have
 *    come after the change (a timeout, a broken connection, a 5xx or other unexpected status, an
 *    unreadable or oversized 200) says the outcome is unknown and is marked not retryable;
 * 4. results are rebuilt by us, so newer MCP result fields come from our SDK, not the provider.
 * Every text block of a result is framed as data (mail is the likeliest place for a prompt
 * injection), after invisible Unicode is taken out (./invisible.ts: tag characters, bidi controls,
 * zero-width marks; DESIGN 26.5). The provider's structuredContent is never passed on: no
 * outputSchema is published for mail tools, and a JSON object can't carry our data framing; when a
 * result has no text, its object becomes the framed text. A tool failure NoMail reports (200 with
 * isError) carries _meta["nourax/error"] {code: "mail_tool_error", retryable: false} like every
 * other error result (DESIGN 10.4, 26.6). No mail text, subject or address ever reaches a log line.
 *
 * Which listed tools a connection may use is decided in one place, ./access.ts: the mail scopes, and
 * (fix round 3) the Files app and workspace scopes for the tools that reach NoDrive, and the share
 * scope for a Drive file sent as a link. A caller that passes no grant is held to mail alone.
 */
import { canonicalJson, sha256Hex, utf8 } from "../core/bytes";
import { EgressDenied, egress, readCapped } from "../core/egress";
import { type ErrorCode, errorMeta, ToolError } from "../core/errors";
import { LIMITS } from "../core/limits";
import { log } from "../core/log";
import type { MailContext, MailToolDef } from "../core/mail-contract";
import { compactJson, errorResult, frame, MAIL_NOTICE } from "../core/result";
import type { MailCacheEntry } from "../vault/schema";
import { DENIAL_MESSAGES, type MailDenial, type MailGrant, linkRefusal, mailDenial, mailOnlyGrant, mailRoom, shownMailTools } from "./access";
import { dropInvisible } from "./invisible";
import { MAIL_NAME_RE, validateProviderTools } from "./validate";

export type CallResult = {
	content: { type: "text"; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	_meta?: Record<string, unknown>;
};

/** The 403 codes of contract v1 (caller rule 1). */
export type BlockCode = "TOOLS_KEY_INVALID" | "TOKEN_NOT_FOR_MCP" | "MFA_REQUIRED" | "MAILBOX_NOT_VERIFIED" | "FORBIDDEN";
const BLOCK_CODES: readonly BlockCode[] = ["TOOLS_KEY_INVALID", "TOKEN_NOT_FOR_MCP", "MFA_REQUIRED", "MAILBOX_NOT_VERIFIED"];

/** What the vault holds (JSON text, encrypted there). */
export interface CachedList {
	v: 1;
	/** Seconds since the epoch; the list is served only until then. */
	fresh_until: number;
	hash: string;
	tools: MailToolDef[];
	blocked: BlockCode | null;
	/** NoMail answered the list with 429: mail tools are hidden until fresh_until (its Retry-After). */
	limited?: boolean;
	/** How many valid tools NoMail offered, before the cap of 30 (absent in entries from before fix round 4). */
	offered?: number;
}

/**
 * The error code of a tool failure NoMail reports itself (200 with isError true). Contract v1 gives
 * such a failure no code, and none of the catalogue's codes (DESIGN 10.5) can be told from its
 * plain message, so it gets this one (DESIGN 26.6).
 */
export const MAIL_TOOL_ERROR = "mail_tool_error";

/** "unknown" only comes from peeking at the cache (workspace_overview): nothing fresh is cached. */
export type ListStatus = "ok" | "blocked" | "rate_limited" | "circuit_open" | "unavailable" | "reconnect_needed" | "inactive" | "unknown";

export interface ListState {
	tools: MailToolDef[];
	status: ListStatus;
	blocked?: BlockCode;
	/** Seconds until NoMail takes list requests again (status rate_limited). */
	retryAfter?: number;
	failures: number;
	cached?: CachedList;
}

/** Failures in a row that open the circuit (the vault keeps a failure for 60 s). */
export const CIRCUIT_FAILURES = 3;
/** How long a list entry is stored (for change detection only; served for at most 300 s). */
export const STORE_SEC = 24 * 3600;
/** How long a 403 answer is remembered before asking again. */
export const BLOCK_FRESH_SEC = 60;

const nowSec = () => Math.floor(Date.now() / 1000);

// ---- plain words ----

export const MAIL_MESSAGES = {
	reconnect: "Your Nourax mail sign-in has ended. Reconnect the assistant to use mail again.",
	unavailable: "NoMail isn't answering right now. Try again in a minute.",
	refused: "NoMail didn't accept the mail sign-in just now, so nothing was done. Try again in a minute.",
	unsure:
		"NoMail didn't answer in time, so it isn't known whether this was done. Check in NoMail (for example the Sent folder) before trying again.",
	unsureBroken:
		"The connection to NoMail broke off, so it isn't known whether this was done. Check in NoMail (for example the Sent folder) before trying again.",
	unsureError:
		"NoMail reported a problem, so it isn't known whether this was done. Check in NoMail (for example the Sent folder) before trying again.",
	unsureUnreadable:
		"NoMail's answer couldn't be read, so it isn't known whether this was done. Check in NoMail (for example the Sent folder) before trying again.",
	unsureTooLarge:
		"NoMail's answer was larger than 1 MB, so it can't be shown, and it isn't known whether this was done. Check in NoMail (for example the Sent folder) before trying again.",
	tooLargeIn: "Too large for mail; save it to NoDrive and refer to its path instead.",
	tooLargeOut: "NoMail's answer was larger than 1 MB, so it can't be passed on. Ask for less at a time.",
	unreadable: "NoMail's answer couldn't be read.",
	gone: "That mail tool isn't available any more.",
	notListed: "That mail tool isn't available on this connection.",
	noRoom:
		"That mail tool isn't offered on this connection: assistants are shown at most 100 tools, and it didn't fit. Choosing fewer apps when reconnecting the assistant makes room for more mail tools.",
	forbidden: "NoMail didn't allow that.",
	noWrite: DENIAL_MESSAGES.mail_write,
	noRead: DENIAL_MESSAGES.mail_read,
	noFiles: DENIAL_MESSAGES.files,
	noFilesWrite: DENIAL_MESSAGES.files_write,
	slowDown: "NoMail asked to slow down. Try again shortly.",
	unknownTools: "Mail is on for this connection. NoMail's tools are loaded when the assistant lists its tools, so how many there are isn't known yet.",
} as const;

export function blockMessage(code: BlockCode | undefined): string {
	switch (code) {
		case "TOOLS_KEY_INVALID":
			return "Mail isn't set up correctly in Nourax Workspace right now, so mail tools are missing. This needs the administrator.";
		case "TOKEN_NOT_FOR_MCP":
			return "NoMail didn't accept this connection's sign-in, so mail tools are missing. Reconnect the assistant; if it keeps happening, this needs the administrator.";
		case "MFA_REQUIRED":
			// NoMail's reply (2026-10-25, section 7): AI connections always carry the first sign-in level,
			// so reconnecting can't help. Say so plainly instead of sending the person round a sign-in loop.
			return "NoMail asks for two-step sign-in before AI assistants can use mail, and this connection's sign-in doesn't carry it, so mail tools are missing. Reconnecting won't change that; it needs the administrator.";
		case "MAILBOX_NOT_VERIFIED":
			return "The person's NoMail mailbox isn't verified yet, so mail tools can't be used. Finish setting up the mailbox in NoMail first.";
		default:
			return MAIL_MESSAGES.forbidden;
	}
}

export function stateMessage(state: MailContext["state"]): string | null {
	switch (state) {
		case "not_set_up":
			return "Mail tools aren't set up for this connection in Nourax Workspace.";
		case "off":
			return "This connection was set up without mail. The person can add it by reconnecting the assistant.";
		case "reconnect_needed":
			return MAIL_MESSAGES.reconnect;
		default:
			return null;
	}
}

function fail(code: ErrorCode, message: string, retryAfterSec?: number): CallResult {
	return errorResult(new ToolError(code, message, retryAfterSec !== undefined ? { retryAfterSec } : {})) as CallResult;
}

/**
 * The outcome of a call that may have changed mail is unknown (caller rule 3): say so, and mark it not
 * retryable, so the assistant checks in NoMail instead of sending the same mail a second time.
 */
export function unsureResult(code: ErrorCode, message: string): CallResult {
	const e = new ToolError(code, message);
	return { content: [{ type: "text", text: e.message }], isError: true, _meta: { "nourax/error": { ...errorMeta(e), retryable: false } } };
}

// ---- the provider HTTP calls ----

/** `sent` is false only when the request certainly never left the Worker. */
type Fetched = { kind: "response"; res: Response } | { kind: "network"; timeout: boolean; sent: boolean };

async function providerFetch(ctx: MailContext, op: "tools" | "call", token: string, body: string | undefined, timeoutMs: number): Promise<Fetched> {
	const base = ctx.cfg.nomailToolsUrl;
	if (!base) return { kind: "network", timeout: false, sent: false };
	const headers: Record<string, string> = {
		authorization: `Bearer ${token}`,
		"x-nourax-tools-key": ctx.env.NOMAIL_TOOLS_KEY ?? "",
		accept: "application/json",
	};
	if (body !== undefined) headers["content-type"] = "application/json";
	try {
		const res = await egress({ env: ctx.env, rid: ctx.rid }, `${base}/v1/${op}`, { method: op === "tools" ? "GET" : "POST", headers, body: body ?? null, timeoutMs });
		return { kind: "response", res };
	} catch (e) {
		if (e instanceof EgressDenied) {
			log({ t: "auth", rid: ctx.rid, ev: "mail_setup_fault", reason: "egress_denied" });
			return { kind: "network", timeout: false, sent: false };
		}
		const name = e instanceof Error ? e.name : "";
		return { kind: "network", timeout: name === "TimeoutError" || name === "AbortError", sent: true };
	}
}

async function readJson(res: Response, maxBytes: number): Promise<unknown> {
	const bytes = await readCapped(res, maxBytes);
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return undefined;
	}
}

/** The `code` of a small JSON error body ({"code":…} or {"error":{"code":…}}), or "" (64 KB read at most). */
async function bodyCode(res: Response): Promise<string> {
	let j: unknown;
	try {
		j = await readJson(res, 64 * 1024);
	} catch {
		return "";
	}
	const code = j && typeof j === "object" ? (j as { code?: unknown; error?: { code?: unknown } }).code ?? (j as { error?: { code?: unknown } }).error?.code : undefined;
	return typeof code === "string" ? code : "";
}

async function blockCodeOf(res: Response): Promise<BlockCode> {
	const code = await bodyCode(res);
	return (BLOCK_CODES as readonly string[]).includes(code) ? (code as BlockCode) : "FORBIDDEN";
}

function retryAfterOf(res: Response): number {
	const ra = Number(res.headers.get("retry-after") ?? "");
	return Number.isFinite(ra) && ra > 0 ? Math.min(Math.ceil(ra), 3600) : 30;
}

/**
 * How long a list answer is served from the vault: min(300 s, max-age), and 300 s when there is no
 * max-age. The contract (brief 5) lets the Worker keep each person's list for 5 minutes, and this copy
 * is private (one connection, encrypted in the vault), so no-store and no-cache don't turn it off.
 * NoMail sends "Cache-Control: no-store" on every answer, /v1/tools included, and counts list
 * requests against the person's 60-a-minute limit: honouring no-store would cost a list request per
 * mail call and run into that limit (fix round 2).
 */
export function freshnessOf(res: Response): number {
	const cc = (res.headers.get("cache-control") ?? "").toLowerCase();
	const m = /(?:^|[\s,])max-age=(\d{1,9})\b/.exec(cc);
	const maxAge = m ? Number(m[1]) : LIMITS.mailCacheSec;
	return Math.max(0, Math.min(LIMITS.mailCacheSec, maxAge));
}

async function cancel(res: Response): Promise<void> {
	await res.body?.cancel().catch(() => undefined);
}

// ---- one refresh at a time (caller rule 2) ----

const refreshing = new Map<string, { at: number; p: Promise<RefreshOutcome> }>();
type RefreshOutcome = { token: string } | { dead: true } | { error: true };

async function refreshOnce(ctx: MailContext, used: string): Promise<RefreshOutcome> {
	const key = await sha256Hex(`${ctx.cfg.nomailToolsUrl ?? ""}|${used}`);
	const now = Date.now();
	const hit = refreshing.get(key);
	if (hit && now - hit.at < 60_000) return hit.p;
	if (refreshing.size > 200) for (const [k, v] of refreshing) if (now - v.at >= 60_000) refreshing.delete(k);
	const p = (async (): Promise<RefreshOutcome> => {
		try {
			// Passing the token that got the 401 lets the vault hand back a token another request has
			// stored since, instead of rotating the refresh token a second time (caller rule 2).
			const t = await ctx.refreshUpstream(used);
			return t ? { token: t } : { dead: true };
		} catch {
			return { error: true };
		}
	})();
	refreshing.set(key, { at: now, p });
	const out = await p;
	// A failed attempt must not be reused: the next 401 may try again.
	if ("error" in out) refreshing.delete(key);
	return out;
}

/** For tests: forget shared refreshes. */
export function resetMailState(): void {
	refreshing.clear();
}

// ---- the cached list ----

function parseCached(value: string | null | undefined): CachedList | undefined {
	if (!value) return undefined;
	try {
		const j = JSON.parse(value) as CachedList;
		if (j?.v !== 1 || !Array.isArray(j.tools) || typeof j.fresh_until !== "number") return undefined;
		return j;
	} catch {
		return undefined;
	}
}

async function hashOf(tools: MailToolDef[]): Promise<string> {
	return (await sha256Hex(canonicalJson(tools))).slice(0, 16);
}

async function store(ctx: MailContext, c: CachedList): Promise<void> {
	try {
		await ctx.cache.put(JSON.stringify(c), STORE_SEC);
	} catch {
		// The cache is a convenience: a vault hiccup means the next call asks NoMail again.
	}
}

/** An entry that is never served (fresh_until 0): written only to end a run of failures. */
const EMPTY_ENTRY: CachedList = { v: 1, fresh_until: 0, hash: "", tools: [], blocked: null };

/**
 * NoMail answered as the contract says, so a run of failures is over (13.2: "three failures in a
 * row"). The vault's put resets the count; the cached list is written back unchanged, or, when
 * nothing is cached, an entry that is never served.
 */
async function markHealthy(ctx: MailContext, st: ListState): Promise<void> {
	if (st.failures <= 0) return;
	await store(ctx, st.cached ?? EMPTY_ENTRY);
	st.failures = 0;
}

async function countFailure(ctx: MailContext, failuresBefore: number): Promise<number> {
	let e: MailCacheEntry | null = null;
	try {
		e = await ctx.cache.fail();
	} catch {
		e = null;
	}
	const n = e?.failures ?? failuresBefore + 1;
	if (n >= CIRCUIT_FAILURES && failuresBefore < CIRCUIT_FAILURES) log({ t: "auth", rid: ctx.rid, ev: "mail_circuit_open", reason: `failures_${n}` });
	return n;
}

/** Only when the vault says the upstream session is dead (a refresh it was refused, DESIGN 29.6). */
async function markReconnect(ctx: MailContext): Promise<void> {
	try {
		await ctx.setState("reconnect_needed");
	} catch {
		// The next call finds out again.
	}
}

/**
 * NoMail refused a token the vault had just refreshed (DESIGN 29.6). The upstream session itself is
 * fine (the refresh worked), so this is a fault on NoMail's side, such as a stale key set or clock
 * skew in its token check. It counts toward the circuit like a provider failure, and mail stays on,
 * so a later call tries again; the connection is never marked reconnect_needed for it, which only
 * a new connection (and a new NoDrive app password) could undo.
 */
async function refusedAfterRefresh(ctx: MailContext, failuresBefore: number): Promise<number> {
	log({ t: "auth", rid: ctx.rid, ev: "mail_setup_fault", reason: "token_refused_after_refresh", status: 401 });
	return countFailure(ctx, failuresBefore);
}

async function fetchList(ctx: MailContext, cached: CachedList | undefined, failures: number): Promise<ListState> {
	const unavailable = async (): Promise<ListState> => ({ tools: [], status: "unavailable", failures: await countFailure(ctx, failures), cached });
	let token: string | null;
	try {
		token = await ctx.upstreamToken();
	} catch {
		return unavailable();
	}
	if (!token) {
		await markReconnect(ctx);
		return { tools: [], status: "reconnect_needed", failures, cached };
	}
	let got = await providerFetch(ctx, "tools", token, undefined, LIMITS.mailListTimeoutMs);
	if (got.kind === "response" && got.res.status === 401) {
		await cancel(got.res);
		const r = await refreshOnce(ctx, token);
		if ("error" in r) return unavailable();
		if ("dead" in r) {
			await markReconnect(ctx);
			return { tools: [], status: "reconnect_needed", failures, cached };
		}
		got = await providerFetch(ctx, "tools", r.token, undefined, LIMITS.mailListTimeoutMs);
		if (got.kind === "response" && got.res.status === 401) {
			await cancel(got.res);
			return { tools: [], status: "unavailable", failures: await refusedAfterRefresh(ctx, failures), cached };
		}
	}
	if (got.kind === "network") return unavailable();
	const res = got.res;
	if (res.status === 403) {
		const code = await blockCodeOf(res);
		if (code === "TOOLS_KEY_INVALID") log({ t: "auth", rid: ctx.rid, ev: "mail_setup_fault", reason: "tools_key_invalid", status: 403 });
		const c: CachedList = { v: 1, fresh_until: nowSec() + BLOCK_FRESH_SEC, hash: cached?.hash ?? "", tools: [], blocked: code };
		await store(ctx, c);
		return { tools: [], status: "blocked", blocked: code, failures: 0, cached: c };
	}
	if (res.status === 429) {
		// NoMail asks to slow down (its per-person limit counts list requests too). That isn't a
		// provider failure, so it doesn't count toward the circuit: the answer is remembered for its
		// Retry-After (at most the 5-minute cache), and mail calls meanwhile answer rate_limited
		// without asking NoMail again.
		const wait = Math.min(retryAfterOf(res), LIMITS.mailCacheSec);
		await cancel(res);
		log({ t: "auth", rid: ctx.rid, ev: "rate_limited", reason: "mail_list", status: 429 });
		const c: CachedList = { v: 1, fresh_until: nowSec() + wait, hash: cached?.hash ?? "", tools: [], blocked: null, limited: true };
		await store(ctx, c);
		return { tools: [], status: "rate_limited", retryAfter: wait, failures: 0, cached: c };
	}
	if (res.status !== 200) {
		// NoMail answers 503 TOOLS_NOT_CONFIGURED while its key or client id isn't set (its reply, 3d).
		if (res.status === 503 && (await bodyCode(res)) === "TOOLS_NOT_CONFIGURED") {
			log({ t: "auth", rid: ctx.rid, ev: "mail_setup_fault", reason: "provider_not_configured", status: 503 });
		}
		await cancel(res);
		if (res.status === 404) log({ t: "auth", rid: ctx.rid, ev: "mail_setup_fault", reason: "list_not_found", status: 404 });
		return unavailable();
	}
	let json: unknown;
	try {
		json = await readJson(res, LIMITS.mailBytes);
	} catch {
		log({ t: "auth", rid: ctx.rid, ev: "mail_setup_fault", reason: "list_too_large" });
		return unavailable();
	}
	const body = json as { version?: unknown; tools?: unknown } | undefined;
	if (!body || typeof body !== "object" || body.version !== 1 || !Array.isArray(body.tools)) {
		log({ t: "auth", rid: ctx.rid, ev: "mail_setup_fault", reason: "list_shape" });
		return unavailable();
	}
	const v = validateProviderTools(body.tools);
	const hash = await hashOf(v.tools);
	// Dropped tools are a provider fault, logged when the set is new to this connection (name hash and reason only).
	if (!cached?.hash || cached.hash !== hash) {
		for (const d of v.dropped.slice(0, 20)) {
			log({ t: "auth", rid: ctx.rid, ev: "mail_setup_fault", reason: `tool_dropped:${d.reason}:${(await sha256Hex(d.name)).slice(0, 10)}` });
		}
	}
	if (cached?.hash && cached.hash !== hash) log({ t: "auth", rid: ctx.rid, ev: "mail_toolset_changed", reason: `set:${hash.slice(0, 12)}` });
	// Always stored (see freshnessOf): it is served for its freshness, the hash notices a change of
	// the set, and the vault's put ends a run of failures. `offered` counts the valid tools before the
	// cap of 30, so workspace_overview can say when some were left out.
	const offered = v.tools.length + v.dropped.filter((d) => d.reason === "over_cap").length;
	const c: CachedList = { v: 1, fresh_until: nowSec() + freshnessOf(res), hash, tools: v.tools, blocked: null, offered };
	await store(ctx, c);
	return { tools: v.tools, status: "ok", failures: 0, cached: c };
}

/** What a fresh cached entry says, or null when it isn't fresh (the caller then asks NoMail or not). */
function fromCache(cached: CachedList | undefined, failures: number): ListState | null {
	const now = nowSec();
	if (!cached || cached.fresh_until <= now) return null;
	if (cached.blocked) return { tools: [], status: "blocked", blocked: cached.blocked, failures, cached };
	if (cached.limited) return { tools: [], status: "rate_limited", retryAfter: Math.max(1, cached.fresh_until - now), failures, cached };
	return { tools: cached.tools, status: "ok", failures, cached };
}

async function readCache(ctx: MailContext): Promise<{ cached: CachedList | undefined; failures: number }> {
	let entry: MailCacheEntry | null = null;
	try {
		entry = await ctx.cache.get();
	} catch {
		entry = null;
	}
	return { cached: parseCached(entry?.value), failures: entry?.failures ?? 0 };
}

async function loadList(ctx: MailContext): Promise<ListState> {
	if (!ctx.active || !ctx.cfg.nomailToolsUrl) return { tools: [], status: "inactive", failures: 0 };
	const { cached, failures } = await readCache(ctx);
	if (failures >= CIRCUIT_FAILURES) return { tools: [], status: "circuit_open", failures, cached };
	return fromCache(cached, failures) ?? fetchList(ctx, cached, failures);
}

/**
 * The cached state only, never a request to NoMail (for workspace_overview, DESIGN 13.2). Nothing
 * fresh plus a failure counted in the last 60 s means the last attempt failed (NoMail down or not set
 * up), so that is what it says, not "not known yet" (fix round 4).
 */
async function peekList(ctx: MailContext): Promise<ListState> {
	if (!ctx.active || !ctx.cfg.nomailToolsUrl) return { tools: [], status: "inactive", failures: 0 };
	const { cached, failures } = await readCache(ctx);
	if (failures >= CIRCUIT_FAILURES) return { tools: [], status: "circuit_open", failures, cached };
	const fresh = fromCache(cached, failures);
	if (fresh) return fresh;
	return { tools: [], status: failures > 0 ? "unavailable" : "unknown", failures, cached };
}

/** One load per request: tools/list and the call in the same request share it. */
const perRequest = new WeakMap<MailContext, Promise<ListState>>();

export function listState(ctx: MailContext): Promise<ListState> {
	let p = perRequest.get(ctx);
	if (!p) {
		p = loadList(ctx).catch((): ListState => ({ tools: [], status: "unavailable", failures: 0 }));
		perRequest.set(ctx, p);
	}
	return p;
}

/** The validated provider tools for this connection (cached up to 5 minutes). Empty when inactive. */
export async function listMailTools(ctx: MailContext): Promise<MailToolDef[]> {
	return (await listState(ctx)).tools;
}

/** What workspace_overview counts against: the connection's grant and how many of our own tools it lists. */
export interface OverviewView {
	grant: MailGrant;
	ownCount: number;
}

export interface MailOverview {
	status: MailContext["state"];
	/** Mail tools this connection lists and may call (the same count as tools/list), or null when not known. */
	tools: number | null;
	/**
	 * How many valid tools NoMail offers this person, before the cap of 30 (so it can be more than 30);
	 * set only when its list is known (status ok).
	 */
	offered?: number;
	reason: string | null;
}

const WHY_HIDDEN: Readonly<Record<MailDenial, string>> = {
	mail_read: "it can't read mail",
	mail_write: "it can't write or send mail",
	files: "it was set up without NoDrive files",
	files_write: "it can't create files in NoDrive",
};

/**
 * Counts exactly as tools/list does (fix round 3): the tools this connection's scopes and apps allow
 * (./access.ts), within the room our own tools leave in the 100. `offered` is NoMail's whole list of
 * valid tools, before the cap of 30 (fix round 4); `offeredAll` is absent for entries cached before
 * that, and then counts what was kept.
 */
function countedOverview(tools: readonly MailToolDef[], view: OverviewView, offeredAll?: number): MailOverview {
	const offered = Math.max(tools.length, offeredAll ?? 0);
	if (offered === 0) return { status: "on", tools: 0, offered: 0, reason: "NoMail offers no mail tools to this person right now." };
	const usable = shownMailTools(tools, view.grant, view.ownCount).length;
	if (usable === offered) return { status: "on", tools: usable, offered, reason: null };
	// Reasons the person can change by reconnecting (scopes, apps, fewer apps for more room), and the
	// cap of 30, which no reconnect changes.
	const why: string[] = [];
	for (const t of tools) {
		const d = mailDenial(t, view.grant);
		if (d && !why.includes(WHY_HIDDEN[d])) why.push(WHY_HIDDEN[d]);
	}
	const allowed = tools.filter((t) => mailDenial(t, view.grant) === null).length;
	if (allowed > mailRoom(view.ownCount)) why.push("assistants are shown at most 100 tools, and the other apps chosen use the rest");
	const capped = offered > tools.length;
	const all = [...(capped ? [`Nourax Workspace uses at most ${LIMITS.mailTools} of them`] : []), ...why];
	return {
		status: "on",
		tools: usable,
		offered,
		reason: `NoMail offers ${offered} mail tool${offered === 1 ? "" : "s"}; ${usable} of them can be used on this connection, because ${all.join(", and ")}.${why.length ? " The person can allow more by reconnecting the assistant." : ""}`,
	};
}

/**
 * For workspace_overview: whether mail tools are there for this connection, how many, and if not all,
 * why. It never asks NoMail (DESIGN 13.2 loads the list only for tools/list and mail calls): it uses
 * this request's list when one was loaded, otherwise the cached entry, and says "not known yet" when
 * that isn't fresh. Without a view it counts for a connection with mail alone and no NoDrive.
 */
export async function mailOverview(ctx: MailContext, view?: OverviewView): Promise<MailOverview> {
	if (!ctx.active) return { status: ctx.state, tools: null, reason: stateMessage(ctx.state) };
	const loaded = perRequest.get(ctx);
	let st: ListState;
	try {
		st = loaded ? await loaded : await peekList(ctx);
	} catch {
		st = { tools: [], status: "unknown", failures: 0 };
	}
	switch (st.status) {
		case "ok":
			return countedOverview(st.tools, view ? { grant: narrowed(ctx, view.grant), ownCount: view.ownCount } : { grant: mailOnlyGrant(ctx.scopes), ownCount: 0 }, st.cached?.offered);
		case "blocked":
			return { status: "on", tools: 0, reason: blockMessage(st.blocked) };
		case "reconnect_needed":
			return { status: "reconnect_needed", tools: 0, reason: MAIL_MESSAGES.reconnect };
		case "rate_limited":
			return { status: "on", tools: 0, reason: `NoMail asked to slow down, so mail tools are hidden for about ${st.retryAfter ?? 60} seconds.` };
		case "unknown":
			return { status: "on", tools: null, reason: MAIL_MESSAGES.unknownTools };
		default:
			return { status: "on", tools: 0, reason: "NoMail isn't answering right now, so mail tools are hidden for the moment." };
	}
}

// ---- calls ----

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** A text as the assistant may read it: control characters (other than \n and \t) and invisible Unicode removed. */
function cleanText(s: string): string {
	return dropInvisible(s).replace(CONTROL, "");
}

/** The same object with every key and string cleaned (cleanText). */
function cleanStrings(v: unknown, depth = 0): unknown {
	if (typeof v === "string") return cleanText(v);
	if (!v || typeof v !== "object" || depth > 64) return v;
	if (Array.isArray(v)) return v.map((x) => cleanStrings(x, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v)) out[cleanText(k)] = cleanStrings(x, depth + 1);
	return out;
}

/** Whether an answer is a CallToolResult we can read: an object with a content array and a boolean (or no) isError. */
export function readableResult(json: unknown): json is { content: unknown[]; isError?: boolean; structuredContent?: unknown } {
	return isPlainObject(json) && Array.isArray(json.content) && (json.isError === undefined || typeof json.isError === "boolean");
}

/**
 * Rebuilds a provider CallToolResult: text blocks only, each cleaned (cleanText) and framed as mail
 * data, all within the 60,000-character cap. structuredContent is never passed on (see the top of this
 * file); when the provider sent no text block, its structuredContent object is used as the text,
 * framed like the rest. A tool failure (isError true) carries _meta["nourax/error"] with the code
 * mail_tool_error, not retryable: NoMail said it didn't do it, so the same call would fail again.
 * An answer that isn't a CallToolResult is "unreadable"; for a tool that changes mail that means the
 * outcome is unknown (caller rule 3).
 */
export function buildResult(name: string, def: MailToolDef, json: unknown): CallResult {
	if (!readableResult(json)) return def.annotations.readOnlyHint ? fail("upstream_unavailable", MAIL_MESSAGES.unreadable) : unsureResult("upstream_unavailable", MAIL_MESSAGES.unsureUnreadable);
	const isError = json.isError === true;
	const texts = json.content
		.filter((b): b is { type: "text"; text: string } => isPlainObject(b) && b.type === "text" && typeof b.text === "string")
		.map((b) => cleanText(b.text));
	if (texts.length === 0) texts.push(isPlainObject(json.structuredContent) ? compactJson(cleanStrings(json.structuredContent)) : "(NoMail sent no text.)");
	const summary = isError ? `NoMail couldn't do ${name}.` : `NoMail's answer to ${name}.`;
	const content: CallResult["content"] = [];
	let room = LIMITS.resultChars;
	for (const t of texts) {
		if (room < 400) break;
		const block = frame(summary, t, { notice: MAIL_NOTICE, maxChars: room });
		content.push({ type: "text", text: block });
		room -= block.length;
	}
	if (!isError) return { content };
	return { content, isError: true, _meta: { "nourax/error": { code: MAIL_TOOL_ERROR, retryable: false } } };
}

/** Why mail can't be used at all on this connection (13.1), in plain words. */
function inactiveResult(state: MailContext["state"]): CallResult {
	if (state === "reconnect_needed") return fail("reconnect_required", MAIL_MESSAGES.reconnect);
	return fail("not_available", stateMessage(state) ?? MAIL_MESSAGES.notListed);
}

/** Why a mail tool isn't in this connection's list right now (DESIGN 13.5), in plain words. */
function missingResult(st: ListState): CallResult {
	switch (st.status) {
		case "blocked":
			return fail("permission_denied", blockMessage(st.blocked));
		case "reconnect_needed":
			return fail("reconnect_required", MAIL_MESSAGES.reconnect);
		case "rate_limited":
			return fail("rate_limited", MAIL_MESSAGES.slowDown, st.retryAfter ?? 60);
		case "circuit_open":
		case "unavailable":
			return fail("upstream_unavailable", MAIL_MESSAGES.unavailable, 60);
		default:
			return fail("not_available", MAIL_MESSAGES.notListed);
	}
}

/**
 * The checks before a call: mail is on, the name is a mail name, the tool is listed, and the grant
 * allows it (./access.ts: the mail scope, and the Files app and workspace scopes for NoDrive tools).
 * The mail scopes come from the context itself, so a grant can narrow them but never widen them.
 */
async function resolveTool(ctx: MailContext, name: string, grant: MailGrant): Promise<{ def: MailToolDef; st: ListState } | { result: CallResult }> {
	if (!ctx.active) return { result: inactiveResult(ctx.state) };
	if (!MAIL_NAME_RE.test(name)) return { result: fail("not_available", MAIL_MESSAGES.notListed) };
	const st = await listState(ctx);
	const def = st.tools.find((t) => t.name === name);
	if (!def) return { result: missingResult(st) };
	const denied = mailDenial(def, narrowed(ctx, grant));
	if (denied) return { result: fail("not_available", DENIAL_MESSAGES[denied]) };
	return { def, st };
}

/** The grant, with its mail scopes cut to what the MailContext says was granted. */
function narrowed(ctx: MailContext, grant: MailGrant): MailGrant {
	return {
		apps: grant.apps,
		scopes: grant.scopes.filter((s) => (s === "mail.read" ? ctx.scopes.read : s === "mail.write" ? ctx.scopes.write : true)),
	};
}

/**
 * For a mail tool the factory couldn't register for this call (caller rule 1, DESIGN 13.5): the plain
 * reason it can't be used right now, without asking NoMail anything beyond the list. Null when the
 * tool is listed and allowed (it was then left out only by the 100-tool room).
 */
export async function mailUnavailable(ctx: MailContext, name: string, grant: MailGrant = mailOnlyGrant(ctx.scopes)): Promise<CallResult | null> {
	const r = await resolveTool(ctx, name, grant);
	return "result" in r ? r.result : null;
}

/**
 * Forwards one call (one refresh and one retry after a 401, no other retries). `grant` is the
 * connection's scopes and apps; without one the call is held to mail alone, so a tool that reaches
 * NoDrive is refused.
 */
export async function callMailTool(ctx: MailContext, name: string, args: Record<string, unknown>, grant: MailGrant = mailOnlyGrant(ctx.scopes)): Promise<CallResult> {
	const resolved = await resolveTool(ctx, name, grant);
	if ("result" in resolved) return resolved.result;
	const { def, st } = resolved;
	const noLink = linkRefusal(def, narrowed(ctx, grant), isPlainObject(args) ? args : {});
	if (noLink) return errorResult(noLink) as CallResult;
	let body: string;
	try {
		body = JSON.stringify({ name, arguments: isPlainObject(args) ? args : {} });
	} catch {
		return fail("invalid_input", "The mail tool's input couldn't be sent.");
	}
	if (utf8(body).byteLength > LIMITS.mailBytes) return fail("too_large", MAIL_MESSAGES.tooLargeIn);

	// A tool that changes mail (above all mail_send_draft, which is not idempotent) may have done its
	// work before a failure. Every answer that can come after the change says the outcome is unknown
	// and is not retryable; "try again" is kept for read-only tools (caller rule 3).
	const changes = !def.annotations.readOnlyHint;
	const networkFailure = async (timeout: boolean, sent: boolean): Promise<CallResult> => {
		await countFailure(ctx, st.failures);
		if (changes && sent) return timeout ? unsureResult("timeout", MAIL_MESSAGES.unsure) : unsureResult("upstream_unavailable", MAIL_MESSAGES.unsureBroken);
		return fail("upstream_unavailable", MAIL_MESSAGES.unavailable);
	};

	let token: string | null;
	try {
		token = await ctx.upstreamToken();
	} catch {
		return fail("upstream_unavailable", MAIL_MESSAGES.unavailable);
	}
	if (!token) {
		await markReconnect(ctx);
		return fail("reconnect_required", MAIL_MESSAGES.reconnect);
	}
	let got = await providerFetch(ctx, "call", token, body, LIMITS.mailCallTimeoutMs);
	if (got.kind === "response" && got.res.status === 401) {
		// The provider refused the token before doing anything, so this one retry is safe.
		await cancel(got.res);
		const r = await refreshOnce(ctx, token);
		if ("error" in r) return fail("upstream_unavailable", MAIL_MESSAGES.unavailable);
		if ("dead" in r) {
			await markReconnect(ctx);
			return fail("reconnect_required", MAIL_MESSAGES.reconnect);
		}
		got = await providerFetch(ctx, "call", r.token, body, LIMITS.mailCallTimeoutMs);
		if (got.kind === "response" && got.res.status === 401) {
			// A 401 says nothing was done, so trying again later is safe; mail stays on (DESIGN 29.6).
			await cancel(got.res);
			await refusedAfterRefresh(ctx, st.failures);
			return fail("upstream_unavailable", MAIL_MESSAGES.refused, 60);
		}
	}
	if (got.kind === "network") return networkFailure(got.timeout, got.sent);
	const res = got.res;
	switch (res.status) {
		case 200:
			break;
		// 403, 404, 413 and 429 are answers the contract names: NoMail is working, so a run of failures
		// ends here too (markHealthy).
		case 403: {
			const code = await blockCodeOf(res);
			if (code === "TOOLS_KEY_INVALID") log({ t: "auth", rid: ctx.rid, ev: "mail_setup_fault", reason: "tools_key_invalid", status: 403 });
			await markHealthy(ctx, st);
			return fail("permission_denied", code === "FORBIDDEN" ? MAIL_MESSAGES.forbidden : blockMessage(code));
		}
		case 404: {
			await cancel(res);
			if (st.cached) {
				// The vault's put also ends a run of failures.
				const tools = st.cached.tools.filter((t) => t.name !== name);
				const gone = st.cached.tools.length - tools.length;
				const offered = st.cached.offered === undefined ? undefined : Math.max(tools.length, st.cached.offered - gone);
				await store(ctx, { ...st.cached, tools, hash: await hashOf(tools), ...(offered === undefined ? {} : { offered }) });
			} else await markHealthy(ctx, st);
			return fail("not_available", MAIL_MESSAGES.gone);
		}
		case 413:
			await cancel(res);
			await markHealthy(ctx, st);
			return fail("too_large", MAIL_MESSAGES.tooLargeIn);
		case 429:
			await cancel(res);
			await markHealthy(ctx, st);
			return fail("rate_limited", MAIL_MESSAGES.slowDown, retryAfterOf(res));
		default:
			// A 5xx (provider error) or any status the contract doesn't name. Only 401, 403, 404, 413
			// and 429 promise that nothing was done.
			await cancel(res);
			if (res.status >= 500) await countFailure(ctx, st.failures);
			return changes ? unsureResult("upstream_unavailable", MAIL_MESSAGES.unsureError) : fail("upstream_unavailable", MAIL_MESSAGES.unavailable);
	}
	let json: unknown;
	try {
		json = await readJson(res, LIMITS.mailBytes);
	} catch (e) {
		if (e instanceof ToolError && e.code === "too_large") {
			return changes ? unsureResult("too_large", MAIL_MESSAGES.unsureTooLarge) : fail("too_large", MAIL_MESSAGES.tooLargeOut);
		}
		// The answer broke off while it was being read.
		return changes ? unsureResult("upstream_unavailable", MAIL_MESSAGES.unsureBroken) : fail("upstream_unavailable", MAIL_MESSAGES.unavailable);
	}
	const result = buildResult(name, def, json);
	// A readable answer ends a run of failures, even when nothing is cached (markHealthy); a tool
	// failure NoMail reports is a readable answer too. An unreadable one doesn't.
	if (readableResult(json)) await markHealthy(ctx, st);
	return result;
}
