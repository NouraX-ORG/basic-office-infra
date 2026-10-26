/**
 * Lane F: the /connections pages through the whole Worker, against the fake NoDrive.
 * The real (production) path runs with a non-loopback CF-Connecting-IP, so dev mode is off; the
 * dev-only QA picker and dev keys run with loopback requests (no CF-Connecting-IP), as in wrangler dev.
 * Covered: sign-in through Login Flow v2 (session purpose), the list, ending connections (app
 * password and grant revoked), someone else's ids, "ending" rows, the unrevoked notes, desktop keys
 * (read-only defaults, the ONLYOFFICE request shape, the IP lock, the account binding, the cap),
 * CSRF and same-origin checks, form limits, sessions, the cross-site reload, setup faults, the
 * per-IP limit, escaping and the brand rule.
 * Second review, fix round 3: notices shown only after this browser's own action (notice.ts),
 * sign-out from a tab that is no longer signed in, the "Replace and remove" note with what is for
 * good, and the end rule of dev rows.
 */
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NxEnv } from "../../src/env";
import { BUILTIN_BRAND_RULES } from "../../src/core/brand";
import { b64url, fromB64url, newId, randomBytes, sha256, sha256Hex } from "../../src/core/bytes";
import { connectCancel, startConnect } from "../../src/auth/connect";
import { issueSession } from "../../src/auth/session";
import { handleRequest } from "../../src/http/router";
import { type AppId, CATALOG, type CatalogEntry, type Scope, SCOPE_WORDS } from "../../src/mcp/catalog";
import { parseKeyForm } from "../../src/pages/connections/forms";
import { forgetDesktopKey, keyIndexKey } from "../../src/pages/connections/key-record";
import { NOTE_COOKIE } from "../../src/pages/connections/notice";
import { signOutKey } from "../../src/pages/connections/session-end";
import {
	CAP_REPLACE_TEXT,
	desktopKeySetting,
	endsText,
	isReservedLabel,
	KEY_PLACEHOLDER,
	type NoticeCode,
	NOTICES,
	REMOVE_TOOL_FATES,
	removeNote,
	SESSION_GRANT_FATE,
	SESSION_LABEL,
	SIGNED_OUT_NOTICES,
	scopeWords,
	UNDOABLE_REMOVE_TOOLS,
	when,
} from "../../src/pages/connections/views";
import type { ConnectionSummary } from "../../src/vault/schema";
import { DAILY_CAPS } from "../../src/core/limits";
import { _resetQuotaMemo, type Quota } from "../../src/vault/quota";
import { type Vault, vaultFor } from "../../src/vault/vault";
import type { FakeNc } from "../fake-nc/index";
import { call, env, fakeWithQa, INIT_2024, ORIGIN, QA, QA_PASS, rpcResult } from "../helpers/index";

