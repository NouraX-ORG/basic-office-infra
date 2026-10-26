/**
 * NoGantt tasks, milestones, links and undo (DESIGN 25.3): gantt_my_tasks, gantt_add_task,
 * gantt_update_task, gantt_add_milestone, gantt_link_tasks and gantt_undo_change.
 *
 * No tool deletes a task (DESIGN 25.6). NoGantt has no trash, and its delete also removes for good
 * the milestones that follow the task, links to it, its people and its card links, and nothing under
 * the "replace and remove" choice deletes for good what can't be brought back, so a task delete
 * can't sit there; people delete tasks in NoGantt itself. Adding one is an owner decision (DESIGN 20,
 * item 9).
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { allowDuplicateArg, cursorArg, limitArg } from "../../core/shapes";
import { defineTool, type ToolCtx } from "../../core/tool";
import {
	boardOut,
	boardWarnings,
	checkedUndo,
	day,
	type DepOut as RawDepOut,
	FEED_WARNING,
	depIn,
	findTask,
	fitWithin,
	gantt,
	jsonChars,
	linksOf,
	milestoneOut,
	notUndoable,
	own,
	pageOf,
	projectTasks,
	type RawDeckSummary,
	type RawMilestone,
	type RawTask,
	restorable,
	statusOf,
	TASK_OUT_ROOM,
	taskOut,
	taskUrl,
	title,
	today,
	UNDO_HINT,
	UNDO_NOT_FOUND,
} from "./api";
import {
	BoardOut,
	checkDate,
	checkDeps,
	checkOrder,
	DepIn,
	dateArg,
	idArg,
	MilestoneOut,
	Moved,
	notesArg,
	Paging,
	progressArg,
	projectIdArg,
	Status,
	statusArg,
	TaskOut,
	taskIdArg,
	titleArg,
} from "./shapes";

const updateBoardCardsArg = () => z.boolean().default(false).describe("Also move linked NoBoard cards' dates when the project asks first.");

/** Result shapes, checked by the contract tests (not published in tools/list; see shapes.ts). */
export const TASK_OUTPUTS = {
	gantt_my_tasks: z.object({
		linked: z.boolean(),
		tasks: z.array(
			z.object({
				task_id: z.number(),
				title: z.string(),
				project_id: z.number(),
				project_title: z.string(),
				start: z.string().nullable(),
				end: z.string().nullable(),
				status: Status,
				progress: z.number(),
				overdue: z.boolean(),
				web_url: z.string(),
			}),
		),
		note: z.string().nullable(),
		...Paging,
	}),
	gantt_add_task: z.object({ task: TaskOut, moved_by_links: z.boolean() }),
	gantt_update_task: z.object({ task: TaskOut, moved: Moved, moved_total: z.number(), board: BoardOut, previous: z.record(z.string(), z.unknown()) }),
	gantt_add_milestone: z.object({ milestone: MilestoneOut }),
	gantt_link_tasks: z.object({ added: z.number(), skipped: z.number(), moved: Moved, moved_total: z.number(), board: BoardOut, op_id: z.string().nullable() }),
	gantt_undo_change: z.object({ reverted_entries: z.number(), task_ids: z.array(z.number()), task_ids_total: z.number(), kinds: z.array(z.string()), board: BoardOut }),
};

/** Tasks whose dates differ between two snapshots (by id). */
function movedBetween(before: readonly RawTask[], after: readonly RawTask[]): z.infer<typeof Moved> {
	const old = new Map(before.map((t) => [t.id, `${day(t.start_date)}|${day(t.end_date)}`]));
	return after
		.filter((t) => old.has(t.id) && old.get(t.id) !== `${day(t.start_date)}|${day(t.end_date)}`)
		.map((t) => ({ task_id: t.id, title: title(t.title), start: day(t.start_date), end: day(t.end_date) }));
}

/**
 * At most 200 moved tasks within `maxChars` (half the result at most, and only what the rest of the
 * answer leaves), with the full count (DESIGN 25.5 and 25.7).
 */
