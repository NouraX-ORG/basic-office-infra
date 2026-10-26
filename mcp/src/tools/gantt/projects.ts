/**
 * NoGantt projects (DESIGN 25.3): gantt_list_projects, gantt_get_project, gantt_create_project,
 * gantt_update_project and gantt_import_plan. No tool deletes a project.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { allowDuplicateArg, cursorArg, limitArg } from "../../core/shapes";
import { defineTool, type ToolCtx } from "../../core/tool";
import {
	type BoardSync,
	checkedUndo,
	COBALT,
	FEED_WARNING,
	day,
	fitWithin,
	gantt,
	getProject,
	jsonChars,
	levelOf,
	milestoneOut,
	notUndoable,
	PROJECT_OUT_ROOM,
	pageOf,
	projectOut,
	projectUrl,
	type RawMilestone,
	type RawPhase,
	type RawProject,
	type RawTask,
	restorable,
	roleOf,
	statusOf,
	TASK_LINKS_SHOWN,
	taskOut,
	title,
} from "./api";
import { checkColor, checkDate, checkOrder, colorArg, dateArg, idArg, MilestoneOut, notesArg, Paging, ProjectOut, projectIdArg, TaskOut, titleArg } from "./shapes";

/** Result shapes, checked by the contract tests (not published in tools/list; see shapes.ts). */
export const PROJECT_OUTPUTS = {
	gantt_list_projects: z.object({ projects: z.array(ProjectOut), total: z.number(), ...Paging }),
	gantt_get_project: z.object({
		project: ProjectOut,
		phases: z.array(z.object({ phase_id: z.number(), parent_id: z.number().nullable(), title: z.string(), status: z.string() })),
		tasks: z.array(TaskOut),
		milestones: z.array(MilestoneOut),
		counts: z.object({ tasks: z.number(), done: z.number(), phases: z.number(), milestones: z.number() }),
		...Paging,
	}),
	gantt_create_project: z.object({ project: ProjectOut }),
	gantt_update_project: z.object({ project: ProjectOut, changed: z.array(z.string()), op_id: z.string().nullable() }),
	gantt_import_plan: z.object({
		project_id: z.number(),
		created_project: z.boolean(),
		phases: z.number(),
		tasks: z.number(),
		milestones: z.number(),
		/** The finish-to-start links asked for that were made (each waiting task moved after the one it waits for). */
		links: z.number(),
		links_not_added: z.number(),
		/** Undated tasks that wait for no other task, hung on the "Project start" milestone (NoGantt's own start-to-start links; DESIGN 25.10). */
		start_milestone_links: z.number(),
		task_ids: z.record(z.string(), z.number()),
		web_url: z.string(),
	}),
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// --- gantt_list_projects ---------------------------------------------------------------------

export const listProjects = defineTool({
	name: "gantt_list_projects",
	title: "List projects",
	description:
		"Lists the NoGantt projects the person can see: their own and those shared with them, with their role (viewer, editor or project_admin), owner, planning period and NoBoard link. query filters by title. gantt_get_project shows one plan in full.",
	input: z
		.object({
			query: z.string().max(200).optional().describe("Title contains this."),
			role: z.enum(["any", "owner", "shared"]).default("any").describe("owner: their own; shared: shared with them."),
			limit: limitArg(200, 50),
			cursor: cursorArg(),
		})
		.strict(),
	async run(ctx, args) {
		const raw = await gantt<RawProject[]>(ctx, "GET", "/projects");
		// Both sides in NFC, so combining accents in the query or a title still match (DESIGN 29.9).
		const q = args.query?.normalize("NFC").trim().toLowerCase() ?? "";
		const all = (Array.isArray(raw) ? raw : [])
			.filter((p) => (args.role === "owner" ? p.owner_id === ctx.uid : args.role === "shared" ? p.owner_id !== ctx.uid : true))
			.filter((p) => !q || String(p.title ?? "").normalize("NFC").toLowerCase().includes(q))
			.map((p) => projectOut(ctx, p, 300));
		const page = await pageOf(ctx, all, args.limit, (items) => ({ projects: items }));
		const data = { projects: page.items, total: all.length, next_cursor: page.next_cursor, has_more: page.has_more };
		return { data, summary: all.length ? `Found ${plural(all.length, "NoGantt project")}; showing ${page.items.length}.` : "No NoGantt projects found." };
	},
});

// --- gantt_get_project -----------------------------------------------------------------------

export const getProjectTool = defineTool({
	name: "gantt_get_project",
	title: "Project plan",
	description:
		"Shows one NoGantt project: phases, tasks (dates, status, progress, links, NoBoard card) and milestones. Dates are YYYY-MM-DD, end included; task notes are cut to 300 characters. Up to 300 tasks per call, earliest first, with next_cursor.",
	input: z
		.object({
			project_id: projectIdArg(),
			include_done: z.boolean().default(true).describe("false leaves out done tasks."),
			limit: limitArg(300, 150),
			cursor: cursorArg(),
		})
		.strict(),
	async run(ctx, args) {
		const id = args.project_id;
		const nf = { notFound: `There's no project ${id} that this person can see.` };
		const [p, phases, tasks, milestones] = await Promise.all([
			getProject(ctx, id),
			gantt<RawPhase[]>(ctx, "GET", `/projects/${id}/subprojects`, nf),
			gantt<RawTask[]>(ctx, "GET", `/projects/${id}/tasks`, nf),
			gantt<RawMilestone[]>(ctx, "GET", `/projects/${id}/milestones`, nf),
		]);
		const allTasks = (Array.isArray(tasks) ? tasks : []).map((t) => taskOut(ctx, t));
		const isDone = (t: { status: string; progress: number }) => t.status === "done" || t.progress >= 100;
		const done = allTasks.filter(isDone).length;
		const shown = (args.include_done ? allTasks : allTasks.filter((t) => !isDone(t))).sort((a, b) => (a.start ?? "").localeCompare(b.start ?? "") || a.task_id - b.task_id);
		const phaseList = (Array.isArray(phases) ? phases : []).map((s) => ({ phase_id: s.id, parent_id: s.parent_id ?? null, title: title(s.title), status: statusOf(s.status) }));
		const msList = (Array.isArray(milestones) ? milestones : []).map(milestoneOut);
		// Phases and milestones aren't paged: at most 200 each, and together no more than half the
		// result, so the tasks always have room and structuredContent never outgrows the text (10.4).
		const project = projectOut(ctx, p);
		const half = Math.floor(ctx.budget.chars / 2);
		const ph = fitWithin(phaseList, 200, half, (items) => ({ project, phases: items }));
		const ms = fitWithin(msList, 200, half, (items) => ({ project, phases: ph.items, milestones: items }));
		const fixed = { project, phases: ph.items, milestones: ms.items };
		const page = await pageOf(ctx, shown, args.limit, (items) => ({ ...fixed, tasks: items }));
		const counts = { tasks: allTasks.length, done, phases: phaseList.length, milestones: msList.length };
		const data = { ...fixed, tasks: page.items, counts, next_cursor: page.next_cursor, has_more: page.has_more };
		const warnings: string[] = [];
		if (ph.cut || ms.cut) {
			warnings.push(`Only ${ph.items.length} of ${plural(phaseList.length, "phase")} and ${ms.items.length} of ${plural(msList.length, "milestone")} fit in one answer; NoGantt shows them all (project web_url).`);
		}
		const manyLinks = page.items.filter((t) => t.depends_on_total !== undefined).length;
		if (manyLinks) {
			warnings.push(`${plural(manyLinks, "task")} ${manyLinks === 1 ? "has" : "have"} more than ${TASK_LINKS_SHOWN} links; only the first ${TASK_LINKS_SHOWN} of each are listed, and depends_on_total has the count.`);
		}
		return {
			data,
			summary: `Project ${id}: ${plural(allTasks.length, "task")} (${done} done), ${plural(counts.milestones, "milestone")}; showing ${page.items.length} tasks.`,
			...(warnings.length ? { warnings } : {}),
		};
	},
});

// --- gantt_create_project --------------------------------------------------------------------

export const createProject = defineTool({
	name: "gantt_create_project",
	title: "Create a project",
	description:
		"Creates a new NoGantt project, private to the person until shared (gantt_share_project), with an optional planning period. gantt_add_task adds tasks; gantt_import_plan builds a whole plan. Projects can't be deleted through this connector.",
	input: z
		.object({
			title: titleArg("Project name, 1 to 255 characters."),
			description: notesArg().optional(),
			color: colorArg().optional(),
			plan_start: dateArg("Planning period start, YYYY-MM-DD.").optional(),
			plan_end: dateArg("Planning period end, YYYY-MM-DD.").optional(),
			allow_duplicate: allowDuplicateArg(),
		})
		.strict(),
	async run(ctx, args) {
		checkColor(args.color);
		checkDate(args.plan_start, "plan_start");
		checkDate(args.plan_end, "plan_end");
		checkOrder(args.plan_start, args.plan_end, "plan_end");
		const body: Record<string, unknown> = { title: args.title, color: args.color ?? COBALT };
		if (args.description !== undefined) body.description = args.description;
		if (args.plan_start !== undefined) body.plan_start = args.plan_start;
		if (args.plan_end !== undefined) body.plan_end = args.plan_end;
		const p = await gantt<RawProject>(ctx, "POST", "/projects", { body });
		return {
			data: { project: projectOut(ctx, p) },
			summary: `Created NoGantt project ${p.id}.`,
			undo: null,
			warnings: ["Projects can't be deleted through this connector; the owner can delete it in NoGantt."],
		};
	},
});

// --- gantt_update_project --------------------------------------------------------------------

const updateProjectInput = z
	.object({
		project_id: projectIdArg(),
		title: titleArg().optional(),
		description: notesArg().nullable().describe("New description; null clears it.").optional(),
		color: colorArg().optional(),
		plan_start: z.string().max(10).nullable().describe("Planning period start; null clears the period.").optional(),
		plan_end: z.string().max(10).nullable().describe("Planning period end; null clears the period.").optional(),
		board_id: z.number().int().min(1).max(2_147_483_647).nullable().describe("NoBoard board to link (boards_list); null unlinks.").optional(),
		board_sync: z.enum(["off", "read", "write_with_confirmation", "write"]).describe("With write levels, card dates follow the plan.").optional(),
	})
	.strict();

export const updateProject = defineTool({
	name: "gantt_update_project",
	title: "Change a project",
	description:
		"Changes a NoGantt project; only the fields given change: title, description (null clears it), colour, planning period (null clears it), the linked NoBoard board (board_id, null unlinks) and board_sync. Linking another board without board_sync sets read; the board already linked keeps its level. A planning-period change returns an op_id for gantt_undo_change. Needs the editor role.",
	input: updateProjectInput,
	async run(ctx, args) {
		const id = args.project_id;
		const keys = ["title", "description", "color", "plan_start", "plan_end", "board_id", "board_sync"] as const;
		const changed = keys.filter((k) => args[k] !== undefined);
		if (changed.length === 0) throw new ToolError("invalid_input", "Nothing to change: give at least one field.");
		checkColor(args.color);
		checkDate(args.plan_start ?? null, "plan_start");
		checkDate(args.plan_end ?? null, "plan_end");
		const old = await getProject(ctx, id);
		if (roleOf(old.permission) === "viewer") throw new ToolError("permission_denied", "This person can only view this project, so they can't change it.");
		// NoGantt sets the level to off whenever no board is linked (ProjectService::applyDeckSyncLevel),
		// so a level for a project that ends up without a board would change nothing (DESIGN 25.9).
		const boardAfter = args.board_id !== undefined ? args.board_id : Number(old.deck_board_id ?? 0) || null;
		if (args.board_sync !== undefined && args.board_sync !== "off" && boardAfter === null) {
			throw args.board_id === null
				? new ToolError("invalid_input", "board_sync needs a linked board, and board_id null unlinks it.", { field: "board_sync" })
				: new ToolError("not_available", `NoGantt project ${id} isn't linked to a NoBoard board, so board_sync can't be set; give board_id too.`, {
						hint: "boards_list lists the person's boards.",
						field: "board_sync",
					});
		}
		const url = projectUrl(ctx, id);
		// The old values go into the undo; a text the undo couldn't write back (too long, or shown
		// changed) isn't changed here (DESIGN 25.6 #3 and 25.7).
		const oldTitle = restorable(old.title, 255, { trimmed: true });
		const oldDescription = restorable(old.description, 10_000);
		if (args.title !== undefined && oldTitle.why) throw notUndoable("project", "title", oldTitle.why, 255, url);
		if (args.description !== undefined && oldDescription.why) throw notUndoable("project", "description", oldDescription.why, 10_000, url);
		const before = projectOut(ctx, old);
		const undoArgs: Record<string, unknown> = { project_id: id };
		for (const k of changed) {
			if (k === "title") undoArgs.title = oldTitle.value;
			if (k === "description") undoArgs.description = oldDescription.value;
			if (k === "color") undoArgs.color = before.color ?? COBALT;
			if (k === "plan_start" || k === "plan_end") {
				undoArgs.plan_start = before.plan_start;
				undoArgs.plan_end = before.plan_end;
			}
			if (k === "board_id" || k === "board_sync") {
				undoArgs.board_id = before.board?.board_id ?? null;
				if (before.board) undoArgs.board_sync = before.board.sync;
			}
		}
		// The old values come back in the undo: they get what the project itself and the warnings
		// leave, so the answer always fits (quotes and control characters count several times in JSON).
		if (jsonChars(undoArgs) > ctx.budget.chars - PROJECT_OUT_ROOM - 2_000) {
			const biggest = Object.keys(undoArgs).reduce((a, b) => (jsonChars(undoArgs[b]) > jsonChars(undoArgs[a]) ? b : a));
			throw notUndoable("project", biggest, "big", 0, url);
		}
		const newStart = args.plan_start !== undefined ? args.plan_start : day(old.plan_start);
		const newEnd = args.plan_end !== undefined ? args.plan_end : day(old.plan_end);
		if (args.plan_start !== null && args.plan_end !== null) checkOrder(newStart, newEnd, "plan_end");
		if (typeof args.board_id === "number") await checkBoard(ctx, args.board_id);

		const body: Record<string, unknown> = {};
		if (args.title !== undefined) body.title = args.title;
		if (args.description !== undefined) body.description = args.description ?? "";
		if (args.color !== undefined) body.color = args.color;
		if (args.plan_start !== undefined) body.plan_start = args.plan_start;
		if (args.plan_end !== undefined) body.plan_end = args.plan_end;
		if (args.board_id !== undefined) body.deck_board_id = args.board_id;
		// Linking a board without board_sync sets read, so NoGantt doesn't write into that board's cards
		// until asked; NoGantt itself would keep the level the old board had. Giving the board that is
		// already linked keeps its level (DESIGN 25.3 and 25.8). Unlinked, NoGantt's level is off.
		let sync: BoardSync | undefined = args.board_sync;
		if (sync === undefined && typeof args.board_id === "number" && args.board_id !== Number(old.deck_board_id ?? 0)) sync = "read";
		if (sync !== undefined) body.deck_sync_level = levelOf(sync);

		const p = await gantt<RawProject>(ctx, "PUT", `/projects/${id}`, {
			body,
			notFound: `There's no project ${id} that this person can see.`,
			forbidden: "This person isn't allowed to change this project (they need the editor role).",
			projectId: id,
		});
		const after = projectOut(ctx, p);
		// NoGantt logs a planning-period change as one operation (ProjectService::updateProject).
		const opId = typeof p.op_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.op_id) ? p.op_id : null;
		const onlyPlan = changed.every((k) => k === "plan_start" || k === "plan_end");
		const warnings: string[] = [];
		let undo: { tool: string; arguments: Record<string, unknown> } | null;
		if (opId && onlyPlan) {
			undo = { tool: "gantt_undo_change", arguments: { op_id: opId } };
		} else {
			const checked = checkedUndo(updateProjectInput, undoArgs, ["project_id"]);
			undo = checked.args ? { tool: "gantt_update_project", arguments: checked.args } : null;
			if (checked.dropped.length) warnings.push(`The old ${checked.dropped.join(" and ")} couldn't be read back, so the undo leaves ${checked.dropped.length === 1 ? "it" : "them"} out.`);
		}
		const writes = after.board && (after.board.sync === "write" || after.board.sync === "write_with_confirmation");
		if (writes) warnings.push("NoGantt now writes plan dates into the linked NoBoard cards when tasks move.");
		// Its title and planning period are what the project's calendar link shows (DESIGN 29.3).
		if (changed.some((k) => k === "title" || k === "plan_start" || k === "plan_end")) warnings.push(FEED_WARNING);
		return {
			data: { project: after, changed: [...changed], op_id: opId },
			summary: `Changed ${changed.join(", ")} of NoGantt project ${id}.`,
			undo,
			...(warnings.length ? { warnings } : {}),
		};
	},
});

