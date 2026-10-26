/**
 * The real Drive-only sign-in, end to end through the Worker (dev mode off: the requests come from a
 * non-loopback IP). Registration, consent, Login Flow v2 with the identity checks, the code
 * exchange with PKCE, MCP calls with the new connection, refresh, and the same client again.
 */
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPS_COOKIE } from "../../src/auth/consent-memory";
import { b64url, fromB64url, randomBytes, sha256 } from "../../src/core/bytes";
import { tokenExchange } from "../../src/auth/tokens";
import { handleRequest } from "../../src/http/router";
import { APP_WORDS } from "../../src/mcp/catalog";
import { parseCloudUser } from "../../src/nc/client";
import { type Vault, vaultFor } from "../../src/vault/vault";
import { type FakeNc, ocs } from "../fake-nc/index";
import { call, env, fakeWithQa, mcpPost, ORIGIN, rpcResult } from "../helpers/index";

const OWNER = "5224252b-4938-4a86-a276-54bbae5d5b49";
const OTHER = "9d2c6a7e-1b3f-4c5d-8e9f-0a1b2c3d4e5f";
const ADMIN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
let ipCounter = 10;
let fake: FakeNc;

beforeEach(() => {
	fake = fakeWithQa();
	fake.addUser({ uid: OWNER, password: "unused-login-password-0123456789", displayName: "Hammad <b>R</b>", email: "owner@example.invalid" });
	fake.addUser({ uid: OTHER, password: "unused-login-password-0123456789", displayName: "Other Person" });
	fake.addUser({ uid: ADMIN, password: "unused-login-password-0123456789", displayName: "An Admin", groups: ["admin"] });
});
afterEach(() => vi.restoreAllMocks());

class Browser {
	cookies = new Map<string, string>();
	ip = `203.0.113.${ipCounter++}`;
	async go(path: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set("cf-connecting-ip", this.ip);
		if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
		const res = await call(path, { ...init, headers });
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

async function register(clientName = "Claude", authMethod = "none"): Promise<string> {
	const res = await call("/oauth/register", {
		method: "POST",
		headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${ipCounter++}` },
		body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: authMethod, client_name: clientName, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { client_id: string }).client_id;
}

async function startAuthorize(b: Browser, clientId: string, scope = "workspace.read workspace.write offline_access", pkce: "S256" | "plain" | "none" = "S256") {
	const verifier = b64url(randomBytes(32));
	const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope, state: "st-123", resource: `${ORIGIN}/mcp` });
	if (pkce === "S256") {
		q.set("code_challenge", b64url(await sha256(verifier)));
		q.set("code_challenge_method", "S256");
	} else if (pkce === "plain") {
		q.set("code_challenge", verifier);
		q.set("code_challenge_method", "plain");
	}
	const page = await b.go(`/authorize?${q.toString()}`);
	return { page, verifier };
}

function handleOf(html: string): string {
	const m = /name="handle" value="([^"]+)"/.exec(html);
	if (!m) throw new Error("no handle");
	return m[1] as string;
}

async function approve(
	b: Browser,
	html: string,
	choose: { scopes?: string[]; apps?: string[]; remember?: boolean; headers?: Record<string, string> } = {},
): Promise<Response> {
	const form = new URLSearchParams();
	form.set("handle", handleOf(html).replace(/&amp;/g, "&"));
	form.set("action", "approve");
	if (/name="offline" value="1"/.test(html)) form.set("offline", "1");
	if (choose.remember) form.set("remember", "1");
	for (const s of choose.scopes ?? ["workspace.read", "workspace.write", "workspace.remove"]) form.append("scope", s);
	for (const a of choose.apps ?? ["files", "docs", "calendar", "contacts", "boards"]) form.append("app", a);
	const headers = choose.headers ?? { origin: ORIGIN };
	return b.go("/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: form.toString() });
}

/** Grants the NoDrive step as `uid` and returns the code from the final redirect. */
async function finishConnect(b: Browser, uid: string): Promise<string> {
	const waiting = await b.go("/connect");
	fake.grantFlow(loginTokenFrom(await waiting.text()), uid);
	const done = await b.go("/connect");
	expect(done.status).toBe(302);
	return new URL(done.headers.get("location") ?? "").searchParams.get("code") as string;
}

function loginTokenFrom(html: string): string {
	const m = /redirectUrl=%2Flogin%2Fv2%2Fflow%2F([A-Za-z0-9]+)/.exec(html);
	if (!m) throw new Error("no login token in /connect page");
	return m[1] as string;
}

async function exchange(code: string, clientId: string, verifier: string) {
	const res = await call("/oauth/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "192.0.2.1" },
		body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${ORIGIN}/mcp` }).toString(),
	});
	return { status: res.status, body: (await res.json()) as { access_token: string; refresh_token?: string; scope: string } };
}