const docFiles = import.meta.glob("../../../docs/mcp.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const DOC = Object.values(docFiles)[0] ?? "";

/** One section of docs/mcp.md, from its "### n.m" heading to the next heading of that level or above. */
function docSection(id: string): string {
	const start = DOC.indexOf(`### ${id} `);
	if (start < 0) throw new Error(`docs/mcp.md has no section ${id}`);
	const rest = DOC.slice(start + 4);
	const end = rest.search(/\n#{2,3} /);
	return end < 0 ? rest : rest.slice(0, end);
}

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const LOGIN_PASSWORD = "unused-login-password-0123456789";
const SAME = { origin: ORIGIN, "sec-fetch-site": "same-origin" };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
let ipCounter = 20;
let fake: FakeNc;

beforeEach(() => {
	fake = fakeWithQa();
});
afterEach(() => vi.restoreAllMocks());

function person(groups: string[] = []): string {
	const uid = crypto.randomUUID();
	fake.addUser({ uid, password: LOGIN_PASSWORD, displayName: `Person ${uid.slice(0, 4)}`, groups });
	return uid;
}

/** A cookie jar per browser. `ip: null` sends no CF-Connecting-IP, as wrangler dev on loopback does. */
class Browser {
	cookies = new Map<string, string>();
	setCookies: string[] = [];
	constructor(public ip: string | null = `203.0.113.${ipCounter++}`) {}
	async go(path: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		if (this.ip) headers.set("cf-connecting-ip", this.ip);
		if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
		const res = await call(path, { ...init, headers });
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

/** Our pages escape apostrophes as &#39;. */
function unesc(html: string): string {
	return html.replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

function csrfOf(html: string): string {
	const m = /name="csrf" value="([^"]+)"/.exec(html);
	if (!m) throw new Error(`no csrf token in: ${html.slice(0, 300)}`);
	return m[1] as string;
}

function connectionIds(html: string): string[] {
	return [...html.matchAll(/name="connection_id" value="([0-9a-f]{32})"/g)].map((m) => m[1] as string);
}

function loginTokenFrom(html: string): string {
	const m = /redirectUrl=%2Flogin%2Fv2%2Fflow%2F([A-Za-z0-9]+)/.exec(html);
	if (!m) throw new Error("no login token in /connect page");
	return m[1] as string;
}

/** /connect: grant as `uid` in NoDrive, then the page's next load. */
async function grantAndFinish(b: Browser, uid: string): Promise<Response> {
	const waiting = await b.go("/connect");
	expect(waiting.status).toBe(200);
	fake.grantFlow(loginTokenFrom(await waiting.text()), uid);
	return b.go("/connect");
}

/** The whole sign-in through NoDrive, as `uid`. Returns the list page's HTML. */
async function signIn(b: Browser, uid: string): Promise<string> {
	const csrf = csrfOf(await (await b.go("/connections")).text());
	const start = await b.post("/connections/sign-in", { csrf });
	expect(start.status).toBe(302);
	expect(start.headers.get("location")).toBe("/connect");
	const done = await grantAndFinish(b, uid);
	expect(done.status).toBe(302);
	expect(done.headers.get("location")).toBe("/connections");
	const list = await b.go("/connections");
	expect(list.status).toBe(200);
	const html = await list.text();
	expect(html).toContain("Connected now");
	return html;
}

function appPasswords(uid: string): string[] {
	return [...(fake.users.get(uid)?.passwords ?? [])].filter((p) => p !== LOGIN_PASSWORD);
}

/** An OAuth connection made the real way (DCR, consent, NoDrive step, code exchange). Returns its access token. */
async function connectOAuth(uid: string, clientName = "Claude Desktop", redirect = REDIRECT): Promise<string> {
	const reg = await call("/oauth/register", {
		method: "POST",
		headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${ipCounter++}` },
		body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none", client_name: clientName, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
	});
	expect(reg.status).toBe(201);
	const clientId = ((await reg.json()) as { client_id: string }).client_id;
	const b = new Browser();
	const verifier = b64url(randomBytes(32));
	const q = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: redirect,
		scope: "workspace.read workspace.write",
		state: "st",
		resource: `${ORIGIN}/mcp`,
		code_challenge: b64url(await sha256(verifier)),
		code_challenge_method: "S256",
	});
	const consent = await (await b.go(`/authorize?${q}`)).text();
	const handle = (/name="handle" value="([^"]+)"/.exec(consent)?.[1] ?? "").replace(/&amp;/g, "&");
	const toConnect = await b.post("/authorize", { handle, action: "approve", scope: ["workspace.read", "workspace.write"], app: ["files", "calendar"] }, { origin: ORIGIN });
	expect(toConnect.headers.get("location")).toBe("/connect");
	const done = await grantAndFinish(b, uid);
	expect(done.status).toBe(302);
	const code = new URL(done.headers.get("location") ?? "").searchParams.get("code") as string;
	const tok = await call("/oauth/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "192.0.2.1" },
		body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource: `${ORIGIN}/mcp` }).toString(),
	});
	expect(tok.status).toBe(200);
	return ((await tok.json()) as { access_token: string }).access_token;
}

/** A raw POST to /mcp in ONLYOFFICE Desktop's shape: Content-Type and Authorization only (no Accept). */
function onlyofficePost(token: string, body: unknown, ip = "198.18.0.1"): Promise<Response> {
	return call("/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "cf-connecting-ip": ip }, body: JSON.stringify(body) });
}

async function seedConnection(uid: string, label: string, kind: "oauth" | "desktop" = "oauth", scopes: Scope[] = ["workspace.read"]): Promise<string> {
	const connectionId = newId();
	// The fake NoDrive knows the seeded app password, so ending the connection really revokes it (fix
	// round 4: a 401 to the revocation no longer counts as "already gone").
	fake.users.get(uid)?.passwords.add(`SEEDED-${connectionId}`);
	const created = await vaultFor(env, uid).createConnection(
		{ connectionId, uid, kind, clientLabel: label, scopes, apps: ["files"], cred: { loginName: uid, appPassword: `SEEDED-${connectionId}` }, idleSec: 86400, maxAgeSec: 86400 * 30 },
		randomBytes(32),
	);
	expect(created.ok).toBe(true);
	return connectionId;
}

/** A form POST from this browser through the whole Worker, but with another env (limits, quota, secrets). */
function postWithEnv(b: Browser, path: string, fields: Record<string, string | string[]>, e: NxEnv): Promise<Response> {
	const form = new URLSearchParams();
	for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) form.append(k, x);
	const headers: Record<string, string> = { ...SAME, "content-type": "application/x-www-form-urlencoded", cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; ") };
	if (b.ip) headers["cf-connecting-ip"] = b.ip;
	return handleRequest(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: form.toString() }), e, ctx);
}

/** The env with the Quota object's take() replaced (the real one is reached through `real`). */
function withQuota(take: (real: (...a: unknown[]) => Promise<unknown>, ...a: unknown[]) => Promise<unknown>): NxEnv {
	const ns = env.QUOTA;
	return {
		...env,
		QUOTA: {
			idFromName: (n: string) => ns.idFromName(n),
			get: (id: DurableObjectId) => {
				const stub = ns.get(id) as unknown as { take: (...a: unknown[]) => Promise<unknown> };
				return { take: (...a: unknown[]) => take((...x: unknown[]) => stub.take(...x), ...a) };
			},
		} as unknown as NxEnv["QUOTA"],
	};
}

function loginFlowStarts(from: number): number {
	return fake.requests.slice(from).filter((r) => r.method === "POST" && /\/login\/v2$/.test(r.url.pathname)).length;
}

/** Desktop key, the real way: the form, NoDrive's grant as `grantAs`, then the key page. */
async function makeKey(b: Browser, grantAs: string, fields: Record<string, string | string[]> = {}): Promise<{ res: Response; html: string; key: string | null }> {
	const form = await b.go("/connections/new-key");
	expect(form.status).toBe(200);
	const csrf = csrfOf(await form.text());
	const start = await b.post("/connections/new-key", { csrf, label: "ONLYOFFICE laptop", scope: "workspace.read", app: ["files", "docs", "calendar", "contacts", "boards"], days: "30", ...fields });
	expect(start.status).toBe(302);
	expect(start.headers.get("location")).toBe("/connect");
	const res = await grantAndFinish(b, grantAs);
	const html = await res.text();
	return { res, html, key: /nxw_ct_[A-Za-z0-9_-]{43}/.exec(html)?.[0] ?? null };
}

describe("signed out", () => {
	it("shows the sign-in button with a short-lived pre-sign-in CSRF cookie and strict headers, and no dev picker", async () => {
		const b = new Browser();
		const res = await b.go("/connections");
		const html = await res.text();
		expect(res.status).toBe(200);
		expect(html).toContain("Sign in with NoDrive");
		expect(html).toContain('action="/connections/sign-in"');
		expect(html).toContain("AI app (Connections page)");
		// Drive-only mode: the grant is safe only for a sign-in the person started on this host just now.
		expect(unesc(html)).toContain("Grant it only if you clicked Sign in on localhost:8787 yourself just now.");
		// The name on NoDrive's grant page is chosen by whoever started the sign-in (an AI app names
		// itself), so the page never vouches for the name, only for a sign-in started here.
		expect(unesc(html)).toContain("If you started it here, that access only tells this page who you are");
		expect(unesc(html)).toContain("Never grant access from a link someone sent you, whatever name NoDrive shows");
		expect(unesc(html)).toContain("so it proves nothing.");
		expect(unesc(html)).not.toMatch(/^.*That access only tells this page who you are/m);
		expect(html).not.toContain("Sign in with Nourax");
		expect(html).not.toContain("dev_uid");
		expect(html).not.toContain("<script");
		const pre = b.setCookies.find((c) => c.startsWith("__Host-nx-pre="));
		expect(pre).toMatch(/Path=\//);
		expect(pre).toMatch(/Secure/);
		expect(pre).toMatch(/HttpOnly/);
		expect(pre).toMatch(/SameSite=Strict/);
		expect(pre).toMatch(/Max-Age=1200/);
		expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
		expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("referrer-policy")).toBe("same-origin");
	});

	it("never echoes the notice parameter, and a link with a known code alone shows no notice", async () => {
		const b = new Browser();
		const evil = await (await b.go("/connections?n=%3Cscript%3Ealert(1)%3C%2Fscript%3E")).text();
		expect(evil).not.toContain("<script>alert");
		expect(evil).not.toContain("alert(1)");
		// A crafted link such as /connections?n=signed-out (the review's case) shows nothing: the
		// notice needs the cookie that only the action itself sets (notice.ts).
		for (const n of Object.keys(NOTICES) as NoticeCode[]) {
			const html = unesc(await (await b.go(`/connections?n=${n}`)).text());
			expect(html, n).not.toContain(NOTICES[n]);
			expect(html, n).not.toContain('role="status"');
		}
	});

	it("a link from another site with a notice code keeps it through the reload, and the notice shows only with its cookie", async () => {
		const b = new Browser();
		b.cookies.set(NOTE_COOKIE, "cancelled");
		const first = await b.go("/connections?n=cancelled", { headers: { "sec-fetch-site": "cross-site" } });
		expect(first.headers.get("refresh")).toBe("0; url=/connections?b=1&n=cancelled");
		expect(await first.text()).toContain('href="/connections?b=1&amp;n=cancelled"');
		// The bounce doesn't use the note up: the reload from this page sends it and shows the notice.
		expect(b.cookies.get(NOTE_COOKIE)).toBe("cancelled");
		const again = unesc(await (await b.go("/connections?b=1&n=cancelled", { headers: { "sec-fetch-site": "same-origin" } })).text());
		expect(again).toContain(`<p class="warn" role="status">${NOTICES.cancelled}</p>`);
		expect(b.cookies.has(NOTE_COOKIE)).toBe(false);
		// An unknown code isn't carried.
		const odd = await new Browser().go("/connections?n=nope", { headers: { "sec-fetch-site": "cross-site" } });
		expect(odd.headers.get("refresh")).toBe("0; url=/connections?b=1");
	});

	it("a link from another site reloads once from this page (the session cookie is SameSite=Strict), then stops", async () => {
		const b = new Browser();
		const first = await b.go("/connections", { headers: { "sec-fetch-site": "cross-site" } });
		expect(first.status).toBe(200);
		expect(first.headers.get("refresh")).toBe("0; url=/connections?b=1");
		expect(await first.text()).toContain('href="/connections"');
		const again = await b.go("/connections?b=1", { headers: { "sec-fetch-site": "cross-site" } });
		expect(again.headers.get("refresh")).toBeNull();
		expect(await again.text()).toContain("Sign in with NoDrive");
	});
});

describe("sign-in through NoDrive", () => {
	it("starts Login Flow v2 as \"AI app (Connections page)\", revokes the app password at once and starts a strict 30-minute session", async () => {
		const uid = person();
		const b = new Browser();
		const html = await signIn(b, uid);
		expect(html).toContain("No AI app is connected");
		const flowStart = fake.requests.find((r) => r.method === "POST" && /\/login\/v2$/.test(r.url.pathname));
		expect(flowStart?.headers.get("user-agent")).toBe("AI app (Connections page)");
		// The page only needed to know who it is: the app password is gone again.
		expect(appPasswords(uid)).toEqual([]);
		expect(fake.requests.some((r) => r.method === "DELETE" && r.url.pathname === "/ocs/v2.php/core/apppassword")).toBe(true);
		const session = b.setCookies.find((c) => c.startsWith("__Host-nx-session="));
		expect(session).toMatch(/SameSite=Strict/);
		expect(session).toMatch(/HttpOnly/);
		expect(session).toMatch(/Secure/);
		expect(session).toMatch(/Max-Age=1800/);
		// The pre-sign-in cookie was cleared when the flow started.
		expect(b.cookies.has("__Host-nx-pre")).toBe(false);
	});

	it("local and admin accounts can't sign in, and their new app password is revoked", async () => {
		const admin = person(["admin"]);
		for (const [uid, words] of [
			[QA.a, "Only Nourax accounts"],
			[admin, "Admin accounts can't be connected"],
		] as const) {
			const b = new Browser();
			const csrf = csrfOf(await (await b.go("/connections")).text());
			expect((await b.post("/connections/sign-in", { csrf })).status).toBe(302);
			const res = await grantAndFinish(b, uid);
			expect(res.status).toBe(403);
			expect(unesc(await res.text())).toContain(words);
			expect(b.cookies.has("__Host-nx-session")).toBe(false);
			expect([...(fake.users.get(uid)?.passwords ?? [])].filter((p) => p !== LOGIN_PASSWORD && p !== QA_PASS[QA.a])).toEqual([]);
		}
	});

	it("refuses without the CSRF token, with another browser's token, from another site, with Origin null alone, too big or not a form", async () => {
		const a = new Browser();
		const tokenA = csrfOf(await (await a.go("/connections")).text());
		const b = new Browser();
		await b.go("/connections");
		const before = fake.requests.length;
		expect((await b.post("/connections/sign-in", {})).status).toBe(403);
		expect((await b.post("/connections/sign-in", { csrf: tokenA })).status).toBe(403);
		const tokenB = csrfOf(await (await b.go("/connections")).text());
		expect((await b.post("/connections/sign-in", { csrf: tokenB }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
		expect((await b.post("/connections/sign-in", { csrf: tokenB }, { "sec-fetch-site": "same-site" })).status).toBe(403);
		expect((await b.post("/connections/sign-in", { csrf: tokenB }, { origin: "null" })).status).toBe(403);
		const big = await b.go("/connections/sign-in", { method: "POST", headers: { ...SAME, "content-type": "application/x-www-form-urlencoded" }, body: `csrf=${tokenB}&x=${"a".repeat(17 * 1024)}` });
		expect(big.status).toBe(413);
		const json = await b.go("/connections/sign-in", { method: "POST", headers: { ...SAME, "content-type": "application/json" }, body: JSON.stringify({ csrf: tokenB }) });
		expect(json.status).toBe(415);
		// None of these reached NoDrive.
		expect(fake.requests.slice(before).some((r) => /\/login\/v2$/.test(r.url.pathname))).toBe(false);
		// Origin null counts together with Sec-Fetch-Site: same-origin (a privacy setting can blank it).
		expect((await b.post("/connections/sign-in", { csrf: tokenB }, { origin: "null", "sec-fetch-site": "same-origin" })).status).toBe(302);
	});

	it("limits sign-in starts per IP (RL_AUTHZ) before NoDrive is asked", async () => {
		const b = new Browser();
		const csrf = csrfOf(await (await b.go("/connections")).text());
		const limited = { ...env, RL_AUTHZ: { limit: async () => ({ success: false }) } as unknown as RateLimit };
		const before = fake.requests.length;
		const req = new Request(`${ORIGIN}/connections/sign-in`, {
			method: "POST",
			headers: { ...SAME, "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": b.ip as string, cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
			body: new URLSearchParams({ csrf }).toString(),
		});
		const res = await handleRequest(req, limited, ctx);
		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).toBe("60");
		expect(fake.requests.slice(before).some((r) => /\/login\/v2$/.test(r.url.pathname))).toBe(false);
	});
});

describe("the list and ending connections", () => {
	it("lists a real AI app connection, and ending it revokes its app password and its grant at once", async () => {
		const uid = person();
		const token = await connectOAuth(uid, "Claude Desktop", "http://127.0.0.1:33418/callback");
		expect((await onlyofficePost(token, INIT_2024)).status).toBe(200);
		expect(appPasswords(uid).length).toBe(1);
		const b = new Browser();
		const html = await signIn(b, uid);
		expect(html).toContain("Claude Desktop");
		expect(html).toContain("AI app (Claude Desktop)");
		expect(html).toContain("Connected now (1 of 5)");
		expect(html).toContain("create and edit");
		expect(html).toContain("Files and sharing (NoDrive)");
		const [id] = connectionIds(html);
		const end = await b.post("/connections/end", { csrf: csrfOf(html), connection_id: id as string });
		expect(end.status).toBe(303);
		expect(end.headers.get("location")).toBe("/connections?n=ended");
		expect(appPasswords(uid)).toEqual([]);
		// The token stops at once: the vault row is gone and the grant is revoked.
		expect((await onlyofficePost(token, INIT_2024)).status).toBe(401);
		const after = await (await b.go("/connections?n=ended")).text();
		expect(after).toContain(NOTICES.ended);
		expect(after).toContain("No AI app is connected");
	});

	it("escapes labels and never lets one person end another person's connection", async () => {
		const owner = person();
		const other = person();
		const otherConn = await seedConnection(other, "Other app");
		await seedConnection(owner, `<img src=x onerror=alert(1)> & "q"`);
		const b = new Browser();
		const html = await signIn(b, owner);
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;");
		expect(html).not.toContain("<img src=x");
		const res = await b.post("/connections/end", { csrf: csrfOf(html), connection_id: otherConn });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/connections?n=gone");
		expect((await vaultFor(env, other).listConnections()).map((c) => c.connectionId)).toEqual([otherConn]);
		expect((await b.post("/connections/end", { csrf: csrfOf(html), connection_id: "../../x" })).status).toBe(400);
	});

	it("warns about an AI app that named itself like this page's own sign-in, and only about that one", async () => {
		const uid = person();
		const fake1 = await seedConnection(uid, "Connections page");
		const fake2 = await seedConnection(uid, "My connections_PAGE 2");
		const real = await seedConnection(uid, "Claude Desktop");
		const b = new Browser();
		const html = unesc(await signIn(b, uid));
		const box = (id: string) => {
			const i = html.indexOf(`name="connection_id" value="${id}"`);
			return html.slice(html.lastIndexOf("<fieldset>", i), i);
		};
		for (const id of [fake1, fake2]) expect(box(id)).toContain("This AI app gave itself the name of this page's own sign-in. If you didn't connect it yourself, end it now.");
		expect(box(real)).not.toContain("gave itself the name");
		expect(html.match(/gave itself the name/g)?.length).toBe(2);
	});

	it("says what a connection may do in plain words, with no promise in brackets", async () => {
		const uid = person();
		await seedConnection(uid, "Wide app", "oauth", ["workspace.read", "workspace.write", "workspace.remove", "workspace.share"]);
		const b = new Browser();
		const html = unesc(await signIn(b, uid));
		expect(html).toContain("May: read; create and edit; replace and remove; share and invite</p>");
		expect(html).not.toMatch(/May: [^<]*\(/);
		for (const s of Object.keys(SCOPE_WORDS) as Scope[]) expect(scopeWords(s)).not.toMatch(/[()]/);
	});

	it("a revocation NoDrive refuses shows as ending, without an End button, and is retried by the vault", async () => {
		const uid = person();
		await seedConnection(uid, "Flaky app");
		const b = new Browser();
		const html = await signIn(b, uid);
		fake.on("DELETE", /^\/ocs\/v2\.php\/core\/apppassword$/, () => new Response("bad gateway", { status: 502 }));
		const res = await b.post("/connections/end", { csrf: csrfOf(html), connection_id: connectionIds(html)[0] as string });
		expect(res.headers.get("location")).toBe("/connections?n=ending");
		const page = await (await b.go("/connections?n=ending")).text();
		expect(unesc(page)).toContain(NOTICES.ending);
		expect(page).toContain("Ending: its NoDrive access is still being removed");
		expect(connectionIds(page)).toEqual([]);
		expect((await vaultFor(env, uid).listConnections())[0]?.status).toBe("revoking");
	});

	it("ending a connection whose NoDrive access can never be removed automatically says it must be removed by hand, not that it keeps trying", async () => {
		const uid = person();
		const id = await seedConnection(uid, "Rotated app");
		const b = new Browser();
		const html = await signIn(b, uid);
		// NX_REVOKE_SECRET rotated to a different, valid value: the revoke-wrap can't be opened.
		await runInDurableObject(vaultFor(env, uid), async (instance: Vault) => {
			(instance as unknown as { env: unknown }).env = { ...env, NX_REVOKE_SECRET: "rotated-revoke-secret-lane-f-0123456789abcdef" };
		});
		const before = fake.requests.length;
		const res = await b.post("/connections/end", { csrf: csrfOf(html), connection_id: id });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/connections?n=manual");
		// Nothing could be sent to NoDrive: there is no credential left to send.
		expect(fake.requests.slice(before).some((r) => r.url.pathname === "/ocs/v2.php/core/apppassword")).toBe(false);
		const page = unesc(await (await b.go("/connections?n=manual")).text());
		expect(page).toContain(NOTICES.manual);
		expect(page).not.toContain(NOTICES.ending);
		expect(page).toContain("Ended, but not fully removed");
		expect(page).toContain('named "AI app (Rotated app)"');
		expect(await vaultFor(env, uid).listConnections()).toEqual([]);
		expect((await vaultFor(env, uid).listUnrevoked()).map((u) => u.connectionId)).toEqual([id]);
		// The "ending" notice stays only for rows the vault really retries.
		expect(NOTICES.ending).toContain("keeps trying by itself");
		expect(NOTICES.manual).not.toContain("keeps trying");
	});

	it("shows ended connections whose NoDrive access must be removed by hand, and clears the note", async () => {
		const uid = person();
		const id = "c".repeat(32);
		await runInDurableObject(vaultFor(env, uid), async (_i: Vault, state) => {
			const t = Math.floor(Date.now() / 1000);
			state.storage.sql.exec("INSERT INTO unrevoked (id, kind, client_label, created_at, ended_at, reason) VALUES (?, ?, ?, ?, ?, ?)", id, "oauth", "Old Claude", t - 999, t, "key_rotated");
		});
		const b = new Browser();
		const html = await signIn(b, uid);
		expect(html).toContain("Ended, but not fully removed");
		expect(html).toContain('named "AI app (Old Claude)"');
		expect(html).toContain("Ask the person who runs Nourax Workspace to remove it");
		const res = await b.post("/connections/forget", { csrf: csrfOf(html), connection_id: id });
		expect(res.headers.get("location")).toBe("/connections?n=cleared");
		expect(await vaultFor(env, uid).listUnrevoked()).toEqual([]);
		expect(await (await b.go("/connections")).text()).not.toContain("Ended, but not fully removed");
	});
});

describe("desktop keys", () => {
	it("the form defaults to read-only, every app but mail, 30 days and no network lock", async () => {
		const uid = person();
		const b = new Browser();
		await signIn(b, uid);
		const html = await (await b.go("/connections/new-key")).text();
		expect(html).toContain('<input type="checkbox" checked disabled>Read (always on)');
		expect(html).toContain('name="scope" value="workspace.write">');
		expect(html).not.toContain('name="scope" value="workspace.write" checked');
		expect(html).not.toContain('value="mail');
		for (const app of ["files", "docs", "calendar", "contacts", "boards"]) expect(html).toContain(`name="app" value="${app}" checked`);
		expect(html).toContain('name="days" value="30" checked');
		expect(html).not.toContain('name="ip_lock" value="1" checked');
		expect(html).toContain("npx -y mcp-remote@0.15.2 http://localhost:8787/mcp");
		// Signed out, the form sends you to sign in.
		const out = await new Browser().go("/connections/new-key");
		expect(out.status).toBe(303);
		expect(out.headers.get("location")).toBe("/connections");
	});

	it("labels \"Replace and remove\" without core's bracketed promise, with a note built from the catalogue, and shows the whole configuration to paste", async () => {
		const uid = person();
		const b = new Browser();
		await signIn(b, uid);
		const html = unesc(await (await b.go("/connections/new-key")).text());
		expect(html).toContain('name="scope" value="workspace.remove">Replace and remove</label>');
		expect(html).not.toMatch(/value="workspace\.[a-z]+"( checked)?>[^<]*\(/);
		const offered = [...html.matchAll(/name="app" value="([a-z]+)"/g)].map((m) => m[1] as AppId);
		expect(offered).toContain("files");
		const note = removeNote(offered);
		expect(note).not.toBe("");
		expect(html).toContain(`Replace and remove</label>\n<p class="muted">${note}</p>`);
		// The note says how the known tools are undone, names every part of them that is for good, and
		// says plainly that any tool lane F doesn't know can't be undone.
		const removeTools = CATALOG.filter((c) => c.scope === "workspace.remove" && (c.app === null || offered.includes(c.app)));
		const known = (name: string) => Object.hasOwn(REMOVE_TOOL_FATES, name);
		for (const c of removeTools) {
			const fate = REMOVE_TOOL_FATES[c.name];
			if (fate?.forGood) expect(note, c.name).toContain(fate.forGood);
		}
		expect(note.includes("Deleting a NoGantt task is for good")).toBe(removeTools.some((c) => c.app === "gantt" && !known(c.name)));
		expect(note.includes("Some other removals can't be undone")).toBe(removeTools.some((c) => c.app !== "gantt" && !known(c.name)));
		// The review's case: removing one occurrence of a repeating event is never promised an undo.
		expect(offered).toContain("calendar");
		expect(note).toContain("Not everything can be undone: ");
		expect(note).toContain("removing one occurrence of a repeating event is for good");
		expect(note).not.toMatch(/removed files and events stay in the trash for 30 days, so these can be undone/);
		// The template, with the menu path from ONLYOFFICE's "Connecting MCP servers" page.
		expect(html).toContain("AI agent, then Settings, then MCP Servers, then Edit configuration");
		expect(html).toContain(desktopKeySetting("http://localhost:8787", KEY_PLACEHOLDER));
		expect(html).not.toMatch(/nxw_ct_[A-Za-z0-9_-]{43}/);
	});

	it("removeNote: how the known tools are undone, what of them is for good (a single occurrence, a share made to you alone), and unknown removals named", () => {
		const entry = (name: string, app: CatalogEntry["app"]): CatalogEntry => ({ ...(CATALOG[0] as CatalogEntry), name, app, scope: "workspace.remove" });
		const today = [entry("files_overwrite_file", "files"), entry("files_move_to_trash", "files"), entry("files_restore_version", "files"), entry("calendar_cancel_event", "calendar")];
		expect(removeNote(["files", "calendar"], today)).toBe(
			"Replaced file content stays as an earlier version; removed files and folders stay in NoDrive's trash, normally for 30 days; a cancelled event stays in its calendar, marked as cancelled, or goes to NoCalendar's trash for 30 days. These can be undone. Not everything can be undone: removing something that was shared with you alone ends that share for good; removing one occurrence of a repeating event is for good.",
		);
		// Only what the key's apps can do is named.
		expect(removeNote(["calendar"], today)).toBe(
			"A cancelled event stays in its calendar, marked as cancelled, or goes to NoCalendar's trash for 30 days. These can be undone. Not everything can be undone: removing one occurrence of a repeating event is for good.",
		);
		expect(removeNote(["files"], [entry("files_overwrite_file", "files"), entry("files_restore_version", "files")])).toBe("Replaced file content stays as an earlier version. These can be undone.");
		const withGantt = [...today, entry("gantt_delete_task", "gantt")];
		expect(removeNote(["files", "gantt"], withGantt)).toContain("Deleting a NoGantt task is for good: NoGantt has no trash.");
		// A key without NoGantt isn't told about NoGantt.
		expect(removeNote(["files"], withGantt)).not.toContain("NoGantt");
		expect(removeNote(["boards"], [entry("boards_delete_card", "boards")])).toBe("Some other removals can't be undone.");
		expect(removeNote(["files"], [entry("boards_delete_card", "boards")])).toBe("");
		// Only the tools with nothing for good count as always undoable.
		expect([...UNDOABLE_REMOVE_TOOLS].sort()).toEqual(["files_overwrite_file", "files_restore_version"]);
	});

	it("every tool lane F knows under \"Replace and remove\" is still there (a rename or a move would be noticed)", () => {
		for (const name of Object.keys(REMOVE_TOOL_FATES)) expect(CATALOG.find((c) => c.name === name)?.scope, name).toBe("workspace.remove");
	});

	it("is made through NoDrive, shown once, works read-only in the ONLYOFFICE request shape, and ends at once from the list", async () => {
		const uid = person();
		const b = new Browser();
		await signIn(b, uid);
		const { res, html, key } = await makeKey(b, uid, { label: "ONLYOFFICE laptop" });
		expect(res.status).toBe(200);
		expect(html).toContain("shown only once");
		expect(key).not.toBeNull();
		const flowStarts = fake.requests.filter((r) => r.method === "POST" && /\/login\/v2$/.test(r.url.pathname));
		expect(flowStarts.at(-1)?.headers.get("user-agent")).toBe("AI app (ONLYOFFICE laptop)");
		expect(appPasswords(uid).length).toBe(1);
		// The key never reaches KV or the vault in clear.
		const rows = await vaultFor(env, uid).listConnections();
		expect(rows.map((r) => [r.kind, r.clientLabel, r.scopes])).toEqual([["desktop", "ONLYOFFICE laptop", ["workspace.read"]]]);
		const init = await onlyofficePost(key as string, INIT_2024);
		expect(init.status).toBe(200);
		const list = (await rpcResult(await onlyofficePost(key as string, { jsonrpc: "2.0", id: 2, method: "tools/list" }))).result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
		expect(list.tools.length).toBeGreaterThan(0);
		expect(list.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
		const page = await (await b.go("/connections")).text();
		expect(page).toContain("Desktop key");
		expect(page).toContain("ONLYOFFICE laptop");
		const end = await b.post("/connections/end", { csrf: csrfOf(page), connection_id: connectionIds(page)[0] as string });
		expect(end.headers.get("location")).toBe("/connections?n=ended");
		expect(appPasswords(uid)).toEqual([]);
		expect((await onlyofficePost(key as string, INIT_2024)).status).toBe(401);
	});

	it("a key granted in NoDrive by a different account is refused, and that app password is revoked", async () => {
		const uid = person();
		const other = person();
		const b = new Browser();
		await signIn(b, uid);
		const { res, html, key } = await makeKey(b, other);
		expect(res.status).toBe(403);
		expect(html).toContain("different NoDrive account");
		expect(key).toBeNull();
		expect(appPasswords(other)).toEqual([]);
		expect(await vaultFor(env, uid).listConnections()).toEqual([]);
		expect(await vaultFor(env, other).listConnections()).toEqual([]);
	});

	it("\"only from this network\" locks the key to the address it was made from", async () => {
		const uid = person();
		const b = new Browser("198.51.100.77");
		await signIn(b, uid);
		const { key } = await makeKey(b, uid, { ip_lock: "1", label: "Locked key" });
		expect((await onlyofficePost(key as string, INIT_2024, "198.51.100.77")).status).toBe(200);
		expect((await onlyofficePost(key as string, INIT_2024, "198.51.100.78")).status).toBe(401);
	});

	it("refuses bad names, no apps and odd lifetimes, drops mail and unknown choices, and keeps read on", () => {
		const scopes = ["workspace.read", "workspace.write", "workspace.remove", "workspace.share"] as const;
		const apps = ["files", "docs", "calendar", "contacts", "boards"] as const;
		const f = (o: Record<string, string | string[]>) => {
			const form = new URLSearchParams();
			for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) form.append(k, x);
			return parseKeyForm(form, scopes, apps);
		};
		const good = f({ label: "  My   laptop ", scope: ["workspace.write", "mail.write", "admin"], app: ["files", "mail", "x"], days: "60" });
		expect(good).toEqual({ ok: true, values: { label: "My laptop", scopes: ["workspace.read", "workspace.write"], apps: ["files"], days: 60, ipLock: false } });
		for (const [o, words] of [
			[{ label: "", app: "files" }, "Give the key a name"],
			[{ label: "a".repeat(41), app: "files" }, "too long"],
			[{ label: "<b>key</b>", app: "files" }, "Use only letters"],
			[{ label: ["Next", "cloud key"].join(""), app: "files" }, "another name"],
			[{ label: ["Next", "_", "Cloud"].join(""), app: "files" }, "another name"],
			[{ label: "Key", app: "mail" }, "at least one app"],
			[{ label: "Key", app: "files", days: "365" }, "7, 30 or 60"],
		] as const) {
			const r = f(o as Record<string, string | string[]>);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toContain(words);
		}
	});

	it("keeps this page's own sign-in name: no key looks like \"AI app (Connections page)\" on NoDrive's grant page", () => {
		const scopes = ["workspace.read", "workspace.write"] as const;
		const apps = ["files"] as const;
		const f = (label: string) => parseKeyForm(new URLSearchParams({ label, app: "files" }), scopes, apps);
		for (const label of [
			"Connections page",
			"connections PAGE",
			"  Connections   page ",
			"Connections_page",
			"Connections-Page",
			"Connections.page",
			"connectionspage",
			"Connection page",
			"My Connections page",
			"Connections page 2",
			["Connections ", "Next", "cloud page"].join(""),
		]) {
			const r = f(label);
			expect(r.ok, label).toBe(false);
			// The brand rule may refuse first (the upstream product name); either way it is refused.
			if (!r.ok) expect(r.error).toMatch(/belongs to this page's own sign-in|^Choose another name for the key\.$/);
			expect(isReservedLabel(label), label).toBe(true);
		}
		for (const label of ["ONLYOFFICE laptop", "Connections", "Page", "Desk page", "Reconnect laptop"]) {
			expect(f(label).ok, label).toBe(true);
			expect(isReservedLabel(label), label).toBe(false);
		}
	});

	it("a key name refused for the upstream product name is never shown back on the form (brand rule 6)", async () => {
		const brand = ["Next", "cloud"].join("");
		const scopes = ["workspace.read"] as const;
		const apps = ["files"] as const;
		for (const label of [`${brand} key`, `My ${["Next", "_", "Cloud"].join("")}`, `<b>${brand}</b>`, `${"x".repeat(36)} ${brand}`, `${["Next", " cloud"].join("")} key`]) {
			const r = parseKeyForm(new URLSearchParams({ label, app: "files" }), scopes, apps);
			expect(r.ok, label).toBe(false);
			expect(r.values.label, label).toBe("");
		}
		// A refused name without the brand word is still put back, so it can be corrected.
		const fixable = parseKeyForm(new URLSearchParams({ label: "<b>key</b>", app: "files" }), scopes, apps);
		expect(fixable.values.label).toBe("<b>key</b>");
		const uid = person();
		const b = new Browser();
		await signIn(b, uid);
		const csrf = csrfOf(await (await b.go("/connections/new-key")).text());
		const before = fake.requests.length;
		for (const label of [`${["Next", " cloud"].join("")} key`, `<i>${brand}</i>`]) {
			const res = await b.post("/connections/new-key", { csrf, label, app: "files", days: "30" });
			expect(res.status).toBe(400);
			const page = unesc(await res.text());
			expect(page).toContain('name="label" maxlength="40" required value=""');
			expect(BUILTIN_BRAND_RULES.filter((rule) => rule.pattern.test(page)).map((rule) => rule.id)).toEqual([]);
		}
		expect(loginFlowStarts(before)).toBe(0);
	});

	it("at the cap a new key replaces the least recently used connection with exactly the same name, an AI app's too, as the form says", async () => {
		const uid = person();
		const b = new Browser();
		await signIn(b, uid);
		const older = await seedConnection(uid, "Twin");
		const newer = await seedConnection(uid, "Twin");
		for (const label of ["A", "B", "C"]) await seedConnection(uid, label);
		await runInDurableObject(vaultFor(env, uid), async (_i: Vault, state) => {
			state.storage.sql.exec("UPDATE conn SET last_used_at = last_used_at - 1000 WHERE id = ?", older);
		});
		const form = unesc(await (await b.go("/connections/new-key")).text());
		expect(form).toContain(CAP_REPLACE_TEXT);
		expect(CAP_REPLACE_TEXT).toContain("least recently used connection with exactly the same name, an AI app's too");
		expect(form).not.toContain("replaces the oldest");
		// Not exactly the same name: refused before NoDrive is asked.
		const csrf = csrfOf(form);
		expect((await b.post("/connections/new-key", { csrf, label: "twin", app: "files", days: "30" })).status).toBe(409);
		// Exactly the same name: the least recently used "Twin" (an AI app's connection) is replaced.
		const { res } = await makeKey(b, uid, { label: "Twin" });
		expect(res.status).toBe(200);
		const rows = await vaultFor(env, uid).listConnections();
		expect(rows.map((r) => r.connectionId)).not.toContain(older);
		expect(rows.map((r) => r.connectionId)).toContain(newer);
		expect(rows.filter((r) => r.clientLabel === "Twin").map((r) => r.kind).sort()).toEqual(["desktop", "oauth"]);
		expect(rows.length).toBe(5);
	});

	it("the list says when each connection ends: both dates when the vault reports the latest end, else the nearer date with the rule that made it", async () => {
		const t = 1_790_000_000;
		const base: ConnectionSummary = { connectionId: "a".repeat(32), kind: "desktop", clientId: null, clientLabel: "K", scopes: ["workspace.read"], apps: ["files"], createdAt: t, lastUsedAt: t + 86400, expiresAt: t + 31 * 86400, status: "active" };
		const withHard = (hard: number) => ({ ...base, hardExpiresAt: hard }) as ConnectionSummary;
		// A 60-day key, used once: 30 days after that use, and 60 days after it was made at the latest.
		expect(endsText(withHard(t + 60 * 86400))).toBe(`ends ${when(t + 31 * 86400)} if it isn't used before then, and ${when(t + 60 * 86400)} at the latest`);
		// A 7-day key: its chosen end comes first, so that is the one date.
		expect(endsText({ ...withHard(t + 7 * 86400), expiresAt: t + 7 * 86400 })).toBe(`ends ${when(t + 7 * 86400)}`);
		// Without the latest end (core today): the nearer date and the rule.
		expect(endsText(base)).toBe(`ends ${when(t + 31 * 86400)} (whichever comes first: 30 days after its last use, or the end of the time chosen for it)`);
		expect(endsText({ ...base, kind: "oauth" })).toBe(`ends ${when(t + 31 * 86400)} (whichever comes first: 14 days after its last use, or 60 days after it was connected)`);
		// A dev row follows the rules it was made with, read from the row (the live review's case: a
		// /dev/token row has an AI app's 14 idle days, not a desktop key's 30).
		const dev = (idleEnd: number): ConnectionSummary => ({ ...base, kind: "dev", expiresAt: base.lastUsedAt + idleEnd });
		expect(endsText(dev(14 * 86400))).toBe(`ends ${when(base.lastUsedAt + 14 * 86400)} (whichever comes first: 14 days after its last use, or 60 days after it was connected)`);
		expect(endsText(dev(30 * 86400))).toBe(`ends ${when(base.lastUsedAt + 30 * 86400)} (whichever comes first: 30 days after its last use, or the end of the time chosen for it)`);
		expect(endsText(dev(5 * 86400))).toBe(`ends ${when(base.lastUsedAt + 5 * 86400)} (the end of the time chosen for it)`);
		// The page uses it with the vault's real summary (whichever form the vault reports today).
		const uid = person();
		await seedConnection(uid, "Rule shown", "desktop");
		const [row] = await vaultFor(env, uid).listConnections();
		const html = unesc(await signIn(new Browser(), uid));
		expect(html).toContain(`· ${endsText(row as ConnectionSummary)}</p>`);
	});

	it("End deletes a desktop key's ct: record at once when core's index names it (lane F's half of the core patch \"ct index\")", async () => {
		const uid = person();
		const b = new Browser();
		await signIn(b, uid);
		const { key } = await makeKey(b, uid, { label: "Index check" });
		const hash = await sha256Hex(key as string);
		const [row] = await vaultFor(env, uid).listConnections();
		const id = row?.connectionId as string;
		// What the patched storeDesktopKey writes next to ct:<hash> (DESIGN 9.3; lane F notes).
		await env.OAUTH_KV.put(keyIndexKey(id), hash, { expirationTtl: 3600 });
		const page = await (await b.go("/connections")).text();
		const end = await b.post("/connections/end", { csrf: csrfOf(page), connection_id: id });
		expect(end.headers.get("location")).toBe("/connections?n=ended");
		expect(await env.OAUTH_KV.get(`ct:${hash}`)).toBeNull();
		expect(await env.OAUTH_KV.get(keyIndexKey(id))).toBeNull();
		expect((await onlyofficePost(key as string, INIT_2024)).status).toBe(401);
		// A damaged index names nothing: no other record is touched, and the index is cleared.
		const other = `ct:${"b".repeat(64)}`;
		await env.OAUTH_KV.put(other, "{}", { expirationTtl: 3600 });
		const id2 = "e".repeat(32);
		await env.OAUTH_KV.put(keyIndexKey(id2), "not-a-hash", { expirationTtl: 3600 });
		expect(await forgetDesktopKey(env, id2)).toBe(false);
		expect(await env.OAUTH_KV.get(keyIndexKey(id2))).toBeNull();
		expect(await env.OAUTH_KV.get(other)).toBe("{}");
		expect(await forgetDesktopKey(env, "../x")).toBe(false);
	});

	it("refuses the reserved name on the form without asking NoDrive", async () => {
		const uid = person();
		const b = new Browser();
		await signIn(b, uid);
		const csrf = csrfOf(await (await b.go("/connections/new-key")).text());
		const before = fake.requests.length;
		const res = await b.post("/connections/new-key", { csrf, label: "Connections page", app: "files", days: "30" });
		expect(res.status).toBe(400);
		expect(unesc(await res.text())).toContain("That name belongs to this page's own sign-in.");
		expect(loginFlowStarts(before)).toBe(0);
	});

	it("the setting to paste is the whole mcpServers block ONLYOFFICE's Edit configuration expects", () => {
		const key = `nxw_ct_${"A".repeat(43)}`;
		const json = JSON.parse(desktopKeySetting("https://mcp.nourax.org", key)) as Record<string, unknown>;
		expect(json).toEqual({ mcpServers: { nourax: { url: "https://mcp.nourax.org/mcp", headers: { Authorization: `Bearer ${key}` } } } });
	});

	it("shows form errors without asking NoDrive, and checks the 5-connection cap first", async () => {
		const uid = person();
		const b = new Browser();
		await signIn(b, uid);
		const csrf = csrfOf(await (await b.go("/connections/new-key")).text());
		const before = fake.requests.length;
		const bad = await b.post("/connections/new-key", { csrf, label: "<script>", app: "files", days: "30" });
		expect(bad.status).toBe(400);
		const badHtml = await bad.text();
		expect(badHtml).toContain("Use only letters");
		expect(badHtml).toContain('value="&lt;script&gt;"');
		for (let i = 0; i < 5; i++) await seedConnection(uid, `App ${i}`);
		expect(await (await b.go("/connections/new-key")).text()).toContain("You already have 5 connections");
		const full = await b.post("/connections/new-key", { csrf, label: "New key", app: "files", days: "30" });
		expect(full.status).toBe(409);
		expect(fake.requests.slice(before).some((r) => /\/login\/v2$/.test(r.url.pathname))).toBe(false);
		// The same name as an existing connection replaces it (the vault's rule), so NoDrive is asked.
		expect((await b.post("/connections/new-key", { csrf, label: "App 0", app: "files", days: "30" })).status).toBe(302);
	});

	it("isn't started without both Worker secrets (no app password that could never be revoked)", async () => {
		const uid = person();
		const b = new Browser();
		await signIn(b, uid);
		const csrf = csrfOf(await (await b.go("/connections/new-key")).text());
		const before = fake.requests.length;
		const req = new Request(`${ORIGIN}/connections/new-key`, {
			method: "POST",
			headers: { ...SAME, "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": b.ip as string, cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
			body: new URLSearchParams({ csrf, label: "Key", app: "files", days: "30" }).toString(),
		});
		const res = await handleRequest(req, { ...env, NX_REVOKE_SECRET: "short" }, ctx);
		expect(res.status).toBe(503);
		expect(await res.text()).toContain("Nothing was shared");
		expect(fake.requests.slice(before).some((r) => /\/login\/v2$/.test(r.url.pathname))).toBe(false);
	});
});

describe("sessions and form checks", () => {
	it("signed-in POSTs need the session's own CSRF token; without a session they go back to sign-in", async () => {
		const uid = person();
		const id = await seedConnection(uid, "Some app");
		const b = new Browser();
		const html = await signIn(b, uid);
		expect((await b.post("/connections/end", { connection_id: id })).status).toBe(403);
		expect((await b.post("/connections/end", { csrf: "x".repeat(43), connection_id: id })).status).toBe(403);
		expect((await b.post("/connections/end", { csrf: csrfOf(html), connection_id: id }, { origin: "https://evil.example" })).status).toBe(403);
		const stranger = new Browser();
		const res = await stranger.post("/connections/end", { csrf: csrfOf(html), connection_id: id });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/connections?n=expired");
		expect((await vaultFor(env, uid).listConnections()).length).toBe(1);
	});

	it("a tampered or expired session cookie counts as signed out", async () => {
		const uid = person();
		const b = new Browser();
		await signIn(b, uid);
		const raw = b.cookies.get("__Host-nx-session") as string;
		const [payload, mac] = raw.split(".");
		const forged = JSON.parse(new TextDecoder().decode(fromB64url(payload as string))) as { uid: string; exp: number };
		for (const bad of [`${b64url(new TextEncoder().encode(JSON.stringify({ ...forged, uid: crypto.randomUUID() })))}.${mac}`, `${payload}.AAAA`, "garbage"]) {
			b.cookies.set("__Host-nx-session", bad);
			expect(await (await b.go("/connections")).text()).toContain("Sign in with NoDrive");
		}
	});

	it("sign-out clears the session", async () => {
		const uid = person();
		const b = new Browser();
		const html = await signIn(b, uid);
		const res = await b.post("/connections/sign-out", { csrf: csrfOf(html) });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/connections?n=signed-out");
		expect(res.headers.getSetCookie().some((c) => /^__Host-nx-session=; .*Max-Age=0/.test(c))).toBe(true);
		const after = unesc(await (await b.go("/connections?n=signed-out")).text());
		expect(after).toContain("Sign in with NoDrive");
		expect(after).toContain(`<p class="muted" role="status">${NOTICES["signed-out"]}</p>`);
	});

	it("sign-out ends the page's sign-in on the server, in every browser: a kept copy of the cookie and another browser's sign-in stop working, someone else's doesn't", async () => {
		const uid = person();
		const a = new Browser();
		const html = await signIn(a, uid);
		const kept = a.cookies.get("__Host-nx-session") as string;
		const b = new Browser();
		await signIn(b, uid);
		const otherPerson = person();
		const c = new Browser();
		await signIn(c, otherPerson);
		const id = await seedConnection(uid, "Keep me");
		// Sessions carry whole seconds: let the second turn, so both sign-ins above are "before".
		await new Promise((r) => setTimeout(r, 1100));
		const res = await a.post("/connections/sign-out", { csrf: csrfOf(html) });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/connections?n=signed-out");
		expect(unesc(await (await a.go("/connections?n=signed-out")).text())).toContain(NOTICES["signed-out"]);
		// The cookie copied before signing out (the verifier's replay): signed out, and its POSTs too.
		const replay = new Browser();
		replay.cookies.set("__Host-nx-session", kept);
		expect(await (await replay.go("/connections")).text()).toContain("Sign in with NoDrive");
		const endTry = await replay.post("/connections/end", { csrf: csrfOf(html), connection_id: id });
		expect(endTry.headers.get("location")).toBe("/connections?n=expired");
		expect((await replay.go("/connections/new-key")).headers.get("location")).toBe("/connections");
		expect((await vaultFor(env, uid).listConnections()).map((r) => r.connectionId)).toEqual([id]);
		// The same person's sign-in in another browser ends too (the Drive-only phishing case, 7.3).
		expect(await (await b.go("/connections")).text()).toContain("Sign in with NoDrive");
		// Another person's sign-in is not touched.
		expect(await (await c.go("/connections")).text()).toContain("Connected now");
		// The record: the time and a hash of the session's nonce; no uid, no nonce, no cookie.
		const rec = (await env.OAUTH_KV.get(await signOutKey(uid))) as string;
		expect(rec).toMatch(/^\d{10}:[0-9a-f]{32}$/);
		expect(rec).not.toContain(uid);
		expect(await signOutKey(uid)).not.toContain(uid);
		// Signing in again right after works, even within the same second as the sign-out.
		expect(await signIn(new Browser(), uid)).toContain("Connected now");
	});

	it("when the sign-out can't be recorded (KV refused the write), the cookie still goes and the page says only this browser is signed out", async () => {
		const uid = person();
		const b = new Browser();
		const html = await signIn(b, uid);
		const kv = env.OAUTH_KV;
		const refusing = {
			...env,
			OAUTH_KV: {
				get: kv.get.bind(kv),
				getWithMetadata: kv.getWithMetadata.bind(kv),
				list: kv.list.bind(kv),
				delete: kv.delete.bind(kv),
				put: async () => {
					throw new Error("KV PUT failed: 429 Too Many Requests");
				},
			} as unknown as KVNamespace,
		} as NxEnv;
		const res = await postWithEnv(b, "/connections/sign-out", { csrf: csrfOf(html) }, refusing);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/connections?n=signed-out-here");
		expect(res.headers.getSetCookie().some((c) => /^__Host-nx-session=; .*Max-Age=0/.test(c))).toBe(true);
		// postWithEnv doesn't keep cookies: take the note the sign-out set, as the browser would.
		expect(res.headers.getSetCookie().some((c) => c.startsWith(`${NOTE_COOKIE}=signed-out-here;`))).toBe(true);
		b.cookies.delete("__Host-nx-session");
		b.cookies.set(NOTE_COOKIE, "signed-out-here");
		const page = unesc(await (await b.go("/connections?n=signed-out-here")).text());
		expect(page).toContain(`<p class="warn" role="status">${NOTICES["signed-out-here"]}</p>`);
	});

	it("sign-out without a live session in this browser (no cookie, an expired one, one already signed out) ends nothing anywhere and says so, never \"every browser\"", async () => {
		const uid = person();
		// Another browser of the same person stays signed in throughout.
		const other = new Browser();
		await signIn(other, uid);
		// A tab left open past 30 minutes: its cookie has expired (the review's case).
		const realNow = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(realNow - (31 * 60 * 1000));
		const stale = (await issueSession(env, uid)).cookie.split(";")[0]?.split("=").slice(1).join("=") as string;
		vi.mocked(Date.now).mockRestore();
		const kept = new Browser();
		kept.cookies.set("__Host-nx-session", stale);
		for (const b of [new Browser(), kept]) {
			const res = await b.post("/connections/sign-out", {});
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/connections?n=already-out");
			const page = unesc(await (await b.go("/connections?n=already-out")).text());
			expect(page).toContain(`<p class="warn" role="status">${NOTICES["already-out"]}</p>`);
			expect(page).not.toContain(NOTICES["signed-out"]);
			expect(page).toContain("Sign in with NoDrive");
		}
		// Nothing was recorded, so the other browser's sign-in is still valid.
		expect(await env.OAUTH_KV.get(await signOutKey(uid))).toBeNull();
		expect(await (await other.go("/connections")).text()).toContain("Connected now");
		// A cookie already signed out (it signed out once): the second sign-out says "already" too.
		const html = await (await other.go("/connections")).text();
		const copy = other.cookies.get("__Host-nx-session") as string;
		expect((await other.post("/connections/sign-out", { csrf: csrfOf(html) })).headers.get("location")).toBe("/connections?n=signed-out");
		const again = new Browser();
		again.cookies.set("__Host-nx-session", copy);
		expect((await again.post("/connections/sign-out", { csrf: csrfOf(html) })).headers.get("location")).toBe("/connections?n=already-out");
		// The words say only what happened.
		expect(NOTICES["already-out"]).toContain("nothing was signed out anywhere else");
		expect(NOTICES["already-out"]).not.toMatch(/every browser/);
	});

	it("a notice shows only after this browser's own action, once; a link alone or another code shows none, and a signed-out notice never shows above a signed-in list", async () => {
		const uid = person();
		const id = await seedConnection(uid, "Notice app");
		const b = new Browser();
		const html = await signIn(b, uid);
		const end = await b.post("/connections/end", { csrf: csrfOf(html), connection_id: id });
		expect(end.headers.get("location")).toBe("/connections?n=ended");
		const note = end.headers.getSetCookie().find((c) => c.startsWith(`${NOTE_COOKIE}=`)) as string;
		expect(note).toBe(`${NOTE_COOKIE}=ended; Path=/; Max-Age=60; Secure; SameSite=Strict; HttpOnly`);
		// The page after the action shows it and clears the note.
		const shown = await b.go("/connections?n=ended");
		expect(shown.headers.getSetCookie().some((c) => c.startsWith(`${NOTE_COOKIE}=; `) && /Max-Age=0/.test(c))).toBe(true);
		expect(await shown.text()).toContain(NOTICES.ended);
		// Once: the same address again shows nothing.
		expect(await (await b.go("/connections?n=ended")).text()).not.toContain(NOTICES.ended);
		// The same link in another browser of the same person shows nothing.
		const c = new Browser();
		await signIn(c, uid);
		expect(await (await c.go("/connections?n=ended")).text()).not.toContain(NOTICES.ended);
		// A note for another code doesn't open this one.
		c.cookies.set(NOTE_COOKIE, "cleared");
		expect(await (await c.go("/connections?n=ended")).text()).not.toContain(NOTICES.ended);
		// A signed-out notice is never shown above a signed-in list, whatever the cookie says.
		for (const n of SIGNED_OUT_NOTICES) {
			c.cookies.set(NOTE_COOKIE, n);
			const list = unesc(await (await c.go(`/connections?n=${n}`)).text());
			expect(list, n).toContain("Connected now");
			expect(list, n).not.toContain(NOTICES[n]);
		}
	});

	it("answers 405 with Allow for wrong methods and 404 for unknown paths", async () => {
		const b = new Browser();
		const r = await b.go("/connections/end");
		expect(r.status).toBe(405);
		expect(r.headers.get("allow")).toBe("POST");
		expect((await b.go("/connections", { method: "PUT" })).headers.get("allow")).toBe("GET, HEAD");
		expect((await b.go("/connections/nope")).status).toBe(404);
	});

	it("without NX_SECRET the page answers 503 and changes nothing", async () => {
		for (const bad of ["", "short"]) {
			const res = await handleRequest(new Request(`${ORIGIN}/connections`, { headers: { "cf-connecting-ip": "203.0.113.250" } }), { ...env, NX_SECRET: bad }, ctx);
			expect(res.status).toBe(503);
		}
	});
});

describe("dev mode (loopback only)", () => {
	it("offers the QA picker on loopback, signs in as the picked QA account, and makes a key at once that never revokes the QA app password", async () => {
		const b = new Browser(null);
		const home = await (await b.go("/connections")).text();
		expect(home).toContain('name="dev_uid"');
		expect(home).toContain(`<option value="${QA.b}">`);
		expect(home).toContain("NX_DEV_AUTH_MARKER_7f3c");
		expect(home).not.toContain(QA_PASS[QA.b] as string);
		const res = await b.post("/connections/sign-in", { csrf: csrfOf(home), dev: "1", dev_uid: QA.b });
		expect(res.status).toBe(303);
		expect(b.cookies.has("__Host-nx-session")).toBe(true);
		// An unknown uid falls back to the real flow (and so needs NoDrive).
		const form = await (await b.go("/connections/new-key")).text();
		expect(form).toContain("Dev only");
		const made = await b.post("/connections/new-key", { csrf: csrfOf(form), label: "Dev key lane F", scope: "workspace.read", app: "files", days: "7" });
		expect(made.status).toBe(200);
		expect(made.headers.get("x-nx-dev")).toBe("NX_DEV_AUTH_MARKER_7f3c");
		const html = await made.text();
		const key = /nxw_ct_[A-Za-z0-9_-]{43}/.exec(html)?.[0] as string;
		expect(unesc(html)).toContain('{"mcpServers":{"nourax":{"url":"http://localhost:8787/mcp","headers":{"Authorization":"Bearer nxw_ct_');
		expect((await onlyofficePost(key, INIT_2024)).status).toBe(200);
		const page = await (await b.go("/connections")).text();
		expect(page).toContain("Dev key lane F");
		expect(page).toContain("Dev connection (local testing only)");
		const rows = await vaultFor(env, QA.b).listConnections();
		const row = rows.find((r) => r.clientLabel === "Dev key lane F");
		const end = await b.post("/connections/end", { csrf: csrfOf(page), connection_id: row?.connectionId as string });
		expect(end.headers.get("location")).toBe("/connections?n=ended");
		expect((await onlyofficePost(key, INIT_2024)).status).toBe(401);
		// The shared QA app password from the dev env file was never revoked.
		expect(fake.users.get(QA.b)?.passwords.has(QA_PASS[QA.b] as string)).toBe(true);
		expect(fake.requests.some((r) => r.method === "DELETE" && r.auth === QA.b)).toBe(false);
	});

	it("shows no picker to a request from a non-loopback address", async () => {
		const html = await (await new Browser("203.0.113.199").go("/connections")).text();
		expect(html).not.toContain("dev_uid");
		expect(html).not.toContain("NX_DEV_AUTH_MARKER_7f3c");
	});
});

describe("daily sign-in caps (the Quota object, the page's own \"page_signin\" cap, DESIGN 29.1)", () => {
	afterEach(() => _resetQuotaMemo());

	it("a checked sign-in start takes one unit of the \"page_signin\" cap; a refused form takes none", async () => {
		const calls: unknown[][] = [];
		const counting = withQuota((real, ...a) => {
			calls.push(a);
			return real(...a);
		});
		const b = new Browser();
		const csrf = csrfOf(await (await b.go("/connections")).text());
		expect((await postWithEnv(b, "/connections/sign-in", { csrf: "x".repeat(43) }, counting)).status).toBe(403);
		expect(calls).toEqual([]);
		const res = await postWithEnv(b, "/connections/sign-in", { csrf }, counting);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/connect");
		expect(calls.length).toBe(1);
		expect(calls[0]?.slice(0, 1)).toEqual(["page_signin"]);
		const caps = DAILY_CAPS.page_signin;
		expect(calls[0]?.slice(2)).toEqual([caps.perCaller, caps.global, caps.reserve]);
		// The caller key is an HMAC, never the IP.
		expect(String(calls[0]?.[1])).toMatch(/^[0-9a-f]{32}$/);
		expect(String(calls[0]?.[1])).not.toContain(b.ip as string);
	});

	it("someone who used up the day's AI-app sign-ins (\"authorize\") doesn't lock people out of this page", async () => {
		const q = env.QUOTA.get(env.QUOTA.idFromName("quota:v1:global"));
		const today = Math.floor(Date.now() / 86400000);
		const setGlobal = (name: string, n: number) =>
			runInDurableObject(q, async (_i: Quota, state) => {
				state.storage.sql.exec("INSERT INTO quota (k, n, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET n = excluded.n", `g:${name}:${today}`, n, (today + 2) * 86400);
			});
		try {
			await setGlobal("authorize", DAILY_CAPS.authorize.global);
			const b = new Browser();
			const csrf = csrfOf(await (await b.go("/connections")).text());
			const res = await postWithEnv(b, "/connections/sign-in", { csrf }, env);
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/connect");
			// Even the page's own cap used up leaves each network its reserve.
			await setGlobal("page_signin", DAILY_CAPS.page_signin.global);
			const c = new Browser();
			const csrf2 = csrfOf(await (await c.go("/connections")).text());
			expect((await postWithEnv(c, "/connections/sign-in", { csrf: csrf2 }, env)).status).toBe(302);
		} finally {
			await runInDurableObject(q, async (_i: Quota, state) => {
				state.storage.sql.exec("DELETE FROM quota");
			});
		}
	});

	it("at the cap the sign-in gets 429 with Retry-After until midnight UTC, and neither NoDrive nor a ConnectFlow is asked", async () => {
		for (const [scope, words] of [
			["caller", "Too many sign-ins were started from your network today."],
			["global", "Nourax Workspace has started too many sign-ins today."],
		] as const) {
			const full = withQuota(async () => ({ ok: false, scope, retryAfterSec: 4321 }));
			const b = new Browser();
			const csrf = csrfOf(await (await b.go("/connections")).text());
			const before = fake.requests.length;
			const res = await postWithEnv(b, "/connections/sign-in", { csrf }, full);
			expect(res.status).toBe(429);
			expect(res.headers.get("retry-after")).toBe("4321");
			expect(unesc(await res.text())).toContain(words);
			expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-nx-connect="))).toBe(false);
			expect(loginFlowStarts(before)).toBe(0);
			_resetQuotaMemo();
		}
	});

	it("with the Quota object out of reach the start fails closed (503) and nothing is started", async () => {
		const down = withQuota(async () => {
			throw new Error("quota unreachable");
		});
		const b = new Browser();
		const csrf = csrfOf(await (await b.go("/connections")).text());
		const before = fake.requests.length;
		const res = await postWithEnv(b, "/connections/sign-in", { csrf }, down);
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).toBe("60");
		expect(loginFlowStarts(before)).toBe(0);
	});

	it("desktop keys count against the same cap, after the form and the 5-connection check", async () => {
		const uid = person();
		const b = new Browser();
		await signIn(b, uid);
		const csrf = csrfOf(await (await b.go("/connections/new-key")).text());
		const calls: unknown[][] = [];
		const full = withQuota(async (_real, ...a) => {
			calls.push(a);
			return { ok: false, scope: "caller", retryAfterSec: 999 };
		});
		const before = fake.requests.length;
		// A bad form is refused before the cap is touched.
		expect((await postWithEnv(b, "/connections/new-key", { csrf, label: "", app: "files", days: "30" }, full)).status).toBe(400);
		expect(calls).toEqual([]);
		const res = await postWithEnv(b, "/connections/new-key", { csrf, label: "Capped key", app: "files", days: "30" }, full);
		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).toBe("999");
		expect(calls.length).toBe(1);
		expect(loginFlowStarts(before)).toBe(0);
	});
});

/**
 * Fixes that need core files (owned by the integrator; listed in lane F's result notes). Each test
 * states the fixed behaviour and is marked `it.fails` while core still behaves the old way, so
 * `npm test` passes now and fails loudly once the core change lands: then change `it.fails` to `it`.
 */
describe("waiting for core changes (it.fails until the integrator applies them)", () => {
	it.fails("core's production key page prints the whole mcpServers block and ONLYOFFICE's menu path (auth/connect.ts desktopKeyPage)", async () => {
		const uid = person();
		const b = new Browser();
		await signIn(b, uid);
		const { res, html, key } = await makeKey(b, uid, { label: "Block check" });
		expect(res.status).toBe(200);
		expect(unesc(html)).toContain(desktopKeySetting(ORIGIN, key as string));
		expect(html).toContain("Edit configuration");
		expect(html).not.toContain("AI Tools, then Settings");
	});

	it("an AI app can't register under this page's own sign-in name, or is shown as plain \"AI app\" (auth/dcr.ts, fix round 4)", async () => {
		for (const clientName of ["Connections page", "connections_PAGE", "My Connection page"]) {
			const reg = await call("/oauth/register", {
				method: "POST",
				headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${ipCounter++}` },
				body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:33418/callback"], token_endpoint_auth_method: "none", client_name: clientName }),
			});
			if (reg.status === 400) continue;
			expect(reg.status).toBe(201);
			const clientId = ((await reg.json()) as { client_id: string }).client_id;
			const b = new Browser();
			const q = new URLSearchParams({
				response_type: "code",
				client_id: clientId,
				redirect_uri: "http://127.0.0.1:33418/callback",
				scope: "workspace.read",
				state: "st",
				resource: `${ORIGIN}/mcp`,
				code_challenge: b64url(await sha256(b64url(randomBytes(32)))),
				code_challenge_method: "S256",
			});
			const consent = await (await b.go(`/authorize?${q}`)).text();
			const handle = (/name="handle" value="([^"]+)"/.exec(consent)?.[1] ?? "").replace(/&amp;/g, "&");
			const before = fake.requests.length;
			const toConnect = await b.post("/authorize", { handle, action: "approve", scope: ["workspace.read"], app: ["files"] }, { origin: ORIGIN });
			expect(toConnect.headers.get("location")).toBe("/connect");
			const ua = fake.requests.slice(before).find((r) => r.method === "POST" && /\/login\/v2$/.test(r.url.pathname))?.headers.get("user-agent") ?? "";
			expect(isReservedLabel(ua.replace(/^AI app \(|\)$/g, "")), `${clientName} -> ${ua}`).toBe(false);
		}
	});

	it.fails("a page sign-in and a desktop key point back to the connections page, not to an AI app, and a page sign-in has no \"Step 2 of 2\" (auth/connect.ts)", async () => {
		// The page sign-in's waiting page: no step count (there is no step 1).
		const s = new Browser();
		const csrf = csrfOf(await (await s.go("/connections")).text());
		expect((await s.post("/connections/sign-in", { csrf })).status).toBe(302);
		const waiting = await (await s.go("/connect")).text();
		expect(waiting).toContain("Allow access to NoDrive");
		expect(waiting).not.toContain("Step 2 of 2");
		// A desktop key whose NoDrive start fails: start again from the connections page.
		const uid = person();
		const b = new Browser();
		await signIn(b, uid);
		const form = csrfOf(await (await b.go("/connections/new-key")).text());
		fake.on("POST", /^\/index\.php\/login\/v2$/, () => new Response("unavailable", { status: 503 }));
		const down = unesc(await (await b.post("/connections/new-key", { csrf: form, label: "Down key", app: "files", days: "30" })).text());
		expect(down).toContain("Try again in a minute from your connections page.");
		expect(down).not.toContain("your AI app");
		// No flow in this browser: both places are named.
		expect(unesc(await (await new Browser().go("/connect")).text())).toContain("Start again from your AI app or your connections page.");
	});

	it.fails("the list shows a 60-day key's chosen end as well as the nearer one (vault listConnections reports hardExpiresAt; core patch \"ends by\")", async () => {
		const uid = person();
		const b = new Browser();
		await signIn(b, uid);
		const { key } = await makeKey(b, uid, { label: "Sixty days", days: "60" });
		expect((await onlyofficePost(key as string, INIT_2024)).status).toBe(200);
		const [row] = await vaultFor(env, uid).listConnections();
		const hard = (row as ConnectionSummary & { hardExpiresAt?: number }).hardExpiresAt;
		expect(hard).toBe((row?.createdAt as number) + 60 * 86400);
		const html = unesc(await (await b.go("/connections")).text());
		expect(html).toContain(`and ${when(hard as number)} at the latest`);
	});

	it.fails("ending a desktop key also deletes its ct: record in KV at once (DESIGN 9.3; core's storeDesktopKey writes the ctc: index)", async () => {
		const uid = person();
		const b = new Browser();
		await signIn(b, uid);
		const { key } = await makeKey(b, uid, { label: "KV check" });
		const kvKey = `ct:${await sha256Hex(key as string)}`;
		expect(await env.OAUTH_KV.get(kvKey)).not.toBeNull();
		const page = await (await b.go("/connections")).text();
		const end = await b.post("/connections/end", { csrf: csrfOf(page), connection_id: connectionIds(page)[0] as string });
		expect(end.headers.get("location")).toBe("/connections?n=ended");
		expect(await env.OAUTH_KV.get(kvKey)).toBeNull();
	});

	it("a page sign-in whose app password NoDrive doesn't take is retried, or logged as revoke_stuck with reason \"session\" (auth/connect.ts completeConnect)", async () => {
		const uid = person();
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			lines.push(a.map(String).join(" "));
		});
		fake.on("DELETE", /^\/ocs\/v2\.php\/core\/apppassword$/, () => new Response("bad gateway", { status: 502 }));
		const before = fake.requests.length;
		await signIn(new Browser(), uid);
		const deletes = fake.requests.slice(before).filter((r) => r.method === "DELETE" && r.url.pathname === "/ocs/v2.php/core/apppassword").length;
		const stuck = lines.some((l) => {
			try {
				const j = JSON.parse(l) as { ev?: unknown; reason?: unknown };
				return j.ev === "revoke_stuck" && j.reason === "session";
			} catch {
				return false;
			}
		});
		expect(deletes > 1 || stuck).toBe(true);
	});

	it("a refused sign-in (admin account) whose new app password NoDrive doesn't take is retried, or logged as revoke_stuck with reason \"refused\" (auth/connect.ts refuse)", async () => {
		const admin = person(["admin"]);
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			lines.push(a.map(String).join(" "));
		});
		fake.on("DELETE", /^\/ocs\/v2\.php\/core\/apppassword$/, () => new Response("bad gateway", { status: 502 }));
		const b = new Browser();
		const csrf = csrfOf(await (await b.go("/connections")).text());
		expect((await b.post("/connections/sign-in", { csrf })).status).toBe(302);
		const before = fake.requests.length;
		const res = await grantAndFinish(b, admin);
		expect(res.status).toBe(403);
		expect(appPasswords(admin).length).toBe(1);
		const deletes = fake.requests.slice(before).filter((r) => r.method === "DELETE" && r.url.pathname === "/ocs/v2.php/core/apppassword").length;
		const stuck = lines.some((l) => {
			try {
				const j = JSON.parse(l) as { ev?: unknown; reason?: unknown };
				return j.ev === "revoke_stuck" && j.reason === "refused";
			} catch {
				return false;
			}
		});
		expect(deletes > 1 || stuck).toBe(true);
	});

	it("core's words for \"Replace and remove\" don't promise that all of it, or every change, can be undone while a tool under it has a part that is for good (mcp/catalog.ts SCOPE_WORDS, auth/consent.ts)", async () => {
		const partly = CATALOG.filter((c) => c.scope === "workspace.remove" && !UNDOABLE_REMOVE_TOOLS.has(c.name)).map((c) => c.name);
		expect(partly).toContain("calendar_cancel_event");
		expect(SCOPE_WORDS["workspace.remove"]).not.toMatch(/all can be undone/);
		// The consent page an AI app's sign-in opens.
		const reg = await call("/oauth/register", {
			method: "POST",
			headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${ipCounter++}` },
			body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "Undo check" }),
		});
		expect(reg.status).toBe(201);
		const clientId = ((await reg.json()) as { client_id: string }).client_id;
		const q = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: REDIRECT,
			scope: "workspace.read workspace.remove",
			state: "st",
			resource: `${ORIGIN}/mcp`,
			code_challenge: b64url(await sha256(b64url(randomBytes(32)))),
			code_challenge_method: "S256",
		});
		const consent = unesc(await (await new Browser().go(`/authorize?${q}`)).text());
		expect(consent).toContain('name="scope" value="workspace.remove"');
		expect(consent).not.toMatch(/all can be undone|Every change can be undone/);
	});
});

