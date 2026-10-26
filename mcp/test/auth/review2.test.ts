/**
 * Second system review (DESIGN 29.2): the redirect that carries the authorization code is checked
 * against ALLOWED_REDIRECTS again just before it is used, as the error and cancel redirects were in
 * fix round 4. If the owner narrows the list (and deploys) while a sign-in is under way, that sign-in
 * can't deliver a code to the address that was removed:
 * - Drive-only: finishConnect refuses before anything is stored, and revokes the new app password;
 * - "Log in with Nourax" on: /callback refuses before Supabase's code is redeemed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { b64url, randomBytes, sha256 } from "../../src/core/bytes";
import type { NxEnv } from "../../src/env";
import { handleRequest } from "../../src/http/router";
import { vaultFor } from "../../src/vault/vault";
import { type FakeNc, SUPABASE } from "../fake-nc/index";
import { env, fakeWithQa, ORIGIN } from "../helpers/index";

const LOOPBACK = "http://127.0.0.1:33418/callback";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const CLIENT = "5b1d2c3e-4f50-4a61-8b72-93a4b5c6d7e8";
const SECRET = "test-supabase-client-secret-review-2-0123456789";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const upEnv: NxEnv = { ...env, SUPABASE_OAUTH_CLIENT_ID: CLIENT, SUPABASE_OAUTH_CLIENT_SECRET: SECRET };
const narrowed = (e: NxEnv): NxEnv => ({ ...e, ALLOWED_REDIRECTS: CLAUDE });

let ip = 40;
let fake: FakeNc;
beforeEach(() => {
	fake = fakeWithQa();
});
afterEach(() => vi.restoreAllMocks());

class Browser {
	cookies = new Map<string, string>();
	ip = `203.0.113.${ip++}`;
	async go(path: string, e: NxEnv, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set("cf-connecting-ip", this.ip);
		if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
		const res = await handleRequest(new Request(path.startsWith("http") ? path : `${ORIGIN}${path}`, { ...init, headers, redirect: "manual" }), e, ctx);
		for (const c of res.headers.getSetCookie()) {
			const [pair] = c.split(";");
			const i = (pair ?? "").indexOf("=");
			const k = (pair ?? "").slice(0, i).trim();
			const v = (pair ?? "").slice(i + 1).trim();
			if (/max-age=0/i.test(c) || v === "") this.cookies.delete(k);
			else this.cookies.set(k, v);
		}
		return res;
	}
}

/** Registration, the consent page and "Allow": the answer to the approve POST. */
async function consented(b: Browser, e: NxEnv): Promise<Response> {
	const reg = await handleRequest(
		new Request(`${ORIGIN}/oauth/register`, {
			method: "POST",
			headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${ip++}` },
			body: JSON.stringify({ redirect_uris: [LOOPBACK], token_endpoint_auth_method: "none", client_name: "Plain helper" }),
		}),
		e,
		ctx,
	);
	expect(reg.status).toBe(201);
	const clientId = ((await reg.json()) as { client_id: string }).client_id;
	const q = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: LOOPBACK,
		scope: "workspace.read",
		state: "st",
		resource: `${ORIGIN}/mcp`,
		code_challenge: b64url(await sha256(b64url(randomBytes(32)))),
		code_challenge_method: "S256",
	});
	const html = await (await b.go(`/authorize?${q}`, e)).text();
	const handle = (/name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "").replace(/&amp;/g, "&");
	expect(handle).not.toBe("");
	const form = new URLSearchParams({ handle, action: "approve" });
	form.append("scope", "workspace.read");
	form.append("app", "files");
	return b.go("/authorize", e, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: form.toString() });
}

function loginTokenFrom(html: string): string {
	const m = /redirectUrl=%2Flogin%2Fv2%2Fflow%2F([A-Za-z0-9]+)/.exec(html);
	if (!m) throw new Error("no login token in /connect page");
	return m[1] as string;
}

function person(): string {
	const uid = crypto.randomUUID();
	fake.addUser({ uid, password: "unused-login-password-0123456789", displayName: "Review Person" });
	return uid;
}

describe("Drive-only: the code is delivered only while its redirect is still allowed", () => {
	it("the list shrinks during the NoDrive step: refused, nothing stored, the new app password revoked", async () => {
		const uid = person();
		const b = new Browser();
		expect((await consented(b, env)).headers.get("location")).toBe("/connect");
		const waiting = await b.go("/connect", env);
		const pass = fake.grantFlow(loginTokenFrom(await waiting.text()), uid);
		// The owner drops "loopback" and deploys while the person is granting access.
		const done = await b.go("/connect", narrowed(env));
		expect(done.status).toBe(400);
		expect(done.headers.get("location")).toBeNull();
		expect(await done.text()).toContain("This app&#39;s return address is no longer allowed. Nothing was shared.");
		expect(fake.requests.some((r) => r.method === "DELETE" && r.url.pathname === "/ocs/v2.php/core/apppassword" && r.auth === uid)).toBe(true);
		expect(fake.users.get(uid)?.passwords.has(pass)).toBe(false);
		expect(await vaultFor(env, uid).listConnections()).toEqual([]);
	});
	it("with the list unchanged the same flow delivers the code to the app", async () => {
		const uid = person();
		const b = new Browser();
		await consented(b, env);
		fake.grantFlow(loginTokenFrom(await (await b.go("/connect", env)).text()), uid);
		const done = await b.go("/connect", env);
		expect(done.status).toBe(302);
		const to = new URL(done.headers.get("location") ?? "");
		expect(`${to.origin}${to.pathname}`).toBe(LOOPBACK);
		expect(to.searchParams.get("code")).toBeTruthy();
	});
});

describe('"Log in with Nourax" on: /callback checks the redirect before redeeming Supabase\'s code', () => {
	const tokenCalls = () => fake.requests.filter((r) => r.method === "POST" && r.url.host === new URL(SUPABASE).host && r.url.pathname === "/auth/v1/oauth/token").length;
	async function toCallback(b: Browser): Promise<string> {
		fake.on("POST", /^\/auth\/v1\/oauth\/token$/, () => Response.json({ error: "invalid_grant" }, { status: 400 }), new URL(SUPABASE).host);
		const approved = await consented(b, upEnv);
		const to = new URL(approved.headers.get("location") ?? "");
		expect(`${to.origin}${to.pathname}`).toBe(`${SUPABASE}/auth/v1/oauth/authorize`);
		return `/callback?code=supabase-code-1&state=${encodeURIComponent(to.searchParams.get("state") ?? "")}`;
	}
	it("the list shrank since consent: a local page, and Supabase is never asked for tokens", async () => {
		const b = new Browser();
		const back = await toCallback(b);
		const res = await b.go(back, narrowed(upEnv));
		expect(res.status).toBe(400);
		expect(res.headers.get("location")).toBeNull();
		expect(await res.text()).toContain("This app&#39;s return address is no longer allowed. Nothing was shared.");
		expect(tokenCalls()).toBe(0);
	});
	it("with the list unchanged the code is redeemed (here Supabase refuses it)", async () => {
		const b = new Browser();
		const back = await toCallback(b);
		const res = await b.go(back, upEnv);
		expect(tokenCalls()).toBe(1);
		expect(res.status).toBe(502);
	});
});
