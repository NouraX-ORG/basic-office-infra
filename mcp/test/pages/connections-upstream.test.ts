/**
 * Lane F, fix round 1: "Log in with Nourax" for the /connections page itself (src/pages/connections/
 * upstream.ts), with the upstream step switched on (SUPABASE_OAUTH_CLIENT_ID and the secret set),
 * against a fake Supabase OAuth 2.1 server (ES256 tokens made here with jose) and the fake NoDrive.
 *
 * Covered: the page offers "Sign in with Nourax" and no NoDrive grant; the start is a page that
 * opens Supabase's authorize endpoint (PKCE S256, state, nonce, our redirect URI) and writes nothing;
 * the callback checks the browser cookie, its age and the state before redeeming the code, sends the
 * client secret and the PKCE verifier, checks both tokens (client_id, nonce) and starts the session
 * for the token's sub; "no" at NoMail changes nothing; desktop keys stay bound to that account; the
 * callback is absent while the step is off; every page passes the brand rule.
 */
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { supabaseKeys } from "../../src/auth/jwt";
import { BUILTIN_BRAND_RULES } from "../../src/core/brand";
import { b64, b64url, newId, randomBytes, sha256, utf8 } from "../../src/core/bytes";
import type { NxEnv } from "../../src/env";
import { handleRequest } from "../../src/http/router";
import { NOTICES } from "../../src/pages/connections/views";
import { vaultFor } from "../../src/vault/vault";
import { type FakeNc, type Recorded, SUPABASE } from "../fake-nc/index";
import { call, env, fakeWithQa, ORIGIN } from "../helpers/index";

const CLIENT = "7a0c9a52-3c1e-4c55-9d1f-2f6a0b9e4c11";
const SECRET = "test-supabase-client-secret-lane-f-0123456789";
const upEnv: NxEnv = { ...env, SUPABASE_OAUTH_CLIENT_ID: CLIENT, SUPABASE_OAUTH_CLIENT_SECRET: SECRET };
const CALLBACK = `${ORIGIN}/connections/callback`;
const SAME = { origin: ORIGIN, "sec-fetch-site": "same-origin" };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const LOGIN_PASSWORD = "unused-login-password-0123456789";

let fake: FakeNc;
let jwk: JWK;
let privateKey: CryptoKey;
let ipCounter = 10;

interface Issued {
	sub: string;
	nonce: string;
	challenge: string;
	/** Overrides for the bad-token cases. */
	clientIdClaim?: string;
	idNonce?: string;
}
const codes = new Map<string, Issued>();

beforeAll(async () => {
	const kp = await generateKeyPair("ES256", { extractable: true });
	privateKey = kp.privateKey as CryptoKey;
	jwk = { ...(await exportJWK(kp.publicKey)), kid: "lane-f-test", alg: "ES256", use: "sig" };
});

beforeEach(async () => {
	fake = fakeWithQa();
	const host = new URL(SUPABASE).host;
	fake.on("GET", /^\/auth\/v1\/\.well-known\/jwks\.json$/, () => Response.json({ keys: [jwk] }), host);
	fake.on("POST", /^\/auth\/v1\/oauth\/token$/, (req) => tokenEndpoint(req), host);
	// The JWKS is cached per isolate for an hour: load this file's key.
	await supabaseKeys(upEnv, SUPABASE, true);
});
afterEach(() => {
	vi.restoreAllMocks();
	codes.clear();
});