/** Consent, then the NoDrive step granted as `uid`. Returns the final /connect response. */
async function connectAs(uid: string, clientId?: string) {
	const cid = clientId ?? (await register());
	const b = new Browser();
	const { page, verifier } = await startAuthorize(b, cid);
	const html = await page.text();
	const toConnect = await approve(b, html);
	expect(toConnect.status).toBe(302);
	expect(toConnect.headers.get("location")).toBe("/connect");
	const waiting = await b.go("/connect");
	const wHtml = await waiting.text();
	expect(waiting.status).toBe(200);
	expect(wHtml).toContain("Step 2 of 2");
	expect(wHtml).toContain('http-equiv="refresh"');
	fake.grantFlow(loginTokenFrom(wHtml), uid);
	const done = await b.go("/connect");
	return { done, cid, verifier, b };
}

describe("consent page", () => {
	it("never shows the raw client name, shows the redirect host, ticks safe defaults and sends strict headers", async () => {
		const cid = await register('<img src=x onerror=alert(1)>"');
		const b = new Browser();
		const { page } = await startAuthorize(b, cid);
		const html = await page.text();
		expect(page.status).toBe(200);
		expect(html).not.toContain("<img src=x");
		// Fix round 4: the page shows the cleaned label (here from the checked redirect host), never the
		// name the app gave itself, so that name isn't on the page at all, escaped or not.
		expect(html).not.toContain("onerror");
		expect(html).toContain("<h1>Connect Claude to Nourax Workspace</h1>");
		expect(html).not.toContain("(name given by the app, not checked)");
		expect(html).toContain("Access will be sent to: <strong>claude.ai</strong>");
		expect(html).toMatch(/name="scope" value="workspace.write" checked/);
		expect(html).toMatch(/name="scope" value="workspace.share">/);
		expect(html).not.toContain("<script");
		expect(html).not.toContain("dev_uid");
		const csp = page.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("frame-ancestors 'none'");
		// Cancel redirects back to the app, so its (allowlisted) origin is a form target too.
		expect(csp).toContain("form-action 'self' https://tbwrezvhgoryzycjerrl.supabase.co https://claude.ai;");
		// Not no-referrer: under it, browsers send Origin: null on our own form POSTs.
		expect(page.headers.get("referrer-policy")).toBe("same-origin");
		expect(page.headers.get("x-content-type-options")).toBe("nosniff");
		expect(page.headers.get("cache-control")).toBe("no-store");
	});
	it("refuses a POST from another origin", async () => {
		const b = new Browser();
		const res = await b.go("/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.test" }, body: "handle=x&action=approve" });
		expect(res.status).toBe(403);
	});
	it("cancel sends access_denied back to the client with iss", async () => {
		const cid = await register();
		const b = new Browser();
		const { page } = await startAuthorize(b, cid);
		const form = new URLSearchParams({ handle: handleOf(await page.text()), action: "deny" });
		const res = await b.go("/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: form.toString() });
		expect(res.status).toBe(302);
		const loc = new URL(res.headers.get("location") ?? "");
		expect(loc.origin + loc.pathname).toBe(REDIRECT);
		expect(loc.searchParams.get("error")).toBe("access_denied");
		expect(loc.searchParams.get("state")).toBe("st-123");
		expect(loc.searchParams.get("iss")).toBe(ORIGIN);
	});
	it("cancel after the allowlist shrank: a local page, no Location, and the handle can't be used again (section 30.3)", async () => {
		const cid = await register();
		const b = new Browser();
		const { page } = await startAuthorize(b, cid);
		const form = new URLSearchParams({ handle: handleOf(await page.text()), action: "deny" });
		// The owner took claude.ai off ALLOWED_REDIRECTS (and deployed) while the consent page was open.
		const shrunk = { ...env, ALLOWED_REDIRECTS: "https://chatgpt.com/connector_platform_oauth_redirect loopback" };
		const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			lines.push(a.map(String).join(" "));
		});
		const post = () =>
			handleRequest(
				new Request(`${ORIGIN}/authorize`, {
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						origin: ORIGIN,
						"cf-connecting-ip": b.ip,
						cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
					},
					body: form.toString(),
				}),
				shrunk,
				ctx,
			);
		const res = await post();
		expect(res.status).toBe(400);
		expect(res.headers.get("location")).toBeNull();
		const html = await res.text();
		expect(html).toContain("<h1>Sign-in cancelled</h1>");
		expect(html).toContain("Nothing was connected. You can close this tab.");
		expect(html).not.toContain("st-123");
		// The consent handle's binding cookie is still cleared.
		expect(res.headers.getSetCookie().some((c) => /^__Host-nx-oauth-/.test(c) && /max-age=0/i.test(c))).toBe(true);
		const events = lines.map((l) => JSON.parse(l) as { t?: string; ev?: string }).filter((l) => l.t === "auth").map((l) => l.ev);
		expect(events).toContain("consent_denied");
		expect(events).toContain("redirect_rejected");
		// Used up: a second Cancel with the same handle is an expired page, not a redirect either.
		const again = await post();
		expect(again.status).toBe(400);
		expect(again.headers.get("location")).toBeNull();
	});
});