/** The board must be one the person can see in NoBoard (NoGantt itself doesn't check). */
async function checkBoard(ctx: ToolCtx, boardId: number): Promise<void> {
	const missing = () => new ToolError("not_found", `There's no NoBoard board ${boardId} that this person can see.`, { hint: "boards_list lists the person's boards.", field: "board_id" });
	try {
		const b = await ctx.nc.deck.rest<{ id?: number }>("GET", `/boards/${boardId}`);
		if (!b || b.id !== boardId) throw missing();
	} catch (e) {
		if (e instanceof ToolError && (e.code === "not_found" || e.code === "permission_denied" || e.code === "invalid_input")) throw missing();
		throw e;
	}
}

// --- gantt_import_plan -----------------------------------------------------------------------

const MAX_ITEMS = 500;
const MAX_DEPTH = 5;
const KEY = /^[A-Za-z0-9_.-]{1,64}$/;

const ImportItem = z
	.object({
		key: z.string().max(64).describe("Unique key (letters, digits, . _ -)."),
		kind: z.enum(["task", "phase"]).describe("A phase groups tasks and phases."),
		title: titleArg(),
		parent_key: z.string().max(64).optional().describe("Key of its phase; none for the top level."),
		start_date: dateArg("Task start, YYYY-MM-DD.").optional(),
		end_date: dateArg("Task end, YYYY-MM-DD.").optional(),
		duration_days: z.number().int().min(1).max(250).optional().describe("Task length in working days."),
		done: z.boolean().optional().describe("Task is done."),
		notes: z.string().max(2000).optional().describe("Up to 2,000 characters."),
	})
	.strict();