async function tokenEndpoint(req: Recorded): Promise<Response> {
	const bad = (error: string) => Response.json({ error }, { status: 400 });
	if (req.headers.get("authorization") !== `Basic ${b64(utf8(`${CLIENT}:${SECRET}`))}`) return Response.json({ error: "invalid_client" }, { status: 401 });
	const form = new URLSearchParams(req.body);
	const code = form.get("code") ?? "";
	const issued = codes.get(code);
	codes.delete(code);
	if (!issued || form.get("grant_type") !== "authorization_code" || form.get("redirect_uri") !== CALLBACK) return bad("invalid_grant");
	if (b64url(await sha256(form.get("code_verifier") ?? "")) !== issued.challenge) return bad("invalid_grant");
	const now = Math.floor(Date.now() / 1000);
	const iss = `${SUPABASE}/auth/v1`;
	const access = await new SignJWT({ role: "authenticated", client_id: issued.clientIdClaim ?? CLIENT, is_anonymous: false })
		.setProtectedHeader({ alg: "ES256", kid: "lane-f-test" })
		.setIssuer(iss)
		.setAudience("authenticated")
		.setSubject(issued.sub)
		.setIssuedAt(now)
		.setExpirationTime(now + 3600)
		.sign(privateKey);
	const id = await new SignJWT({ nonce: issued.idNonce ?? issued.nonce, email: "person@example.invalid" })
		.setProtectedHeader({ alg: "ES256", kid: "lane-f-test" })
		.setIssuer(iss)
		.setAudience(CLIENT)
		.setSubject(issued.sub)
		.setIssuedAt(now)
		.setExpirationTime(now + 3600)
		.sign(privateKey);
	return Response.json({ access_token: access, refresh_token: "refresh-not-kept", id_token: id, token_type: "bearer", expires_in: 3600 });
}

function person(): string {
	const uid = crypto.randomUUID();
	fake.addUser({ uid, password: LOGIN_PASSWORD, displayName: `Person ${uid.slice(0, 4)}` });
	return uid;
}

function unesc(html: string): string {
	return html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function csrfOf(html: string): string {
	const m = /name="csrf" value="([^"]+)"/.exec(html);
	if (!m) throw new Error("no csrf token");
	return m[1] as string;
}

/** A cookie jar per browser, talking to the whole Worker with the upstream step on. */
class Browser {
	cookies = new Map<string, string>();
	setCookies: string[] = [];
	constructor(public ip = `203.0.113.${ipCounter++}`) {}
	async go(path: string, init: RequestInit = {}, e: NxEnv = upEnv): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set("cf-connecting-ip", this.ip);
		if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
		const res = await handleRequest(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init, headers }), e, ctx);
		for (const c of res.headers.getSetCookie()) {
			this.setCookies.push(c);
			const [pair] = c.split(";");
			const i = (pair ?? "").indexOf("=");
			const k = (pair ?? "").slice(0, i).trim();
			const v = (pair ?? "").slice(i + 1).trim();
			if (/max-age=0/i.test(c) || v === "") this.cookies.delete(k);
			else this.cookies.set(k, v);
		}
		return res;
	}
	post(path: string, fields: Record<string, string | string[]>, headers: Record<string, string> = SAME): Promise<Response> {
		const form = new URLSearchParams();
		for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) form.append(k, x);
		return this.go(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: form.toString() });
	}
}

/** Clicks "Sign in with Nourax" and returns the authorize URL the page opens. */
async function start(b: Browser): Promise<{ res: Response; authorize: URL }> {
	const csrf = csrfOf(await (await b.go("/connections")).text());
	const res = await b.post("/connections/sign-in", { csrf });
	expect(res.status).toBe(200);
	const refresh = res.headers.get("refresh") ?? "";
	expect(refresh.startsWith("0; url=")).toBe(true);
	return { res, authorize: new URL(refresh.slice("0; url=".length)) };
}

/** The person signs in at NoMail as `sub` and says yes: Supabase sends the browser back with a code. */
function issueCode(authorize: URL, sub: string, extra: Partial<Issued> = {}): string {
	const code = `code-${b64url(randomBytes(12))}`;
	codes.set(code, { sub, nonce: authorize.searchParams.get("nonce") ?? "", challenge: authorize.searchParams.get("code_challenge") ?? "", ...extra });
	return `/connections/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(authorize.searchParams.get("state") ?? "")}`;
}