describe("the NoDrive step and the whole connection", () => {
	it("connects the owner, issues tokens, and the tools act as that person with the new app password", async () => {
		const { done, cid, verifier } = await connectAs(OWNER);
		expect(done.status).toBe(302);
		const loc = new URL(done.headers.get("location") ?? "");
		expect(loc.origin + loc.pathname).toBe(REDIRECT);
		expect(loc.searchParams.get("iss")).toBe(ORIGIN);
		const code = loc.searchParams.get("code") as string;
		const tok = await exchange(code, cid, verifier);
		expect(tok.status).toBe(200);
		expect(tok.body.refresh_token).toBeTruthy();
		expect(tok.body.scope.split(" ")).toEqual(expect.arrayContaining(["workspace.read", "workspace.write", "workspace.remove"]));
		// The app password was named after the client.
		const flow = [...fake.flows.values()].pop();
		expect(flow?.userAgent).toBe("AI app (Claude)");

		const res = await mcpPost(tok.body.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspace_whoami", arguments: {} } });
		const r = (await rpcResult(res)).result as { structuredContent: { user_id: string; display_name: string; connection: { kind: string; client: string; can: string[] } } };
		expect(r.structuredContent.user_id).toBe(OWNER);
		expect(r.structuredContent.connection).toMatchObject({ kind: "oauth", client: "Claude" });
		expect(r.structuredContent.connection.can).toContain("create and edit");
		const appPassCall = fake.driveCalls().filter((c) => c.url.pathname === "/ocs/v2.php/cloud/user" && c.auth === OWNER);
		expect(appPassCall.length).toBeGreaterThan(0);

		// Refresh works and keeps the connection.
		const refreshed = await call("/oauth/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "192.0.2.1" },
			body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.body.refresh_token as string, client_id: cid, resource: `${ORIGIN}/mcp` }).toString(),
		});
		expect(refreshed.status).toBe(200);
	});

	it("the same client connecting again ends the earlier connection and revokes its app password", async () => {
		const first = await connectAs(OWNER);
		const code1 = new URL(first.done.headers.get("location") ?? "").searchParams.get("code") as string;
		const t1 = await exchange(code1, first.cid, first.verifier);
		const firstPasswords = new Set(fake.users.get(OWNER)?.passwords);
		const second = await connectAs(OWNER, first.cid);
		expect(second.done.status).toBe(302);
		const owner = fake.users.get(OWNER);
		const survivors = [...firstPasswords].filter((p) => owner?.passwords.has(p) && p.startsWith("APPPASS"));
		expect(survivors).toEqual([]);
		const res = await mcpPost(t1.body.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
	});

	it.each([
		[ADMIN, "be connected to AI assistants. Use a normal Nourax account"],
		["qa-t1-91", "Only Nourax accounts"],
	])("refuses %s and revokes the new app password at once", async (uid, message) => {
		const { done } = await connectAs(uid);
		expect(done.status).toBe(403);
		expect(await done.text()).toContain(message);
		const pw = [...(fake.users.get(uid)?.passwords ?? [])].filter((p) => p.startsWith("APPPASS"));
		expect(pw).toEqual([]);
		expect(fake.requests.some((r) => r.method === "DELETE" && r.url.pathname === "/ocs/v2.php/core/apppassword")).toBe(true);
	});

	it("fails closed when NoDrive's cloud/user has no list of groups: refused, app password revoked", async () => {
		const stored = (await vaultFor(env, OWNER).listConnections()).length;
		for (const groups of [undefined, null, "admin", [1, 2], ["users", 7]]) {
			fake.on("GET", /^\/ocs\/v2\.php\/cloud\/user$/, (req) => {
				if (!req.auth) return new Response("", { status: 401 });
				const u = fake.users.get(req.auth);
				return ocs({ id: u?.uid, displayname: u?.displayName, quota: u?.quota, ...(groups === undefined ? {} : { groups }) });
			});
			const { done } = await connectAs(OWNER);
			expect(done.status, JSON.stringify(groups)).toBe(502);
			expect(await done.text()).toContain("couldn&#39;t be checked");
			const pw = [...(fake.users.get(OWNER)?.passwords ?? [])].filter((p) => p.startsWith("APPPASS"));
			expect(pw).toEqual([]);
			expect((await vaultFor(env, OWNER).listConnections()).length).toBe(stored);
		}
	});

	it("a Vault call that throws after the checks still revokes the new app password (fix round 3)", async () => {
		const stored = (await vaultFor(env, OWNER).listConnections()).length;
		const realGet = env.VAULT.get.bind(env.VAULT);
		vi.spyOn(env.VAULT, "get").mockImplementation((id: DurableObjectId) => {
			const stub = realGet(id);
			return new Proxy(stub, {
				get(target, prop, receiver) {
					if (prop === "revokeForClient") return async () => Promise.reject(new Error("overloaded"));
					return Reflect.get(target, prop, receiver);
				},
			});
		});
		const { done } = await connectAs(OWNER);
		vi.mocked(env.VAULT.get).mockRestore();
		expect(done.status).toBe(500);
		expect(await done.text()).toContain("Nothing was shared");
		const pw = [...(fake.users.get(OWNER)?.passwords ?? [])].filter((p) => p.startsWith("APPPASS"));
		expect(pw).toEqual([]);
		expect((await vaultFor(env, OWNER).listConnections()).length).toBe(stored);
	});

	it.each([["http://drive.nourax.org"], ["https://evil.example"], ["not a url"]])(
		"a Login Flow answer naming server %s is not used, and its app password is revoked on our drive (fix round 3)",
		async (server) => {
			fake.on("POST", /^\/(?:index\.php\/)?login\/v2\/poll$/, (req) => {
				const token = new URLSearchParams(req.body).get("token") ?? "";
				const f = fake.flows.get(token);
				if (!f || !f.granted || f.done) return new Response("[]", { status: 404 });
				f.done = true;
				return Response.json({ server, loginName: f.granted.uid, appPassword: f.granted.appPassword });
			});
			const cid = await register();
			const b = new Browser();
			const { page } = await startAuthorize(b, cid);
			expect((await approve(b, await page.text())).headers.get("location")).toBe("/connect");
			const waiting = await b.go("/connect");
			const pass = fake.grantFlow(loginTokenFrom(await waiting.text()), OWNER);
			const done = await b.go("/connect");
			expect(done.status).toBe(410);
			expect(fake.users.get(OWNER)?.passwords.has(pass)).toBe(false);
			// The flow is over: polling again doesn't get another chance at it.
			expect((await b.go("/connect")).status).not.toBe(302);
		},
	);

	it("parseCloudUser keeps groups only when they are a list of strings", () => {
		expect(parseCloudUser({ id: "u", groups: ["a", "admin"] }).groups).toEqual(["a", "admin"]);
		expect(parseCloudUser({ id: "u", groups: [] }).groups).toEqual([]);
		for (const groups of [undefined, null, "admin", {}, [1], ["a", null]]) expect(parseCloudUser({ id: "u", groups }).groups).toBeNull();
	});

	it("/connect without a flow, and cancel", async () => {
		const b = new Browser();
		expect((await b.go("/connect")).status).toBe(400);
		const cid = await register();
		const { page } = await startAuthorize(b, cid);
		await approve(b, await page.text());
		const cancel = await b.go("/connect/cancel");
		expect(cancel.status).toBe(302);
		expect(new URL(cancel.headers.get("location") ?? "").searchParams.get("error")).toBe("access_denied");
	});
});