type ImportItem = z.infer<typeof ImportItem>;

interface TreeNode {
	key: string;
	type: "task" | "subproject";
	title: string;
	description?: string;
	done?: boolean;
	start_date?: string;
	end_date?: string;
	duration?: number;
	children?: TreeNode[];
}

/** Builds NoGantt's tree from the flat list, refusing bad keys, unknown parents, tasks as parents, loops and depth over 5. */
export function buildTree(items: readonly ImportItem[]): TreeNode[] {
	const byKey = new Map<string, ImportItem>();
	for (const [i, it] of items.entries()) {
		if (!KEY.test(it.key)) throw new ToolError("invalid_input", `items[${i}].key may hold only letters, digits, ".", "_" and "-".`, { field: "items" });
		if (byKey.has(it.key)) throw new ToolError("invalid_input", `items[${i}]: the key "${it.key}" is used twice.`, { field: "items" });
		byKey.set(it.key, it);
		if (it.kind === "phase" && (it.start_date || it.end_date || it.duration_days || it.done !== undefined)) {
			throw new ToolError("invalid_input", `items[${i}]: phases take their dates from their tasks; give dates to the tasks.`, { field: "items" });
		}
		checkDate(it.start_date, `items[${i}].start_date`);
		checkDate(it.end_date, `items[${i}].end_date`);
		checkOrder(it.start_date, it.end_date, `items[${i}].end_date`);
	}
	const children = new Map<string | null, ImportItem[]>();
	for (const [i, it] of items.entries()) {
		const parent = it.parent_key ?? null;
		if (parent !== null) {
			const p = byKey.get(parent);
			if (!p) throw new ToolError("invalid_input", `items[${i}]: parent_key "${parent.slice(0, 64)}" isn't one of the keys.`, { field: "items" });
			if (p.kind !== "phase") throw new ToolError("invalid_input", `items[${i}]: its parent "${parent}" is a task; only phases hold items.`, { field: "items" });
		}
		const list = children.get(parent) ?? [];
		list.push(it);
		children.set(parent, list);
	}
	let placed = 0;
	// Top-level items are at depth 0; items may sit at most MAX_DEPTH levels below the top.
	const build = (parent: string | null, depth: number): TreeNode[] => {
		const list = children.get(parent) ?? [];
		if (list.length && depth > MAX_DEPTH) throw new ToolError("invalid_input", `Phases nest ${MAX_DEPTH} deep at most.`, { field: "items" });
		return list.map((it) => {
			placed++;
			const node: TreeNode = { key: it.key, type: it.kind === "phase" ? "subproject" : "task", title: it.title };
			if (it.notes) node.description = it.notes;
			if (it.kind === "task") {
				if (it.done !== undefined) node.done = it.done;
				if (it.start_date) node.start_date = it.start_date;
				if (it.end_date) node.end_date = it.end_date;
				if (it.duration_days) node.duration = it.duration_days;
			} else {
				node.children = build(it.key, depth + 1);
			}
			return node;
		});
	};
	const tree = build(null, 0);
	// Items in a parent_key loop are never reached from the top level.
	if (placed !== items.length) throw new ToolError("invalid_input", "Some items can't be reached from the top level: their parent_key values make a loop.", { field: "items" });
	return tree;
}

