/**
 * The gate (scopes x apps x flags), desktop keys in the ONLYOFFICE request shape, the 401 circuit
 * breaker for a dead NoDrive credential, and the per-person limits answered as tool results.
 */
import { runInDurableObject } from "cloudflare:test";
import { insufficientScope } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopVaultKey, newDesktopKey, storeDesktopKey } from "../../src/auth/conn-tokens";
import { newId } from "../../src/core/bytes";
import { config } from "../../src/env";
import { CATALOG } from "../../src/mcp/catalog";
import { effectiveScopes, gateCall, hiddenBy } from "../../src/mcp/gate";
import { type Vault, vaultFor } from "../../src/vault/vault";
import type { FakeNc } from "../fake-nc/index";
import { devToken, env, fakeWithQa, INIT_2024, mcpPost, ORIGIN, QA, QA_PASS, rpcResult } from "../helpers/index";

const OWNER = "5224252b-4938-4a86-a276-54bbae5d5b49";
let fake: FakeNc;
beforeEach(() => {
	fake = fakeWithQa();
	fake.addUser({ uid: OWNER, password: "DESKTOP-APP-PASSWORD-0123456789abc", displayName: "Owner" });
});
afterEach(() => vi.restoreAllMocks());

const entry = (n: string) => CATALOG.find((c) => c.name === n) as (typeof CATALOG)[number];

