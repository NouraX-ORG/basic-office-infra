/**
 * The Quota Durable Object (DESIGN 14, fix round 2; DESIGN 29.1): one object for the whole Worker.
 * It keeps exact daily caps on unauthenticated work, so what an outsider can make the Worker write
 * (and so spend) per day has a hard ceiling:
 * - "authorize": a sign-in started at GET /authorize (the consent transaction, or the next step's
 *   transaction when consent is remembered);
 * - "register": a client registration at POST /oauth/register;
 * - "page_signin": a NoDrive sign-in or a desktop key started on /connections (its own name, so a
 *   flood of AI-app sign-ins can't lock people out of the page where they end connections).
 *
 * The Workers rate-limit bindings are approximate and count per Cloudflare location; Cloudflare's
 * docs say to use a Durable Object for one strict limit across locations. Each take() counts per
 * UTC day both for everyone and for one caller key: an HMAC of the caller's network (dailyBucket: an
 * IPv4 address, or an IPv6 address by its /48), never the IP itself. A caller that has used fewer
 * than `reserve` units today still gets one when the global cap is used up. Rows are removed two
 * days later.
 */
import { DurableObject } from "cloudflare:workers";
import type { NxEnv } from "../env";
import { hmacSha256, toHex } from "../core/bytes";
import { subkey } from "../core/keys";
import { DAILY_CAPS, type QuotaName } from "../core/limits";
import { log } from "../core/log";

export type QuotaResult = { ok: true } | { ok: false; scope: "global" | "caller"; retryAfterSec: number };

const now = () => Math.floor(Date.now() / 1000);

export class Quota extends DurableObject<NxEnv> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: NxEnv) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => {
			this.sql.exec("CREATE TABLE IF NOT EXISTS quota (k TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)");
			this.sql.exec("CREATE INDEX IF NOT EXISTS quota_exp ON quota (exp)");
		});
	}

	private count(k: string): number {
		const rows = this.sql.exec<{ n: number }>("SELECT n FROM quota WHERE k = ?", k).toArray();
		return rows[0] ? Number(rows[0].n) : 0;
	}

	/**
	 * Counts one unit of `name` for today, when the caller is under its own cap and either today's
	 * total is under the global cap or the caller has used fewer than `reserve` units today.
	 * Synchronous SQL only, so two calls can't interleave between the check and the count.
	 */
	async take(name: QuotaName, callerKey: string, perCaller: number, global: number, reserve = 0): Promise<QuotaResult> {
		if (!(name in DAILY_CAPS)) throw new Error("unknown quota");
		if (!/^[0-9a-f]{32}$/.test(callerKey)) throw new Error("bad caller key");
		if (!Number.isInteger(perCaller) || !Number.isInteger(global) || perCaller < 1 || global < 1) throw new Error("bad caps");
		if (!Number.isInteger(reserve) || reserve < 0 || reserve > perCaller) throw new Error("bad caps");
		const t = now();
		const day = Math.floor(t / 86400);
		const retryAfterSec = 86400 - (t % 86400);
		const exp = (day + 2) * 86400;
		this.sql.exec("DELETE FROM quota WHERE exp < ?", t);
		const g = `g:${name}:${day}`;
		const c = `c:${name}:${callerKey}:${day}`;
		const used = this.count(c);
		if (used >= perCaller) return { ok: false, scope: "caller", retryAfterSec };
		// The reserve: the global cap can't take a caller's first few units of the day.
		if (this.count(g) >= global && used >= reserve) return { ok: false, scope: "global", retryAfterSec };
		for (const k of [g, c]) {
			this.sql.exec("INSERT INTO quota (k, n, exp) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1", k, exp);
		}
		return { ok: true };
	}
}

/** The 8 groups of an IPv6 address (NaN for a group that isn't hex), or null when it can't be read. */
function ipv6Groups(s: string): number[] | null {
	const halves = s.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	let groups: string[];
	if (halves.length === 2) {
		const tail = halves[1] ? halves[1].split(":") : [];
		const fill = 8 - head.length - tail.length;
		if (fill < 0) return null;
		groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
	} else {
		groups = head;
	}
	return groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
}

/**
 * The bucket a caller's IP counts in: an IPv4 address as it is, an IPv4-mapped IPv6 address as its
 * IPv4, and any other IPv6 address by its first `prefix` bits. One site or one customer usually
 * holds a whole /64, so per-address limits would be easy to step around: the per-minute limits count
 * by /64. A /56 or even a /48 is cheap to get (tunnel brokers hand out /48s for free), so the daily
 * caps count by /48 (dailyBucket, DESIGN 29.1).
 */
export function ipBucket(ip: string, prefix: 64 | 48 = 64): string {
	const s = ip.trim().toLowerCase();
	if (!s.includes(":")) return s;
	const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
	if (mapped) return mapped[1] as string;
	const groups = ipv6Groups(s);
	if (!groups) return s;
	const first = groups.slice(0, prefix / 16).map((g) => (Number.isNaN(g) ? "x" : g.toString(16)));
	return `${first.join(":")}::/${prefix}`;
}

/** The network a daily cap counts per caller: an IPv4 address, or an IPv6 address by its /48. */
export function dailyBucket(ip: string): string {
	return ipBucket(ip, 48);
}

const QUOTA_OBJECT = "quota:v1:global";
/**
 * Per isolate: callers known to be refused today, so their further requests skip the round trip.
 * Only callers are remembered, never "the global cap is reached": the reserve still lets in a
 * caller that hasn't used it, and only the Quota object knows that.
 */
const reached = new Map<string, { until: number; scope: "global" | "caller" }>();
const REACHED_MAX = 2_000;

function remember(key: string, until: number, scope: "global" | "caller"): void {
	if (reached.size >= REACHED_MAX) {
		const t = now();
		for (const [k, v] of reached) if (v.until <= t) reached.delete(k);
		if (reached.size >= REACHED_MAX) reached.clear();
	}
	reached.set(key, { until, scope });
}

/**
 * Takes one unit of a daily cap for the caller at `ip`. Throws when the Quota object can't be
 * reached or NX_SECRET is missing; callers answer 503 then (fail closed: no write without a count).
 */
export async function takeDaily(env: NxEnv, name: QuotaName, ip: string): Promise<QuotaResult> {
	const t = now();
	const callerKey = toHex(await hmacSha256(await subkey(env, "quota-caller"), `${name}|${dailyBucket(ip)}`)).slice(0, 32);
	const memo = `c:${name}:${callerKey}`;
	const known = reached.get(memo);
	if (known && known.until > t) return { ok: false, scope: known.scope, retryAfterSec: known.until - t };
	const caps = DAILY_CAPS[name];
	const stub = env.QUOTA.get(env.QUOTA.idFromName(QUOTA_OBJECT));
	const r = await stub.take(name, callerKey, caps.perCaller, caps.global, caps.reserve);
	if (!r.ok) {
		// A global refusal comes only once this caller has used its reserve, so it stays refused today.
		remember(memo, t + r.retryAfterSec, r.scope);
		log({ t: "auth", ev: "daily_cap", reason: `${name}_${r.scope}` });
	}
	return r;
}

/** Tests only: forget what this isolate learned about reached caps. */
export function _resetQuotaMemo(): void {
	reached.clear();
}