function movedShown(moved: z.infer<typeof Moved>, maxChars: number): { moved: z.infer<typeof Moved>; moved_total: number; warning: string | null } {
	const shown = fitWithin(moved, 200, maxChars, (items) => ({ moved: items })).items;
	const more = moved.length - shown.length;
	const warning = more > 0 ? `${more} more moved task${more === 1 ? " isn't" : "s aren't"} listed here; gantt_get_project shows the whole plan.` : null;
	return { moved: shown, moved_total: moved.length, warning };
}

/** Room for the moved list: half the result at most, and what the rest of the answer leaves (with room for the warnings still to come). */
function movedRoom(ctx: ToolCtx, rest: unknown): number {
	return Math.min(Math.floor(ctx.budget.chars / 2), ctx.budget.chars - jsonChars(rest) - 600);
}

/** A link as depends_on takes it (the undo's form). */
function depArg(d: RawDepOut): Record<string, unknown> {
	return d.after_task_id !== null ? { after_task_id: d.after_task_id, type: d.type, lag_days: d.lag_days } : { after_milestone_id: d.after_milestone_id, type: d.type, lag_days: d.lag_days };
}

/** Warns when a task's links were cut to fit (taskOut lists at most 100). */
function linksWarning(t: { task_id: number; depends_on: unknown[]; depends_on_total?: number }): string | null {
	return t.depends_on_total !== undefined
		? `Task ${t.task_id} has ${t.depends_on_total} links; only the first ${t.depends_on.length} are listed here (NoGantt shows them all).`
		: null;
}

/** NoGantt's own maximum for /my-tasks (MyTaskController: int<1, 500>, earliest due first). */
const MY_TASKS_MAX = 500;

const writeForbidden = "This person isn't allowed to change this project's plan (they need the editor role).";
const noProject = (id: number) => `There's no project ${id} that this person can see.`;
const cardsWaiting = "Linked NoBoard cards weren't changed because the project asks first; update_board_cards true changes them.";

// --- gantt_my_tasks --------------------------------------------------------------------------

export const myTasks = defineTool({
	name: "gantt_my_tasks",
	title: "My project tasks",
	description:
		"Lists NoGantt tasks assigned to the person across their projects, earliest due first, with dates, status, progress and overdue flags. Assignment goes through a NoGantt person linked to the account; without one the list is empty and says so.",
	input: z
		.object({
			include_done: z.boolean().default(false).describe("Also list done tasks."),
			due_before: dateArg("Only tasks ending by this date, YYYY-MM-DD.").optional(),
			project_id: idArg("Only this project.").optional(),
			limit: limitArg(200, 50),
			cursor: cursorArg(),
		})
		.strict(),
	async run(ctx, args) {
		checkDate(args.due_before, "due_before");
		const query: Record<string, string> = { limit: String(MY_TASKS_MAX) };
		if (args.include_done) query.include_done = "true";
		const r = await gantt<{ has_linked_resource?: boolean; tasks?: Record<string, unknown>[] }>(ctx, "GET", "/my-tasks", { query });
		const linked = r?.has_linked_resource === true;
		const raw = Array.isArray(r?.tasks) ? r.tasks : [];
		// NoGantt answers with its first 500 at most, earliest due first; filters here can't see past them.
		const capped = raw.length >= MY_TASKS_MAX;
		const all = raw
			.map((t) => ({
				task_id: Number(t.id),
				title: title(t.title as string),
				project_id: Number(t.project_id),
				project_title: title(t.project_title as string),
				start: day(t.start_date as string),
				end: day(t.end_date as string),
				status: statusOf(t.status as string),
				progress: Math.max(0, Math.min(100, Number(t.manual_progress ?? 0) || 0)),
				overdue: t.overdue === true,
				web_url: taskUrl(ctx, Number(t.project_id), Number(t.id)),
			}))
			.filter((t) => (args.project_id === undefined || t.project_id === args.project_id) && (!args.due_before || (t.end !== null && t.end <= args.due_before)));
		const page = await pageOf(ctx, all, args.limit, (items) => ({ tasks: items }));
		const note = linked ? null : "No NoGantt person is linked to this account yet, so no tasks are assigned to it. A project owner links people under Resources in NoGantt.";
		const data = { linked, tasks: page.items, note, next_cursor: page.next_cursor, has_more: page.has_more };
		const among = capped ? ` among NoGantt's first ${MY_TASKS_MAX}` : "";
		const warnings = capped
			? [`NoGantt gives at most ${MY_TASKS_MAX} assigned tasks, earliest due first, so tasks due later may be missing here, also for one project; gantt_get_project shows a whole project.`]
			: [];
		return {
			data,
			summary: linked ? `Found ${all.length} assigned NoGantt task${all.length === 1 ? "" : "s"}${among}; showing ${page.items.length}.` : "No NoGantt tasks are assigned to this person.",
			...(warnings.length ? { warnings } : {}),
		};
	},
});