/**
 * docs/mcp.md describes what production does today. These run the real flow and check the docs
 * against the outcome, so a core change (the it.fails tests above) can't leave the docs behind.
 */
describe("docs/mcp.md follows what production does", () => {
	it("7.6: the docs say what an ended desktop key's KV record holds, that it stays after End, and that the key's next use (from its own network) deletes it", async () => {
		const uid = person();
		const lockedIp = "198.51.100.91";
		const b = new Browser(lockedIp);
		await signIn(b, uid);
		const { key } = await makeKey(b, uid, { label: "Record check", ip_lock: "1" });
		const kvKey = `ct:${await sha256Hex(key as string)}`;
		const rec = JSON.parse((await env.OAUTH_KV.get(kvKey)) as string) as Record<string, unknown>;
		// What the record holds, as 7.6 lists it: no secret, but the account, the name, the dates, the
		// format version and the IP lock.
		expect(Object.keys(rec).sort()).toEqual(["connectionId", "createdAt", "expiresAt", "ipLock", "label", "uid", "v"]);
		expect(rec.ipLock).toBe(lockedIp);
		expect(JSON.stringify(rec)).not.toContain(key as string);
		const s76 = docSection("7.6").replace(/\s+/g, " ");
		for (const words of ["the account id", "the connection id", "the key's name", "when it was made", "its end date", "a format number", "IP address"]) expect(s76).toContain(words);
		const page = await (await b.go("/connections")).text();
		await b.post("/connections/end", { csrf: csrfOf(page), connection_id: connectionIds(page)[0] as string });
		const staysAfterEnd = (await env.OAUTH_KV.get(kvKey)) !== null;
		expect(s76.includes("but the record itself stays")).toBe(staysAfterEnd);
		if (!staysAfterEnd) return; // the core change of the it.fails test above landed: End deletes it at once
		// From outside its IP lock the key is refused before the vault is asked (resolveDesktopKey).
		expect((await onlyofficePost(key as string, INIT_2024, "198.51.100.92")).status).toBe(401);
		const staysAfterOtherNetwork = (await env.OAUTH_KV.get(kvKey)) !== null;
		// From its own network the vault row is missing, so core's endAccess (mcp/handler.ts) deletes it.
		expect((await onlyofficePost(key as string, INIT_2024, lockedIp)).status).toBe(401);
		const staysAfterUse = (await env.OAUTH_KV.get(kvKey)) !== null;
		expect(s76.includes("until the key is next used (that request is refused and the record is deleted) or until its end date")).toBe(!staysAfterUse);
		expect(s76.includes("For a key limited to one network, only a use from that network deletes it.")).toBe(staysAfterOtherNetwork && !staysAfterUse);
		// Production today, measured: the record survives End and a use from elsewhere, and goes at the next own use.
		expect([staysAfterOtherNetwork, staysAfterUse]).toEqual([true, false]);
	});

	it("4.1, 9.4 and the sign-in page: when NoDrive doesn't take the removal of the page's own sign-in access, it stays, the session still starts, nothing secret is logged, the text says it can stay, and 9.4 says whether a log line marks it", async () => {
		const uid = person();
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			lines.push(a.map(String).join(" "));
		});
		fake.on("DELETE", /^\/ocs\/v2\.php\/core\/apppassword$/, () => new Response("bad gateway", { status: 502 }));
		const signedOut = unesc(await (await new Browser().go("/connections")).text());
		const before = fake.requests.length;
		await signIn(new Browser(), uid);
		// The fake refuses every removal, so "AI app (Connections page)" stays in NoDrive.
		const left = appPasswords(uid);
		expect(left.length).toBe(1);
		for (const l of lines) for (const p of left) expect(l).not.toContain(p);
		expect(fake.requests.slice(before).filter((r) => r.method === "DELETE" && r.url.pathname === "/ocs/v2.php/core/apppassword").length).toBeGreaterThan(0);
		// 9.4 says whether a log line marks the leftover; it must match what the connect step logs
		// (none today; `revoke_stuck` with reason `session` once the core change of the it.fails test
		// above lands).
		const stuck = lines.some((l) => {
			try {
				const j = JSON.parse(l) as { ev?: unknown; reason?: unknown };
				return j.ev === "revoke_stuck" && j.reason === "session";
			} catch {
				return false;
			}
		});
		const s94 = docSection("9.4").replace(/\s+/g, " ");
		expect(s94).toContain('A leftover "AI app (Connections page)"');
		expect(s94.includes("Today no log line marks such a leftover")).toBe(!stuck);
		if (stuck) expect(s94).toContain("`revoke_stuck` with reason `session`");
		// So neither the page nor docs/mcp.md 4.1 may say that it is removed, full stop.
		expect(signedOut).toContain(SESSION_GRANT_FATE);
		const s41 = docSection("4.1").replace(/\s+/g, " ");
		for (const text of [SESSION_GRANT_FATE, s41]) {
			expect(text).not.toMatch(/removed straight away/);
			expect(text).toContain("If NoDrive doesn't confirm that removal");
			expect(text).toContain("Nobody has its password: it was never stored or shown.");
		}
		expect(s41).toContain('"AI app (Connections page)" can stay in NoDrive\'s list of devices and sessions until the owner removes it');
	});

	it("7.3: the WAF pass is bound to one sign-in (its landing page's path), and the docs say what it covers and what it doesn't (section 30.2)", async () => {
		// On mcp.nourax.org every Login Flow v2 start (AI app, this page's sign-in, desktop key) sets the
		// cookies the WAF rule of DESIGN 20 item 2 checks for. Two starts, as two browsers would make them:
		const prod = { ...env, PUBLIC_ORIGIN: "https://mcp.nourax.org" } as NxEnv;
		const attr = (c: string, name: string) => new RegExp(`;\\s*${name}=([^;]*)`, "i").exec(c)?.[1];
		const flowPaths: string[][] = [];
		for (let i = 0; i < 2; i++) {
			const res = await startConnect(prod, { purpose: "session", clientLabel: SESSION_LABEL, scopes: [], apps: [], cli: "other" });
			expect(res.status).toBe(302);
			const set = res.headers.getSetCookie();
			const tokens = [...fake.flows.values()].map((f) => f.loginToken);
			const token = tokens[tokens.length - 1] as string;
			const flow = set.filter((c) => c.startsWith("__Secure-nx-wafflow="));
			// Sent only to this sign-in's own landing page, plain and with /index.php.
			expect(flow.map((c) => attr(c, "Path")).sort()).toEqual([`/index.php/login/v2/flow/${token}`, `/login/v2/flow/${token}`]);
			const pass = set.filter((c) => c.startsWith("__Secure-nx-wafpass="));
			// The pages after the landing; never Path=/, so it is not sent to the rest of nourax.org.
			expect(pass.map((c) => attr(c, "Path")).sort()).toEqual(["/index.php/login/v2", "/login/v2"]);
			for (const c of [...flow, ...pass]) {
				expect(attr(c, "Domain")).toBe("nourax.org");
				expect(attr(c, "Max-Age")).toBe("1200");
				expect(c).toMatch(/;\s*Secure(;|$)/);
				expect(c).toMatch(/;\s*HttpOnly(;|$)/);
				expect(attr(c, "SameSite")).toBe("Lax");
			}
			flowPaths.push(flow.map((c) => attr(c, "Path") as string));
		}
		// Each sign-in's pass is its own: nothing a browser holds for one opens another's landing page.
		expect(flowPaths[0]?.some((p) => flowPaths[1]?.includes(p))).toBe(false);
		const s73 = docSection("7.3").replace(/\s+/g, " ");
		expect(s73).not.toContain("isn't tied to one sign-in");
		expect(s73).toContain("bound to that one sign-in");
		expect(s73).toContain("A grant link for someone else's sign-in doesn't open");
		expect(s73).toContain("any page on a nourax.org address");
		const owner = DOC.slice(DOC.indexOf("## 10. Owner steps still open")).replace(/\s+/g, " ");
		expect(owner).toContain("opens only for the browser that started that sign-in");
	});
	it("7.3: ending a sign-in clears its own WAF pass, with the same domain and paths it was set with", async () => {
		const prod = { ...env, PUBLIC_ORIGIN: "https://mcp.nourax.org" } as NxEnv;
		const res = await startConnect(prod, { purpose: "session", clientLabel: SESSION_LABEL, scopes: [], apps: [], cli: "other" });
		const tokens = [...fake.flows.values()].map((f) => f.loginToken);
		const token = tokens[tokens.length - 1] as string;
		const connect = res.headers.getSetCookie().find((c) => c.startsWith("__Host-nx-connect=")) as string;
		const cancel = await connectCancel(new Request("https://mcp.nourax.org/connect/cancel", { headers: { cookie: connect.split(";")[0] as string, "sec-fetch-site": "same-origin" } }), prod);
		const cleared = cancel.headers.getSetCookie().filter((c) => c.startsWith("__Secure-nx-wafflow=;"));
		expect(cleared.map((c) => /;\s*Path=([^;]*)/i.exec(c)?.[1]).sort()).toEqual([`/index.php/login/v2/flow/${token}`, `/login/v2/flow/${token}`]);
		for (const c of cleared) {
			expect(c).toMatch(/Max-Age=0/);
			expect(c).toMatch(/Domain=nourax\.org/);
		}
	});

	it("2.4: the docs tell people how to complete the setting when the key page prints only the inner part", async () => {
		const uid = person();
		const b = new Browser();
		await signIn(b, uid);
		const { html, key } = await makeKey(b, uid, { label: "Docs check" });
		const s24 = docSection("2.4");
		const whole = unesc(html).includes(desktopKeySetting(ORIGIN, key as string));
		if (!whole) {
			expect(unesc(html)).toContain(JSON.stringify({ url: `${ORIGIN}/mcp`, headers: { Authorization: `Bearer ${key}` } }));
			expect(s24).toContain('If the key page shows only the part that starts with `{"url"`');
			expect(s24).not.toMatch(/inside this whole setting/);
		} else {
			// Core's key page prints the whole block (core patch "key page"): the workaround goes.
			expect(s24).not.toContain("If the key page shows only the part");
		}
		expect(s24).toContain("**AI agent > Settings > MCP Servers > Edit configuration**");
	});
});

