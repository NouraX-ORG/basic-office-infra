import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "../../src/core/bytes";
import { PER_MINUTE } from "../../src/core/limits";
import { hkdf, open, recordAad, revokeKek, seal, unwrapKey, useKek, wrapKey } from "../../src/vault/crypto";
import type { NewConnection } from "../../src/vault/schema";
import { revokeAnswerGone, revokeBackoffSec, type Vault, vaultFor } from "../../src/vault/vault";
import { FakeNc, SUPABASE } from "../fake-nc/index";
import { env } from "../helpers/index";

afterEach(() => vi.restoreAllMocks());

const UID = "11111111-2222-4333-8444-555555555555";
let n = 0;
const uid = () => `${UID.slice(0, -4)}${String(++n).padStart(4, "0")}`;
const cid = () => [...randomBytes(16)].map((b) => b.toString(16).padStart(2, "0")).join("");

function conn(u: string, over: Partial<NewConnection> = {}): NewConnection {
	return {
		connectionId: cid(),
		uid: u,
		kind: "oauth",
		clientId: "client-a",
		clientLabel: "Claude",
		scopes: ["workspace.read", "workspace.write"],
		apps: ["files", "calendar"],
		cred: { loginName: u, appPassword: "APP-PASSWORD-0123456789-abcdefghij" },
		displayName: "Test Person",
		upstream: null,
		idleSec: 14 * 86400,
		maxAgeSec: 60 * 86400,
		...over,
	};
}

describe("vault crypto in workerd", () => {
	it("AES-KW and HKDF work; wrong key or AAD fails", async () => {
		const dek = randomBytes(32);
		const kek = await hkdf(randomBytes(32), "salt", "info");
		const wrapped = await wrapKey(kek, dek);
		expect([...(await unwrapKey(kek, wrapped))]).toEqual([...dek]);
		await expect(unwrapKey(await hkdf(randomBytes(32), "salt", "info"), wrapped)).rejects.toThrow();
		const aad = recordAad("u", "c", "cred", 1);
		const sealed = await seal(dek, new TextEncoder().encode("secret"), aad);
		expect(new TextDecoder().decode(await open(dek, sealed, aad))).toBe("secret");
		await expect(open(dek, sealed, recordAad("u", "other", "cred", 1))).rejects.toThrow();
		await expect(open(randomBytes(32), sealed, aad)).rejects.toThrow();
	});
	it("a rotated pepper breaks the use-wrap but the revoke-wrap still works", async () => {
		const dek = randomBytes(32);
		const vk = randomBytes(32);
		const wrapUse = await wrapKey(await useKek(vk, randomBytes(32), "u", "c"), dek);
		await expect(unwrapKey(await useKek(vk, randomBytes(32), "u", "c"), wrapUse)).rejects.toThrow();
		const wrapRev = await wrapKey(await revokeKek("revoke-secret-0123456789abcdef0123", "u", "c"), dek);
		expect([...(await unwrapKey(await revokeKek("revoke-secret-0123456789abcdef0123", "u", "c"), wrapRev))]).toEqual([...dek]);
	});
});

