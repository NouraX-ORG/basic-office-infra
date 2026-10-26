import { exportJWK, generateKeyPair, SignJWT, type JWK, createLocalJWKSet } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkClientMetadata, clientLabel, redirectAllowed } from "../../src/auth/dcr";
import { devActive, devMisconfigured } from "../../src/auth/dev-guard";
import { checkAccessToken, checkIdToken, TokenCheckFailed } from "../../src/auth/jwt";
import { b64url, utf8 } from "../../src/core/bytes";
import { config } from "../../src/env";
import { call, env, fakeWithQa } from "../helpers/index";

afterEach(() => vi.restoreAllMocks());

const allow = () => config(env).allowedRedirects;

describe("redirect allowlist", () => {
	it.each([
		["https://claude.ai/api/mcp/auth_callback", true],
		["https://claude.com/api/mcp/auth_callback", true],
		["https://chatgpt.com/connector_platform_oauth_redirect", true],
		["https://chatgpt.com/connector/oauth/abc123", true],
		["http://localhost:33418/callback", true],
		["http://127.0.0.1:6274/oauth/callback", true],
		["http://[::1]:9000/cb", true],
		["https://claude.ai/api/mcp/auth_callback/extra", false],
		["https://claude.ai.evil.test/api/mcp/auth_callback", false],
		["https://chatgpt.com/connector/oauth/../../evil", false],
		["https://chatgpt.com/connector/oauth/%2e%2e/x", false],
		["https://evil.test/callback", false],
		["http://claude.ai/api/mcp/auth_callback", false],
		["https://localhost/callback", false],
		["http://localhost.evil.test/cb", false],
		["http://user@localhost:1/cb", false],
		["https://claude.ai/api/mcp/auth_callback#x", false],
		["javascript:alert(1)", false],
		["com.example.app:/oauth", false],
	])("%s -> %s", (uri, expected) => {
		expect(redirectAllowed(uri, allow())).toBe(expected);
	});
});

describe("client registration policy", () => {
	const good = { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: "Claude" };
	it("accepts the big clients' shapes, without application_type or client_name", () => {
		expect(checkClientMetadata(good, allow())).toBeNull();
		expect(checkClientMetadata({ redirect_uris: ["http://localhost:5555/callback"] }, allow())).toBeNull();
	});
	it.each([
		[{ ...good, redirect_uris: ["https://evil.test/cb"] }, "redirect_not_allowed"],
		[{ ...good, redirect_uris: [] }, "redirect_uris"],
		[{ ...good, software_statement: "x.y.z" }, "software_statement"],
		[{ ...good, jwks_uri: "https://evil.test/jwks" }, "jwks"],
		[{ ...good, client_name: "x".repeat(61) }, "client_name"],
		[{ ...good, client_name: "bad\nname" }, "client_name"],
		[{ ...good, grant_types: ["client_credentials"] }, "grant_types"],
		[{ ...good, response_types: ["token"] }, "response_types"],
		[{ ...good, token_endpoint_auth_method: "private_key_jwt" }, "auth_method"],
	])("refuses %#", (meta, reason) => {
		expect(checkClientMetadata(meta as Record<string, unknown>, allow())).toBe(reason);
	});
	it("through the Worker: allowed and refused registrations", async () => {
		fakeWithQa();
		const ok = await call("/oauth/register", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.20" }, body: JSON.stringify(good) });
		expect(ok.status).toBe(201);
		const j = (await ok.json()) as { client_id: string };
		expect(j.client_id).toBeTruthy();
		const bad = await call("/oauth/register", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.20" }, body: JSON.stringify({ ...good, redirect_uris: ["https://evil.test/cb"] }) });
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { error: string }).error).toBe("invalid_redirect_uri");
	});
	it("labels clients plainly, without the upstream brand", () => {
		expect(clientLabel("anything", "https://claude.ai/api/mcp/auth_callback")).toBe("Claude");
		expect(clientLabel(undefined, "https://chatgpt.com/connector_platform_oauth_redirect")).toBe("ChatGPT");
		expect(clientLabel("My helper <script>", "http://localhost:1/cb")).toBe("My helper script");
		// A name carrying the upstream product name is shown as plain "AI app" (fix round 4: before, the
		// brand was cut out and the rest kept).
		expect(clientLabel(`My ${["Next", "cloud"].join("")} helper <script>`, "http://localhost:1/cb")).toBe("AI app");
		expect(clientLabel("", "http://127.0.0.1:1/cb")).toBe("App on this computer");
	});
});