// --- gantt_add_task --------------------------------------------------------------------------

export const addTask = defineTool({
	name: "gantt_add_task",
	title: "Add a task",
	description:
		"Adds a task to a NoGantt project: title, start and end dates (YYYY-MM-DD, end included), and optionally phase, notes, status, progress and what it waits for (depends_on). Links may move it later; the result says so. Needs the editor role. Tasks are deleted only in NoGantt itself.",
	input: z
		.object({
			project_id: projectIdArg(),
			title: titleArg(),
			start_date: dateArg("First day, YYYY-MM-DD."),
			end_date: dateArg("Last day, YYYY-MM-DD (included)."),
			phase_id: idArg("Its phase (gantt_get_project).").optional(),
			notes: notesArg().optional(),
			status: statusArg().optional(),
			progress: progressArg().optional(),
			depends_on: z.array(DepIn).max(20).optional().describe("What it waits for, up to 20."),
			allow_duplicate: allowDuplicateArg(),
		})
		.strict(),
	async run(ctx, args) {
		checkDate(args.start_date, "start_date");
		checkDate(args.end_date, "end_date");
		checkOrder(args.start_date, args.end_date);
		checkDeps(args.depends_on, "depends_on");
		const body: Record<string, unknown> = { title: args.title, start_date: args.start_date, end_date: args.end_date };
		if (args.phase_id !== undefined) body.subproject_id = args.phase_id;
		if (args.notes !== undefined) body.description = args.notes;
		if (args.status !== undefined) body.status = args.status;
		if (args.progress !== undefined) body.manual_progress = args.progress;
		if (args.depends_on?.length) body.dependencies = args.depends_on.map(depIn);
		const t = await gantt<RawTask>(ctx, "POST", `/projects/${args.project_id}/tasks`, {
			body,
			notFound: noProject(args.project_id),
			forbidden: writeForbidden,
			projectId: args.project_id,
		});
		const task = taskOut(ctx, t);
		const moved = task.start !== args.start_date || task.end !== args.end_date;
		return {
			data: { task, moved_by_links: moved },
			summary: `Added task ${t.id} to NoGantt project ${args.project_id}${moved ? "; its links moved it" : ""}.`,
			// No tool deletes a task (25.6), so there is no undo; the person can delete it in NoGantt.
			undo: null,
			warnings: [FEED_WARNING],
		};
	},
});

// --- gantt_update_task -----------------------------------------------------------------------

const updateTaskInput = z
	.object({
		project_id: projectIdArg(),
		task_id: taskIdArg(),
		title: titleArg().optional(),
		notes: notesArg().nullable().describe("New notes; null clears them.").optional(),
		start_date: dateArg("New first day, YYYY-MM-DD.").optional(),
		end_date: dateArg("New last day, YYYY-MM-DD.").optional(),
		status: statusArg().optional(),
		progress: progressArg().optional(),
		phase_id: z.number().int().min(1).max(2_147_483_647).nullable().describe("New phase; null for none.").optional(),
		depends_on: z.array(DepIn).max(20).optional().describe("Replaces all its links; [] removes them."),
		update_board_cards: updateBoardCardsArg(),
	})
	.strict();

