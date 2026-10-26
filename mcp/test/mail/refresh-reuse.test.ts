/**
 * Caller rule 2 (brief 5): when two requests get a NoMail 401, only one rotates the upstream refresh
 * token and the other reuses the new token, also when the second 401 arrives after the first
 * refresh has already finished (another isolate). The vault compares the token that got the 401
 * with the one it holds.
 */
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "../../src/core/bytes";
import { config } from "../../src/env";
import { mailContext } from "../../src/mcp/mail-ctx";
import type { NewConnection, OpenOk } from "../../src/vault/schema";
import { type Vault, vaultFor } from "../../src/vault/vault";
import { FakeNc, SUPABASE } from "../fake-nc/index";
import { env } from "../helpers/index";

afterEach(() => vi.restoreAllMocks());

const UID = "22222222-3333-4444-8555-666666666666";
let n = 0;
const uid = () => `${UID.slice(0, -4)}${String(++n).padStart(4, "0")}`;
const cid = () => [...randomBytes(16)].map((b) => b.toString(16).padStart(2, "0")).join("");
const nowSec = () => Math.floor(Date.now() / 1000);

function conn(u: string, accessToken: string, expiresIn: number): NewConnection {
	return {
		connectionId: cid(),
		uid: u,
		kind: "oauth",
		clientId: "client-e",
		clientLabel: "Claude",
		scopes: ["workspace.read", "mail.read"],
		apps: ["files", "mail"],
		cred: { loginName: u, appPassword: "APP-PASSWORD-0123456789-abcdefghij" },
		displayName: "Test Person",
		upstream: { accessToken, refreshToken: "refresh-1", expiresAt: nowSec() + expiresIn },
		idleSec: 14 * 86400,
		maxAgeSec: 60 * 86400,
	};
}

function supabaseFake() {
	const fake = new FakeNc();
	const seen = { calls: 0 };
	fake.on(
		"POST",
		/^\/auth\/v1\/oauth\/token$/,
		async () => {
			seen.calls++;
			return Response.json({ access_token: `rotated-${seen.calls}`, refresh_token: `refresh-${seen.calls + 1}`, expires_in: 3600 });
		},
		new URL(SUPABASE).host,
	);
	fake.install();
	return seen;
}

const upstreamEnv = () => ({ ...env, SUPABASE_OAUTH_CLIENT_ID: "cid", SUPABASE_OAUTH_CLIENT_SECRET: "csecret" });

describe("Vault.refreshUpstream with the token that got the 401", () => {
	it("hands back a token another request stored meanwhile, without rotating again", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		// The stored token is already the new one: another request refreshed after the same 401.
		const c = conn(u, "access-B", 3600);
		const key = randomBytes(32);
		await v.createConnection(c, key);
		const seen = supabaseFake();
		await runInDurableObject(v, async (instance: Vault) => {
			(instance as unknown as { env: unknown }).env = upstreamEnv();
			const r = await instance.refreshUpstream(c.connectionId, key, true, "access-A");
			expect(r).toEqual({ accessToken: "access-B", expiresAt: expect.any(Number) });
			expect(seen.calls).toBe(0);
			// The stored token itself was refused: that one is rotated, once.
			const again = await instance.refreshUpstream(c.connectionId, key, true, "access-B");
			expect("accessToken" in again && again.accessToken).toBe("rotated-1");
			expect(seen.calls).toBe(1);
			// Without a token to compare, a forced refresh always rotates (core's behaviour, unchanged).
			const forced = await instance.refreshUpstream(c.connectionId, key, true);
			expect("accessToken" in forced && forced.accessToken).toBe("rotated-2");
			expect(seen.calls).toBe(2);
		});
	});
	it("a different stored token that is about to expire is still refreshed", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const c = conn(u, "access-B", 60);
		const key = randomBytes(32);
		await v.createConnection(c, key);
		const seen = supabaseFake();
		await runInDurableObject(v, async (instance: Vault) => {
			(instance as unknown as { env: unknown }).env = upstreamEnv();
			const r = await instance.refreshUpstream(c.connectionId, key, true, "access-A");
			expect("accessToken" in r && r.accessToken).toBe("rotated-1");
			expect(seen.calls).toBe(1);
		});
	});
	it("two requests with the same refused token: one rotation in all, the later one reuses it", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const c = conn(u, "access-A", 3600);
		const key = randomBytes(32);
		await v.createConnection(c, key);
		const seen = supabaseFake();
		await runInDurableObject(v, async (instance: Vault) => {
			(instance as unknown as { env: unknown }).env = upstreamEnv();
			const first = await instance.refreshUpstream(c.connectionId, key, true, "access-A");
			const second = await instance.refreshUpstream(c.connectionId, key, true, "access-A");
			expect(first).toEqual(second);
			expect(seen.calls).toBe(1);
		});
	});
	it("a forced refresh that starts while a non-forced one runs doesn't take its answer (fix round 3)", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		// The stored token is fresh, so the non-forced call returns it as it is.
		const c = conn(u, "access-A", 3600);
		const key = randomBytes(32);
		await v.createConnection(c, key);
		const seen = supabaseFake();
		await runInDurableObject(v, async (instance: Vault) => {
			(instance as unknown as { env: unknown }).env = upstreamEnv();
			const plain = instance.refreshUpstream(c.connectionId, key, false);
			// Meanwhile NoMail refused that very token: the forced call must rotate it.
			const forced = instance.refreshUpstream(c.connectionId, key, true, "access-A");
			const [a, b] = await Promise.all([plain, forced]);
			expect("accessToken" in a && a.accessToken).toBe("access-A");
			expect("accessToken" in b && b.accessToken).toBe("rotated-1");
			expect(seen.calls).toBe(1);
		});
	});
});

describe("mailContext passes the refused token to the vault", () => {
	it("refreshUpstream(used) asks the vault with force and that token", async () => {
		const calls: unknown[][] = [];
		const vault = {
			refreshUpstream: async (...args: unknown[]) => {
				calls.push(args);
				return { accessToken: "fresh-token", expiresAt: nowSec() + 3600 };
			},
		};
		const open = { upstream: { state: "ok", accessToken: "old-token", expiresAt: nowSec() + 3600 }, mailState: "ok" } as unknown as OpenOk;
		const e = { ...env, NOMAIL_TOOLS_URL: "https://mail-tools.nomail.test/functions/v1/mcp-tools", NOMAIL_TOOLS_KEY: "k".repeat(43) } as typeof env;
		const key = randomBytes(32);
		const ctx = mailContext({ env: e, cfg: config(e), rid: "r", open, scopes: ["workspace.read", "mail.read"], apps: ["mail"], vault: vault as never, connectionId: "conn-1", useKey: key });
		expect(ctx.active).toBe(true);
		expect(await ctx.upstreamToken()).toBe("old-token");
		expect(await ctx.refreshUpstream("old-token")).toBe("fresh-token");
		expect(calls).toEqual([["conn-1", key, true, "old-token"]]);
		expect(await ctx.upstreamToken()).toBe("fresh-token");
	});
});