function tokenCalls(from = 0): Recorded[] {
	return fake.requests.slice(from).filter((r) => r.method === "POST" && r.url.pathname === "/auth/v1/oauth/token");
}

function driveCallsSince(from: number): Recorded[] {
	return fake.requests.slice(from).filter((r) => r.url.host === "drive.nourax.org");
}

/** The whole Nourax sign-in as `sub`; returns the list page's HTML. */
async function signInNourax(b: Browser, sub: string): Promise<string> {
	const { authorize } = await start(b);
	const back = await b.go(issueCode(authorize, sub), { headers: { "sec-fetch-site": "cross-site" } });
	expect(back.status).toBe(303);
	expect(back.headers.get("location")).toBe("/connections");
	const list = await b.go("/connections", { headers: { "sec-fetch-site": "same-origin" } });
	expect(list.status).toBe(200);
	const html = await list.text();
	expect(html).toContain("Connected now");
	return html;
}

async function seedConnection(uid: string, label: string): Promise<string> {
	const connectionId = newId();
	const created = await vaultFor(env, uid).createConnection(
		{ connectionId, uid, kind: "oauth", clientLabel: label, scopes: ["workspace.read"], apps: ["files"], cred: { loginName: uid, appPassword: `SEEDED-${connectionId}` }, idleSec: 86400, maxAgeSec: 86400 * 30 },
		randomBytes(32),
	);
	expect(created.ok).toBe(true);
	return connectionId;
}