/**
 * Gives each task in `waiting` that has no date of its own the plan's start date as its own, and
 * returns how many it changed (DESIGN 25.10).
 *
 * NoGantt hangs every task without a date of its own on the "Project start" milestone, start to start
 * (StructureImportService::import), and its link route refuses a finish-to-start link to such a task
 * when it lasts one working day: CriticalPathService counts a one-day task that starts with a fixed
 * milestone as due on the milestone's own day, so waiting for any task leaves it below zero slack
 * (negative_float). With the tool's defaults (one day, start milestone on) every link failed. A task
 * with a date of its own is never hung on the milestone, starts on the same day (both go to the next
 * working day), and the link route then moves it after the task it waits for (TaskService::linkMany,
 * which only ever moves a task later). Tasks that wait for nothing still hang on the milestone, and
 * the tasks waiting for them follow it through their links.
 */
export function startWaitingTasks(tree: TreeNode[], waiting: ReadonlySet<string>, start: string): number {
	let changed = 0;
	const walk = (nodes: readonly TreeNode[]) => {
		for (const node of nodes) {
			if (node.type === "subproject") walk(node.children ?? []);
			else if (waiting.has(node.key) && !node.start_date && !node.end_date) {
				node.start_date = start;
				changed++;
			}
		}
	};
	walk(tree);
	return changed;
}

