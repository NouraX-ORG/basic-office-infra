/**
 * Input and output shapes shared by the NoGantt tools (DESIGN 25.3). Inputs are strict, every
 * string has a maximum and every number has bounds (10.8), and their descriptions are short: lane
 * G's 15 tools share the tools/list budget with the 55 others.
 *
 * The output shapes are not published in tools/list (that would double lane G's share of it);
 * the contract tests check every result against them (test/tools/gantt).
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { parseTime } from "../../core/time";
import { Person } from "../../core/shapes";

const MAX_ID = 2_147_483_647;

export const idArg = (what: string) => z.number().int().min(1).max(MAX_ID).describe(what);
export const projectIdArg = () => idArg("Project id (gantt_list_projects).");
export const taskIdArg = () => idArg("Task id (gantt_get_project).");

/** YYYY-MM-DD; checked by checkDate() in run, which gives a plain message. */
export const dateArg = (what: string) => z.string().max(10).describe(what);

/** A real calendar day YYYY-MM-DD between 1970 and 2200 (NoGantt's own range). */
export function checkDate(value: string | null | undefined, field: string): void {
	if (value === null || value === undefined) return;
	const bad = () => new ToolError("invalid_input", `${field} must be a date like 2026-11-03 (you gave "${String(value).slice(0, 20)}").`, { field });
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw bad();
	const p = parseTime(value, "UTC", field);
	if (p.kind !== "date" || p.y < 1970 || p.y > 2200) throw bad();
}

export function checkOrder(start: string | null | undefined, end: string | null | undefined, field = "end_date"): void {
	if (start && end && end < start) throw new ToolError("invalid_input", `${field} (${end}) is before the start (${start}).`, { field });
}

export const titleArg = (what = "1 to 255 characters.") => z.string().trim().min(1).max(255).describe(what);
export const notesArg = (what = "Up to 10,000 characters.") => z.string().max(10_000).describe(what);

export function checkColor(c: string | undefined): void {
	if (c !== undefined && !/^#[0-9a-fA-F]{6}$/.test(c)) throw new ToolError("invalid_input", "color must look like #2563EB.", { field: "color" });
}
export const colorArg = () => z.string().max(7).describe("Like #2563EB (Nourax cobalt, the default).");

export const statusArg = () => z.enum(["not_started", "in_progress", "blocked", "done"]).describe("Task status.");
export const progressArg = () => z.number().int().min(0).max(100).describe("Percent done.");
export const linkTypeArg = () => z.enum(["finish_to_start", "start_to_start", "finish_to_finish", "start_to_finish"]).describe("Default finish_to_start.");
export const lagArg = () => z.number().int().min(-30).max(250).describe("Working days of gap (negative overlaps). Default 0.");

export const DepIn = z
	.object({
		after_task_id: idArg("Task it waits for.").optional(),
		after_milestone_id: idArg("Or milestone it waits for.").optional(),
		type: linkTypeArg().optional(),
		lag_days: lagArg().optional(),
	})
	.strict();
export type DepIn = z.infer<typeof DepIn>;

export function checkDeps(deps: readonly DepIn[] | undefined, field: string, selfTaskId?: number): void {
	for (const [i, d] of (deps ?? []).entries()) {
		const both = d.after_task_id !== undefined && d.after_milestone_id !== undefined;
		const none = d.after_task_id === undefined && d.after_milestone_id === undefined;
		if (both || none) throw new ToolError("invalid_input", `${field}[${i}] needs exactly one of after_task_id and after_milestone_id.`, { field });
		if (selfTaskId !== undefined && d.after_task_id === selfTaskId) throw new ToolError("invalid_input", `${field}[${i}]: a task can't wait for itself.`, { field });
	}
}

// --- Outputs (checked in tests; not published) ------------------------------------------------

export const Role = z.enum(["viewer", "editor", "project_admin"]);
export const LinkType = z.enum(["finish_to_start", "start_to_start", "finish_to_finish", "start_to_finish"]);
export const Status = z.enum(["not_started", "in_progress", "blocked", "done"]);

export const DepOut = z.object({
	after_task_id: z.number().nullable(),
	after_milestone_id: z.number().nullable(),
	type: LinkType,
	lag_days: z.number(),
});

export const TaskOut = z.object({
	task_id: z.number(),
	project_id: z.number(),
	title: z.string(),
	phase_id: z.number().nullable(),
	start: z.string().nullable(),
	end: z.string().nullable(),
	status: Status,
	progress: z.number(),
	depends_on: z.array(DepOut).max(100),
	/** Only when the task has more links than are listed (api.ts TASK_LINKS_SHOWN). */
	depends_on_total: z.number().optional(),
	assigned: z.boolean(),
	board_card_id: z.number().nullable(),
	notes: z.string().nullable(),
	web_url: z.string(),
});

export const ProjectOut = z.object({
	project_id: z.number(),
	title: z.string(),
	description: z.string().nullable(),
	color: z.string().nullable(),
	owner: Person,
	my_role: Role,
	plan_start: z.string().nullable(),
	plan_end: z.string().nullable(),
	board: z.object({ board_id: z.number(), sync: z.enum(["off", "read", "write_with_confirmation", "write"]) }).nullable(),
	web_url: z.string(),
});

export const MilestoneOut = z.object({
	milestone_id: z.number(),
	title: z.string(),
	date: z.string().nullable(),
	phase_id: z.number().nullable(),
	follows: z.object({ kind: z.enum(["task", "phase", "project"]), id: z.number().nullable(), at: z.enum(["start", "end"]) }).nullable(),
});

export const Moved = z.array(z.object({ task_id: z.number(), title: z.string(), start: z.string().nullable(), end: z.string().nullable() }));

/** What NoGantt did with linked NoBoard cards (api.ts boardOut; every part of NoGantt's summary). */
export const BoardOut = z
	.object({ cards_updated: z.number(), cards_failed: z.number(), cards_kept_their_dates: z.number(), cards_gone: z.number(), waiting_for_confirmation: z.number() })
	.strict()
	.nullable();

export const Paging = { next_cursor: z.string().nullable(), has_more: z.boolean() };