describe("/connections with \"Log in with Nourax\" on", () => {
	it("offers \"Sign in with Nourax\" and no NoDrive grant", async () => {
		const html = await (await new Browser().go("/connections")).text();
		expect(html).toContain("Sign in with Nourax");
		expect(html).not.toContain("Sign in with NoDrive");
		expect(html).not.toContain("AI app (Connections page)");
		expect(html).toContain('action="/connections/sign-in"');
	});

	it("the start opens Supabase's authorize endpoint with PKCE S256, state and nonce, writes nothing and never asks NoDrive", async () => {
		const b = new Browser();
		const before = fake.requests.length;
		const { res, authorize } = await start(b);
		expect(authorize.origin).toBe(SUPABASE);
		expect(authorize.pathname).toBe("/auth/v1/oauth/authorize");
		const q = authorize.searchParams;
		expect(q.get("client_id")).toBe(CLIENT);
		expect(q.get("redirect_uri")).toBe(CALLBACK);
		expect(q.get("response_type")).toBe("code");
		expect(q.get("scope")).toBe("openid email profile");
		expect(q.get("code_challenge_method")).toBe("S256");
		for (const k of ["code_challenge", "state", "nonce"]) expect(q.get(k)).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(new Set([q.get("code_challenge"), q.get("state"), q.get("nonce")]).size).toBe(3);
		const html = unesc(await res.text());
		expect(html).toContain(`href="${authorize.toString()}"`);
		expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
		const cup = b.setCookies.find((c) => c.startsWith("__Host-nx-cup="));
		expect(cup).toMatch(/^__Host-nx-cup=[A-Za-z0-9_-]{22}\.\d{10}; /);
		for (const attr of [/Path=\//, /Max-Age=600/, /Secure/, /HttpOnly/, /SameSite=Lax/]) expect(cup).toMatch(attr);
		// The cookie holds a random nonce and a time, never the state, verifier or nonce themselves.
		for (const k of ["code_challenge", "state", "nonce"]) expect(cup).not.toContain(q.get(k) as string);
		expect(b.cookies.has("__Host-nx-pre")).toBe(false);
		expect(b.setCookies.some((c) => c.startsWith("__Host-nx-connect="))).toBe(false);
		expect(fake.requests.slice(before)).toEqual([]);
		// Two starts never share a state.
		const again = await start(new Browser());
		expect(again.authorize.searchParams.get("state")).not.toBe(q.get("state"));
	});

	it("back from Nourax: the code is redeemed with the client secret and the PKCE verifier, both tokens are checked, and the session is for that account", async () => {
		const uid = person();
		await seedConnection(uid, "Claude");
		const b = new Browser();
		const before = fake.requests.length;
		const { authorize } = await start(b);
		const back = await b.go(issueCode(authorize, uid), { headers: { "sec-fetch-site": "cross-site" } });
		expect(back.status).toBe(303);
		expect(back.headers.get("location")).toBe("/connections");
		const tok = tokenCalls(before);
		expect(tok.length).toBe(1);
		const form = new URLSearchParams(tok[0]?.body);
		expect(form.get("grant_type")).toBe("authorization_code");
		expect(form.get("redirect_uri")).toBe(CALLBACK);
		expect(b64url(await sha256(form.get("code_verifier") ?? ""))).toBe(authorize.searchParams.get("code_challenge"));
		const session = b.setCookies.find((c) => c.startsWith("__Host-nx-session="));
		expect(session).toMatch(/SameSite=Strict/);
		expect(session).toMatch(/Max-Age=1800/);
		expect(b.cookies.has("__Host-nx-cup")).toBe(false);
		// A browser arriving from NoMail's site doesn't send the SameSite=Strict cookie on that hop: the
		// page reloads itself once (tested in connections.test.ts), and from our own page it is sent.
		const list = await (await b.go("/connections?b=1", { headers: { "sec-fetch-site": "same-origin" } })).text();
		expect(list).toContain("Claude");
		expect(list).toContain("Connected now (1 of 5)");
		// NoDrive was never asked: no login flow and no app password made or removed.
		expect(driveCallsSince(before)).toEqual([]);
		// The Supabase tokens are not kept anywhere: the vault has only the seeded connection.
		expect((await vaultFor(env, uid).listConnections()).map((c) => c.clientLabel)).toEqual(["Claude"]);
	});

	it("another browser, a wrong state, an old start or a second use is refused before the code is redeemed", async () => {
		const uid = person();
		const b = new Browser();
		const { authorize } = await start(b);
		const path = issueCode(authorize, uid);
		const before = fake.requests.length;
		// Another browser (no cookie): someone who got the link can't finish it.
		const other = await new Browser().go(path);
		expect(other.status).toBe(400);
		expect(await other.text()).toContain("This sign-in has expired");
		// A wrong state in the right browser: refused, and it doesn't cancel the real sign-in.
		const wrong = await b.go(path.replace(/state=[^&]+/, `state=${"A".repeat(43)}`));
		expect(wrong.status).toBe(400);
		expect(tokenCalls(before)).toEqual([]);
		expect(b.cookies.has("__Host-nx-session")).toBe(false);
		expect(b.cookies.has("__Host-nx-cup")).toBe(true);
		expect((await b.go(path)).status).toBe(303);
		expect(tokenCalls(before).length).toBe(1);
		// An old start (more than 10 minutes).
		const b2 = new Browser();
		const s2 = await start(b2);
		const p2 = issueCode(s2.authorize, uid);
		const realNow = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(realNow + 11 * 60 * 1000);
		const old = await b2.go(p2);
		vi.mocked(Date.now).mockRestore();
		expect(old.status).toBe(400);
		expect(tokenCalls(before).length).toBe(1);
		// Used once: the cookie is gone, so the same answer can't be replayed.
		const replay = await b.go(path);
		expect(replay.status).toBe(400);
		expect(tokenCalls(before).length).toBe(1);
	});

	it("tokens for another client, a wrong nonce or a failed exchange start no session", async () => {
		const uid = person();
		for (const [extra, status] of [
			[{ clientIdClaim: "c0ffee00-0000-4000-8000-000000000000" }, 403],
			[{ idNonce: "not-the-nonce" }, 403],
		] as const) {
			const b = new Browser();
			const { authorize } = await start(b);
			const res = await b.go(issueCode(authorize, uid, extra));
			expect(res.status).toBe(status);
			expect(unesc(await res.text())).toContain("couldn't be checked");
			expect(b.cookies.has("__Host-nx-session")).toBe(false);
			expect(b.cookies.has("__Host-nx-cup")).toBe(false);
		}
		// Supabase refuses the code (it was never issued).
		const b = new Browser();
		const { authorize } = await start(b);
		const res = await b.go(`/connections/callback?code=never-issued&state=${encodeURIComponent(authorize.searchParams.get("state") ?? "")}`);
		expect(res.status).toBe(502);
		expect(b.cookies.has("__Host-nx-session")).toBe(false);
	});

	it("\"no\" at NoMail's consent page changes nothing", async () => {
		const b = new Browser();
		const { authorize } = await start(b);
		const before = fake.requests.length;
		const res = await b.go(`/connections/callback?error=access_denied&state=${encodeURIComponent(authorize.searchParams.get("state") ?? "")}`);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/connections?n=cancelled");
		expect(tokenCalls(before)).toEqual([]);
		expect(b.cookies.has("__Host-nx-session")).toBe(false);
		// The notice goes with its cookie (notice.ts): this browser sees it, a bare link shows nothing.
		expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-nx-note=cancelled;"))).toBe(true);
		expect(unesc(await (await b.go("/connections?n=cancelled")).text())).toContain(NOTICES.cancelled);
		expect(unesc(await (await new Browser().go("/connections?n=cancelled")).text())).not.toContain(NOTICES.cancelled);
	});

	it("a desktop key made after a Nourax sign-in is still bound to that account in NoDrive's grant", async () => {
		const uid = person();
		const other = person();
		const b = new Browser();
		await signInNourax(b, uid);
		const form = await (await b.go("/connections/new-key")).text();
		const res = await b.post("/connections/new-key", { csrf: csrfOf(form), label: "Laptop", scope: "workspace.read", app: "files", days: "30" });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/connect");
		const waiting = await (await b.go("/connect")).text();
		const loginToken = /redirectUrl=%2Flogin%2Fv2%2Fflow%2F([A-Za-z0-9]+)/.exec(waiting)?.[1] as string;
		fake.grantFlow(loginToken, other);
		const done = await b.go("/connect");
		expect(done.status).toBe(403);
		expect(await done.text()).toContain("different NoDrive account");
		expect(await vaultFor(env, uid).listConnections()).toEqual([]);
	});

	it("the same start needs the page's own form: another site's POST or a missing token is refused", async () => {
		const b = new Browser();
		const csrf = csrfOf(await (await b.go("/connections")).text());
		expect((await b.post("/connections/sign-in", {})).status).toBe(403);
		expect((await b.post("/connections/sign-in", { csrf }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
		expect(b.cookies.has("__Host-nx-cup")).toBe(false);
	});

	it("/connections/callback isn't there while the upstream step is off", async () => {
		const res = await call("/connections/callback?code=x&state=y", { headers: { "cf-connecting-ip": "203.0.113.240" } });
		expect(res.status).toBe(404);
		expect((await new Browser().go("/connections/callback", { method: "POST" })).status).toBe(405);
	});

	it("every page passes the brand rule", async () => {
		const uid = person();
		const texts: string[] = [];
		const b = new Browser();
		texts.push(await (await b.go("/connections")).text());
		const { res, authorize } = await start(b);
		texts.push(await res.text());
		texts.push(await (await new Browser().go(issueCode(authorize, uid))).text());
		texts.push(await (await b.go(`/connections/callback?error=access_denied&state=${encodeURIComponent(authorize.searchParams.get("state") ?? "")}`)).text());
		texts.push(await signInNourax(new Browser(), uid));
		const bad = texts.flatMap((t, i) => BUILTIN_BRAND_RULES.filter((r) => r.pattern.test(t)).map((r) => `${i}:${r.id}`));
		expect(bad).toEqual([]);
	});
});
