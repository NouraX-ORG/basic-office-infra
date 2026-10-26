/**
 * Lane C's share of the own tools/list budget (DESIGN 10.8: all own tools at most 60 KB). With 55+
 * tools that is about 1.1 KB per tool on average; this keeps the seven document tools honest.
 */
import { afterEach, expect, it, vi } from "vitest";
import { devToken, fakeWithQa, mcpPost, QA, rpcResult } from "../../helpers/index";

afterEach(() => vi.restoreAllMocks());

const MINE = ["files_read_text", "docs_create_document", "docs_create_spreadsheet", "docs_create_presentation", "docs_convert", "docs_list_template_fields", "docs_fill_template"];

it("the seven document tools stay within their share of tools/list", async () => {
	fakeWithQa();
	const t = await devToken(QA.a, { scopes: ["workspace.read", "workspace.write", "workspace.remove", "workspace.share"] });
	const body = await rpcResult(await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
	const tools = (body.result as { tools: { name: string }[] }).tools.filter((x) => MINE.includes(x.name));
	expect(tools.map((x) => x.name).sort()).toEqual([...MINE].sort());
	const sizes = Object.fromEntries(tools.map((x) => [x.name, JSON.stringify(x).length]));
	const total = Object.values(sizes).reduce((a, b) => a + b, 0);
	// 14,650 bytes before fix round 1; 12,548 after it (shorter descriptions, and no output schema on
	// the four simple save tools). The cap stops it creeping up. Each tool also stays under 2.5 KB.
	expect(total, JSON.stringify(sizes)).toBeLessThanOrEqual(12_800);
	for (const [name, n] of Object.entries(sizes)) expect(n, name).toBeLessThanOrEqual(2_500);
});
