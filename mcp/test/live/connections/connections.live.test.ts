/**
 * Lane F's live cases (DESIGN 17.6): the /connections pages under `wrangler dev --env dev`, as QA
 * account qa-t1-28 against the real drive.nourax.org, from this PC (the owner's IP).
 *
 * - The signed-out page, the dev QA picker, and a page session for the QA account.
 * - A dev connection shows in the list; ending it stops its token at once.
 * - A desktop key made on the page works in ONLYOFFICE Desktop's request shape (no Accept, no
 *   protocol header, no initialized notification), sees only read-only tools by default, reads the
 *   QA account's real data, and stops at once when it is ended on the page.
 * - The production sign-in start reaches NoDrive's real Login Flow v2 and /connect waits for the
 *   grant; cancel abandons it (the flow expires on NoDrive by itself after 20 minutes).
 * - Same-origin, form type and size checks.
 * - Fix round 1: the sign-in wording (grant only a sign-in started on this host), the reserved key
 *   name "Connections page", and no /connections/callback while "Log in with Nourax" is off.
 * - Fix round 2: the sign-in page says the grant page's name proves nothing; the key form shows
 *   "Replace and remove" without core's bracketed promise, with its own note, and the whole
 *   ONLYOFFICE configuration to paste.
 * - Fix round 3: the sign-in page doesn't promise that its own NoDrive access was removed (only that
 *   it is asked for at once, and what happens if NoDrive doesn't confirm it). With NX_LIVE_PERSIST
 *   (the dev server's --persist-to directory), an ended desktop key's ct: record is read from local
 *   KV at each step: it stays after End and goes at the key's next use (docs/mcp.md 7.6). The key is
 *   never printed; only yes/no answers are compared.
 * - Second review, fix round 2: signing out ends the page's sign-in on the server, so a kept copy of
 *   the cookie and another browser's sign-in for the same account stop working; a key name refused
 *   for the upstream product name comes back empty on the form.
 * - Second review, fix round 3: sign-out in a browser that isn't signed in any more says so and ends
 *   nothing; a link with ?n= alone shows no notice, and a real notice shows once; a dev row's end
 *   date names the rule it really follows; the key form says what of "Replace and remove" is for good.
 *
 * QA account: NX_LIVE_UID_F (qa-t1-f-connections-docs-1 since fix round 1, made by
 * test/live/connections/qa-account.sh; qa-t1-28 by default for the shared runner). That name breaks
 * the brief's qa-t<task>-<n> pattern; it is on the owner's deletion list with the other QA accounts.
 *
 * Nothing is created in NoDrive: the dev rows reuse the QA account's app password from the dev env
 * file, and the vault never revokes it. Every connection a case makes, it ends itself.
 *
 * Base URL: NX_LIVE_BASE (default http://localhost:8787, the shared runner). Lane F runs its own
 * dev server on :8850 with test/live/connections/vitest.lane-f.config.ts.
 */
import * as childProcess from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brandScan } from "../_shared/client";

const BASE = process.env.NX_LIVE_BASE ?? "http://localhost:8787";
/** The dev server's --persist-to directory, for reading its local KV (optional; the KV case skips without it). */
const PERSIST = process.env.NX_LIVE_PERSIST;
// The shared Node shim declares only spawnSync's status; this case also reads its output.
const runSync = childProcess.spawnSync as unknown as (cmd: string, args: string[], opts: Record<string, unknown>) => { status: number | null; stdout: string; stderr: string };

/** Whether the dev server's local KV holds `key`, read with wrangler (its output is never printed). */
function localKvHas(key: string): boolean {
	const root = process.cwd();
	const r = runSync(process.execPath, [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "kv", "key", "get", key, "--binding", "OAUTH_KV", "--env", "dev", "--local", "--persist-to", PERSIST as string], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
	});
	if (r.status !== 0) throw new Error(`wrangler kv key get failed (exit ${r.status})`);
	const out = `${r.stdout}`.trim();
	if (/Value not found/i.test(`${r.stdout}${r.stderr}`)) return false;
	return out.length > 0;
}

async function sha256Hex(s: string): Promise<string> {
	const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
	return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const UID = process.env.NX_LIVE_UID_F ?? "qa-t1-28";
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "onlyoffice-shape", version: "1" } } };

