/**
 * Fix round 4, sign-in side:
 * - client_name: a name that looks like the connections page's own sign-in, or that carries the
 *   upstream product name, is refused at registration; clientLabel() shows such names, and names
 *   claiming to be Nourax, as plain "AI app", and the consent page shows that label, never the raw
 *   name;
 * - GET /connect/cancel refuses a navigation from another site (nothing changes), and its redirect
 *   back to the app is checked against ALLOWED_REDIRECTS again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkClientMetadata, clientLabel, reservedClientName } from "../../src/auth/dcr";
import { b64url, randomBytes, sha256 } from "../../src/core/bytes";
import { brandClean } from "../../src/core/brand";
import type { FakeNc } from "../fake-nc/index";
import { call, env, fakeWithQa, ORIGIN } from "../helpers/index";

const LOOPBACK = "http://127.0.0.1:33418/callback";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const ALLOW = ["loopback", CLAUDE];
let ip = 20;
let fake: FakeNc;
beforeEach(() => {
	fake = fakeWithQa();
});
afterEach(() => vi.restoreAllMocks());

class Browser {
	cookies = new Map<string, string>();
	ip = `203.0.113.${ip++}`;
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

async function register(clientName: string, redirect = LOOPBACK): Promise<Response> {
	return call("/oauth/register", {
		method: "POST",
		headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${ip++}` },
		body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none", client_name: clientName }),
	});
}

async function consentPage(b: Browser, clientId: string, redirect = LOOPBACK): Promise<string> {
	const q = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: redirect,
		scope: "workspace.read",
		state: "st",
		resource: `${ORIGIN}/mcp`,
		code_challenge: b64url(await sha256(b64url(randomBytes(32)))),
		code_challenge_method: "S256",
	});
	return (await b.go(`/authorize?${q}`)).text();
}

async function toWaiting(b: Browser, redirect = LOOPBACK): Promise<void> {
	const reg = await register("Plain helper", redirect);
	const clientId = ((await reg.json()) as { client_id: string }).client_id;
	const html = await consentPage(b, clientId, redirect);
	const handle = (/name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "").replace(/&amp;/g, "&");
	const form = new URLSearchParams({ handle, action: "approve" });
	form.append("scope", "workspace.read");
	form.append("app", "files");
	const res = await b.go("/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: form.toString() });
	expect(res.headers.get("location")).toBe("/connect");
}

describe("client names", () => {
	it("registration refuses the page's own sign-in name, its look-alikes and the upstream product name", () => {
		const nc = ["Next", "cloud"].join("");
		for (const name of ["Connections page", "connections_PAGE", "My Connection page", "Ｃｏｎｎｅｃｔｉｏｎｓ ｐａｇｅ", nc, `${nc} Assistant`, "N.e.x.t c-l-o-u-d"]) {
			expect(checkClientMetadata({ redirect_uris: [LOOPBACK], client_name: name }, ALLOW), name).toBe("client_name_reserved");
			expect(reservedClientName(name), name).toBe(true);
		}
		for (const name of ["Claude Desktop", "My helper", "Cursor"]) expect(checkClientMetadata({ redirect_uris: [LOOPBACK], client_name: name }, ALLOW), name).toBeNull();
	});

	it("clientLabel shows such names, and names claiming to be Nourax, as plain AI app", () => {
		const nc = ["Next", "cloud"].join("");
		for (const name of ["Connections page", `${nc} Helper`, "Nourax Workspace (official)", "N o u r a x support"]) expect(clientLabel(name, LOOPBACK), name).toBe("AI app");
		expect(clientLabel("Cursor", LOOPBACK)).toBe("Cursor");
		expect(clientLabel(undefined, LOOPBACK)).toBe("App on this computer");
		// A name from the redirect host is checked, whatever the app calls itself.
		expect(clientLabel("Nourax Workspace (official)", CLAUDE)).toBe("Claude");
	});

	it("the consent page shows the cleaned label, never the raw name", async () => {
		const reg = await register("Nourax Workspace (official)");
		expect(reg.status).toBe(201);
		const clientId = ((await reg.json()) as { client_id: string }).client_id;
		const html = await consentPage(new Browser(), clientId);
		expect(html).toContain("<h1>Connect AI app to Nourax Workspace</h1>");
		expect(html).not.toContain("official");
		expect(html).toContain("(name given by the app, not checked)");
		expect(brandClean(html)).toBe(true);
	});

	it("a client named after the host it returns to is shown by that name, without the 'not checked' note", async () => {
		const reg = await register("Claude", CLAUDE);
		const clientId = ((await reg.json()) as { client_id: string }).client_id;
		const html = await consentPage(new Browser(), clientId, CLAUDE);
		expect(html).toContain("<h1>Connect Claude to Nourax Workspace</h1>");
		expect(html).not.toContain("not checked");
	});
});

describe("GET /connect/cancel", () => {
	it("a navigation from another site is refused and the connect carries on", async () => {
		const b = new Browser();
		await toWaiting(b);
		for (const site of ["cross-site", "same-site"]) {
			const res = await b.go("/connect/cancel", { headers: { "sec-fetch-site": site } });
			expect(res.status).toBe(403);
			expect(res.headers.getSetCookie().length).toBe(0);
			expect(await res.text()).toContain("Nothing was changed.");
		}
		// The flow is still there: the waiting page still shows.
		const waiting = await b.go("/connect");
		expect(waiting.status).toBe(200);
		expect(await waiting.text()).toContain("Grant access");
		// Our own Cancel link (same-origin) works.
		const cancel = await b.go("/connect/cancel", { headers: { "sec-fetch-site": "same-origin" } });
		expect(cancel.status).toBe(302);
		expect(new URL(cancel.headers.get("location") ?? "").searchParams.get("error")).toBe("access_denied");
	});

	it("when the app's redirect is no longer on the allowlist, the local page is shown instead", async () => {
		const b = new Browser();
		await toWaiting(b);
		const before = env.ALLOWED_REDIRECTS;
		try {
			(env as { ALLOWED_REDIRECTS: string }).ALLOWED_REDIRECTS = CLAUDE;
			const cancel = await b.go("/connect/cancel", { headers: { "sec-fetch-site": "none" } });
			expect(cancel.status).toBe(200);
			expect(cancel.headers.get("location")).toBeNull();
			expect(await cancel.text()).toContain("Nothing was connected.");
		} finally {
			(env as { ALLOWED_REDIRECTS: string }).ALLOWED_REDIRECTS = before;
		}
	});
});
