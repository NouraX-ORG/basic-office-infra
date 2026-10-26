/**
 * Protocol and conformance through the full Worker (DESIGN 17.2): the ONLYOFFICE request shape,
 * the 2025-era SDK client in both legacy revisions, and the 2026-07-28 era.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeNc } from "../fake-nc/index";
import { devToken, fakeWithQa, framedPayload, INIT_2024, mcpPost, QA, rpcResult, sdkClient } from "../helpers/index";

let fake: FakeNc;
beforeEach(() => {
	fake = fakeWithQa();
});
afterEach(() => vi.restoreAllMocks());

describe("ONLYOFFICE Desktop Editors request shape", () => {
	it("initialize 2024-11-05 with no Accept, then tools/list and tools/call, no initialized notification", async () => {
		const t = await devToken(QA.a);
		const headers = { "content-type": "application/json" };
		const init = await mcpPost(t.access_token, INIT_2024, { accept: "" });
		expect(init.status).toBeGreaterThanOrEqual(200);
		expect(init.status).toBeLessThan(300);
		const ij = await rpcResult(init);
		const result = ij.result as { protocolVersion: string; serverInfo: { name: string }; instructions?: string; capabilities: { tools?: unknown } };
		expect(result.protocolVersion).toBe("2024-11-05");
		expect(result.serverInfo.name).toBe("nourax-workspace");
		expect(result.capabilities.tools).toBeDefined();
		expect(result.instructions).toContain("Nourax Workspace tools act as the signed-in person");

		const list = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { ...headers, accept: "" });
		expect(list.status).toBe(200);
		const tools = ((await rpcResult(list)).result as { tools: { name: string; annotations: Record<string, boolean> }[] }).tools;
		expect(tools.map((x) => x.name)).toContain("workspace_whoami");
		const who = tools.find((x) => x.name === "workspace_whoami");
		expect(who?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

		const callRes = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workspace_whoami", arguments: {} } }, { accept: "" });
		expect(callRes.status).toBe(200);
		const r = (await rpcResult(callRes)).result as { content: { text: string }[]; structuredContent: Record<string, unknown>; isError?: boolean };
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent.user_id).toBe(QA.a);
		expect(r.structuredContent.display_name).toBe("QA t1 91");
		expect(JSON.parse(framedPayload(r.content[0]?.text ?? "")).user_id).toBe(QA.a);
		// Every NoDrive call carried the QA account's Basic credential.
		const cu = fake.driveCalls().filter((c) => c.url.pathname === "/ocs/v2.php/cloud/user");
		expect(cu.length).toBeGreaterThan(0);
		expect(cu.every((c) => c.auth === QA.a && c.headers.get("ocs-apirequest") === "true")).toBe(true);
	});
});

describe("2025-era SDK client", () => {
	for (const version of ["2025-06-18", "2025-11-25"]) {
		it(`connects, lists and calls (${version})`, async () => {
			const t = await devToken(QA.a);
			const client = await sdkClient(t.access_token, { mode: "legacy", protocolVersion: version });
			const tools = await client.listTools();
			expect(tools.tools.map((x) => x.name)[0]).toBe("workspace_whoami");
			const r = await client.callTool({ name: "workspace_whoami", arguments: {} });
			expect(r.isError).toBeFalsy();
			expect((r.structuredContent as { user_id: string }).user_id).toBe(QA.a);
			await client.close();
		});
	}
});

describe("2026-07-28 era", () => {
	it("negotiates the modern era with server/discover and calls a tool", async () => {
		const t = await devToken(QA.a);
		const client = await sdkClient(t.access_token, { mode: "auto" });
		expect(client.getProtocolEra()).toBe("modern");
		const tools = await client.listTools();
		expect(tools.tools.some((x) => x.name === "workspace_whoami")).toBe(true);
		const r = await client.callTool({ name: "workspace_whoami", arguments: {} });
		expect((r.structuredContent as { user_id: string }).user_id).toBe(QA.a);
		await client.close();
	});
});