describe("the consent form's same-origin check, in the shapes real browsers send", () => {
	it.each([
		["Origin null with Sec-Fetch-Site same-origin (a page under no-referrer)", { origin: "null", "sec-fetch-site": "same-origin" }, 302],
		["no Origin with Sec-Fetch-Site same-origin", { "sec-fetch-site": "same-origin" }, 302],
		["our Origin with Sec-Fetch-Site same-origin (Chrome, Firefox, Safari)", { origin: ORIGIN, "sec-fetch-site": "same-origin" }, 302],
		["our Origin only (a browser without Fetch Metadata)", { origin: ORIGIN }, 302],
		["Origin null without Sec-Fetch-Site", { origin: "null" }, 403],
		["Origin null from another site's no-referrer page", { origin: "null", "sec-fetch-site": "cross-site" }, 403],
		["our Origin claimed on a cross-site request", { origin: ORIGIN, "sec-fetch-site": "cross-site" }, 403],
		["a sibling subdomain", { origin: "https://drive.nourax.org", "sec-fetch-site": "same-site" }, 403],
		["no Origin and no Sec-Fetch-Site", {}, 403],
	])("%s: %s", async (_name, headers, status) => {
		const cid = await register();
		const b = new Browser();
		const { page } = await startAuthorize(b, cid);
		const res = await approve(b, await page.text(), { headers: headers as Record<string, string> });
		expect(res.status).toBe(status);
		if (status === 302) expect(res.headers.get("location")).toBe("/connect");
	});
});

