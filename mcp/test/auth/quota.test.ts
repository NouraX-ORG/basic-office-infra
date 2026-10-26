/**
 * The exact daily caps on unauthenticated work that writes to KV (DESIGN 14, fix round 2): the
 * Quota object, the IP buckets, and the caps on new sign-ins (GET /authorize) and client
 * registrations, through the whole router.
 */
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { b64url, randomBytes, sha256 } from "../../src/core/bytes";
import { DAILY_CAPS } from "../../src/core/limits";
import { handleRequest } from "../../src/http/router";
import { _resetQuotaMemo, dailyBucket, ipBucket, type Quota, takeDaily } from "../../src/vault/quota";
import { env, fakeWithQa, ORIGIN } from "../helpers/index";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const day = () => Math.floor(Date.now() / 86400000);
const quota = () => env.QUOTA.get(env.QUOTA.idFromName("quota:v1:global"));
let ip = 1;
const nextIp = () => `192.0.2.${ip++}`;

async function setCount(k: string, n: number): Promise<void> {
	await runInDurableObject(quota(), async (_i: Quota, state) => {
		state.storage.sql.exec("INSERT INTO quota (k, n, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET n = excluded.n", k, n, (day() + 2) * 86400);
	});
}

async function count(k: string): Promise<number> {
	return runInDurableObject(quota(), async (_i: Quota, state) => {
		const rows = state.storage.sql.exec<{ n: number }>("SELECT n FROM quota WHERE k = ?", k).toArray();
		return rows[0] ? Number(rows[0].n) : 0;
	});
}