describe("docs/mcp.md follows what production does (fix round 2 of the second review)", () => {
	it("4.1 and 7.3: the docs say sign-out ends the page's sign-in in every browser only while it really does", async () => {
		const uid = person();
		const a = new Browser();
		const html = await signIn(a, uid);
		const b = new Browser();
		await signIn(b, uid);
		await new Promise((r) => setTimeout(r, 1100));
		await a.post("/connections/sign-out", { csrf: csrfOf(html) });
		const otherBrowserOut = (await (await b.go("/connections")).text()).includes("Sign in with NoDrive");
		const s41 = docSection("4.1").replace(/\s+/g, " ");
		const s73 = docSection("7.3").replace(/\s+/g, " ");
		expect(s41.includes("ends your sign-in on this page in every browser")).toBe(otherBrowserOut);
		expect(s73.includes("that ends every sign-in to the page, theirs included")).toBe(otherBrowserOut);
		expect(otherBrowserOut).toBe(true);
		expect(s41).not.toContain("ends it sooner");
	});

	it("4.2: the docs say whether the list shows a key's latest end, as the vault reports it", async () => {
		const uid = person();
		await seedConnection(uid, "Docs dates", "desktop");
		const [row] = await vaultFor(env, uid).listConnections();
		const reported = typeof (row as ConnectionSummary & { hardExpiresAt?: unknown }).hardExpiresAt === "number";
		const s42 = docSection("4.2").replace(/\s+/g, " ");
		expect(s42).toContain("**When it ends.** A connection ends at whichever comes first");
		expect(s42.includes("Today the list shows the nearer date with the rule that made it")).toBe(!reported);
	});
});