export const updateTask = defineTool({
	name: "gantt_update_task",
	title: "Change a task",
	description:
		"Changes a NoGantt task; only given fields change: title, notes (null clears), dates, status, progress, phase (null for none), depends_on (replaces its links; [] removes them). Dependent tasks move along and are listed; gantt_undo_change takes moves back. Needs the editor role.",
	input: updateTaskInput,
	async run(ctx, args) {
		const fields = ["title", "notes", "start_date", "end_date", "status", "progress", "phase_id", "depends_on"] as const;
		const changed = fields.filter((k) => args[k] !== undefined);
		if (changed.length === 0) throw new ToolError("invalid_input", "Nothing to change: give at least one field.");
		checkDate(args.start_date, "start_date");
		checkDate(args.end_date, "end_date");
		checkDeps(args.depends_on, "depends_on", args.task_id);
		const { task: old, all } = await findTask(ctx, args.project_id, args.task_id);
		const before = taskOut(ctx, old);
		checkOrder(args.start_date ?? before.start, args.end_date ?? before.end);
		const url = before.web_url;
		// The old values go into the undo. A value the undo couldn't write back isn't changed here
		// (DESIGN 25.6 #3 and 25.7): a title or notes too long, or shown changed; links depends_on
		// couldn't take back (NoGantt doesn't log a link change, so gantt_undo_change can't either).
		const oldTitle = restorable(old.title, 255, { trimmed: true });
		const oldNotes = restorable(old.description, 10_000);
		if (args.title !== undefined && oldTitle.why) throw notUndoable("task", "title", oldTitle.why, 255, url);
		if (args.notes !== undefined && oldNotes.why) throw notUndoable("task", "notes", oldNotes.why, 10_000, url);
		const oldLinks = linksOf(old).map(depArg);
		if (args.depends_on !== undefined) checkOldLinks(old, oldLinks, url);
		const previous: Record<string, unknown> = {};
		for (const k of changed) {
			if (k === "title") previous.title = oldTitle.value;
			if (k === "notes") previous.notes = oldNotes.value;
			if (k === "start_date") previous.start_date = before.start;
			if (k === "end_date") previous.end_date = before.end;
			if (k === "status") previous.status = before.status;
			if (k === "progress") previous.progress = before.progress;
			if (k === "phase_id") previous.phase_id = before.phase_id;
			if (k === "depends_on") previous.depends_on = oldLinks;
		}
		// The old values come back twice at most (previous, and the undo's arguments). Together they
		// get what the task itself, the card summary and the warnings leave, so the answer always fits
		// (quotes and control characters count several times in JSON); the moved list takes the rest.
		if (2 * jsonChars(previous) > ctx.budget.chars - TASK_OUT_ROOM - 2_000) {
			const biggest = Object.keys(previous).reduce((a, b) => (jsonChars(previous[b]) > jsonChars(previous[a]) ? b : a));
			throw notUndoable("task", biggest, "big", 0, url);
		}

		const body: Record<string, unknown> = {};
		if (args.title !== undefined) body.title = args.title;
		if (args.notes !== undefined) body.description = args.notes ?? "";
		if (args.start_date !== undefined) body.start_date = args.start_date;
		if (args.end_date !== undefined) body.end_date = args.end_date;
		if (args.status !== undefined) body.status = args.status;
		if (args.progress !== undefined) body.manual_progress = args.progress;
		if (args.phase_id !== undefined) body.subproject_id = args.phase_id;
		if (args.depends_on !== undefined) body.dependencies = args.depends_on.map(depIn);
		if (args.update_board_cards) body.deck_confirmed = true;

		const r = await gantt<{ task: RawTask; propagated?: RawTask[]; op_id?: string | null; deck?: RawDeckSummary }>(ctx, "PUT", `/tasks/${args.task_id}`, {
			body,
			notFound: `Project ${args.project_id} has no task ${args.task_id}.`,
			forbidden: writeForbidden,
			projectId: args.project_id,
		});
		const after = taskOut(ctx, r.task);
		const others = movedBetween(all, Array.isArray(r.propagated) ? r.propagated : []).filter((m) => m.task_id !== args.task_id);
		const opId = typeof r.op_id === "string" && r.op_id ? r.op_id : null;
		const onlyDates = changed.every((k) => k === "start_date" || k === "end_date");
		const warnings: string[] = [];
		let undo: { tool: string; arguments: Record<string, unknown> } | null;
		if (opId) {
			undo = { tool: "gantt_undo_change", arguments: { op_id: opId } };
			if (!onlyDates) warnings.push("gantt_undo_change takes back only the date moves; gantt_update_task with the old values in previous takes back the rest.");
		} else {
			const checked = checkedUndo(updateTaskInput, { project_id: args.project_id, task_id: args.task_id, ...previous }, ["project_id", "task_id"]);
			undo = checked.args ? { tool: "gantt_update_task", arguments: checked.args } : null;
			if (checked.dropped.length) warnings.push(`The old ${checked.dropped.join(" and ")} couldn't be read back, so the undo leaves ${checked.dropped.length === 1 ? "it" : "them"} out.`);
		}
		const board = boardOut(r.deck);
		if (board?.waiting_for_confirmation) warnings.push(cardsWaiting);
		warnings.push(...boardWarnings(board, "new"));
		const cut = linksWarning(after);
		if (cut) warnings.push(cut);
		warnings.push(FEED_WARNING);
		// The moved list gets what the rest of the answer leaves, half of it at most (DESIGN 25.7).
		const rest = { task: after, moved: [], moved_total: others.length, board, previous, undo, warnings };
		const shown = movedShown(others, movedRoom(ctx, rest));
		if (shown.warning) warnings.push(shown.warning);
		return {
			data: { task: after, moved: shown.moved, moved_total: shown.moved_total, board, previous },
			summary: `Changed task ${args.task_id}${others.length ? `; ${others.length} dependent task${others.length === 1 ? "" : "s"} moved` : ""}.`,
			undo,
			...(warnings.length ? { warnings } : {}),
		};
	},
});