class Jar {
	cookies = new Map<string, string>();
	async go(path: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
		const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
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
	post(path: string, fields: Record<string, string | string[]>, headers: Record<string, string> = { origin: BASE }): Promise<Response> {
		const form = new URLSearchParams();
		for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) form.append(k, x);
		return this.go(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: form.toString() });
	}
}

function csrfOf(html: string): string {
	const m = /name="csrf" value="([^"]+)"/.exec(html);
	if (!m) throw new Error("no csrf token on the page");
	return m[1] as string;
}

function unesc(html: string): string {
	return html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** The connection ids in the list, with the label of each. */
function rows(html: string): { id: string; label: string }[] {
	const out: { id: string; label: string }[] = [];
	for (const m of html.matchAll(/<legend>([^<]*)<\/legend>[\s\S]*?name="connection_id" value="([0-9a-f]{32})"/g)) out.push({ label: unesc(m[1] as string), id: m[2] as string });
	return out;
}

async function signedIn(): Promise<{ jar: Jar; html: string }> {
	const jar = new Jar();
	const home = await jar.go("/connections");
	expect(home.status).toBe(200);
	const h = await home.text();
	brandScan("connections signed out", h);
	expect(h).toContain(`<option value="${UID}">`);
	const res = await jar.post("/connections/sign-in", { csrf: csrfOf(h), dev: "1", dev_uid: UID });
	expect(res.status).toBe(303);
	const list = await jar.go("/connections");
	expect(list.status).toBe(200);
	const html = await list.text();
	expect(html).toContain("Connected now");
	brandScan("connections list", html);
	return { jar, html };
}

async function rpc(token: string, body: unknown, ip?: string): Promise<{ status: number; json: Record<string, unknown>; raw: string }> {
	// ONLYOFFICE Desktop's shape: only Content-Type and the person's own headers.
	const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}` };
	if (ip) headers["cf-connecting-ip"] = ip;
	const res = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
	const raw = await res.text();
	let json: Record<string, unknown> = {};
	if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
		for (const line of raw.split(/\r?\n/)) if (line.startsWith("data:")) json = JSON.parse(line.slice(5)) as Record<string, unknown>;
	} else if (raw) {
		try {
			json = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			json = {};
		}
	}
	return { status: res.status, json, raw };
}

describe("live: /connections", () => {
	it("a dev connection shows in the list, and ending it stops its token at once", async () => {
		const t = await fetch(`${BASE}/dev/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid: UID, scopes: ["workspace.read"], apps: ["files"] }) });
		expect(t.status).toBe(200);
		const { access_token: token, connection_id: connectionId } = (await t.json()) as { access_token: string; connection_id: string };
		expect((await rpc(token, INIT)).status).toBe(200);
		const { jar, html } = await signedIn();
		const row = rows(html).find((r) => r.id === connectionId);
		expect(row?.label).toBe("Dev runner");
		expect(html).toContain("Dev connection (local testing only)");
		const end = await jar.post("/connections/end", { csrf: csrfOf(html), connection_id: connectionId });
		expect(end.status).toBe(303);
		expect(end.headers.get("location")).toBe("/connections?n=ended");
		const after = await rpc(token, INIT);
		expect(after.status).toBe(401);
		expect(rows(await (await jar.go("/connections?n=ended")).text()).some((r) => r.id === connectionId)).toBe(false);
	});

	it("a desktop key works in ONLYOFFICE's request shape, read-only by default, and stops at once when ended", async () => {
		const { jar } = await signedIn();
		const form = await (await jar.go("/connections/new-key")).text();
		brandScan("new-key form", form);
		expect(form).toContain('name="days" value="30" checked');
		const label = `Live key ${Date.now() % 100000}`;
		const made = await jar.post("/connections/new-key", { csrf: csrfOf(form), label, scope: "workspace.read", app: ["files", "calendar", "contacts", "boards"], days: "7" });
		expect(made.status).toBe(200);
		const page = await made.text();
		brandScan("key page", page);
		const key = /nxw_ct_[A-Za-z0-9_-]{43}/.exec(page)?.[0] as string;
		expect(key).toBeTruthy();
		expect(unesc(page)).toContain(`{"mcpServers":{"nourax":{"url":"${BASE}/mcp","headers":{"Authorization":"Bearer nxw_ct_`);

		const init = await rpc(key, INIT);
		expect(init.status).toBe(200);
		expect((init.json.result as { protocolVersion: string }).protocolVersion).toBe("2024-11-05");
		const list = await rpc(key, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		expect(list.status).toBe(200);
		const tools = (list.json.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools;
		expect(tools.map((x) => x.name)).toContain("workspace_whoami");
		expect(tools.every((x) => x.annotations.readOnlyHint)).toBe(true);
		brandScan("tools/list (desktop key)", list.raw);
		const who = await rpc(key, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workspace_whoami", arguments: {} } });
		const r = who.json.result as { isError?: boolean; structuredContent: { user_id: string; connection: { kind: string; can: string[] } } };
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent.user_id).toBe(UID);
		brandScan("workspace_whoami (desktop key)", who.raw);

		const listPage = await (await jar.go("/connections")).text();
		const row = rows(listPage).find((x) => x.label === label);
		expect(row).toBeTruthy();
		const end = await jar.post("/connections/end", { csrf: csrfOf(listPage), connection_id: row?.id as string });
		expect(end.headers.get("location")).toBe("/connections?n=ended");
		expect((await rpc(key, INIT)).status).toBe(401);
	});

	it("the production sign-in start reaches NoDrive's Login Flow v2, /connect waits for the grant, and cancel abandons it", async () => {
		const jar = new Jar();
		const h = await (await jar.go("/connections")).text();
		const start = await jar.post("/connections/sign-in", { csrf: csrfOf(h) });
		expect(start.status).toBe(302);
		expect(start.headers.get("location")).toBe("/connect");
		const waiting = await jar.go("/connect");
		expect(waiting.status).toBe(200);
		const w = await waiting.text();
		brandScan("connect waiting", w);
		expect(w).toContain("allow access to NoDrive");
		expect(unesc(w)).toContain('The access will be named "AI app (Connections page)" in NoDrive.');
		expect(w).toMatch(/https:\/\/drive\.nourax\.org\/apps\/user_oidc\/login\/1\?redirectUrl=%2Flogin%2Fv2%2Fflow%2F[A-Za-z0-9]{16,}/);
		const cancel = await jar.go("/connect/cancel");
		expect(cancel.status).toBe(200);
		expect(await cancel.text()).toContain("Nothing was connected");
		expect(jar.cookies.has("__Host-nx-session")).toBe(false);
	});

	it("fix round 1: the sign-in asks to grant only a sign-in started here; the page's own name can't be given to a key; no callback while \"Log in with Nourax\" is off", async () => {
		const jar = new Jar();
		const h = unesc(await (await jar.go("/connections")).text());
		expect(h).toContain(`Grant it only if you clicked Sign in on ${new URL(BASE).host} yourself just now.`);
		expect(h).toContain("Sign in with NoDrive");
		const { jar: j2 } = await signedIn();
		const form = await (await j2.go("/connections/new-key")).text();
		for (const label of ["Connections page", "connections_PAGE"]) {
			const res = await j2.post("/connections/new-key", { csrf: csrfOf(form), label, scope: "workspace.read", app: "files", days: "7" });
			expect(res.status).toBe(400);
			const page = unesc(await res.text());
			expect(page).toContain("That name belongs to this page's own sign-in.");
			expect(page).not.toMatch(/nxw_ct_[A-Za-z0-9_-]{43}/);
			brandScan("reserved key name", page);
		}
		const cb = await jar.go("/connections/callback?code=x&state=y");
		expect(cb.status).toBe(404);
		const out = await j2.post("/connections/sign-out", { csrf: csrfOf(form) });
		expect(out.headers.get("location")).toBe("/connections?n=signed-out");
	});

	it("fix round 2: the sign-in page doesn't vouch for the grant page's name; the key form names what \"Replace and remove\" covers and shows the whole configuration to paste", async () => {
		const h = unesc(await (await new Jar().go("/connections")).text());
		// Fix round 3: the page no longer promises that the removal worked (views.ts SESSION_GRANT_FATE).
		expect(h).toContain("If you started it here, that access only tells this page who you are. Nourax Workspace never stores it and removes it again at once. If NoDrive doesn't confirm that removal, it can stay in NoDrive's list of devices and sessions until the person who runs Nourax Workspace removes it. Nobody has its password: it was never stored or shown.");
		expect(h).not.toContain("removed straight away");
		expect(h).toContain("Never grant access from a link someone sent you, whatever name NoDrive shows: that name is chosen by whoever started the sign-in, so it proves nothing.");
		brandScan("signed out (fix round 2)", h);
		const { jar } = await signedIn();
		const form = unesc(await (await jar.go("/connections/new-key")).text());
		expect(form).toContain('name="scope" value="workspace.remove">Replace and remove</label>');
		expect(form).not.toMatch(/all can be undone/);
		// Second review, fix round 3: the note names what is for good (one occurrence of a repeating
		// event; a share made to the person alone) instead of promising that all of it can be undone.
		expect(form).toContain(
			"Replaced file content stays as an earlier version; removed files and folders stay in NoDrive's trash, normally for 30 days; a cancelled event stays in its calendar, marked as cancelled, or goes to NoCalendar's trash for 30 days. These can be undone. Not everything can be undone: removing something that was shared with you alone ends that share for good; removing one occurrence of a repeating event is for good.",
		);
		expect(form).not.toContain("removed files and events stay in the trash for 30 days, so these can be undone");
		expect(form).toContain("AI agent, then Settings, then MCP Servers, then Edit configuration");
		expect(form).toContain(`{"mcpServers":{"nourax":{"url":"${BASE}/mcp","headers":{"Authorization":"Bearer nxw_ct_…"}}}}`);
		brandScan("new-key form (fix round 2)", form);
		const out = await jar.post("/connections/sign-out", { csrf: csrfOf(form) });
		expect(out.headers.get("location")).toBe("/connections?n=signed-out");
	});

	it("fix round 3: an ended desktop key's ct: record stays after End and is deleted at the key's next use (docs/mcp.md 7.6)", async () => {
		if (!PERSIST) return; // needs NX_LIVE_PERSIST, the dev server's --persist-to directory
		const { jar } = await signedIn();
		const form = await (await jar.go("/connections/new-key")).text();
		const label = `KV check ${Date.now() % 100000}`;
		const made = await jar.post("/connections/new-key", { csrf: csrfOf(form), label, scope: "workspace.read", app: "files", days: "7" });
		expect(made.status).toBe(200);
		const key = /nxw_ct_[A-Za-z0-9_-]{43}/.exec(await made.text())?.[0] as string;
		expect(key).toBeTruthy();
		const kvKey = `ct:${await sha256Hex(key)}`;
		expect((await rpc(key, INIT)).status).toBe(200);
		const steps: Record<string, boolean> = { made: localKvHas(kvKey) };
		const listPage = await (await jar.go("/connections")).text();
		const row = rows(listPage).find((x) => x.label === label);
		expect(row).toBeTruthy();
		const end = await jar.post("/connections/end", { csrf: csrfOf(listPage), connection_id: row?.id as string });
		expect(end.headers.get("location")).toBe("/connections?n=ended");
		steps.afterEnd = localKvHas(kvKey);
		// The next use is refused (the vault row is gone), and core's endAccess deletes the record.
		expect((await rpc(key, INIT)).status).toBe(401);
		steps.afterNextUse = localKvHas(kvKey);
		expect((await rpc(key, INIT)).status).toBe(401);
		expect(steps).toEqual({ made: true, afterEnd: true, afterNextUse: false });
		const out = await jar.post("/connections/sign-out", { csrf: csrfOf(listPage) });
		expect(out.headers.get("location")).toBe("/connections?n=signed-out");
	});

	it("second review, fix round 2: sign-out ends the page's sign-in on the server, in every browser; a refused brand-word key name isn't shown back", async () => {
		const { jar: a, html } = await signedIn();
		const kept = a.cookies.get("__Host-nx-session") as string;
		expect(kept).toBeTruthy();
		const { jar: b } = await signedIn();
		// Sessions carry whole seconds: let the second turn, so both sign-ins are before the sign-out.
		await new Promise((r) => setTimeout(r, 1100));
		const out = await a.post("/connections/sign-out", { csrf: csrfOf(html) });
		expect(out.headers.get("location")).toBe("/connections?n=signed-out");
		const notice = unesc(await (await a.go("/connections?n=signed-out")).text());
		expect(notice).toContain("You're signed out of this page, in every browser.");
		brandScan("signed out everywhere", notice);
		// The verifier's replay: the cookie kept from before the sign-out is signed out now.
		const replay = new Jar();
		replay.cookies.set("__Host-nx-session", kept);
		const replayed = await (await replay.go("/connections")).text();
		expect(replayed).toContain("Sign in with NoDrive");
		expect(replayed).not.toContain("Connected now");
		// The other browser's sign-in for the same account is signed out too.
		expect(await (await b.go("/connections")).text()).toContain("Sign in with NoDrive");
		// Signing in again at once works.
		const { jar: c } = await signedIn();
		const form = await (await c.go("/connections/new-key")).text();
		const brand = ["Next", " cloud"].join("");
		const refused = await c.post("/connections/new-key", { csrf: csrfOf(form), label: `${brand} key`, scope: "workspace.read", app: "files", days: "7" });
		expect(refused.status).toBe(400);
		const page = unesc(await refused.text());
		expect(page).toContain("Choose another name for the key.");
		expect(page).toContain('name="label" maxlength="40" required value=""');
		brandScan("refused brand-word key name", page);
		const done = await c.post("/connections/sign-out", { csrf: csrfOf(form) });
		expect(done.headers.get("location")).toBe("/connections?n=signed-out");
	});

	it("second review, fix round 3: sign-out in a browser that isn't signed in says so and ends nothing; a link alone shows no notice; a real one shows once; a dev row names its own end rule", async () => {
		const t = await fetch(`${BASE}/dev/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid: UID, scopes: ["workspace.read"], apps: ["files"] }) });
		expect(t.status).toBe(200);
		const { access_token: token, connection_id: connectionId } = (await t.json()) as { access_token: string; connection_id: string };
		const { jar: a, html } = await signedIn();
		// The dev row from /dev/token has an AI app's rules (14 days without use), and says so.
		const at = html.indexOf(`name="connection_id" value="${connectionId}"`);
		expect(at).toBeGreaterThan(0);
		const box = unesc(html.slice(html.lastIndexOf("<fieldset>", at), at));
		expect(box).toContain("(whichever comes first: 14 days after its last use, or 60 days after it was connected)");
		// A link with a notice code alone shows nothing, signed out or signed in.
		for (const j of [new Jar(), a]) {
			for (const n of ["signed-out", "ended", "already-out"]) {
				const p = unesc(await (await j.go(`/connections?n=${n}`)).text());
				expect(p, n).not.toContain('role="status"');
				expect(p, n).not.toContain("in every browser.");
			}
		}
		// The review's stale tab: a browser with no live sign-in signs out. It is told so, nothing is
		// recorded, and the other browser stays signed in.
		const stale = new Jar();
		const out = await stale.post("/connections/sign-out", {});
		expect(out.status).toBe(303);
		expect(out.headers.get("location")).toBe("/connections?n=already-out");
		const said = unesc(await (await stale.go("/connections?n=already-out")).text());
		expect(said).toContain("This browser was already signed out of this page, so nothing was signed out anywhere else.");
		expect(said).not.toContain("in every browser.");
		brandScan("already signed out", said);
		expect(await (await a.go("/connections")).text()).toContain("Connected now");
		// A real notice shows once, in the browser that did it.
		const end = await a.post("/connections/end", { csrf: csrfOf(html), connection_id: connectionId });
		expect(end.headers.get("location")).toBe("/connections?n=ended");
		expect(await (await a.go("/connections?n=ended")).text()).toContain("The connection was ended.");
		expect(await (await a.go("/connections?n=ended")).text()).not.toContain("The connection was ended.");
		expect((await rpc(token, INIT)).status).toBe(401);
		const done = await a.post("/connections/sign-out", { csrf: csrfOf(html) });
		expect(done.headers.get("location")).toBe("/connections?n=signed-out");
		expect(unesc(await (await a.go("/connections?n=signed-out")).text())).toContain("You're signed out of this page, in every browser.");
	});

	it("refuses another site's POST, a non-form body and a body over 16 KB", async () => {
		const { jar, html } = await signedIn();
		const csrf = csrfOf(html);
		expect((await jar.post("/connections/sign-out", { csrf }, { origin: "https://evil.example" })).status).toBe(403);
		const json = await jar.go("/connections/end", { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: "{}" });
		expect(json.status).toBe(415);
		const big = await jar.go("/connections/end", { method: "POST", headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: `csrf=${csrf}&x=${"a".repeat(17 * 1024)}` });
		expect(big.status).toBe(413);
		const out = await jar.post("/connections/sign-out", { csrf });
		expect(out.headers.get("location")).toBe("/connections?n=signed-out");
	});
});