/** Links per call to NoGantt's link route (it takes 500; smaller calls stay well inside one call's 20 seconds). */
export const LINK_CHUNK = 100;
/** No link call starts after this long, so the answer comes back within the tool's 60 seconds. */
export const LINK_TIME_BUDGET_MS = 30_000;

interface KeyLink {
	from: string;
	to: string;
}

/**
 * The links without repeats, in an order NoGantt schedules in one pass: every waiting task comes
 * after the tasks it waits for (Kahn's algorithm), so each task moves once and the route doesn't
 * push a chain along again for every link. Refuses a loop before anything is written.
 */
export function linkOrder(links: readonly KeyLink[]): KeyLink[] {
	const seen = new Set<string>();
	const unique = links.filter((l) => {
		const k = `${l.from}>${l.to}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	const next = new Map<string, string[]>();
	const waits = new Map<string, number>();
	for (const l of unique) {
		const list = next.get(l.from) ?? [];
		list.push(l.to);
		next.set(l.from, list);
		waits.set(l.to, (waits.get(l.to) ?? 0) + 1);
		if (!waits.has(l.from)) waits.set(l.from, 0);
	}
	const queue = [...waits].filter(([, n]) => n === 0).map(([k]) => k);
	const rank = new Map<string, number>();
	for (let i = 0; i < queue.length; i++) {
		const k = queue[i] as string;
		rank.set(k, i);
		for (const to of next.get(k) ?? []) {
			const n = (waits.get(to) ?? 0) - 1;
			waits.set(to, n);
			if (n === 0) queue.push(to);
		}
	}
	if (rank.size !== waits.size) {
		throw new ToolError("invalid_input", "The links make a loop: a task would end up waiting for itself.", { field: "links" });
	}
	return unique
		.map((l, i) => ({ l, i, r: rank.get(l.to) ?? 0 }))
		.sort((a, b) => a.r - b.r || a.i - b.i)
		.map((x) => x.l);
}

/**
 * NoGantt's task ids by key, for the task keys that were sent. NoGantt builds them as a PHP array
 * keyed by item key, and PHP sends one whose keys are exactly "0", "1", ... in order as a JSON list;
 * then index i is key "i" (DESIGN 25.9).
 */
export function importedIds(raw: unknown, kinds: ReadonlyMap<string, "task" | "phase">): Map<string, number> {
	const entries: [string, unknown][] = Array.isArray(raw) ? raw.map((v, i) => [String(i), v]) : raw && typeof raw === "object" ? Object.entries(raw) : [];
	return new Map(entries.filter((e): e is [string, number] => typeof e[1] === "number" && Number.isInteger(e[1]) && e[1] > 0 && kinds.get(e[0]) === "task"));
}

/**
 * Makes the plan's links through NoGantt's link route, which moves each waiting task after the task
 * it waits for (TaskService::linkMany). The import route only stores links and moves nothing
 * (StructureImportService::insertDependencies), so a plan imported with them would break its own
 * links (DESIGN 25.9). The tasks exist by now, so a link step that fails is a warning, not an error:
 * the answer still gives the project and its task ids.
 */
async function addImportLinks(
	ctx: ToolCtx,
	projectId: number,
	ordered: readonly KeyLink[],
	ids: ReadonlyMap<string, number>,
	started: number,
): Promise<{ added: number; notAdded: number; warning: string | null }> {
	let added = 0;
	for (let i = 0; i < ordered.length; i += LINK_CHUNK) {
		const left = ordered.length - i;
		if (Date.now() - started > LINK_TIME_BUDGET_MS) {
			return { added, notAdded: left, warning: `NoGantt is slow right now, so ${plural(left, "link")} ${left === 1 ? "wasn't" : "weren't"} added; gantt_link_tasks adds them by task id (task_ids).` };
		}
		const links = ordered.slice(i, i + LINK_CHUNK).map((l) => ({ task_id: ids.get(l.to), predecessor_id: `t-${ids.get(l.from)}`, dependency_type: "EA", lag_days: 0 }));
		try {
			const r = await gantt<{ added?: number }>(ctx, "POST", `/projects/${projectId}/dependencies`, { body: { links, deck_confirmed: false }, projectId });
			added += Math.max(0, Number(r?.added ?? 0) || 0);
		} catch (e) {
			const unsure = !(e instanceof ToolError) || e.code === "timeout" || e.code === "upstream_unavailable";
			// A refusal comes with the remedy that fits it (mapGanttError's hint), not gantt_link_tasks:
			// that goes through the same route and would be refused the same way (DESIGN 25.10).
			const warning = unsure
				? `The tasks and phases were imported, but NoGantt didn't confirm ${plural(left, "link")}; gantt_get_project shows which are there, and gantt_link_tasks adds the rest (it skips links that exist).`
				: `The tasks and phases were imported, but ${plural(left, "link")} couldn't be added: ${e.message} ${e.hint ?? "gantt_get_project shows the plan as it is."}`;
			return { added, notAdded: left, warning };
		}
	}
	return { added, notAdded: 0, warning: null };
}