describe("Vault", () => {
	it("stores, opens with the right key only, and keeps nothing readable at rest", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const c = conn(u);
		const key = randomBytes(32);
		expect(await v.createConnection(c, key)).toEqual({ ok: true, replaced: 0 });
		const o = await v.open(c.connectionId, key, {});
		expect(o.ok).toBe(true);
		if (o.ok) {
			expect(o.cred.appPassword).toBe(c.cred.appPassword);
			expect(o.scopes).toEqual(c.scopes);
			expect(o.displayName).toBe("Test Person");
		}
		await runInDurableObject(v, async (_i: Vault, state) => {
			const rows = state.storage.sql.exec("SELECT * FROM conn").toArray();
			const dump = JSON.stringify(rows);
			expect(dump).not.toContain(c.cred.appPassword);
			expect(dump).not.toContain("Test Person");
		});
		// A wrong key ends the connection for good (key_rotated) instead of retrying.
		const fake = new FakeNc();
		fake.addUser({ uid: u, password: c.cred.appPassword });
		fake.install();
		const bad = await v.open(c.connectionId, randomBytes(32), {});
		expect(bad).toEqual({ ok: false, reason: "revoked" });
		expect(fake.requests.some((r) => r.method === "DELETE" && r.url.pathname === "/ocs/v2.php/core/apppassword")).toBe(true);
		expect(await v.status(c.connectionId)).toBe("revoked");
	});

	it("revokeAndWipe revokes the app password with its own credential and returns no plaintext", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const c = conn(u);
		await v.createConnection(c, randomBytes(32));
		const fake = new FakeNc();
		fake.addUser({ uid: u, password: c.cred.appPassword });
		fake.install();
		const r = await v.revokeAndWipe(c.connectionId, "user");
		expect(r).toEqual({ revoked: true });
		expect(JSON.stringify(r)).not.toContain(c.cred.appPassword);
		expect(fake.users.get(u)?.passwords.has(c.cred.appPassword)).toBe(false);
		const del = fake.requests.find((x) => x.method === "DELETE");
		expect(del?.auth).toBe(u);
		expect(await v.status(c.connectionId)).toBe("revoked");
	});

	it("keeps a revocation pending when NoDrive is down, and the alarm finishes it", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const c = conn(u);
		await v.createConnection(c, randomBytes(32));
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }));
		expect(await v.revokeAndWipe(c.connectionId, "user")).toEqual({ revoked: false });
		expect((await v.listConnections())[0]?.status).toBe("revoking");
		vi.restoreAllMocks();
		const fake = new FakeNc();
		fake.addUser({ uid: u, password: c.cred.appPassword });
		fake.install();
		// Not due yet (backoff): the alarm leaves it alone.
		await runDurableObjectAlarm(v);
		expect((await v.listConnections())[0]?.status).toBe("revoking");
		await runInDurableObject(v, async (_i: Vault, state) => {
			state.storage.sql.exec("UPDATE conn SET last_used_at = last_used_at - 601");
		});
		await runDurableObjectAlarm(v);
		expect(await v.listConnections()).toEqual([]);
		expect(fake.users.get(u)?.passwords.has(c.cred.appPassword)).toBe(false);
	});

	it("never drops a row while its app password may still work: still queued after 30 failures, retried daily", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const c = conn(u);
		await v.createConnection(c, randomBytes(32));
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }));
		await v.revokeAndWipe(c.connectionId, "user");
		await runInDurableObject(v, async (_i: Vault, state) => {
			state.storage.sql.exec("UPDATE conn SET revoke_tries = 30, last_used_at = last_used_at - 90000");
		});
		await runDurableObjectAlarm(v);
		const rows = await v.listConnections();
		expect(rows.length).toBe(1);
		expect(rows[0]?.status).toBe("revoking");
		expect(await v.status(c.connectionId)).toBe("revoked");
		await runInDurableObject(v, async (_i: Vault, state) => {
			const r = state.storage.sql.exec<{ revoke_tries: number; last_used_at: number }>("SELECT revoke_tries, last_used_at FROM conn").one();
			expect(Number(r.revoke_tries)).toBe(31);
			// The next try is a day after this one.
			expect(Number(r.last_used_at) + revokeBackoffSec(31) - Math.floor(Date.now() / 1000)).toBeGreaterThan(86000);
			expect((await state.storage.getAlarm()) ?? 0).toBeGreaterThan(Date.now());
		});
		expect(revokeBackoffSec(1)).toBe(600);
		expect(revokeBackoffSec(6)).toBe(600);
		expect(revokeBackoffSec(7)).toBe(1200);
		expect(revokeBackoffSec(13)).toBe(76800);
		expect(revokeBackoffSec(14)).toBe(86400);
		expect(revokeBackoffSec(500)).toBe(86400);
	});

	it("a revoke-wrap that can't be opened any more goes to the owner's unrevoked list, with no secrets", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const c = conn(u, { clientLabel: "ChatGPT" });
		await v.createConnection(c, randomBytes(32));
		const spy = vi.spyOn(globalThis, "fetch");
		await runInDurableObject(v, async (instance: Vault) => {
			// NX_REVOKE_SECRET rotated: a different, valid secret.
			(instance as unknown as { env: unknown }).env = { ...env, NX_REVOKE_SECRET: "rotated-revoke-secret-0123456789abcdef0123" };
			expect(await instance.revokeAndWipe(c.connectionId, "user")).toEqual({ revoked: false });
			(instance as unknown as { env: unknown }).env = env;
		});
		expect(spy).not.toHaveBeenCalled();
		expect(await v.listConnections()).toEqual([]);
		expect(await v.status(c.connectionId)).toBe("revoked");
		const list = await v.listUnrevoked();
		expect(list).toEqual([expect.objectContaining({ connectionId: c.connectionId, kind: "oauth", clientLabel: "ChatGPT", reason: "user" })]);
		expect(JSON.stringify(list)).not.toContain(c.cred.appPassword);
		expect(await v.clearUnrevoked(c.connectionId)).toBe(true);
		expect(await v.listUnrevoked()).toEqual([]);
	});

	it("without NX_REVOKE_SECRET: no new connection, and a pending revocation waits for the secret", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const c = conn(u);
		await v.createConnection(c, randomBytes(32));
		const spy = vi.spyOn(globalThis, "fetch");
		await runInDurableObject(v, async (instance: Vault) => {
			for (const bad of [undefined, "", "too-short"]) {
				(instance as unknown as { env: unknown }).env = { ...env, NX_REVOKE_SECRET: bad };
				await expect(instance.createConnection(conn(u), randomBytes(32))).rejects.toThrow(/NX_REVOKE_SECRET/);
				expect(await instance.revokeAndWipe(c.connectionId, "user")).toEqual({ revoked: false });
			}
			(instance as unknown as { env: unknown }).env = env;
		});
		expect(spy).not.toHaveBeenCalled();
		const rows = await v.listConnections();
		expect(rows.map((r) => r.status)).toEqual(["revoking"]);
		expect(await v.listUnrevoked()).toEqual([]);
		// The revoke-wrap made under a missing secret can't exist: crypto refuses it too.
		await expect(revokeKek(undefined, "u", "c")).rejects.toThrow(/NX_REVOKE_SECRET/);
		await expect(revokeKek("x".repeat(31), "u", "c")).rejects.toThrow(/NX_REVOKE_SECRET/);
	});

	it("without NX_SECRET (or with a short one): a setup fault that changes nothing, never a wipe", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const key = randomBytes(32);
		const first = conn(u, { clientLabel: "ChatGPT", upstream: { accessToken: "a", refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 30 } });
		await v.createConnection(first, key);
		for (let i = 1; i < 5; i++) await v.createConnection(conn(u, { clientLabel: `App ${i}` }), randomBytes(32));
		const spy = vi.spyOn(globalThis, "fetch");
		await runInDurableObject(v, async (instance: Vault) => {
			for (const bad of [undefined, "", "too-short"]) {
				(instance as unknown as { env: unknown }).env = { ...env, NX_SECRET: bad, SUPABASE_OAUTH_CLIENT_ID: "cid", SUPABASE_OAUTH_CLIENT_SECRET: "csecret" };
				await expect(instance.open(first.connectionId, key, { bucket: "read", weight: 1 })).rejects.toThrow(/NX_SECRET/);
				await expect(instance.dedupe(first.connectionId, key, "k", "get")).rejects.toThrow(/NX_SECRET/);
				await expect(instance.refreshUpstream(first.connectionId, key, true)).rejects.toThrow(/NX_SECRET/);
				// At the cap, a new connection of the same client would replace the oldest: refused first.
				await expect(instance.createConnection(conn(u, { clientLabel: "ChatGPT" }), randomBytes(32))).rejects.toThrow(/NX_SECRET/);
			}
			(instance as unknown as { env: unknown }).env = env;
		});
		expect(spy).not.toHaveBeenCalled();
		expect(await v.status(first.connectionId)).toBe("active");
		expect((await v.listConnections()).map((r) => r.status)).toEqual(["active", "active", "active", "active", "active"]);
		// Once the secret is back, the same connection opens as before.
		const o = await v.open(first.connectionId, key, {});
		expect(o.ok && o.cred.appPassword).toBe(first.cred.appPassword);
	});

	it("a different, valid NX_SECRET is a rotation (the kill switch): the connection ends and is revoked", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const c = conn(u);
		const key = randomBytes(32);
		await v.createConnection(c, key);
		const fake = new FakeNc();
		fake.addUser({ uid: u, password: c.cred.appPassword });
		fake.install();
		await runInDurableObject(v, async (instance: Vault) => {
			(instance as unknown as { env: unknown }).env = { ...env, NX_SECRET: "rotated-nx-secret-0123456789abcdef0123456789" };
			expect(await instance.open(c.connectionId, key, {})).toEqual({ ok: false, reason: "revoked" });
			(instance as unknown as { env: unknown }).env = env;
		});
		expect(await v.status(c.connectionId)).toBe("revoked");
		expect(fake.users.get(u)?.passwords.has(c.cred.appPassword)).toBe(false);
	});

	it("only NoDrive's own answers prove an app password is already gone", async () => {
		const ocsBody = (code: number) => JSON.stringify({ ocs: { meta: { status: "failure", statuscode: code, message: "could not remove apptoken" }, data: [] } });
		const json = { "content-type": "application/json; charset=utf-8" };
		// Fix round 4: a 401 is no proof (a disabled account answers 401 for every app password).
		expect(await revokeAnswerGone(new Response("", { status: 401 }))).toBe(false);
		expect(await revokeAnswerGone(new Response(ocsBody(997), { status: 401, headers: json }))).toBe(false);
		expect(await revokeAnswerGone(new Response(ocsBody(403), { status: 403, headers: json }))).toBe(true);
		expect(await revokeAnswerGone(new Response(ocsBody(997), { status: 403, headers: json }))).toBe(true);
		// The tunnel's catch-all rule, a Cloudflare block page, odd JSON, an OCS 404: not proof.
		expect(await revokeAnswerGone(new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } }))).toBe(false);
		expect(await revokeAnswerGone(new Response(ocsBody(404), { status: 404, headers: json }))).toBe(false);
		expect(await revokeAnswerGone(new Response("<html>Sorry, you have been blocked</html>", { status: 403, headers: { "content-type": "text/html" } }))).toBe(false);
		expect(await revokeAnswerGone(new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: json }))).toBe(false);
		expect(await revokeAnswerGone(new Response("{not json", { status: 403, headers: json }))).toBe(false);
		expect(await revokeAnswerGone(new Response(ocsBody(403), { status: 403 }))).toBe(false);
		expect(await revokeAnswerGone(new Response("", { status: 500 }))).toBe(false);
	});

	it("a plain-text 404 (not NoDrive) keeps the row queued; NoDrive's OCS 403 lets it go", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const c = conn(u);
		await v.createConnection(c, randomBytes(32));
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } }));
		expect(await v.revokeAndWipe(c.connectionId, "user")).toEqual({ revoked: false });
		expect((await v.listConnections()).map((r) => r.status)).toEqual(["revoking"]);
		vi.restoreAllMocks();
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			Response.json({ ocs: { meta: { status: "failure", statuscode: 403, message: "could not remove apptoken" }, data: [] } }, { status: 403 }),
		);
		await runInDurableObject(v, async (_i: Vault, state) => {
			state.storage.sql.exec("UPDATE conn SET last_used_at = last_used_at - 601");
		});
		await runDurableObjectAlarm(v);
		expect(await v.listConnections()).toEqual([]);
		expect(await v.listUnrevoked()).toEqual([]);
		expect(await v.status(c.connectionId)).toBe("revoked");
	});

	it("the grant check ends OAuth connections whose grant is gone or whose code was never exchanged, and keeps the rest", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const fake = new FakeNc();
		fake.addUser({ uid: u, password: "APP-PASSWORD-0123456789-abcdefghij" });
		fake.install();
		const live = conn(u, { clientId: "live" });
		const gone = conn(u, { clientId: "gone" });
		const never = conn(u, { clientId: "never" });
		const desk = conn(u, { kind: "desktop", clientId: undefined, clientLabel: "ONLYOFFICE" });
		for (const c of [live, gone, never, desk]) await v.createConnection(c, randomBytes(32));
		await v.bindGrant(live.connectionId, "LiveGrant0123456");
		await v.bindGrant(gone.connectionId, "GoneGrant0123456");
		await env.OAUTH_KV.put(`grant:${u}:LiveGrant0123456`, "{}");
		await runInDurableObject(v, async (_i: Vault, state) => {
			const at = Number(state.storage.sql.exec<{ v: number }>("SELECT v FROM meta WHERE k = 'grant_check_at'").one().v);
			expect(at - Math.floor(Date.now() / 1000)).toBeGreaterThan(3500);
			state.storage.sql.exec("UPDATE conn SET created_at = created_at - 3700");
			state.storage.sql.exec("UPDATE meta SET v = 0 WHERE k = 'grant_check_at'");
		});
		await runDurableObjectAlarm(v);
		expect(await v.status(live.connectionId)).toBe("active");
		expect(await v.status(gone.connectionId)).toBe("revoked");
		expect(await v.status(never.connectionId)).toBe("revoked");
		expect(await v.status(desk.connectionId)).toBe("active");
		expect(fake.requests.filter((r) => r.method === "DELETE" && r.url.pathname === "/ocs/v2.php/core/apppassword").length).toBe(2);
		await runInDurableObject(v, async (_i: Vault, state) => {
			const at = Number(state.storage.sql.exec<{ v: number }>("SELECT v FROM meta WHERE k = 'grant_check_at'").one().v);
			expect(at - Math.floor(Date.now() / 1000)).toBeGreaterThan(86000);
		});
		// bindGrant never moves a connection to another grant.
		await v.bindGrant(live.connectionId, "OtherGrant012345");
		expect(await v.grantOf(live.connectionId)).toBe("LiveGrant0123456");
	});

	it("a KV failure during the grant check ends nothing", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const c = conn(u);
		await v.createConnection(c, randomBytes(32));
		await v.bindGrant(c.connectionId, "MissingGrant0123");
		await runInDurableObject(v, async (instance: Vault, state) => {
			state.storage.sql.exec("UPDATE meta SET v = 0 WHERE k = 'grant_check_at'");
			(instance as unknown as { env: unknown }).env = { ...env, OAUTH_KV: { get: async () => Promise.reject(new Error("kv down")) } };
			await instance.alarm();
			(instance as unknown as { env: unknown }).env = env;
			const at = Number(state.storage.sql.exec<{ v: number }>("SELECT v FROM meta WHERE k = 'grant_check_at'").one().v);
			expect(at - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);
		});
		expect(await v.status(c.connectionId)).toBe("active");
	});

	it("never revokes the shared QA app password of a dev connection", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const c = conn(u, { kind: "dev" });
		await v.createConnection(c, randomBytes(32));
		const spy = vi.spyOn(globalThis, "fetch");
		await v.revokeAndWipe(c.connectionId, "user");
		expect(spy).not.toHaveBeenCalled();
	});

	it("counts calls exactly per person and blocks over the per-minute limit", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const c = conn(u);
		const key = randomBytes(32);
		await v.createConnection(c, key);
		// The counter is per clock minute: start well inside one, so the calls below share it (a run
		// that crossed a minute boundary found the 11th call in a fresh minute).
		while (Date.now() % 60_000 > 50_000) await new Promise((r) => setTimeout(r, 250));
		for (let i = 0; i < PER_MINUTE.share; i++) {
			const o = await v.open(c.connectionId, key, { bucket: "share", weight: 1 });
			expect(o.ok && !o.limited).toBe(true);
		}
		const over = await v.open(c.connectionId, key, { bucket: "share", weight: 1 });
		expect(over.ok).toBe(true);
		if (over.ok) {
			expect(over.limited?.reason).toBe("rate_limited");
			expect(over.limited?.retryAfterSec).toBeGreaterThan(0);
		}
		// Reads without weight (initialize, tools/list) are never blocked.
		const free = await v.open(c.connectionId, key, {});
		expect(free.ok && !free.limited).toBe(true);
	});

	it("allows 5 connections; the 6th replaces the least recently used one of the same client", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const fake = new FakeNc();
		fake.addUser({ uid: u, password: "APP-PASSWORD-0123456789-abcdefghij" });
		fake.install();
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const c = conn(u, { clientLabel: i === 0 ? "ChatGPT" : `App ${i}` });
			ids.push(c.connectionId);
			expect((await v.createConnection(c, randomBytes(32))).ok).toBe(true);
		}
		const refused = await v.createConnection(conn(u, { clientLabel: "Something new" }), randomBytes(32));
		expect(refused).toEqual({ ok: false, reason: "cap" });
		const replaced = await v.createConnection(conn(u, { clientLabel: "ChatGPT" }), randomBytes(32));
		expect(replaced).toEqual({ ok: true, replaced: 1 });
		expect(await v.status(ids[0] as string)).toBe("revoked");
		expect((await v.listConnections()).length).toBe(5);
	});

	it("ends idle and expired connections in the alarm", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const c = conn(u, { idleSec: 1 });
		await v.createConnection(c, randomBytes(32));
		const fake = new FakeNc();
		fake.addUser({ uid: u, password: c.cred.appPassword });
		fake.install();
		await runInDurableObject(v, async (_i: Vault, state) => {
			state.storage.sql.exec("UPDATE conn SET last_used_at = last_used_at - 10");
		});
		await runDurableObjectAlarm(v);
		expect(await v.status(c.connectionId)).toBe("revoked");
		expect(fake.users.get(u)?.passwords.size).toBe(0);
	});

	it("revokeForClient ends every connection of that client", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const fake = new FakeNc();
		// One app password per connection, as Login Flow v2 hands out (fix round 4: a second DELETE of
		// a password already removed answers 401, which no longer counts as "gone").
		const pass = (n: number) => `APP-PASSWORD-${n}-0123456789-abcdefghij`;
		const user = fake.addUser({ uid: u, password: pass(1) });
		user.passwords.add(pass(2)).add(pass(3));
		fake.install();
		await v.createConnection(conn(u, { clientId: "x", cred: { loginName: u, appPassword: pass(1) } }), randomBytes(32));
		await v.createConnection(conn(u, { clientId: "x", cred: { loginName: u, appPassword: pass(2) } }), randomBytes(32));
		await v.createConnection(conn(u, { clientId: "y", cred: { loginName: u, appPassword: pass(3) } }), randomBytes(32));
		expect(await v.revokeForClient("x", "replaced")).toBe(2);
		expect((await v.listConnections()).map((c) => c.clientId)).toEqual(["y"]);
	});

	it("the duplicate guard and the mail cache are encrypted with the connection key", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const c = conn(u);
		const key = randomBytes(32);
		await v.createConnection(c, key);
		await v.dedupe(c.connectionId, key, "tasks_create|{...}", "put", JSON.stringify({ at: 1, result: { secret: "dedupe-secret-value" } }));
		expect(JSON.parse((await v.dedupe(c.connectionId, key, "tasks_create|{...}", "get")) as string)).toEqual({ at: 1, result: { secret: "dedupe-secret-value" } });
		await v.mailCache(c.connectionId, key, "put", JSON.stringify([{ name: "mail_list" }]), 300);
		expect(JSON.parse((await v.mailCache(c.connectionId, key, "get"))?.value ?? "null")).toEqual([{ name: "mail_list" }]);
		expect((await v.mailCache(c.connectionId, key, "fail"))?.failures).toBe(1);
		await runInDurableObject(v, async (_i: Vault, state) => {
			expect(JSON.stringify(state.storage.sql.exec("SELECT * FROM kv").toArray())).not.toContain("dedupe-secret-value");
		});
	});

	it("refreshes the upstream token single-flight: two callers, one Supabase call, rotation saved", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const c = conn(u, { upstream: { accessToken: "old-access", refreshToken: "refresh-1", expiresAt: Math.floor(Date.now() / 1000) + 30 } });
		const key = randomBytes(32);
		await v.createConnection(c, key);
		const fake = new FakeNc();
		let calls = 0;
		fake.on(
			"POST",
			/^\/auth\/v1\/oauth\/token$/,
			async (req) => {
				calls++;
				const p = new URLSearchParams(req.body);
				expect(p.get("grant_type")).toBe("refresh_token");
				expect(p.get("refresh_token")).toBe(calls === 1 ? "refresh-1" : "refresh-2");
				await new Promise((r) => setTimeout(r, 20));
				return Response.json({ access_token: `new-access-${calls}`, refresh_token: `refresh-${calls + 1}`, expires_in: 3600 });
			},
			new URL(SUPABASE).host,
		);
		fake.install();
		const testEnv = { ...env, SUPABASE_OAUTH_CLIENT_ID: "cid", SUPABASE_OAUTH_CLIENT_SECRET: "csecret" };
		// The DO reads its own env; inject the upstream settings for this test through runInDurableObject.
		await runInDurableObject(v, async (instance: Vault) => {
			(instance as unknown as { env: unknown }).env = testEnv;
			const [a, b] = await Promise.all([instance.refreshUpstream(c.connectionId, key, true), instance.refreshUpstream(c.connectionId, key, true)]);
			expect(a).toEqual(b);
			expect(calls).toBe(1);
			const again = await instance.refreshUpstream(c.connectionId, key, true);
			expect(calls).toBe(2);
			expect("accessToken" in again && again.accessToken).toBe("new-access-2");
		});
		const o = await v.open(c.connectionId, key, {});
		expect(o.ok && o.upstream.accessToken).toBe("new-access-2");
	});
});
