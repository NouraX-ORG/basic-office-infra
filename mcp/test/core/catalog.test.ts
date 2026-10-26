/**
 * Catalogue and description lint (DESIGN 10.8), the instructions builder, and the registry.
 * Lanes' tools are checked here too as soon as they are registered.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LIMITS } from "../../src/core/limits";
import { annotationsFor, CATALOG } from "../../src/mcp/catalog";
import { BASE_INSTRUCTIONS, buildInstructions } from "../../src/mcp/instructions";
import { TOOLS } from "../../src/tools/registry";
import { devToken, fakeWithQa, mcpPost, QA, rpcResult } from "../helpers/index";

afterEach(() => vi.restoreAllMocks());

const ORDER = [
	"workspace_whoami", "workspace_overview",
	"files_list_folder", "files_search", "files_get_info", "files_read_text", "files_create_file", "files_overwrite_file", "files_create_folder",
	"files_move", "files_copy", "files_rename", "files_move_to_trash", "files_list_trash", "files_restore_from_trash", "files_list_versions",
	"files_restore_version", "files_list_favorites", "files_set_favorite", "files_list_recent",
	"sharing_find_people", "sharing_create_link", "sharing_share_with", "sharing_list", "sharing_update", "sharing_delete",
	"docs_create_document", "docs_create_spreadsheet", "docs_create_presentation", "docs_convert", "docs_list_template_fields", "docs_fill_template",
	"calendar_list_calendars", "calendar_list_events", "calendar_find_free_time", "calendar_create_event", "calendar_update_event", "calendar_cancel_event", "calendar_add_attendees", "calendar_respond",
	"tasks_list", "tasks_create", "tasks_complete", "tasks_set_due_date",
	"contacts_search", "contacts_get", "contacts_add", "contacts_update",
	"boards_list", "boards_get_board", "boards_get_card", "boards_create_card", "boards_move_card", "boards_set_due_date", "boards_assign_card", "boards_add_comment",
	// DESIGN 25.3 (lane G), after the boards tools.
	"gantt_list_projects", "gantt_get_project", "gantt_my_tasks", "gantt_create_project", "gantt_update_project", "gantt_import_plan", "gantt_add_task",
	"gantt_update_task", "gantt_add_milestone", "gantt_link_tasks", "gantt_critical_path", "gantt_project_report", "gantt_link_board_card",
	"gantt_share_project", "gantt_undo_change",
];

describe("catalogue", () => {
	it("has 71 tools in a fixed order", () => {
		expect(CATALOG).toHaveLength(71);
		expect(CATALOG.map((c) => c.name)).toEqual(ORDER);
	});
	it("names are snake_case with a domain prefix, at most 25 characters, unique", () => {
		for (const c of CATALOG) {
			expect(c.name, c.name).toMatch(/^[a-z]+(_[a-z0-9]+)+$/);
			expect(c.name.length, c.name).toBeLessThanOrEqual(LIMITS.toolNameChars);
		}
		expect(new Set(CATALOG.map((c) => c.name)).size).toBe(71);
		expect(Math.max(...CATALOG.map((c) => c.name.length))).toBe(25);
	});
	it("tiers match scopes and buckets", () => {
		for (const c of CATALOG) {
			if (c.tier === "R") expect([c.name, c.bucket]).not.toEqual([c.name, "write"]);
			if (c.scope === "workspace.remove") expect(c.tier, c.name).toBe("D");
			if (c.scope === "workspace.share" && c.name !== "sharing_find_people") expect(c.tier, c.name).toBe("D");
			const a = annotationsFor(c);
			expect(Object.keys(a).sort()).toEqual(["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"]);
			if (c.tier === "R") expect(a).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
			if (c.tier === "D") expect(a.destructiveHint).toBe(true);
		}
		expect(CATALOG.filter((c) => c.openWorld).map((c) => c.name)).toEqual(["sharing_create_link"]);
		expect(CATALOG.filter((c) => c.dedupe).map((c) => c.name).sort()).toEqual(
			[
				"boards_add_comment",
				"boards_create_card",
				"calendar_create_event",
				"contacts_add",
				"sharing_create_link",
				"tasks_create",
				"gantt_create_project",
				"gantt_import_plan",
				"gantt_add_task",
				"gantt_add_milestone",
			].sort(),
		);
	});
});

type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; items?: JsonSchema; additionalProperties?: unknown; maxLength?: number; minimum?: number; maximum?: number; exclusiveMaximum?: number; enum?: unknown[]; description?: string; anyOf?: JsonSchema[]; oneOf?: JsonSchema[]; format?: string; const?: unknown; pattern?: string };

function lintSchema(s: JsonSchema, where: string, problems: string[], top = false): void {
	if (s.anyOf || s.oneOf) for (const x of [...(s.anyOf ?? []), ...(s.oneOf ?? [])]) lintSchema(x, where, problems);
	const t = Array.isArray(s.type) ? s.type : [s.type];
	if (t.includes("string") && s.enum === undefined && s.const === undefined && s.maxLength === undefined && s.format === undefined) problems.push(`${where}: string without maxLength`);
	if ((t.includes("number") || t.includes("integer")) && (s.minimum === undefined || (s.maximum === undefined && s.exclusiveMaximum === undefined))) problems.push(`${where}: number without bounds`);
	if (t.includes("object") || s.properties) {
		if (top && s.additionalProperties !== false) problems.push(`${where}: input is not strict`);
		for (const [k, v] of Object.entries(s.properties ?? {})) {
			if (!v.description) problems.push(`${where}.${k}: no description`);
			else if (v.description.length > LIMITS.propertyDescriptionChars) problems.push(`${where}.${k}: description over 120 characters`);
			lintSchema(v, `${where}.${k}`, problems);
		}
	}
	if (s.items) lintSchema(s.items, `${where}[]`, problems);
}

describe("built tools follow the description standard", () => {
	it("every built tool is a catalogue entry, in catalogue order", () => {
		const idx = TOOLS.map((t) => ORDER.indexOf(t.name));
		expect(idx.every((i) => i >= 0)).toBe(true);
		expect([...idx].sort((a, b) => a - b)).toEqual(idx);
		expect(TOOLS.map((t) => t.name)).toContain("workspace_whoami");
	});
	it("titles, descriptions and schemas pass the lint", () => {
		const problems: string[] = [];
		for (const t of TOOLS) {
			if (!t.title || t.title.length > 60) problems.push(`${t.name}: title`);
			if (t.description.length > LIMITS.descriptionChars) problems.push(`${t.name}: description over 450 characters`);
			if (/\b(you must|always call|never call|you should)\b/i.test(t.description)) problems.push(`${t.name}: instructs the model`);
			lintSchema(z.toJSONSchema(t.input) as JsonSchema, t.name, problems, true);
		}
		expect(problems).toEqual([]);
	});
	it("the whole own tools/list stays within LIMITS.ownToolsListBytes (100 KB since fix round 3), with no $schema lines", async () => {
		fakeWithQa();
		const t = await devToken(QA.a, { scopes: ["workspace.read", "workspace.write", "workspace.remove", "workspace.share"] });
		const res = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		const body = await rpcResult(res);
		const tools = (body.result as { tools: { name: string; _meta?: Record<string, unknown> }[] }).tools;
		expect(JSON.stringify(tools).length).toBeLessThanOrEqual(LIMITS.ownToolsListBytes);
		// MCP reads a schema without "$schema" as JSON Schema 2020-12 (2025-11-25, "JSON Schema Usage").
		expect(JSON.stringify(tools)).not.toContain('"$schema"');
		expect(tools.map((x) => x.name)).toEqual(TOOLS.map((x) => x.name));
		expect(tools[0]?._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["workspace.read"] }]);
	});
});

describe("instructions", () => {
	it("are facts only and at most 900 characters", () => {
		for (const scopes of [["workspace.read"], ["workspace.read", "workspace.write"], ["workspace.read", "workspace.write", "workspace.remove", "workspace.share", "mail.read", "mail.write"]] as const) {
			for (const [mail, apps] of [[true, undefined], [false, undefined], [true, ["files"]], [false, ["files", "gantt"]]] as const) {
				const text = buildInstructions(scopes as never, mail, apps as never);
				expect(text.length).toBeLessThanOrEqual(LIMITS.instructionsChars);
				expect(text.startsWith(BASE_INSTRUCTIONS)).toBe(true);
				expect(text).not.toMatch(/\byou must\b|\balways call\b/i);
			}
		}
		expect(buildInstructions(["workspace.read"], false)).toContain("This connection can only read.");
		expect(buildInstructions(["workspace.read", "workspace.write"], false)).toContain("can't share files");
		expect(buildInstructions(["workspace.read", "workspace.write", "mail.read"], true)).toContain("can't send mail");
		expect(buildInstructions(["workspace.read", "workspace.write", "workspace.remove", "workspace.share"], false)).toBe(BASE_INSTRUCTIONS);
		// Fix round 3: no "replace and remove", no mail.read, and apps that weren't chosen are said too.
		expect(buildInstructions(["workspace.read", "workspace.write", "workspace.share"], false)).toContain("can't move things to the trash, replace a file's content or cancel events");
		expect(buildInstructions(["workspace.read", "workspace.write", "mail.write"], true)).toContain("This connection can't read mail.");
		expect(buildInstructions(["workspace.read", "workspace.write", "mail.read"], true)).not.toContain("can't read mail");
		const someApps = buildInstructions(["workspace.read", "workspace.write", "workspace.remove", "workspace.share"], false, ["files", "docs", "calendar", "contacts"]);
		expect(someApps).toContain("This connection doesn't cover NoBoard or NoGantt.");
		expect(someApps.endsWith("The person can allow more by reconnecting.")).toBe(true);
		expect(buildInstructions(["workspace.read", "workspace.write", "workspace.remove", "workspace.share"], false, ["files", "docs", "calendar", "contacts", "boards", "gantt"])).toBe(BASE_INSTRUCTIONS);
		// The most a connection can lack still gives whole sentences within 900 characters.
		const most = buildInstructions(["workspace.read", "workspace.write"], true, ["files"]);
		expect(most.length).toBeLessThanOrEqual(LIMITS.instructionsChars);
		expect(most.endsWith("The person can allow more by reconnecting.")).toBe(true);
	});
});