describe("docs/mcp.md follows what production does (fix round 3 of the second review)", () => {
	it("4.1 and 7.3: the docs say what sign-out does in a tab that is no longer signed in, and that a link can't make the page show a notice, as the page does it", async () => {
		const uid = person();
		const other = new Browser();
		await signIn(other, uid);
		const stale = new Browser();
		const out = await stale.post("/connections/sign-out", {});
		const page = unesc(await (await stale.go(out.headers.get("location") ?? "/connections")).text());
		const saysAlready = page.includes(NOTICES["already-out"]);
		const otherStillIn = (await (await other.go("/connections")).text()).includes("Connected now");
		const crafted = unesc(await (await new Browser().go("/connections?n=signed-out")).text());
		const linkShowsNotice = crafted.includes(NOTICES["signed-out"]);
		const s41 = docSection("4.1").replace(/\s+/g, " ");
		const s73 = docSection("7.3").replace(/\s+/g, " ");
		// The notice the docs quote is the page's own text.
		expect(NOTICES["already-out"].startsWith("This browser was already signed out of this page")).toBe(true);
		expect(s41.includes('the page says so ("This browser was already signed out of this page")')).toBe(saysAlready && otherStillIn);
		expect(s73.includes('signing out there ends nothing (the page then says "This browser was already signed out of this page")')).toBe(saysAlready && otherStillIn);
		expect(s41.includes("an address with `?n=` alone shows no notice")).toBe(!linkShowsNotice);
		expect(s73.includes("never because of a link someone sent you")).toBe(!linkShowsNotice);
		expect([saysAlready, otherStillIn, linkShowsNotice]).toEqual([true, true, false]);
	});
});