describe("PKCE for every client", () => {
	it("refuses a self-registered confidential client that leaves out PKCE, with a local page and no redirect", async () => {
		const cid = await register("Some app", "client_secret_basic");
		const b = new Browser();
		const { page } = await startAuthorize(b, cid, "workspace.read", "none");
		expect(page.status).toBe(400);
		expect(page.headers.get("location")).toBeNull();
		expect(await page.text()).toContain("PKCE with S256");
		expect(b.cookies.size).toBe(0);
	});
	it("the plain method is refused too, and S256 works for the same confidential client", async () => {
		const cid = await register("Some app", "client_secret_basic");
		const plain = await startAuthorize(new Browser(), cid, "workspace.read", "plain");
		expect(plain.page.status).not.toBe(200);
		const s256 = await startAuthorize(new Browser(), cid, "workspace.read", "S256");
		expect(s256.page.status).toBe(200);
	});
	it("a public client without PKCE gets the library's RFC 6749 error redirect (no code), only while its redirect is allowlisted", async () => {
		const cid = await register();
		const { page } = await startAuthorize(new Browser(), cid, "workspace.read", "none");
		expect(page.status).toBe(302);
		const loc = new URL(page.headers.get("location") ?? "");
		expect(loc.origin + loc.pathname).toBe(REDIRECT);
		expect(loc.searchParams.get("error")).toBe("invalid_request");
		expect(loc.searchParams.get("code")).toBeNull();
		expect(loc.searchParams.get("state")).toBe("st-123");
		// The owner took claude.ai off ALLOWED_REDIRECTS after this client registered: a local page.
		const shrunk = { ...env, ALLOWED_REDIRECTS: "https://chatgpt.com/connector_platform_oauth_redirect loopback" };
		const q = new URLSearchParams({ response_type: "code", client_id: cid, redirect_uri: REDIRECT, scope: "workspace.read", state: "s", resource: `${ORIGIN}/mcp` });
		const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
		const res = await handleRequest(new Request(`${ORIGIN}/authorize?${q}`, { headers: { "cf-connecting-ip": "203.0.113.250" } }), shrunk, ctx);
		expect(res.status).toBe(400);
		expect(res.headers.get("location")).toBeNull();
		expect(await res.text()).toContain("This sign-in link isn&#39;t valid");
	});
});