/**
 * Refuses a depends_on change when the old links couldn't be written back by depends_on itself:
 * more than its 20, a link NoGantt sent in a form we don't know, or a lag outside -30 to 250.
 */
function checkOldLinks(old: RawTask, oldLinks: Record<string, unknown>[], url: string): void {
	const raw = Array.isArray(old.dependencies) ? old.dependencies.length : 0;
	if (raw > 20) {
		throw new ToolError(
			"too_large",
			`This task waits for ${raw} tasks and milestones, more than the 20 that depends_on takes, so replacing its links here couldn't be undone. Nothing was changed.`,
			{ hint: `gantt_link_tasks adds links; NoGantt itself changes or removes them: ${url}`, field: "depends_on" },
		);
	}
	if (oldLinks.length !== raw || !updateTaskInput.shape.depends_on.safeParse(oldLinks).success) {
		throw new ToolError(
			"not_available",
			"One of this task's links can't be written back through depends_on (its kind or lag is outside what the tool takes), so replacing its links here couldn't be undone. Nothing was changed.",
			{ hint: `Change its links in NoGantt itself: ${url}`, field: "depends_on" },
		);
	}
}

// --- gantt_add_milestone ---------------------------------------------------------------------

export const addMilestone = defineTool({
	name: "gantt_add_milestone",
	title: "Add a milestone",
	description:
		"Adds a milestone to a NoGantt project: on a fixed date, or following the start or end of a task, a phase or the whole project (follows), so it moves with them. Tasks can then wait for it (gantt_link_tasks). Needs the editor role.",
	input: z
		.object({
			project_id: projectIdArg(),
			title: titleArg(),
			date: dateArg("Fixed date, YYYY-MM-DD.").optional(),
			phase_id: idArg("Phase to show a fixed milestone in.").optional(),
			follows: z
				.object({
					kind: z.enum(["task", "phase", "project"]).describe("Follow a task, a phase or the project."),
					id: idArg("Task or phase id.").optional(),
					at: z.enum(["start", "end"]).default("end").describe("Its start or end (default end)."),
				})
				.strict()
				.optional()
				.describe("Instead of date: what it follows."),
			allow_duplicate: allowDuplicateArg(),
		})
		.strict(),
	async run(ctx, args) {
		if ((args.date === undefined) === (args.follows === undefined)) throw new ToolError("invalid_input", "Give either date or follows.");
		checkDate(args.date, "date");
		const body: Record<string, unknown> = { title: args.title, milestone_date: args.date ?? today(ctx) };
		if (args.follows) {
			const f = args.follows;
			if (f.kind !== "project" && f.id === undefined) throw new ToolError("invalid_input", `follows.id is needed for a ${f.kind}.`, { field: "follows.id" });
			if (f.kind === "project" && f.id !== undefined) throw new ToolError("invalid_input", "follows.id isn't used for the whole project.", { field: "follows.id" });
			if (args.phase_id !== undefined) throw new ToolError("invalid_input", "phase_id is for fixed milestones; use follows with kind phase.", { field: "phase_id" });
			body.dependency_type = f.at === "start" ? "AA" : "EA";
			if (f.kind === "task") body.task_id = f.id;
			if (f.kind === "phase") body.subproject_id = f.id;
		} else if (args.phase_id !== undefined) {
			body.subproject_id = args.phase_id;
		}
		const m = await gantt<RawMilestone>(ctx, "POST", `/projects/${args.project_id}/milestones`, {
			body,
			notFound: noProject(args.project_id),
			forbidden: writeForbidden,
			projectId: args.project_id,
		});
		return {
			data: { milestone: milestoneOut(m) },
			summary: `Added milestone ${m.id} to NoGantt project ${args.project_id}.`,
			undo: null,
			warnings: [FEED_WARNING],
		};
	},
});

