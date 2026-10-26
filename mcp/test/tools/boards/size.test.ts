/**
 * Lane E's share of tools/list (DESIGN 10.8 wants the whole own list within 60 KB). The 8 boards
 * tools and workspace_overview publish compact, open output schemas and short descriptions; together
 * they stay within 15 KB (about 1.6 KB a tool, of which about 400 bytes is core's fixed part:
 * annotations, the title again, _meta and two $schema keys).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { devToken, fakeWithQa, mcpPost, QA, rpcResult } from "../../helpers/index";

afterEach(() => vi.restoreAllMocks());

describe("lane E in tools/list", () => {
	it("stays small", async () => {
		fakeWithQa();
		const t = await devToken(QA.a, { scopes: ["workspace.read", "workspace.write", "workspace.remove", "workspace.share"] });
		const body = await rpcResult(await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
		const tools = (body.result as { tools: { name: string }[] }).tools.filter((x) => x.name.startsWith("boards_") || x.name === "workspace_overview");
		expect(tools).toHaveLength(9);
		const sizes = Object.fromEntries(tools.map((x) => [x.name, JSON.stringify(x).length]));
		const total = Object.values(sizes).reduce((a, b) => a + b, 0);
		expect(total, JSON.stringify(sizes)).toBeLessThanOrEqual(15 * 1024);
		for (const [name, n] of Object.entries(sizes)) expect(n, name).toBeLessThanOrEqual(2 * 1024);
	});
});