describe("Supabase token checks (ES256 only)", () => {
	const SUPA = "https://tbwrezvhgoryzycjerrl.supabase.co";
	const CLIENT = "mcp-client-id";
	const SUB = "5224252b-4938-4a86-a276-54bbae5d5b49";
	async function setup() {
		const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
		const jwk = (await exportJWK(publicKey)) as JWK;
		jwk.kid = "k1";
		jwk.alg = "ES256";
		const keys = createLocalJWKSet({ keys: [jwk] });
		const now = Math.floor(Date.now() / 1000);
		const sign = (claims: Record<string, unknown>, header: Record<string, unknown> = {}) =>
			new SignJWT({ role: "authenticated", client_id: CLIENT, is_anonymous: false, ...claims })
				.setProtectedHeader({ alg: "ES256", kid: "k1", ...header })
				.setIssuer(`${SUPA}/auth/v1`)
				.setAudience((claims.aud as string | undefined) ?? "authenticated")
				.setSubject((claims.sub as string | undefined) ?? SUB)
				.setIssuedAt(now)
				.setExpirationTime(now + 3600)
				.sign(privateKey);
		return { keys, sign, jwk, privateKey, now };
	}
	it("accepts a good access token and id_token", async () => {
		const { keys, sign, privateKey, now } = await setup();
		const at = await checkAccessToken(await sign({}), { supabaseUrl: SUPA, clientId: CLIENT, keys });
		expect(at.sub).toBe(SUB);
		const id = await new SignJWT({ nonce: "n1", email: "x@y.z" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(`${SUPA}/auth/v1`).setAudience(CLIENT).setSubject(SUB).setIssuedAt(now).setExpirationTime(now + 3600).sign(privateKey);
		expect((await checkIdToken(id, { supabaseUrl: SUPA, clientId: CLIENT, keys, nonce: "n1", sub: SUB })).email).toBe("x@y.z");
		await expect(checkIdToken(id, { supabaseUrl: SUPA, clientId: CLIENT, keys, nonce: "other", sub: SUB })).rejects.toThrow(TokenCheckFailed);
		await expect(checkIdToken(id, { supabaseUrl: SUPA, clientId: CLIENT, keys, nonce: "n1", sub: "0".repeat(8) })).rejects.toThrow(TokenCheckFailed);
	});
	it("refuses another client, role, issuer, audience, anonymous users and bad subs", async () => {
		const { keys, sign } = await setup();
		const o = { supabaseUrl: SUPA, clientId: CLIENT, keys };
		await expect(checkAccessToken(await sign({ client_id: "1d6d9589-a0c0-44c3-82c8-1bfcd17415f1" }), o)).rejects.toMatchObject({ reason: "client_id" });
		await expect(checkAccessToken(await sign({ role: "service_role" }), o)).rejects.toMatchObject({ reason: "role" });
		await expect(checkAccessToken(await sign({ is_anonymous: true }), o)).rejects.toMatchObject({ reason: "anonymous" });
		await expect(checkAccessToken(await sign({ sub: "not-a-uuid" }), o)).rejects.toMatchObject({ reason: "sub" });
		await expect(checkAccessToken(await sign({}), { ...o, supabaseUrl: "https://other.supabase.co" })).rejects.toThrow(TokenCheckFailed);
		await expect(checkAccessToken(await sign({ aud: "other" }), o)).rejects.toThrow(TokenCheckFailed);
	});
	it("refuses expired tokens, alg none and HS256 signed with the public key", async () => {
		const { keys, sign, jwk, now } = await setup();
		const o = { supabaseUrl: SUPA, clientId: CLIENT, keys };
		await expect(checkAccessToken(await sign({}), { ...o, nowSec: now + 7200 })).rejects.toThrow(TokenCheckFailed);
		const payload = b64url(utf8(JSON.stringify({ iss: `${SUPA}/auth/v1`, aud: "authenticated", sub: "5224252b-4938-4a86-a276-54bbae5d5b49", role: "authenticated", client_id: CLIENT, iat: now, exp: now + 3600 })));
		const none = `${b64url(utf8(JSON.stringify({ alg: "none", typ: "JWT" })))}.${payload}.`;
		await expect(checkAccessToken(none, o)).rejects.toThrow(TokenCheckFailed);
		const hsKey = await crypto.subtle.importKey("raw", utf8(JSON.stringify(jwk)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const head = b64url(utf8(JSON.stringify({ alg: "HS256", kid: "k1", typ: "JWT" })));
		const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", hsKey, utf8(`${head}.${payload}`))));
		await expect(checkAccessToken(`${head}.${payload}.${sig}`, o)).rejects.toThrow(TokenCheckFailed);
	});
});

describe("dev-only auth guards", () => {
	const req = (url: string, ip?: string) => new Request(url, { headers: ip ? { "cf-connecting-ip": ip } : {} });
	it("are on only for loopback dev", () => {
		expect(devActive(env, req("http://localhost:8787/dev/token"))).toBe(true);
		expect(devActive(env, req("http://localhost:8787/dev/token", "127.0.0.1"))).toBe(true);
		expect(devActive(env, req("http://localhost:8787/dev/token", "203.0.113.1"))).toBe(false);
		expect(devActive({ ...env, NX_ENV: "production" }, req("http://localhost:8787/x"))).toBe(false);
		expect(devActive({ ...env, PUBLIC_ORIGIN: "https://mcp.nourax.org" }, req("http://localhost:8787/x"))).toBe(false);
		expect(devActive(env, req("https://mcp.nourax.org/x"))).toBe(false);
	});
	it("QA credentials outside loopback fail closed for every request", async () => {
		expect(devMisconfigured(env)).toBe(false);
		expect(devMisconfigured({ ...env, PUBLIC_ORIGIN: "https://mcp.nourax.org" })).toBe(true);
		const { handleRequest } = await import("../../src/http/router");
		const res = await handleRequest(new Request("https://mcp.nourax.org/"), { ...env, PUBLIC_ORIGIN: "https://mcp.nourax.org", NX_ENV: "production" }, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
		expect(res.status).toBe(503);
	});
	it("/dev/* is not reachable from a non-loopback address", async () => {
		fakeWithQa();
		const res = await call("/dev/token", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.5" }, body: JSON.stringify({ uid: "qa-t1-91" }) });
		expect(res.status).toBe(404);
	});
});