export const importPlan = defineTool({
	name: "gantt_import_plan",
	title: "Import a plan",
	description:
		"Builds a NoGantt plan in one step, in a new or existing project: up to 500 tasks and phases as a flat list (parent_key nests phases, 5 deep) plus finish-to-start links by key, which move each waiting task to start after the task it waits for. Undated tasks start at start_date and last default_duration_days working days. Tasks and phases are all or nothing; returns task ids by key.",
	input: z
		.object({
			new_project_title: titleArg("Name of a new project to make.").optional(),
			project_id: idArg("Or an existing project.").optional(),
			phase_id: idArg("With project_id: import inside this phase.").optional(),
			start_date: dateArg("Start of undated tasks, YYYY-MM-DD."),
			default_duration_days: z.number().int().min(1).max(250).default(1).describe("Working days for undated tasks."),
			add_start_milestone: z.boolean().default(true).describe("Hang undated tasks that wait for no other task on a \"Project start\" milestone."),
			items: z.array(ImportItem).min(1).max(MAX_ITEMS).describe("Tasks and phases, in order."),
			links: z
				.array(z.object({ from: z.string().max(64).describe("Task key that comes first."), to: z.string().max(64).describe("Task key that starts after it ends.") }).strict())
				.max(MAX_ITEMS)
				.optional()
				.describe("Finish-to-start links by key."),
			allow_duplicate: allowDuplicateArg(),
		})
		.strict(),
	async run(ctx, args) {
		const intoNew = args.new_project_title !== undefined;
		if (intoNew === (args.project_id !== undefined)) throw new ToolError("invalid_input", "Give either new_project_title or project_id, not both and not neither.");
		if (args.phase_id !== undefined && args.project_id === undefined) throw new ToolError("invalid_input", "phase_id needs project_id.", { field: "phase_id" });
		checkDate(args.start_date, "start_date");
		const tree = buildTree(args.items);
		const kinds = new Map(args.items.map((i) => [i.key, i.kind]));
		for (const [i, l] of (args.links ?? []).entries()) {
			if (kinds.get(l.from) !== "task" || kinds.get(l.to) !== "task") throw new ToolError("invalid_input", `links[${i}] must join two task keys from items.`, { field: "links" });
			if (l.from === l.to) throw new ToolError("invalid_input", `links[${i}]: a task can't wait for itself.`, { field: "links" });
		}
		const ordered = linkOrder(args.links ?? []);
		// Undated tasks that wait for another task get the plan's start as their own date, so NoGantt
		// doesn't hang them on the start milestone, which would make it refuse their links (DESIGN 25.10).
		if (args.add_start_milestone) startWaitingTasks(tree, new Set(ordered.map((l) => l.to)), args.start_date);
		// A big import is more work than one write: one write per 50 items, and one more per 100 links
		// beyond the first 100 (each further call to the link route).
		const extra = Math.ceil(args.items.length / 50) - 1 + Math.max(0, Math.ceil(ordered.length / LINK_CHUNK) - 1);
		if (extra > 0) await ctx.charge("write", extra);
		const started = Date.now();
		const target: Record<string, unknown> = intoNew ? { title: args.new_project_title } : { project_id: args.project_id };
		if (args.phase_id !== undefined) target.subproject_id = args.phase_id;
		const r = await gantt<{ project_id: number; subprojects?: number; tasks?: number; milestones?: number; dependencies?: number; task_ids?: unknown }>(ctx, "POST", "/structure-import", {
			body: {
				target,
				items: tree,
				options: { start_date: args.start_date, duration: args.default_duration_days, start_milestone: args.add_start_milestone },
				// The links go through the link route afterwards, which schedules them (addImportLinks).
				dependencies: [],
			},
			notFound: `There's no project ${args.project_id ?? ""} that this person can see.`,
			forbidden: "This person isn't allowed to change that project (they need the editor role).",
			...(args.project_id !== undefined ? { projectId: args.project_id } : {}),
		});
		const warnings: string[] = [];
		if (intoNew) {
			// NoGantt's import gives a new project the upstream blue; make it Nourax cobalt.
			try {
				await gantt(ctx, "PUT", `/projects/${r.project_id}`, { body: { color: COBALT } });
			} catch {
				warnings.push("The new project kept NoGantt's default colour; gantt_update_project can change it.");
			}
			warnings.push("Projects can't be deleted through this connector; the owner can delete it in NoGantt.");
		}
		// Only keys that were sent (NoGantt's taskKeys), so the answer stays within the 500 items.
		const ids = importedIds(r.task_ids, kinds);
		const known = ordered.filter((l) => ids.has(l.from) && ids.has(l.to));
		const linked = known.length ? await addImportLinks(ctx, r.project_id, known, ids, started) : { added: 0, notAdded: 0, warning: null };
		const unknown = ordered.length - known.length;
		if (unknown) {
			warnings.push(`NoGantt didn't give back the ids of some linked tasks, so ${plural(unknown, "link")} ${unknown === 1 ? "wasn't" : "weren't"} added; gantt_get_project shows the tasks.`);
		}
		if (linked.warning) warnings.push(linked.warning);
		// A new project has no calendar link yet (NoGantt makes one only when its feed dialog is opened).
		if (!intoNew) warnings.push(FEED_WARNING);
		const data = {
			project_id: r.project_id,
			created_project: intoNew,
			phases: r.subprojects ?? 0,
			tasks: r.tasks ?? 0,
			milestones: r.milestones ?? 0,
			links: linked.added,
			links_not_added: linked.notAdded + unknown,
			// The import itself only makes these links now: one to the start milestone per undated task
			// that waits for no other task (startWaitingTasks).
			start_milestone_links: Math.max(0, Number(r.dependencies ?? 0) || 0),
			task_ids: Object.fromEntries(ids),
			web_url: projectUrl(ctx, r.project_id),
		};
		const withLinks = data.links ? `, with ${plural(data.links, "link")} (tasks that wait now start after the tasks they wait for)` : "";
		return {
			data,
			summary: `Imported ${plural(data.tasks, "task")} and ${plural(data.phases, "phase")} into ${intoNew ? "new " : ""}NoGantt project ${r.project_id}${withLinks}.`,
			undo: null,
			...(warnings.length ? { warnings } : {}),
		};
	},
});

export const projectTools = [listProjects, getProjectTool, createProject, updateProject, importPlan];