describe("brand rule 6", () => {
	it("every page state is clean", async () => {
		const uid = person();
		await seedConnection(uid, "Claude");
		await seedConnection(uid, "My key", "desktop");
		await runInDurableObject(vaultFor(env, uid), async (_i: Vault, state) => {
			state.storage.sql.exec("INSERT INTO unrevoked (id, kind, client_label, created_at, ended_at, reason) VALUES (?, 'oauth', 'Old', 1, 2, 'x')", "d".repeat(32));
		});
		const texts: string[] = [];
		const out = new Browser();
		for (const p of ["/connections", "/connections?n=expired", "/connections/nope"]) texts.push(await (await out.go(p)).text());
		texts.push(await (await out.go("/connections", { headers: { "sec-fetch-site": "cross-site" } })).text());
		const b = new Browser();
		texts.push(await signIn(b, uid));
		// Every notice as it really shows (with its note cookie): signed-out ones on the sign-in page,
		// the others above the list.
		for (const n of Object.keys(NOTICES) as NoticeCode[]) {
			const where = SIGNED_OUT_NOTICES.has(n) ? out : b;
			where.cookies.set(NOTE_COOKIE, n);
			const html = await (await where.go(`/connections?n=${n}`)).text();
			expect(unesc(html), n).toContain(NOTICES[n]);
			texts.push(html);
		}
		const form = await (await b.go("/connections/new-key")).text();
		texts.push(form);
		texts.push(await (await b.post("/connections/new-key", { csrf: csrfOf(form), label: "", app: "files" })).text());
		texts.push(await (await b.go("/connections/end")).text());
		texts.push(await (await new Browser(null).go("/connections")).text());
		const bad = texts.flatMap((t, i) => BUILTIN_BRAND_RULES.filter((r) => r.pattern.test(t)).map((r) => `${i}:${r.id}`));
		expect(bad).toEqual([]);
	});
});