// --- gantt_link_tasks ------------------------------------------------------------------------

export const linkTasks = defineTool({
	name: "gantt_link_tasks",
	title: "Link tasks",
	description:
		"Makes NoGantt tasks wait for another task or a milestone (finish_to_start unless type says otherwise, optional lag_days), up to 50 per call. Existing links are skipped, loops refused. Tasks that must move are moved and listed; gantt_undo_change takes it all back. Needs the editor role.",
	input: z
		.object({
			project_id: projectIdArg(),
			links: z
				.array(
					DepIn.extend({ task_id: idArg("Task that waits.") }).strict(),
				)
				.min(1)
				.max(50)
				.describe("task_id waits for after_task_id or after_milestone_id."),
			update_board_cards: updateBoardCardsArg(),
		})
		.strict(),
	async run(ctx, args) {
		args.links.forEach((l, i) => checkDeps([l], `links[${i}]`, l.task_id));
		const before = await projectTasks(ctx, args.project_id);
		const ids = new Set(before.map((t) => t.id));
		for (const [i, l] of args.links.entries()) {
			if (!ids.has(l.task_id)) throw new ToolError("invalid_input", `links[${i}].task_id isn't a task of project ${args.project_id}.`, { field: "links" });
			if (l.after_task_id !== undefined && !ids.has(l.after_task_id)) throw new ToolError("invalid_input", `links[${i}].after_task_id isn't a task of project ${args.project_id}.`, { field: "links" });
		}
		const links = args.links.map((l) => ({ task_id: l.task_id, ...depIn(l) }));
		const r = await gantt<{ tasks?: RawTask[]; op_id?: string | null; added?: number; skipped?: number; deck?: RawDeckSummary }>(ctx, "POST", `/projects/${args.project_id}/dependencies`, {
			body: { links, deck_confirmed: args.update_board_cards },
			notFound: noProject(args.project_id),
			forbidden: writeForbidden,
			projectId: args.project_id,
		});
		const moved = movedBetween(before, Array.isArray(r.tasks) ? r.tasks : []);
		const opId = typeof r.op_id === "string" && r.op_id ? r.op_id : null;
		const board = boardOut(r.deck);
		const added = Number(r.added ?? 0) || 0;
		const skipped = Number(r.skipped ?? 0) || 0;
		const warnings: string[] = [...(board?.waiting_for_confirmation ? [cardsWaiting] : []), ...boardWarnings(board, "new"), ...(moved.length ? [FEED_WARNING] : [])];
		const shown = movedShown(moved, movedRoom(ctx, { added, skipped, moved: [], moved_total: moved.length, board, op_id: opId, warnings }));
		if (shown.warning) warnings.push(shown.warning);
		return {
			data: { added, skipped, moved: shown.moved, moved_total: shown.moved_total, board, op_id: opId },
			summary: `Added ${added} link${added === 1 ? "" : "s"}${skipped ? `, ${skipped} already there` : ""}; ${moved.length} task${moved.length === 1 ? "" : "s"} moved.`,
			undo: opId ? { tool: "gantt_undo_change", arguments: { op_id: opId } } : null,
			...(warnings.length ? { warnings } : {}),
		};
	},
});

