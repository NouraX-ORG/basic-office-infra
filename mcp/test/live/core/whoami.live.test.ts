/**
 * Core's live case: wrangler dev on :8787, dev-only auth as qa-t1-21, against drive.nourax.org.
 * initialize (ONLYOFFICE shape), tools/list and workspace_whoami, then the same through the SDK in
 * the 2025 and 2026-07-28 eras. Read-only: nothing is created on the server.
 */
import { describe, expect, it } from "vitest";
import { BASE, brandScan, devToken, rpc, sdk } from "../_shared/client";

const UID = process.env.NX_LIVE_UID ?? "qa-t1-21";

describe("live: core", () => {
	it("initialize, tools/list and workspace_whoami in the ONLYOFFICE request shape", async () => {
		const t = await devToken(UID);
		const init = await rpc(t.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "live", version: "1" } } }, { accept: "" });
		expect(init.status).toBe(200);
		const ir = init.json.result as { protocolVersion: string; serverInfo: { name: string }; instructions: string };
		expect(ir.protocolVersion).toBe("2024-11-05");
		expect(ir.serverInfo.name).toBe("nourax-workspace");
		brandScan("initialize", init.raw);

		const list = await rpc(t.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { accept: "" });
		expect(list.status).toBe(200);
		const tools = (list.json.result as { tools: { name: string }[] }).tools;
		expect(tools.map((x) => x.name)).toContain("workspace_whoami");
		brandScan("tools/list", list.raw);

		const who = await rpc(t.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workspace_whoami", arguments: {} } }, { accept: "" });
		expect(who.status).toBe(200);
		const r = who.json.result as { isError?: boolean; structuredContent: { user_id: string; display_name: string; storage: { used_bytes: number }; connection: { kind: string } } };
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent.user_id).toBe(UID);
		expect(r.structuredContent.connection.kind).toBe("dev");
		expect(typeof r.structuredContent.storage.used_bytes).toBe("number");
		brandScan("workspace_whoami", who.raw);
	});

	it("fix round 1: a batch is refused, the preflight allows the 2026 headers, the health check answers", async () => {
		const t = await devToken(UID);
		const whoami = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "workspace_whoami", arguments: {} } });
		const batch = await fetch(`${BASE}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${t.access_token}` },
			body: JSON.stringify([whoami(1), whoami(2)]),
		});
		expect(batch.status).toBe(400);
		expect(((await batch.json()) as { error: { code: number } }).error.code).toBe(-32600);
		const pre = await fetch(`${BASE}/mcp`, { method: "OPTIONS", headers: { origin: "http://localhost:6274", "access-control-request-method": "POST" } });
		expect(pre.status).toBe(204);
		expect(pre.headers.get("access-control-allow-headers")).toContain("Mcp-Method, Mcp-Name");
		const health = (await (await fetch(`${BASE}/healthz?deep=1`)).json()) as { status: string; drive: string };
		expect(health).toMatchObject({ status: "ok", drive: "ok" });
	});

	it("the SDK client in both eras", async () => {
		const t = await devToken(UID);
		for (const mode of ["legacy", "auto"] as const) {
			const client = await sdk(t.access_token, mode);
			expect(client.getProtocolEra()).toBe(mode === "auto" ? "modern" : "legacy");
			const r = await client.callTool({ name: "workspace_whoami", arguments: {} });
			expect((r.structuredContent as { user_id: string }).user_id).toBe(UID);
			await client.close();
		}
	});
});
