/**
 * Supabase's key set (DESIGN 29.5): a signing-key rotation must not stop every "Log in with Nourax"
 * sign-in for an hour. A token whose key id isn't in the cached set reloads the set once and is
 * checked again, at most once a minute per isolate; a set with no ES256 key is kept for 60 s only.
 */
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetJwksCache, checkAccessToken, JWKS_RELOAD_GAP_MS, JWKS_SHORT_CACHE_MS, supabaseKeys } from "../../src/auth/jwt";
import { type FakeNc, SUPABASE } from "../fake-nc/index";
import { env, fakeWithQa } from "../helpers/index";

const CLIENT = "7a0c9a52-3c1e-4c55-9d1f-2f6a0b9e4c11";
const SUB = "5d7f9a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
let fake: FakeNc;
let published: JWK[] = [];
let fetches = 0;
const keys: Record<string, { jwk: JWK; priv: CryptoKey }> = {};
const t0 = Date.now();
const at = (ms: number) => vi.spyOn(Date, "now").mockReturnValue(t0 + ms);

beforeAll(async () => {
	for (const kid of ["old", "new", "forged"]) {
		const kp = await generateKeyPair("ES256", { extractable: true });
		keys[kid] = { jwk: { ...(await exportJWK(kp.publicKey)), kid, alg: "ES256", use: "sig" }, priv: kp.privateKey as CryptoKey };
	}
});

beforeEach(() => {
	_resetJwksCache();
	fake = fakeWithQa();
	fetches = 0;
	fake.on(
		"GET",
		/^\/auth\/v1\/\.well-known\/jwks\.json$/,
		() => {
			fetches++;
			return Response.json({ keys: published });
		},
		new URL(SUPABASE).host,
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	_resetJwksCache();
});

async function token(kid: string): Promise<string> {
	const now = Math.floor(t0 / 1000);
	return new SignJWT({ role: "authenticated", client_id: CLIENT, is_anonymous: false })
		.setProtectedHeader({ alg: "ES256", kid })
		.setIssuer(`${SUPABASE}/auth/v1`)
		.setAudience("authenticated")
		.setSubject(SUB)
		.setIssuedAt(now)
		.setExpirationTime(now + 3600)
		.sign((keys[kid] as { priv: CryptoKey }).priv);
}

const check = async (tok: string) => checkAccessToken(tok, { supabaseUrl: SUPABASE, clientId: CLIENT, keys: await supabaseKeys(env, SUPABASE) });

describe("an unknown key id", () => {
	it("Supabase added a key: one reload, and the token checks", async () => {
		published = [(keys.old as { jwk: JWK }).jwk];
		at(0);
		expect((await check(await token("old"))).sub).toBe(SUB);
		expect(fetches).toBe(1);
		// Rotation: the new key is published, and the cached set (an hour) doesn't have it.
		published = [(keys.old as { jwk: JWK }).jwk, (keys.new as { jwk: JWK }).jwk];
		at(JWKS_RELOAD_GAP_MS + 1_000);
		expect((await check(await token("new"))).sub).toBe(SUB);
		expect(fetches).toBe(2);
		// The reloaded set is kept: the next token with that key needs no fetch.
		expect((await check(await token("new"))).sub).toBe(SUB);
		expect(fetches).toBe(2);
	});
	it("at most one reload a minute per isolate: made-up key ids can't flood Supabase's JWKS endpoint", async () => {
		published = [(keys.old as { jwk: JWK }).jwk];
		at(0);
		await check(await token("old"));
		expect(fetches).toBe(1);
		at(1_000);
		// Within the gap after the last fetch: refused without asking Supabase.
		await expect(check(await token("forged"))).rejects.toMatchObject({ reason: "ERR_JWKS_NO_MATCHING_KEY" });
		expect(fetches).toBe(1);
		at(JWKS_RELOAD_GAP_MS + 2_000);
		await expect(check(await token("forged"))).rejects.toMatchObject({ reason: "ERR_JWKS_NO_MATCHING_KEY" });
		expect(fetches).toBe(2);
		// And again within the gap of that reload: no further fetch.
		at(JWKS_RELOAD_GAP_MS + 3_000);
		await expect(check(await token("forged"))).rejects.toMatchObject({ reason: "ERR_JWKS_NO_MATCHING_KEY" });
		expect(fetches).toBe(2);
	});
});

describe("what is cached", () => {
	it("a set with no ES256 key is kept for 60 s only; a good set for the hour", async () => {
		published = [];
		at(0);
		await supabaseKeys(env, SUPABASE);
		expect(fetches).toBe(1);
		at(JWKS_SHORT_CACHE_MS - 1_000);
		await supabaseKeys(env, SUPABASE);
		expect(fetches).toBe(1);
		published = [(keys.old as { jwk: JWK }).jwk];
		at(JWKS_SHORT_CACHE_MS + 1_000);
		expect((await check(await token("old"))).sub).toBe(SUB);
		expect(fetches).toBe(2);
		at(30 * 60_000);
		await supabaseKeys(env, SUPABASE);
		expect(fetches).toBe(2);
	});
	it("an unreachable key set fails the check plainly and isn't cached", async () => {
		fake.on("GET", /^\/auth\/v1\/\.well-known\/jwks\.json$/, () => new Response("down", { status: 503 }), new URL(SUPABASE).host);
		at(0);
		await expect(supabaseKeys(env, SUPABASE)).rejects.toMatchObject({ reason: "jwks_unavailable" });
	});
});