// --- gantt_undo_change -----------------------------------------------------------------------

/** The example in the op_id refusal: plainly made up, so a model that copies it can't take back a real change. */
export const EXAMPLE_OP_ID = "00000000-0000-4000-8000-000000000000";

const and = (parts: string[]) => (parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

/**
 * What an undo took back, in a person's words (DESIGN 25.8): the tasks whose dates went back and the
 * kinds of things it touched. Not NoGantt's reverted_count, which counts logged fields (a moved task
 * is two: its start and its end).
 */
export function undoSummary(tasks: number, kinds: readonly string[]): string {
	const parts: string[] = [];
	if (tasks) parts.push(`the dates of ${tasks} task${tasks === 1 ? "" : "s"}`);
	else if (kinds.includes("task dates")) parts.push("task dates");
	if (kinds.includes("links")) parts.push("the links it added or changed");
	if (kinds.includes("project planning period")) parts.push("the project's planning period");
	if (kinds.includes("phase planning period")) parts.push("a phase's planning period");
	if (kinds.includes("other")) parts.push("other plan details");
	return parts.length ? `Took back the NoGantt change: ${and(parts)}.` : "Took back the NoGantt change.";
}

export const undoChange = defineTool({
	name: "gantt_undo_change",
	title: "Undo a plan change",
	description:
		"Takes back one NoGantt change by its op_id (from gantt_update_task, gantt_link_tasks or gantt_update_project): the moved dates, every task the change pushed along, links it added, or a planning period. Linked NoBoard cards get the old dates back too, without asking first, unless changed in NoBoard since; board counts them. Refused when one of those things was changed again since. Needs the editor role.",
	input: z
		.object({
			op_id: z.string().max(36).describe("op_id of the change."),
		})
		.strict(),
	async run(ctx, args) {
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args.op_id)) {
			throw new ToolError("invalid_input", `op_id must be an undo id from gantt_update_task, gantt_link_tasks or gantt_update_project, shaped like ${EXAMPLE_OP_ID}.`, { field: "op_id" });
		}
		const r = await gantt<{ reverted_count?: number; task_ids?: unknown[]; entity_types?: unknown[]; deck?: RawDeckSummary }>(ctx, "POST", `/changes/${args.op_id}/revert`, {
			notFound: UNDO_NOT_FOUND,
		}).catch((e: unknown) => {
			// An unknown id (404) and a plain 403 (the person may not change that project, or can't see
			// it at all) get one answer: the route names no project, so the two can't be told apart
			// (DESIGN 25.1 and 25.8). Conflicts and "NoGantt is off" keep their own answers.
			if (e instanceof ToolError && (e.code === "not_found" || (e.code === "permission_denied" && e.upstreamStatus === 403))) {
				throw new ToolError("not_found", UNDO_NOT_FOUND, { hint: UNDO_HINT, field: "op_id", upstreamStatus: e.upstreamStatus });
			}
			throw e;
		});
		const kindWord: Record<string, string> = { task: "task dates", dependency: "links", project: "project planning period", subproject: "phase planning period" };
		const taskIds = (Array.isArray(r?.task_ids) ? r.task_ids : []).filter((x): x is number => typeof x === "number");
		const board = boardOut(r?.deck);
		const kinds = [...new Set((Array.isArray(r?.entity_types) ? r.entity_types : []).filter((x): x is string => typeof x === "string").map((k) => own(kindWord, k) ?? "other"))];
		const data = {
			// NoGantt's reverted_count: logged fields, not changes (a moved task counts its start and its end).
			reverted_entries: Number(r?.reverted_count ?? 0) || 0,
			task_ids: taskIds.slice(0, 200),
			task_ids_total: taskIds.length,
			kinds,
			board,
		};
		const warnings = boardWarnings(board, "old");
		return {
			data,
			summary: undoSummary(taskIds.length, kinds),
			undo: null,
			...(warnings.length ? { warnings } : {}),
		};
	},
});

export const taskTools = [myTasks, addTask, updateTask, addMilestone, linkTasks, undoChange];

/** For tests: the helper that finds moved tasks. */
export const _movedBetween = movedBetween;
