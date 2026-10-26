/**
 * Lane A's share of tools/list (DESIGN 10.8: the whole own list within 60 KB, about 1.1 KB a tool
 * for the 55 tools it was set for). The 17 files tools publish no output schemas
 * (src/tools/files/define.ts) and short texts.
 *
 * Measured on 2026-10-25 (fix round 1): lane A's own part (name, title, description, input schema
 * without its "$schema" key, no output schema) 13.5 KB, was 31,013 bytes; whole entries, with
 * core's fixed part (annotations with the title again, _meta and "$schema", about 300 bytes a
 * tool), 17,346 bytes, was 34,257.
 */
import { afterEach, expect, it, vi } from "vitest";
import { mcpPost, rpcResult } from "../../helpers/index";
import { LANE_A, setup } from "./helpers";

afterEach(() => vi.restoreAllMocks());

/** What lane A controls, for its 17 tools: 14 KB, about 840 bytes a tool. */
export const LANE_A_OWN_BUDGET = 14 * 1024;
/** Whole entries, core's fixed part included: 18 KB, about 1.06 KB a tool. */
export const LANE_A_ENTRY_BUDGET = 18 * 1024;

it("lane A's 17 tools stay small in tools/list, without output schemas", async () => {
	const e = await setup();
	const body = await rpcResult(await mcpPost(e.token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
	const tools = (body.result as { tools: Record<string, unknown>[] }).tools.filter((t) => LANE_A.includes(String(t.name)));
	expect(tools.map((t) => t.name)).toEqual(LANE_A);
	for (const t of tools) expect(t.outputSchema, String(t.name)).toBeUndefined();
	const own = (t: Record<string, unknown>) => {
		const { $schema: _s, ...input } = t.inputSchema as Record<string, unknown>;
		return JSON.stringify({ name: t.name, title: t.title, description: t.description, inputSchema: input }).length;
	};
	const sizes: Record<string, number> = Object.fromEntries(tools.map((t) => [String(t.name), own(t)]));
	const total = Object.values(sizes).reduce((a, b) => a + b, 0);
	expect(total, JSON.stringify({ total, ...sizes })).toBeLessThanOrEqual(LANE_A_OWN_BUDGET);
	for (const [name, n] of Object.entries(sizes)) expect(n, name).toBeLessThanOrEqual(1500);
	expect(JSON.stringify(tools).length).toBeLessThanOrEqual(LANE_A_ENTRY_BUDGET);
});