async function clear(): Promise<void> {
	_resetQuotaMemo();
	await runInDurableObject(quota(), async (_i: Quota, state) => {
		state.storage.sql.exec("DELETE FROM quota");
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	await clear();
});

describe("ipBucket", () => {
	it.each([
		["198.51.100.7", "198.51.100.7"],
		["::ffff:198.51.100.7", "198.51.100.7"],
		["0:0:0:0:0:ffff:198.51.100.7", "198.51.100.7"],
		["2001:db8:1234:5678:aaaa:bbbb:cccc:dddd", "2001:db8:1234:5678::/64"],
		["2001:DB8:1234:5678::1", "2001:db8:1234:5678::/64"],
		["2001:0db8:1234:5678:1::9", "2001:db8:1234:5678::/64"],
		["2001:db8::1", "2001:db8:0:0::/64"],
		["::1", "0:0:0:0::/64"],
		["local", "local"],
	])("%s counts as %s", (input, out) => {
		expect(ipBucket(input)).toBe(out);
	});
});

describe("dailyBucket (DESIGN 29.1): the daily caps count an IPv6 caller by its /48", () => {
	it.each([
		["198.51.100.7", "198.51.100.7"],
		["::ffff:198.51.100.7", "198.51.100.7"],
		["2001:db8:1234:5678:aaaa:bbbb:cccc:dddd", "2001:db8:1234::/48"],
		["2001:db8:1234:ff00::1", "2001:db8:1234::/48"],
		["2001:DB8:1234::9", "2001:db8:1234::/48"],
		["2001:db8::1", "2001:db8:0::/48"],
		["local", "local"],
	])("%s counts as %s", (input, out) => {
		expect(dailyBucket(input)).toBe(out);
	});
	it("so the 256 /64s of a /56, or the 65,536 of a /48, are one caller", async () => {
		for (let i = 0; i < DAILY_CAPS.authorize.perCaller; i++) {
			expect((await takeDaily(env, "authorize", `2001:db8:aaaa:${(i + 1).toString(16)}::1`)).ok).toBe(true);
		}
		expect(await takeDaily(env, "authorize", "2001:db8:aaaa:ffff::7")).toMatchObject({ ok: false, scope: "caller" });
		expect((await takeDaily(env, "authorize", "2001:db8:aaab::1")).ok).toBe(true);
	});
});

describe("the Quota object", () => {
	it("counts per caller and for everyone, per UTC day, and refuses at either cap", async () => {
		const q = quota();
		const a = "a".repeat(32);
		const b = "b".repeat(32);
		expect(await q.take("register", a, 2, 3)).toEqual({ ok: true });
		expect(await q.take("register", a, 2, 3)).toEqual({ ok: true });
		const callerFull = await q.take("register", a, 2, 3);
		expect(callerFull).toMatchObject({ ok: false, scope: "caller" });
		expect(await q.take("register", b, 2, 3)).toEqual({ ok: true });
		const globalFull = await q.take("register", b, 2, 3);
		expect(globalFull).toMatchObject({ ok: false, scope: "global" });
		if (!globalFull.ok) {
			expect(globalFull.retryAfterSec).toBeGreaterThan(0);
			expect(globalFull.retryAfterSec).toBeLessThanOrEqual(86400);
		}
		// Another quota is counted on its own.
		expect(await q.take("authorize", a, 2, 3)).toEqual({ ok: true });
		// Refusals are not counted.
		expect(await count(`g:register:${day()}`)).toBe(3);
		// Yesterday's rows are removed once they expire.
		await runInDurableObject(q, async (_i: Quota, state) => {
			state.storage.sql.exec("UPDATE quota SET exp = 1");
		});
		expect(await q.take("register", a, 2, 3)).toEqual({ ok: true });
		expect(await count(`g:register:${day()}`)).toBe(1);
	});
	it("refuses bad input", async () => {
		await runInDurableObject(quota(), async (instance: Quota) => {
			await expect(instance.take("register", "not-hex", 1, 1)).rejects.toThrow(/caller key/);
			await expect(instance.take("nope" as never, "a".repeat(32), 1, 1)).rejects.toThrow(/unknown quota/);
			await expect(instance.take("register", "a".repeat(32), 0, 1)).rejects.toThrow(/caps/);
			// A reserve can't be larger than the caller's own cap, nor negative (DESIGN 29.1).
			await expect(instance.take("register", "a".repeat(32), 2, 2, 3)).rejects.toThrow(/caps/);
			await expect(instance.take("register", "a".repeat(32), 2, 2, -1)).rejects.toThrow(/caps/);
		});
	});
	it("stores no IP: caller keys are HMACs of the bucket", async () => {
		const addr = "203.0.113.77";
		expect(await takeDaily(env, "register", addr)).toEqual({ ok: true });
		await runInDurableObject(quota(), async (_i: Quota, state) => {
			const dump = JSON.stringify(state.storage.sql.exec("SELECT * FROM quota").toArray());
			expect(dump).not.toContain(addr);
			expect(dump).toMatch(/c:register:[0-9a-f]{32}:\d+/);
		});
	});
	it("the reserve (DESIGN 29.1): at the global cap a caller's first units of the day still pass, then it is refused", async () => {
		const q = quota();
		const a = "a".repeat(32);
		const b = "b".repeat(32);
		const c = "c".repeat(32);
		expect(await q.take("authorize", a, 5, 2, 1)).toEqual({ ok: true });
		expect(await q.take("authorize", a, 5, 2, 1)).toEqual({ ok: true });
		// The day's total is used up, and a has used more than its reserve of 1.
		expect(await q.take("authorize", a, 5, 2, 1)).toMatchObject({ ok: false, scope: "global" });
		// b has used nothing: its one reserved unit passes, and only then is it refused.
		expect(await q.take("authorize", b, 5, 2, 1)).toEqual({ ok: true });
		expect(await q.take("authorize", b, 5, 2, 1)).toMatchObject({ ok: false, scope: "global" });
		expect(await count(`g:authorize:${day()}`)).toBe(3);
		// The caller's own cap still comes first.
		expect(await q.take("register", c, 1, 100, 1)).toEqual({ ok: true });
		expect(await q.take("register", c, 1, 100, 1)).toMatchObject({ ok: false, scope: "caller" });
	});
	it("every quota has a reserve, no larger than its per-caller cap, and the page's sign-in has its own quota", () => {
		for (const [name, caps] of Object.entries(DAILY_CAPS)) {
			expect(caps.reserve, name).toBeGreaterThan(0);
			expect(caps.reserve, name).toBeLessThanOrEqual(caps.perCaller);
		}
		expect(DAILY_CAPS.page_signin.global).toBeGreaterThan(DAILY_CAPS.authorize.global);
	});
	it("at the global cap a network still gets its reserve; once it is used, this isolate stops asking the object for that network today", async () => {
		await setCount(`g:register:${day()}`, DAILY_CAPS.register.global);
		const me = nextIp();
		for (let i = 0; i < DAILY_CAPS.register.reserve; i++) expect(await takeDaily(env, "register", me)).toEqual({ ok: true });
		expect(await takeDaily(env, "register", me)).toMatchObject({ ok: false, scope: "global" });
		const spy = vi.spyOn(env.QUOTA, "get");
		expect(await takeDaily(env, "register", me)).toMatchObject({ ok: false, scope: "global" });
		expect(spy).not.toHaveBeenCalled();
		// Another network still has its own reserve, so the object is asked for it.
		expect(await takeDaily(env, "register", nextIp())).toEqual({ ok: true });
		expect(spy).toHaveBeenCalled();
	});
});

async function register(): Promise<string> {
	const res = await handleRequest(
		new Request(`${ORIGIN}/oauth/register`, {
			method: "POST",
			headers: { "content-type": "application/json", "cf-connecting-ip": nextIp() },
			body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "Claude", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
		}),
		env,
		ctx,
	);
	expect(res.status).toBe(201);
	return ((await res.json()) as { client_id: string }).client_id;
}

async function authorizeUrl(clientId: string): Promise<string> {
	const verifier = b64url(randomBytes(32));
	const q = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT,
		scope: "workspace.read",
		state: "s",
		code_challenge: b64url(await sha256(verifier)),
		code_challenge_method: "S256",
		resource: `${ORIGIN}/mcp`,
	});
	return `${ORIGIN}/authorize?${q}`;
}

