/**
 * Lane G's catalogue entries, description lint, schema lint, tools/list size and gating (DESIGN
 * 10.3, 10.8 and 25.3). The same rules as test/core/catalog.test.ts, for the gantt_* tools.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BUILTIN_BRAND_RULES } from "../../../src/core/brand";
import { LIMITS } from "../../../src/core/limits";
import { annotationsFor, APP_WORDS, ALL_APPS, catalogEntry, CATALOG } from "../../../src/mcp/catalog";
import { tools as ganttTools } from "../../../src/tools/gantt/index";
import { TOOLS } from "../../../src/tools/registry";
import { mcpPost, ORIGIN, rpcResult } from "../../helpers/index";
import { ALL_WORKSPACE, setup, token, tool } from "./_helpers";

afterEach(() => vi.restoreAllMocks());

const NAMES = [
	"gantt_list_projects", "gantt_get_project", "gantt_my_tasks", "gantt_create_project", "gantt_update_project", "gantt_import_plan",
	"gantt_add_task", "gantt_update_task", "gantt_add_milestone", "gantt_link_tasks", "gantt_critical_path",
	"gantt_project_report", "gantt_link_board_card", "gantt_share_project", "gantt_undo_change",
];

const HINTS: Record<string, [tier: "R" | "A" | "D", scope: string, idempotent: boolean]> = {
	gantt_list_projects: ["R", "workspace.read", true],
	gantt_get_project: ["R", "workspace.read", true],
	gantt_my_tasks: ["R", "workspace.read", true],
	gantt_create_project: ["A", "workspace.write", false],
	gantt_update_project: ["D", "workspace.write", true],
	gantt_import_plan: ["A", "workspace.write", false],
	gantt_add_task: ["A", "workspace.write", false],
	gantt_update_task: ["D", "workspace.write", true],
	gantt_add_milestone: ["A", "workspace.write", false],
	gantt_link_tasks: ["D", "workspace.write", true],
	gantt_critical_path: ["R", "workspace.read", true],
	gantt_project_report: ["R", "workspace.read", true],
	gantt_link_board_card: ["D", "workspace.write", false],
	gantt_share_project: ["D", "workspace.share", false],
	gantt_undo_change: ["D", "workspace.write", false],
};

type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; items?: JsonSchema; additionalProperties?: unknown; maxLength?: number; minimum?: number; maximum?: number; enum?: unknown[]; description?: string; anyOf?: JsonSchema[]; format?: string; const?: unknown };

function lint(s: JsonSchema, where: string, problems: string[], strict = false): void {
	for (const x of s.anyOf ?? []) lint(x, where, problems, strict);
	const t = Array.isArray(s.type) ? s.type : [s.type];
	if (t.includes("string") && s.enum === undefined && s.const === undefined && s.maxLength === undefined && s.format === undefined) problems.push(`${where}: string without maxLength`);
	if ((t.includes("number") || t.includes("integer")) && (s.minimum === undefined || s.maximum === undefined)) problems.push(`${where}: number without bounds`);
	if (t.includes("object") || s.properties) {
		if (strict && s.additionalProperties !== false) problems.push(`${where}: object is not strict`);
		for (const [k, v] of Object.entries(s.properties ?? {})) {
			if (!v.description) problems.push(`${where}.${k}: no description`);
			else if (v.description.length > LIMITS.propertyDescriptionChars) problems.push(`${where}.${k}: description over 120 characters`);
			lint(v, `${where}.${k}`, problems, strict);
		}
	}
	if (s.items) lint(s.items, `${where}[]`, problems, strict);
}

describe("lane G catalogue", () => {
	it("has the 15 tools after the boards tools, in order, with app gantt and lane G", () => {
		const names = CATALOG.filter((c) => c.lane === "G").map((c) => c.name);
		expect(names).toEqual(NAMES);
		const boardsLast = CATALOG.findIndex((c) => c.name === "boards_add_comment");
		expect(CATALOG.findIndex((c) => c.name === NAMES[0])).toBe(boardsLast + 1);
		for (const n of NAMES) {
			const c = catalogEntry(n);
			expect(c?.app, n).toBe("gantt");
			expect(n.length, n).toBeLessThanOrEqual(LIMITS.toolNameChars);
			expect(n).toMatch(/^[a-z]+(_[a-z0-9]+)+$/);
		}
		expect(ALL_APPS).toContain("gantt");
		expect(APP_WORDS.gantt).toBe("Projects (NoGantt)");
	});
	it("sets all four hints as DESIGN 25.3 says", () => {
		for (const n of NAMES) {
			const c = catalogEntry(n);
			if (!c) throw new Error(n);
			const [tier, scope, idem] = HINTS[n] as [string, string, boolean];
			expect([n, c.tier, c.scope, c.idempotent, c.openWorld]).toEqual([n, tier, scope, idem, false]);
			const a = annotationsFor(c);
			expect(a.readOnlyHint).toBe(tier === "R");
			expect(a.destructiveHint).toBe(tier === "D");
		}
		// gantt_link_board_card has no 10-minute guard: linking has a natural key, and making a card
		// checks the task's current card link instead (DESIGN 25.7).
		expect(NAMES.filter((n) => catalogEntry(n)?.dedupe)).toEqual(["gantt_create_project", "gantt_import_plan", "gantt_add_task", "gantt_add_milestone"]);
		// Every tool with the guard takes allow_duplicate, the one way past it (DESIGN 10.7).
		for (const t of ganttTools) {
			const has = "allow_duplicate" in (t.input as unknown as { shape: Record<string, unknown> }).shape;
			expect([t.name, has]).toEqual([t.name, catalogEntry(t.name)?.dedupe === true]);
		}
	});
	it("every tool is built and registered once, in catalogue order", () => {
		expect(ganttTools.map((t) => t.name)).toEqual(NAMES);
		const reg = TOOLS.map((t) => t.name).filter((n) => n.startsWith("gantt_"));
		expect(reg).toEqual(NAMES);
	});
	it("titles, descriptions and input schemas pass the lint, with no upstream brand", () => {
		const problems: string[] = [];
		for (const t of ganttTools) {
			if (!t.title || t.title.length > 60) problems.push(`${t.name}: title`);
			if (t.description.length > LIMITS.descriptionChars) problems.push(`${t.name}: description is ${t.description.length} characters`);
			if (/\b(you must|always call|never call|you should)\b/i.test(t.description)) problems.push(`${t.name}: instructs the model`);
			const js = z.toJSONSchema(t.input) as JsonSchema;
			if (js.additionalProperties !== false) problems.push(`${t.name}: input is not strict`);
			lint(js, t.name, problems, true);
			const text = JSON.stringify([t.title, t.description, z.toJSONSchema(t.input), t.output ? z.toJSONSchema(t.output) : null]);
			for (const r of BUILTIN_BRAND_RULES) if (r.pattern.test(text)) problems.push(`${t.name}: brand ${r.id}`);
			if (/nc[_-]?gantt/i.test(text)) problems.push(`${t.name}: names the upstream app`);
		}
		expect(problems).toEqual([]);
	});
	it("its part of tools/list stays small (measured), and every entry carries its OAuth scope", async () => {
		setup();
		const t = await token({ scopes: ALL_WORKSPACE });
		const body = await rpcResult(await mcpPost(t, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
		const whole = (body.result as { tools: { name: string; _meta?: { securitySchemes?: unknown } }[] }).tools;
		const list = whole.filter((x) => x.name.startsWith("gantt_"));
		expect(list.map((x) => x.name)).toEqual(NAMES);
		const bytes = JSON.stringify(list).length;
		// Measured 2026-10-25 (fix round 3): 23,558 bytes for the 15 tools, with no output schemas
		// published (DESIGN 25.5). The whole own list's cap is core's to check once every lane is in;
		// its size is logged here for that decision (DESIGN 25.8).
		expect(bytes, `lane G tools/list is ${bytes} bytes`).toBeLessThanOrEqual(24 * 1024);
		console.info(`lane G tools/list: ${list.length} tools, ${bytes} bytes; whole own list: ${whole.length} tools, ${JSON.stringify(whole).length} bytes (cap ${LIMITS.ownToolsListBytes})`);
		expect(list.every((x) => !("outputSchema" in x))).toBe(true);
		for (const x of list) expect(x._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: [catalogEntry(x.name)?.scope] }]);
	});
});

describe("lane G gating", () => {
	it("a connection without the NoGantt app sees no gantt tools, and a call gets not_available", async () => {
		setup();
		const t = await token({ apps: ["files", "boards"] });
		const body = await rpcResult(await mcpPost(t, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
		const names = (body.result as { tools: { name: string }[] }).tools.map((x) => x.name);
		expect(names.some((n) => n.startsWith("gantt_"))).toBe(false);
		const r = await tool("gantt_list_projects", {}, { token: t });
		expect(r.isError).toBe(true);
		expect(r._meta?.["nourax/error"]?.code).toBe("not_available");
	});
	it("a read-only connection sees only the read tools; sharing asks for workspace.share (403)", async () => {
		setup();
		const t = await token({ scopes: ["workspace.read"] });
		const body = await rpcResult(await mcpPost(t, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
		const names = (body.result as { tools: { name: string }[] }).tools.map((x) => x.name).filter((n) => n.startsWith("gantt_"));
		expect(names).toEqual(["gantt_list_projects", "gantt_get_project", "gantt_my_tasks", "gantt_critical_path", "gantt_project_report"]);
		const res = await mcpPost(t, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gantt_share_project", arguments: { project_id: 1, action: "list" } } }, { origin: ORIGIN });
		expect(res.status).toBe(403);
		expect(res.headers.get("www-authenticate")).toContain('scope="workspace.read workspace.share"');
	});
	it("no gantt tool deletes anything for good: none needs workspace.remove, and gantt_delete_task doesn't exist (DESIGN 25.6)", async () => {
		expect(CATALOG.filter((c) => c.app === "gantt" && c.scope === "workspace.remove")).toEqual([]);
		expect(catalogEntry("gantt_delete_task")).toBeUndefined();
		const { fake } = setup();
		const t = await token({ scopes: ALL_WORKSPACE });
		fake.requests.length = 0;
		const body = await rpcResult(await mcpPost(t, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gantt_delete_task", arguments: { project_id: 1, task_id: 2 } } }, { origin: ORIGIN }));
		const failed = body.error !== undefined || (body.result as { isError?: boolean } | undefined)?.isError === true;
		expect(failed).toBe(true);
		expect(fake.driveCalls().some((c) => c.url.pathname.includes("/nc_gantt/"))).toBe(false);
	});
	it("the largest possible list (every app, every flag, the most mail tools) stays within ONLYOFFICE's 100 (DESIGN 0.8)", () => {
		expect(CATALOG.length + LIMITS.mailTools).toBeLessThanOrEqual(100);
		expect(ALL_APPS).toContain("mail");
	});
});