describe("gate", () => {
	const cfg = () => config(env);
	it("hides by scope, app and flag", () => {
		const rc = { scopes: ["workspace.read"] as never, apps: ["files"] as never, cfg: cfg() };
		expect(hiddenBy(entry("files_list_folder"), rc)).toBeNull();
		expect(hiddenBy(entry("files_create_file"), rc)).toBe("scope");
		expect(hiddenBy(entry("calendar_list_events"), rc)).toBe("app");
		expect(hiddenBy(entry("workspace_whoami"), rc)).toBeNull();
		const rw = { scopes: ["workspace.read", "workspace.write", "workspace.share"] as never, apps: ["docs", "calendar"] as never };
		expect(hiddenBy(entry("docs_convert"), { ...rw, cfg: { ...cfg(), heavyTools: false } })).toBe("flag");
		expect(hiddenBy(entry("calendar_add_attendees"), { ...rw, cfg: { ...cfg(), calendarAttendees: "off" } })).toBe("flag");
		expect(hiddenBy(entry("calendar_add_attendees"), { ...rw, cfg: cfg() })).toBeNull();
	});
	it("OAuth steps up with 403 insufficient_scope; desktop keys and hidden apps answer not_available", () => {
		const built = () => true;
		const oauth = { scopes: ["workspace.read"] as never, apps: ["files"] as never, cfg: cfg(), canStepUp: true };
		expect(gateCall(oauth, "files_create_file", built)).toEqual({ kind: "step_up", needed: "workspace.write" });
		const desk = gateCall({ ...oauth, canStepUp: false }, "files_create_file", built);
		expect(desk.kind).toBe("not_available");
		if (desk.kind === "not_available") expect(desk.error.hint).toContain(`${ORIGIN}/connections`);
		const app = gateCall(oauth, "calendar_list_events", built);
		expect(app.kind === "not_available" && app.error.message).toContain("without that app");
		expect(gateCall(oauth, "files_create_file", () => false)).toEqual({ kind: "pass" });
		expect(gateCall(oauth, "mail_send_draft", built)).toEqual({ kind: "pass" });
		const res = insufficientScope({ token: "t", audience: `${ORIGIN}/mcp`, scope: ["workspace.read"] }, ["workspace.read", "workspace.write"]);
		expect(res.status).toBe(403);
		expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
		expect(res.headers.get("www-authenticate")).toContain('scope="workspace.read workspace.write"');
		expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
	});
	it("effective scopes come from the token for OAuth and from the record for desktop keys", () => {
		expect(effectiveScopes(["workspace.read", "offline_access", "bogus"], ["workspace.write"], true)).toEqual(["workspace.read"]);
		expect(effectiveScopes([], ["workspace.read", "workspace.write"], false)).toEqual(["workspace.read", "workspace.write"]);
	});
	it("a read-only connection lists only read tools and says so in its instructions", async () => {
		const t = await devToken(QA.a, { scopes: ["workspace.read"], apps: ["files"] });
		const init = (await rpcResult(await mcpPost(t.access_token, INIT_2024))).result as { instructions: string };
		expect(init.instructions).toContain("This connection can only read.");
		const list = (await rpcResult(await mcpPost(t.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" }))).result as { tools: { annotations: { readOnlyHint: boolean } }[] };
		expect(list.tools.every((x) => x.annotations.readOnlyHint)).toBe(true);
	});
	it("a tool that isn't built yet is an unknown tool to the client", async () => {
		const t = await devToken(QA.a);
		const r = await rpcResult(await mcpPost(t.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "files_definitely_not_a_tool", arguments: {} } }));
		expect(JSON.stringify(r)).toMatch(/not found/i);
	});
});

async function makeDesktopKey(opts: { scopes?: string[]; ipLock?: string; expiresIn?: number } = {}) {
	const key = newDesktopKey();
	const connectionId = newId();
	const v = vaultFor(env, OWNER);
	await v.createConnection(
		{
			connectionId,
			uid: OWNER,
			kind: "desktop",
			clientLabel: "ONLYOFFICE",
			scopes: opts.scopes ?? ["workspace.read"],
			apps: ["files", "docs"],
			cred: { loginName: OWNER, appPassword: "DESKTOP-APP-PASSWORD-0123456789abc" },
			displayName: "Owner",
			idleSec: 30 * 86400,
			maxAgeSec: 30 * 86400,
		},
		await desktopVaultKey(env, key, connectionId),
	);
	await storeDesktopKey(env, key, { uid: OWNER, connectionId, expiresAt: Math.floor(Date.now() / 1000) + (opts.expiresIn ?? 86400), label: "ONLYOFFICE", ...(opts.ipLock ? { ipLock: opts.ipLock } : {}) });
	return { key, connectionId, v };
}

describe("desktop keys (ONLYOFFICE Desktop Editors)", () => {
	const oo = { accept: "", origin: "onlyoffice-proxy://desktop", "user-agent": "ONLYOFFICE Desktop Editors 10.0" };
	it("work in the ONLYOFFICE request shape and act as the person", async () => {
		const { key } = await makeDesktopKey();
		const init = await mcpPost(key, INIT_2024, oo);
		expect(init.status).toBe(200);
		const call = await mcpPost(key, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workspace_whoami", arguments: {} } }, oo);
		const r = (await rpcResult(call)).result as { structuredContent: { user_id: string; connection: { kind: string; can: string[] } } };
		expect(r.structuredContent.user_id).toBe(OWNER);
		expect(r.structuredContent.connection.kind).toBe("desktop");
		expect(r.structuredContent.connection.can).toEqual(["read"]);
	});
	it("honour the IP lock and the expiry", async () => {
		const locked = await makeDesktopKey({ ipLock: "198.51.100.7" });
		expect((await mcpPost(locked.key, INIT_2024, { ...oo, "cf-connecting-ip": "198.51.100.8" })).status).toBe(401);
		expect((await mcpPost(locked.key, INIT_2024, { ...oo, "cf-connecting-ip": "198.51.100.7" })).status).toBe(200);
		const old = await makeDesktopKey({ expiresIn: -10 });
		expect((await mcpPost(old.key, INIT_2024, oo)).status).toBe(401);
	});
	it("stop working at once when the connection is ended, and their record goes", async () => {
		const { key, connectionId, v } = await makeDesktopKey();
		expect((await mcpPost(key, INIT_2024, oo)).status).toBe(200);
		await v.revokeAndWipe(connectionId, "user");
		expect((await mcpPost(key, INIT_2024, oo)).status).toBe(401);
		expect(await env.OAUTH_KV.list({ prefix: "ct:" }).then((l) => l.keys.length)).toBeGreaterThanOrEqual(0);
		expect(fake.users.get(OWNER)?.passwords.has("DESKTOP-APP-PASSWORD-0123456789abc")).toBe(false);
	});
});

describe("401 circuit breaker (DESIGN 8.5)", () => {
	it("one probe, then the connection ends and the client is told to reconnect", async () => {
		const t = await devToken(QA.a);
		// The app password stops working on the server side.
		fake.users.get(QA.a)?.passwords.delete(QA_PASS[QA.a] as string);
		const before = fake.requests.length;
		const res = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspace_whoami", arguments: {} } });
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
		const attempts = fake.requests.slice(before).filter((r) => r.url.pathname === "/ocs/v2.php/cloud/user");
		expect(attempts.length).toBeLessThanOrEqual(2);
		// The credential is never sent again: the next request fails before any NoDrive call.
		const mark = fake.requests.length;
		expect((await mcpPost(t.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(401);
		expect(fake.requests.length).toBe(mark);
	});
});

describe("per-person limits", () => {
	it("a blocked call answers rate_limited as a tool result with retry_after_seconds", async () => {
		const t = await devToken(QA.a);
		const v = vaultFor(env, QA.a);
		await runInDurableObject(v, async (_i: Vault, state) => {
			const minute = Math.floor(Date.now() / 60000);
			state.storage.sql.exec("INSERT OR REPLACE INTO counters (k, n, exp) VALUES (?, 120, ?)", `m:read:${minute}`, (minute + 2) * 60);
			state.storage.sql.exec("INSERT OR REPLACE INTO counters (k, n, exp) VALUES (?, 120, ?)", `m:read:${minute + 1}`, (minute + 3) * 60);
		});
		const r = (await rpcResult(await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspace_whoami", arguments: {} } }))).result as {
			isError: boolean;
			_meta: Record<string, { code: string; retry_after_seconds: number }>;
		};
		expect(r.isError).toBe(true);
		expect(r._meta["nourax/error"]?.code).toBe("rate_limited");
		expect(r._meta["nourax/error"]?.retry_after_seconds).toBeGreaterThan(0);
	});
});