describe("the consent POST body", () => {
	const chunked = (size: number) =>
		new ReadableStream<Uint8Array>({
			start(c) {
				for (let i = 0; i < size; i += 4096) c.enqueue(new TextEncoder().encode(`scope=${"a".repeat(4090)}`));
				c.close();
			},
		});
	it("is read at most 16 KB, chunked included (413), and only as an HTML form (415)", async () => {
		const b = new Browser();
		const form = { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN };
		const declared = await b.go("/authorize", { method: "POST", headers: { ...form, "content-length": String(17 * 1024) }, body: "a".repeat(17 * 1024) });
		expect(declared.status).toBe(413);
		const streamed = await b.go("/authorize", { method: "POST", headers: form, body: chunked(64 * 1024), duplex: "half" } as RequestInit);
		expect(streamed.status).toBe(413);
		for (const ct of ["multipart/form-data; boundary=x", "application/json", "text/plain"]) {
			const other = await b.go("/authorize", { method: "POST", headers: { "content-type": ct, origin: ORIGIN }, body: "handle=x&action=approve" });
			expect(other.status, ct).toBe(415);
		}
		// A small chunked form is read normally (here: an unknown handle, so "expired").
		const small = await b.go("/authorize", { method: "POST", headers: form, body: chunked(4096), duplex: "half" } as RequestInit);
		expect(small.status).toBe(400);
		expect(await small.text()).toContain("This page has expired");
	});
});

