/**
 * Pins the OAuth library's grant layout that src/auth/grants.ts relies on (grant key, token and code
 * shape), against the real library through the Worker. If a library update changes them, this
 * fails here instead of the vault's grant check quietly ending connections.
 */
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantExists, grantIdFromRedirect, grantKvKey, grantOfToken } from "../../src/auth/grants";
import { providerOptions } from "../../src/auth/provider";
import { vaultFor } from "../../src/vault/vault";
import { devToken, env, fakeWithQa, QA } from "../helpers/index";

beforeEach(() => {
	fakeWithQa();
});
afterEach(() => vi.restoreAllMocks());

describe("the library's grant records", () => {
	it("tokens are <uid>:<grantId>:<secret>, the grant is at grant:<uid>:<grantId>, and revokeGrant removes it", async () => {
		const t = await devToken(QA.a);
		const a = grantOfToken(t.access_token);
		const r = grantOfToken(t.refresh_token);
		expect(a).toEqual({ uid: QA.a, grantId: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/) });
		expect(r).toEqual(a);
		const grantId = (a as { grantId: string }).grantId;
		expect(await grantExists(env.OAUTH_KV, QA.a, grantId)).toBe(true);
		expect(await env.OAUTH_KV.get(grantKvKey(QA.a, grantId))).not.toBeNull();
		// The vault row points at the same grant (bound at the code exchange).
		expect(await vaultFor(env, QA.a).grantOf(t.connection_id)).toBe(grantId);
		const helpers = getOAuthApi(providerOptions(env), env);
		expect((await helpers.listUserGrants(QA.a)).items.map((g) => g.id)).toContain(grantId);
		await helpers.revokeGrant(grantId, QA.a);
		expect(await grantExists(env.OAUTH_KV, QA.a, grantId)).toBe(false);
	});
	it("reads grant ids only from well-formed values", () => {
		expect(grantOfToken("qa-t1-91:AAAAAAAAAAAAAAAA:secret")).toEqual({ uid: "qa-t1-91", grantId: "AAAAAAAAAAAAAAAA" });
		expect(grantOfToken("5224252b-4938-4a86-a276-54bbae5d5b49:abcdefghijklmnop:s")).not.toBeNull();
		for (const bad of [null, 3, "", "a:b", "a:b:c:d", "nodrive:AAAAAAAAAAAAAAAA:s", "qa-t1-91:short:s", "qa-t1-91:AAAAAAAAAAAAAAA/:s", `qa-t1-91:AAAAAAAAAAAAAAAA:${"x".repeat(600)}`]) {
			expect(grantOfToken(bad), String(bad)).toBeNull();
		}
		expect(grantIdFromRedirect("https://claude.ai/cb?code=qa-t1-91%3AAAAAAAAAAAAAAAAA%3Asecret&state=s", "qa-t1-91")).toBe("AAAAAAAAAAAAAAAA");
		expect(grantIdFromRedirect("https://claude.ai/cb?code=qa-t1-92%3AAAAAAAAAAAAAAAAA%3Asecret", "qa-t1-91")).toBeNull();
		expect(grantIdFromRedirect("not a url", "qa-t1-91")).toBeNull();
	});
});