describe("the daily caps through the router", () => {
	it("new sign-ins: counted once each; at the cap, 429 with Retry-After and nothing written to KV", async () => {
		fakeWithQa();
		const cid = await register();
		const url = await authorizeUrl(cid);
		const ok = await handleRequest(new Request(url, { headers: { "cf-connecting-ip": nextIp() } }), env, ctx);
		expect(ok.status).toBe(200);
		expect(await count(`g:authorize:${day()}`)).toBe(1);
		await setCount(`g:authorize:${day()}`, DAILY_CAPS.authorize.global);
		// The day's total is used up: a network still gets its reserve (DESIGN 29.1), then 429.
		const late = nextIp();
		for (let i = 0; i < DAILY_CAPS.authorize.reserve; i++) {
			expect((await handleRequest(new Request(url, { headers: { "cf-connecting-ip": late } }), env, ctx)).status).toBe(200);
		}
		const put = vi.spyOn(env.OAUTH_KV, "put");
		const capped = await handleRequest(new Request(url, { headers: { "cf-connecting-ip": late } }), env, ctx);
		expect(capped.status).toBe(429);
		expect(Number(capped.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(await capped.text()).toContain("too many new connections today");
		expect(put).not.toHaveBeenCalled();
		// An invalid request is refused before it is counted.
		await clear();
		const bad = await handleRequest(new Request(`${ORIGIN}/authorize?client_id=nope`, { headers: { "cf-connecting-ip": nextIp() } }), env, ctx);
		expect(bad.status).toBe(400);
		expect(await count(`g:authorize:${day()}`)).toBe(0);
	});
	it("one caller's cap leaves everyone else alone", async () => {
		fakeWithQa();
		const cid = await register();
		const url = await authorizeUrl(cid);
		const me = "2001:db8:aaaa:bbbb::1";
		for (let i = 0; i < DAILY_CAPS.authorize.perCaller; i++) expect((await takeDaily(env, "authorize", `2001:db8:aaaa:bbbb::${(i % 9) + 1}`)).ok).toBe(true);
		const mine = await handleRequest(new Request(url, { headers: { "cf-connecting-ip": me } }), env, ctx);
		expect(mine.status).toBe(429);
		expect(await mine.text()).toContain("from your network");
		const other = await handleRequest(new Request(url, { headers: { "cf-connecting-ip": nextIp() } }), env, ctx);
		expect(other.status).toBe(200);
	});
	it("registrations: counted; at the cap, 429 JSON and no client stored", async () => {
		await register();
		expect(await count(`g:register:${day()}`)).toBe(1);
		await setCount(`g:register:${day()}`, DAILY_CAPS.register.global);
		const late = nextIp();
		const reg = () =>
			handleRequest(
				new Request(`${ORIGIN}/oauth/register`, {
					method: "POST",
					headers: { "content-type": "application/json", "cf-connecting-ip": late },
					body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "Claude" }),
				}),
				env,
				ctx,
			);
		// The network's reserve still registers (DESIGN 29.1), then 429.
		for (let i = 0; i < DAILY_CAPS.register.reserve; i++) expect((await reg()).status).toBe(201);
		const put = vi.spyOn(env.OAUTH_KV, "put");
		const res = await reg();
		expect(res.status).toBe(429);
		expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(((await res.json()) as { error: string }).error).toBe("slow_down");
		expect(put).not.toHaveBeenCalled();
	});
	it("a malformed or refused registration uses no unit of the day's cap; a stored one uses one (section 30.1)", async () => {
		const reg = (body: string, extra: Record<string, string> = {}) =>
			handleRequest(
				new Request(`${ORIGIN}/oauth/register`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": nextIp(), ...extra }, body }),
				env,
				ctx,
			);
		const refused: [string, string][] = [
			["{}", "no redirect_uris (the library refuses it)"],
			["not json", "not JSON"],
			["[1,2]", "not an object"],
			[JSON.stringify({ redirect_uris: ["https://evil.test/cb"], token_endpoint_auth_method: "none" }), "a redirect off the allowlist"],
			[JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", response_types: ["token"] }), "our policy refuses it"],
			[JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: 42 }), "a bad client_name"],
		];
		const put = vi.spyOn(env.OAUTH_KV, "put");
		for (const [body, why] of refused) expect((await reg(body)).status, why).toBe(400);
		expect(put).not.toHaveBeenCalled();
		expect(await count(`g:register:${day()}`)).toBe(0);
		// A caller can't hand the library an admission of its own: the router replaces the header.
		const ok = await reg(JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "Claude" }), { "x-nx-dcr-admit": "f".repeat(32) });
		expect(ok.status).toBe(201);
		expect(await count(`g:register:${day()}`)).toBe(1);
	});
	it("five networks can't use up the day's registrations: a sixth still gets more than its reserve (section 30.1)", async () => {
		const caps = DAILY_CAPS.register;
		// It takes at least 100 networks to use up the day's total (it took 5 before).
		expect(caps.global / caps.perCaller).toBeGreaterThanOrEqual(100);
		expect(DAILY_CAPS.authorize.global / DAILY_CAPS.authorize.perCaller).toBeGreaterThanOrEqual(30);
		for (let n = 0; n < 5; n++) {
			const net = nextIp();
			for (let i = 0; i < caps.perCaller; i++) expect((await takeDaily(env, "register", net)).ok).toBe(true);
			expect(await takeDaily(env, "register", net)).toMatchObject({ ok: false, scope: "caller" });
		}
		const sixth = nextIp();
		for (let i = 0; i < caps.perCaller; i++) expect((await takeDaily(env, "register", sixth)).ok, `unit ${i + 1}`).toBe(true);
		expect(caps.perCaller).toBeGreaterThan(caps.reserve);
		expect(await count(`g:register:${day()}`)).toBe(6 * caps.perCaller);
	});
	it("a registration at the cap is refused before the library writes, also when the Quota object is down", async () => {
		await setCount(`g:register:${day()}`, DAILY_CAPS.register.global);
		const me = nextIp();
		for (let i = 0; i < DAILY_CAPS.register.reserve; i++) await takeDaily(env, "register", me);
		const put = vi.spyOn(env.OAUTH_KV, "put");
		const res = await handleRequest(
			new Request(`${ORIGIN}/oauth/register`, {
				method: "POST",
				headers: { "content-type": "application/json", "cf-connecting-ip": me },
				body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
			}),
			env,
			ctx,
		);
		expect(res.status).toBe(429);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const retry = Number(res.headers.get("retry-after"));
		expect(retry).toBeGreaterThan(0);
		expect(retry).toBeLessThanOrEqual(86400);
		expect(await res.json()).toEqual({ error: "slow_down", error_description: "Too many app registrations today. Try again tomorrow." });
		expect(put).not.toHaveBeenCalled();
	});
	it("a Quota outage fails closed: 503 with Retry-After, nothing written", async () => {
		fakeWithQa();
		const cid = await register();
		const url = await authorizeUrl(cid);
		const broken = {
			...env,
			QUOTA: {
				idFromName: () => ({}),
				get: () => ({ take: async () => Promise.reject(new Error("quota down")) }),
			} as unknown as typeof env.QUOTA,
		};
		const put = vi.spyOn(env.OAUTH_KV, "put");
		const page = await handleRequest(new Request(url, { headers: { "cf-connecting-ip": nextIp() } }), broken, ctx);
		expect(page.status).toBe(503);
		expect(page.headers.get("retry-after")).toBe("60");
		const reg = await handleRequest(
			new Request(`${ORIGIN}/oauth/register`, {
				method: "POST",
				headers: { "content-type": "application/json", "cf-connecting-ip": nextIp() },
				body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "Claude" }),
			}),
			broken,
			ctx,
		);
		expect(reg.status).toBe(503);
		expect(reg.headers.get("retry-after")).toBe("60");
		expect(put).not.toHaveBeenCalled();
	});
});