describe("remembered consent", () => {
	it("keeps the apps that were ticked, and shows the page again when they can't be recovered", async () => {
		const cid = await register();
		const b = new Browser();
		const first = await startAuthorize(b, cid);
		const toConnect = await approve(b, await first.page.text(), { apps: ["files"], remember: true });
		expect(toConnect.status).toBe(302);
		expect(b.cookies.has(APPS_COOKIE)).toBe(true);
		await exchange(await finishConnect(b, OWNER), cid, first.verifier);

		// Same browser, same client: the page is skipped and only Files is granted again.
		const second = await startAuthorize(b, cid);
		expect(second.page.status).toBe(302);
		expect(second.page.headers.get("location")).toBe("/connect");
		const tok = await exchange(await finishConnect(b, OWNER), cid, second.verifier);
		const r = (await rpcResult(await mcpPost(tok.body.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspace_whoami", arguments: {} } }))).result as {
			structuredContent: { connection: { apps: string[] } };
		};
		expect(r.structuredContent.connection.apps).toEqual([APP_WORDS.files]);

		// Without the remembered apps, the person is asked again instead of getting every app.
		b.cookies.delete(APPS_COOKIE);
		const third = await startAuthorize(b, cid);
		expect(third.page.status).toBe(200);
		expect(await third.page.text()).toContain('name="handle"');
	});
	it("a tampered apps cookie counts as missing", async () => {
		const cid = await register();
		const b = new Browser();
		const first = await startAuthorize(b, cid);
		await approve(b, await first.page.text(), { apps: ["files"], remember: true });
		const raw = b.cookies.get(APPS_COOKIE) as string;
		const [payload, mac] = raw.split(".");
		const forged = b64url(new TextEncoder().encode(new TextDecoder().decode(fromB64url(payload as string)).replace('["files"]', '["files","calendar","contacts","boards","docs"]')));
		b.cookies.set(APPS_COOKIE, `${forged}.${mac}`);
		const again = await startAuthorize(b, cid);
		expect(again.page.status).toBe(200);
	});
});

describe("a client's own revocation (RFC 7009)", () => {
	async function connected() {
		const cid = await register();
		const b = new Browser();
		const { page, verifier } = await startAuthorize(b, cid);
		await approve(b, await page.text());
		const tok = await exchange(await finishConnect(b, OWNER), cid, verifier);
		const v = vaultFor(env, OWNER);
		const mine = (await v.listConnections()).find((c) => c.clientId === cid);
		expect(mine?.status).toBe("active");
		return { cid, tok, v, connectionId: mine?.connectionId as string };
	}
	async function runGrantCheck(v: ReturnType<typeof vaultFor>) {
		await runInDurableObject(v, async (_i: Vault, state) => {
			const at = Number(state.storage.sql.exec<{ v: number }>("SELECT v FROM meta WHERE k = 'grant_check_at'").one().v);
			// Scheduled about two minutes out (KV's edge cache), not a day.
			expect(at - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(125);
			state.storage.sql.exec("UPDATE meta SET v = 0 WHERE k = 'grant_check_at'");
		});
		await runDurableObjectAlarm(v);
	}
	const revoke = (token: string, cid: string) =>
		call("/oauth/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "192.0.2.9" },
			body: new URLSearchParams({ token, token_type_hint: "refresh_token", client_id: cid }).toString(),
		});

	it("revoking the refresh token ends the vault connection and revokes its app password", async () => {
		const { cid, tok, v, connectionId } = await connected();
		const appPasswords = () => [...(fake.users.get(OWNER)?.passwords ?? [])].filter((p) => p.startsWith("APPPASS"));
		const before = appPasswords().length;
		expect((await revoke(tok.body.refresh_token as string, cid)).status).toBe(200);
		expect((await mcpPost(tok.body.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
		await runGrantCheck(v);
		expect(await v.status(connectionId)).toBe("revoked");
		expect(appPasswords().length).toBe(before - 1);
	});
	it("a forged revocation for a real grant changes nothing", async () => {
		const { cid, tok, v, connectionId } = await connected();
		const [uid, grantId] = (tok.body.refresh_token as string).split(":");
		expect((await revoke(`${uid}:${grantId}:${"x".repeat(32)}`, cid)).status).toBe(200);
		await runGrantCheck(v);
		expect(await v.status(connectionId)).toBe("active");
		expect((await mcpPost(tok.body.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
	});
});

describe("setup faults", () => {
	const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
	it("without NX_REVOKE_SECRET (or with a short one) no connection is started", async () => {
		const cid = await register();
		const q = new URLSearchParams({ response_type: "code", client_id: cid, redirect_uri: REDIRECT, scope: "workspace.read", state: "s", code_challenge: b64url(await sha256("v".repeat(43))), code_challenge_method: "S256", resource: `${ORIGIN}/mcp` });
		for (const bad of [undefined, "short-secret"]) {
			const res = await handleRequest(new Request(`${ORIGIN}/authorize?${q}`, { headers: { "cf-connecting-ip": "203.0.113.200" } }), { ...env, NX_REVOKE_SECRET: bad as unknown as string }, ctx);
			expect(res.status).toBe(503);
			expect(await res.text()).toContain("Nothing was shared");
		}
		expect(fake.requests.some((r) => r.url.pathname.endsWith("/login/v2"))).toBe(false);
	});
});

describe("tokenExchangeCallback", () => {
	const base = { clientId: "c", subjectClientId: "c", grantId: "g1", scope: [], requestedScope: [], resource: `${ORIGIN}/mcp`, env };
	it("binds the grant on code exchange and refuses dead, missing or 60-day-old connections on refresh", async () => {
		const uid = "12345678-1234-4234-8234-123456789012";
		const v = vaultFor(env, uid);
		const connectionId = "ab".repeat(16);
		await v.createConnection(
			{ connectionId, uid, kind: "oauth", clientId: "c", clientLabel: "Claude", scopes: ["workspace.read"], apps: ["files"], cred: { loginName: uid, appPassword: "p".repeat(30) }, idleSec: 3600, maxAgeSec: 86400 },
			randomBytes(32),
		);
		const props = { v: 1 as const, kind: "oauth" as const, uid, connectionId, vaultKey: b64url(randomBytes(32)), connectedAt: Math.floor(Date.now() / 1000), clientLabel: "Claude" };
		const code = await tokenExchange({ ...base, grantType: "authorization_code" as never, userId: uid, props });
		expect(code?.newProps?.grantId).toBe("g1");
		expect(await v.grantOf(connectionId)).toBe("g1");
		expect(await tokenExchange({ ...base, grantType: "refresh_token" as never, userId: uid, props })).toBeUndefined();
		await expect(tokenExchange({ ...base, grantType: "refresh_token" as never, userId: uid, props: { ...props, connectedAt: props.connectedAt - 61 * 86400 } })).rejects.toMatchObject({ code: "invalid_grant" });
		expect(await v.status(connectionId)).toBe("revoked");
		await expect(tokenExchange({ ...base, grantType: "refresh_token" as never, userId: uid, props })).rejects.toMatchObject({ code: "invalid_grant" });
		await expect(tokenExchange({ ...base, grantType: "refresh_token" as never, userId: "someone-else", props })).rejects.toMatchObject({ code: "invalid_grant" });
	});
});
