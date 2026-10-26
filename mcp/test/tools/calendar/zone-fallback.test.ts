/**
 * The person's time-zone lookup (src/mcp/zone.ts):
 * - fix round 3: a lookup NoDrive didn't answer is not cached: the default stands in for that one
 *   call, with a warning, and the next call reads the zone again;
 * - fix round 4: it runs only for tools that read times, inside the tool's budget, with 5 s of its
 *   own and no retry. A files tool or a tool the connection doesn't cover sends nothing for it, and a
 *   lookup that hangs costs at most 5 s;
 * - a dead credential found by the lookup still ends the connection (8.5), through nc.isDead()
 *   after the tool.
 * The zone cache lives in module memory, so these run in a file of their own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultFor } from "../../../src/vault/vault";
import { ocs } from "../../fake-nc/index";
import { devToken, env as nxEnv, mcpPost, rpcResult } from "../../helpers/index";
import { callTool, QA, resetTokens, type Setup, setup, tokenFor } from "./_helpers";

let s: Setup;
beforeEach(async () => {
	s = setup();
	await resetTokens();
	s.cal.home(QA.a);
});
afterEach(() => vi.restoreAllMocks());

const base = { start: "2030-11-04", end: "2030-11-04", duration_minutes: 60 };
const cloudUserCalls = () => s.fake.requests.filter((r) => r.url.pathname === "/ocs/v2.php/cloud/user");

describe("the person's time zone", () => {
	it("a lookup that fails isn't cached or retried: the default is used once, with a warning, then the zone is read again", async () => {
		await tokenFor();
		const me = s.fake.users.get(QA.a);
		let failures = 1; // fix round 4: the lookup isn't retried after a 503
		s.fake.on("GET", /^\/ocs\/v2\.php\/cloud\/user$/, (req) => {
			if (!req.auth) return new Response("", { status: 401 });
			if (failures > 0) {
				failures--;
				return new Response("busy", { status: 503 });
			}
			return ocs({ id: me?.uid, displayname: me?.displayName, groups: me?.groups ?? [], timezone: "Europe/Berlin", quota: me?.quota });
		});
		s.fake.requests.length = 0;
		const first = await callTool("calendar_find_free_time", base);
		expect(first.isError).toBeFalsy();
		expect(first.structuredContent.time_zone).toBe("UTC");
		expect(first.structuredContent.warnings).toEqual([expect.stringContaining("NoDrive didn't say which time zone this person uses")]);
		expect(cloudUserCalls()).toHaveLength(1);
		const second = await callTool("calendar_find_free_time", base);
		expect(second.structuredContent.time_zone).toBe("Europe/Berlin");
		expect(JSON.stringify(second.structuredContent.warnings ?? [])).not.toContain("time zone");
	});

	it("a tool that reads no times, and a tool the connection doesn't cover, send nothing for the zone", async () => {
		const t = await devToken(QA.b, { scopes: ["workspace.read"], apps: ["files"] });
		s.fake.requests.length = 0;
		const gated = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boards_list", arguments: {} } });
		expect(gated.status).toBe(200);
		expect(((await rpcResult(gated)).result as { isError?: boolean }).isError).toBe(true);
		const bad = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "files_list_folder", arguments: { path: 5 } } });
		expect(((await rpcResult(bad)).result as { isError?: boolean }).isError).toBe(true);
		expect(cloudUserCalls()).toHaveLength(0);
		expect(s.fake.requests.filter((r) => r.url.pathname.startsWith("/remote.php/dav/principals/"))).toHaveLength(0);
	});

	it("a lookup that hangs costs at most about 5 s, and the tool still answers", async () => {
		const t = await devToken(QA.b, { scopes: ["workspace.read"], apps: ["calendar"] });
		s.cal.home(QA.b);
		let release: () => void = () => undefined;
		const hung = new Promise<void>((r) => {
			release = r;
		});
		s.fake.on("GET", /^\/ocs\/v2\.php\/cloud\/user$/, async () => {
			await hung;
			return new Response("late", { status: 503 });
		});
		const started = Date.now();
		try {
			const res = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "calendar_find_free_time", arguments: base } });
			const body = (await rpcResult(res)).result as { isError?: boolean; structuredContent?: { warnings?: string[] } };
			expect(body.isError).toBeFalsy();
			expect(body.structuredContent?.warnings).toEqual([expect.stringContaining("NoDrive didn't say which time zone this person uses")]);
			const took = Date.now() - started;
			expect(took).toBeGreaterThanOrEqual(4_500);
			expect(took).toBeLessThan(15_000);
		} finally {
			release();
		}
	});

	it("a dead credential found by the lookup ends the connection", async () => {
		// QA.b's zone isn't cached (no lookup of it has succeeded), so the lookup asks NoDrive.
		const t = await devToken(QA.b, { scopes: ["workspace.read"], apps: ["calendar"] });
		// NoDrive no longer takes this person's app password: cloud/user and the probe both get 401.
		s.fake.on("GET", /^\/ocs\/v2\.php\/cloud\/user$/, () => new Response("", { status: 401 }));
		s.fake.requests.length = 0;
		const res = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "calendar_find_free_time", arguments: base } });
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate") ?? "").toContain("invalid_token");
		expect(await vaultFor(nxEnv, QA.b).status(t.connection_id)).not.toBe("active");
		// Only the lookup and its one probe were sent with the dead credential.
		expect(cloudUserCalls()).toHaveLength(2);
		expect(s.fake.requests.filter((r) => r.url.pathname.startsWith("/remote.php/dav/"))).toHaveLength(0);
		const again = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "calendar_find_free_time", arguments: base } });
		expect(again.status).toBe(401);
		await rpcResult(again).catch(() => undefined);
	});
});
