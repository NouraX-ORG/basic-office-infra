/**
 * Lane D's size in the own tools/list (DESIGN 10.8: the whole own list at most 60 KB).
 *
 * Measured in fix round 1 (2026-10-25): the 11 calendar and tasks entries were 14,642 bytes and are
 * 13,479 after the wording was cut. An equal share of the design's cap (60 KB / 55 tools x 11 =
 * 12,288) can't be reached by wording alone: the framing core adds to every entry (name, title twice,
 * annotations, _meta.securitySchemes, $schema, required, additionalProperties) is about 511 bytes a
 * tool, so only about 6,700 bytes would be left for 11 descriptions and 68 input properties. The whole
 * own list is about 104 KB for 70 tools, so the cap itself is core's to re-budget (see the lane
 * result). Until then these ceilings keep lane D from growing.
 */
import { describe, expect, it } from "vitest";
import { LIMITS } from "../../../src/core/limits";
import { devToken, fakeWithQa, mcpPost, QA, rpcResult } from "../../helpers/index";

const LANE_D = [
	"calendar_list_calendars",
	"calendar_list_events",
	"calendar_find_free_time",
	"calendar_create_event",
	"calendar_update_event",
	"calendar_cancel_event",
	"calendar_add_attendees",
	"tasks_list",
	"tasks_create",
	"tasks_complete",
	"tasks_set_due_date",
];

/** The equal share of the design's cap, for reference in the failure message. */
export const LANE_D_EQUAL_SHARE = Math.floor((LIMITS.ownToolsListBytes / 55) * LANE_D.length);
/** The size after fix round 1 (13,479 bytes) plus under 1%. */
export const LANE_D_CEILING = 13_568;
/** No single lane D entry over this (calendar_create_event is the largest, 2,211 bytes). */
export const ENTRY_CEILING = 2_304;

interface Entry {
	name: string;
	description: string;
	inputSchema: { properties?: Record<string, unknown> };
}

describe("lane D's tools/list entries", () => {
	it("stay within lane D's ceiling, entry by entry and in all", async () => {
		fakeWithQa();
		const t = await devToken(QA.a, { scopes: ["workspace.read", "workspace.write", "workspace.remove", "workspace.share"] });
		const res = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		const body = await rpcResult(res);
		const tools = (body.result as { tools: Entry[] }).tools;
		const mine = tools.filter((x) => LANE_D.includes(x.name));
		expect(mine.map((x) => x.name)).toEqual(LANE_D);
		const sizes = Object.fromEntries(mine.map((x) => [x.name, JSON.stringify(x).length]));
		const total = Object.values(sizes).reduce((a, b) => a + b, 0);
		// What the lane writes itself (descriptions and input properties), apart from core's framing.
		const own = mine.reduce((n, x) => n + x.description.length + JSON.stringify(x.inputSchema.properties ?? {}).length, 0);
		const info = JSON.stringify({ total, own, framing: total - own, ceiling: LANE_D_CEILING, equal_share: LANE_D_EQUAL_SHARE, sizes });
		expect(total, info).toBeLessThanOrEqual(LANE_D_CEILING);
		for (const [name, n] of Object.entries(sizes)) expect(n, `${name}: ${info}`).toBeLessThanOrEqual(ENTRY_CEILING);
	});

	it("offers step_minutes as exactly 15, 30 or 60 (an enum, not a range that lets 45 through)", async () => {
		fakeWithQa();
		const t = await devToken(QA.a, { scopes: ["workspace.read"] });
		const body = await rpcResult(await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
		const free = (body.result as { tools: Entry[] }).tools.find((x) => x.name === "calendar_find_free_time");
		expect(free?.inputSchema.properties?.step_minutes).toMatchObject({ enum: [15, 30, 60], default: 30 });
	});
});
