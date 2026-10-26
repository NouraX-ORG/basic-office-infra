/**
 * NoGantt (nc_gantt 2.4.1) for lane G (DESIGN section 25): the API base, one call helper with our
 * own plain-English errors, and the mapping from NoGantt's answers to what the tools show.
 *
 * Facts from the installed source and live checks (25.1): every route is OCS
 * (/ocs/v2.php/apps/nc_gantt/api/v1/...), needs OCS-APIRequest (412 without it, which the core
 * client always sends), answers in the OCS envelope, and reports errors as an OCS error with the
 * real HTTP status and a short code in ocs.meta.message. Those codes and every server text stay
 * here: tools show only our sentences.
 */
import type { ZodType } from "zod";
import { type ErrorCode, ToolError } from "../../core/errors";
import type { ToolCtx } from "../../core/tool";

export const GANTT = "/ocs/v2.php/apps/nc_gantt/api/v1";

/** NoGantt's own colour for projects without one is the upstream brand blue (brief rule 6). */
export const COBALT = "#2563EB";
const UPSTREAM_BLUES = new Set(["#0082c9", "#00679e"]);

type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface CallOptions {
	body?: Record<string, unknown>;
	query?: Record<string, string>;
	/** Our sentence when NoGantt answers 404 not_found (and 403 on reads: the same, so existence isn't shown). */
	notFound?: string;
	/** Our sentence for 403 on writes. */
	forbidden?: string;
	/**
	 * For a write that names a project: NoGantt answers 403 both to a viewer and to someone who
	 * can't see the project at all (404 only when it doesn't exist). On a plain 403 the project is
	 * read once more; when that fails too, the answer is the same not_found as a read (DESIGN 25.1),
	 * so project ids, which count up, don't show which projects exist.
	 */
	projectId?: number;
}

type Mapped = [ErrorCode, string, string?];

/**
 * The one answer for an undo id NoGantt doesn't know (404 operation_not_found) and for one on a
 * project the person may not change or can't see at all (a plain 403: revertOperation checks
 * canEditOrOwn). The revert route names no project, so the two can't be told apart, and DESIGN 25.1
 * gives "missing" and "can't see" the same answer (DESIGN 25.8).
 */
export const UNDO_NOT_FOUND = "There's no change with that undo id that this person may take back (taking one back needs the editor role on its project).";
export const UNDO_HINT = "Undo ids come from gantt_update_task, gantt_link_tasks and gantt_update_project.";

/**
 * NoGantt's calendar links (DESIGN 29.3, read in nc_gantt 2.4.1): /projects/{id}/calendar.ics and
 * /my/calendar.ics are public pages with a token in the address. A project's feed carries its title
 * and dates, its milestones (title and date) and, when the setting is on, its phases (title and
 * dates, worked out from their tasks); a person's own feed carries the titles and dates of the tasks
 * they are on. The token is made the first time someone opens the feed dialog and never shows in the
 * project's JSON, so the Worker can't tell whether a project has one: every write that changes what a
 * feed shows says so. Changing a plan is workspace.write, not workspace.share, so this is a warning,
 * not a refusal (docs/mcp.md 7.7). A handoff asks NoGantt for a read-only flag; once it exists these
 * writes can be refused without workspace.share when the flag is set, as calendars published by link
 * are (DESIGN 22).
 */
export const FEED_WARNING =
	"NoGantt's calendar links work without signing in: whoever has this project's link, if it has one, can see its title, dates, milestones and phases, and a person's own NoGantt calendar link shows the titles and dates of the tasks they are on.";

/**
 * NoGantt's negative_float refusal (TaskSchedulingService::assertNoNewNegativeFloat), and the remedy
 * that works for its most common cause: a one-day waiting task hung on a fixed milestone, which only
 * replacing that task's links fixes; adding links (gantt_link_tasks) is refused the same way (DESIGN 25.10).
 * Together they stay within core's 300 characters for an error (oneLine), pinned in fix5.test.ts.
 */
export const NEGATIVE_FLOAT = "That would make a task in this plan miss a fixed milestone (its slack would drop below zero).";
export const NEGATIVE_FLOAT_HINT =
	"A one-day task that starts with a fixed milestone is due that day: gantt_update_task with depends_on on the waiting task replaces its links, the milestone link too. Or move the milestone in NoGantt.";

/** NoGantt's error codes (ocs.meta.message) on the routes lane G uses, read from its source. */
const CODES: Readonly<Record<string, Mapped>> = {
	invalid_date: ["invalid_input", "NoGantt didn't accept a date. Dates look like 2026-11-03."],
	invalid_start_date: ["invalid_input", "NoGantt didn't accept the start date. Dates look like 2026-11-03."],
	invalid_plan_date: ["invalid_input", "NoGantt didn't accept a planning-period date. Dates look like 2026-11-03."],
	plan_start_after_end: ["invalid_input", "The planning period would start after it ends."],
	dependency_cycle: ["invalid_input", "That would make a loop: a task would end up waiting for itself."],
	invalid_dependency: ["invalid_input", "A link points to a task or milestone that isn't in this project."],
	"Invalid dependency_type": ["invalid_input", "That kind of link isn't known."],
	invalid_task_id: ["invalid_input", "That task isn't in this project.", "gantt_get_project lists its tasks."],
	invalid_subproject_id: ["invalid_input", "That phase isn't in this project.", "gantt_get_project lists its phases."],
	invalid_color: ["invalid_input", "Colours look like #2563EB."],
	invalid_status: ["invalid_input", "That status isn't known."],
	invalid_title: ["invalid_input", "A title can't be empty."],
	invalid_item: ["invalid_input", "One of the items to import isn't valid."],
	invalid_item_type: ["invalid_input", "Items to import are tasks or phases."],
	too_many_items: ["too_large", "That is more than NoGantt imports in one go."],
	too_deep: ["invalid_input", "The phases are nested too deep."],
	nothing_to_import: ["invalid_input", "There is nothing to import."],
	invalid_duration: ["invalid_input", "Durations are 1 to 250 working days."],
	invalid_deck_sync_level: ["invalid_input", "That board link level isn't known."],
	roles_only_assignment: ["permission_denied", "This project only lets people be assigned through roles."],
	deck_sync_off: ["not_available", "This project isn't linked to a NoBoard board, or the link is switched off.", "gantt_update_project with board_id links one."],
	deck_write_level: [
		"not_available",
		"The project's NoBoard link only reads. Making or changing cards needs board_sync write_with_confirmation or write.",
		"gantt_update_project changes it.",
	],
	deck_no_board: ["not_available", "This project isn't linked to a NoBoard board.", "gantt_update_project with board_id links one."],
	deck_card_taken: ["already_exists", "That NoBoard card is already linked to another task."],
	invalid_deck_card: ["not_found", "There's no NoBoard card with that id that this person can see."],
	invalid_date_action: ["invalid_input", "That choice for the card's dates isn't known."],
	deck_unavailable: ["not_available", "NoBoard isn't available right now."],
	deck_error: ["upstream_unavailable", "NoBoard didn't do that. Try again in a minute."],
	principal_not_found: ["permission_denied", "NoGantt can't share with that person, group or team."],
	group_sharing_disabled: ["not_available", "Sharing with groups is switched off in Nourax Workspace."],
	invalid_permission: ["invalid_input", "That role isn't known."],
	invalid_principal_type: ["invalid_input", "That kind of share isn't known."],
	operation_not_found: ["not_found", UNDO_NOT_FOUND, UNDO_HINT],
	// Both come only from ChangeEventService::revertOperation. A second undo of one change gets one of
	// them too: its dates are the old ones by then (conflict), or a link it added is gone (entity_missing).
	conflict: ["conflict", "Something in that change was changed again since, or the change was taken back already, so it can't be taken back automatically."],
	entity_missing: ["conflict", "Something in that change (a task, a link or a phase) no longer exists, or the change was taken back already, so it can't be taken back."],
	internal_error: ["upstream_unavailable", "NoGantt had a problem with that. Try again in a minute."],
};

/**
 * A lookup in one of our own tables by a key NoGantt sent: only the table's own keys count, never an
 * inherited one such as "constructor" or "__proto__" (DESIGN 25.9).
 */
export function own<V>(table: Readonly<Record<string, V>>, key: string): V | undefined {
	return Object.hasOwn(table, key) ? table[key] : undefined;
}

function ocsMeta(detail: string | undefined): { status: number | null; message: string | null } {
	if (!detail) return { status: null, message: null };
	try {
		const j = JSON.parse(detail) as { ocs?: { meta?: { statuscode?: unknown; message?: unknown } } };
		const m = j?.ocs?.meta;
		return {
			status: typeof m?.statuscode === "number" ? m.statuscode : null,
			message: typeof m?.message === "string" ? m.message : null,
		};
	} catch {
		return { status: null, message: null };
	}
}

/** Turns a NoGantt failure into our error. Exported for the tests. */
export function mapGanttError(e: ToolError, method: Method, opts: CallOptions): ToolError {
	if (e.code === "reconnect_required" || e.code === "rate_limited" || e.code === "timeout") return e;
	const status = e.upstreamStatus;
	const meta = ocsMeta(e.detail);
	const keep = { upstreamStatus: status };
	if (status === 404 && meta.status === 998) {
		return new ToolError("not_available", "NoGantt isn't switched on in Nourax Workspace right now.", keep);
	}
	const code = meta.message ?? "";
	if (code.startsWith("negative_float:")) {
		// CriticalPathService counts a one-day task that starts with a fixed milestone (such as an
		// imported plan's "Project start") as due on the milestone's day, so it can't wait for any task;
		// replacing its links drops that milestone link, which NoGantt accepts (DESIGN 25.10).
		return new ToolError("invalid_input", NEGATIVE_FLOAT, { ...keep, hint: NEGATIVE_FLOAT_HINT });
	}
	const known = own(CODES, code);
	if (code.startsWith("invalid_") && !known && status === 400) {
		return new ToolError("invalid_input", "NoGantt didn't accept one of the values.", keep);
	}
	if (known) return new ToolError(known[0], known[1], { ...keep, hint: known[2] });
	const notFound = opts.notFound ?? "That isn't in NoGantt, or this person can't see it.";
	if (status === 404) return new ToolError("not_found", notFound, { ...keep, hint: "gantt_list_projects lists the projects this person can see." });
	if (status === 403) {
		if (method === "GET") return new ToolError("not_found", notFound, { ...keep, hint: "gantt_list_projects lists the projects this person can see." });
		return new ToolError("permission_denied", opts.forbidden ?? "This person isn't allowed to change that in NoGantt (they may only view it).", keep);
	}
	if (status === 409) return new ToolError("conflict", "That clashes with a change made in the meantime. Read it again first.", keep);
	if (status === 400) return new ToolError("invalid_input", "NoGantt didn't accept that.", keep);
	if (status !== undefined && status >= 500) return new ToolError("upstream_unavailable", "NoGantt didn't answer. Try again in a minute.", keep);
	return new ToolError(e.code, e.code === "upstream_unavailable" ? "NoGantt didn't answer. Try again in a minute." : e.message, { ...keep, hint: e.hint });
}

/** A 403 without one of NoGantt's own codes: "not allowed", which may also mean "can't see it". */
function plain403(e: ToolError): boolean {
	return e.upstreamStatus === 403 && !own(CODES, ocsMeta(e.detail).message ?? "");
}

/** One NoGantt call as the person. The path is under GANTT and checked by the egress allowlist. */
export async function gantt<T = unknown>(ctx: ToolCtx, method: Method, path: string, opts: CallOptions = {}): Promise<T> {
	const full = `${GANTT}${path}`;
	try {
		switch (method) {
			case "GET":
				return await ctx.nc.ocs.get<T>(full, opts.query);
			case "POST":
				return await ctx.nc.ocs.post<T>(full, opts.body ?? {});
			case "PUT":
				return await ctx.nc.ocs.put<T>(full, opts.body ?? {});
			case "DELETE":
				return await ctx.nc.ocs.delete<T>(full, opts.query);
		}
	} catch (e) {
		if (!(e instanceof ToolError)) throw e;
		const mapped = mapGanttError(e, method, opts);
		if (method !== "GET" && opts.projectId !== undefined && plain403(e)) {
			const visible = await ctx.nc.ocs.get(`${GANTT}/projects/${opts.projectId}`).then(
				() => true,
				(p: unknown) => !(p instanceof ToolError && (p.upstreamStatus === 403 || p.upstreamStatus === 404)),
			);
			if (!visible) throw mapGanttError(e, "GET", opts);
		}
		throw mapped;
	}
}

/**
 * A NoGantt call whose success is "204 No Content" with an empty body (DELETE /shares/{id}, checked
 * live). The core client's nc.ocs.* always parses a JSON body, so this goes through its low-level
 * request() instead, with the same headers, allowlist and error mapping.
 */
export async function ganttNoContent(ctx: ToolCtx, method: "DELETE", path: string, opts: CallOptions = {}): Promise<void> {
	try {
		const res = await ctx.nc.request(method, `${GANTT}${path}?format=json`, { headers: { "ocs-apirequest": "true", accept: "application/json" } });
		await res.body?.cancel();
	} catch (e) {
		if (e instanceof ToolError) throw mapGanttError(e, method, opts);
		throw e;
	}
}

// --- What NoGantt sends (only the fields we read) --------------------------------------------

export interface RawProject {
	id: number;
	title: string;
	description: string | null;
	color: string | null;
	deck_board_id: number | null;
	deck_sync_level: string | null;
	owner_id: string;
	owner_display_name: string | null;
	permission: string | null;
	plan_start: string | null;
	plan_end: string | null;
	updated_at: string | null;
	op_id?: string;
}

export interface RawDep {
	id?: number;
	task_id?: number;
	predecessor_id: string;
	dependency_type: string;
	lag_days: number;
}

export interface RawTask {
	id: number;
	project_id: number;
	subproject_id: number | null;
	title: string;
	description: string | null;
	start_date: string;
	end_date: string;
	status: string | null;
	manual_progress: number | null;
	dependencies?: RawDep[];
	resources?: unknown[];
	resource_id?: number | null;
	deck_card_id?: number | null;
	updated_at?: string | null;
}

export interface RawMilestone {
	id: number;
	project_id: number;
	subproject_id: number | null;
	task_id: number | null;
	title: string;
	milestone_date: string;
	dependency_type: string | null;
}

export interface RawPhase {
	id: number;
	parent_id: number | null;
	title: string;
	status: string | null;
}

/**
 * What NoGantt did with linked NoBoard cards after a date change (DeckDateSyncService::sync):
 * `updated` were written; `failed` couldn't be; `pending` couldn't be because the person can't edit
 * the card (NoGantt tries again later); `deviations` kept their own dates because they were changed
 * in NoBoard since NoGantt last wrote them (STATUS_CONFLICT); `gone` no longer exist in NoBoard;
 * `unconfirmed` counts cards not written because the project asks first.
 */
export interface RawDeckSummary {
	updated?: unknown[];
	failed?: unknown[];
	pending?: unknown[];
	deviations?: unknown[];
	gone?: unknown[];
	unconfirmed?: number;
}

// --- Mapping --------------------------------------------------------------------------------

/** NoGantt's own name in texts it returns becomes NoGantt (brief rule 6, lane G facts). */
export function brandText(s: string): string {
	return s.replace(/\bnc[ _-]?gantt\b/gi, "NoGantt");
}

export function text(s: string | null | undefined, max: number): string | null {
	if (s === null || s === undefined || s === "") return null;
	const t = brandText(String(s));
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function title(s: string | null | undefined): string {
	return text(s, 255) ?? "";
}

/** Shows the upstream blue as Nourax cobalt, as NoGantt's own theme does. */
export function colour(c: string | null | undefined): string | null {
	if (!c) return null;
	return UPSTREAM_BLUES.has(c.toLowerCase()) ? COBALT : c;
}

/** "2026-11-02 00:00:00" or "2026-11-02" to "2026-11-02". */
export function day(s: string | null | undefined): string | null {
	if (!s) return null;
	const d = String(s).slice(0, 10);
	return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

export type Role = "viewer" | "editor" | "project_admin";

export function roleOf(p: string | null | undefined): Role {
	if (p === "admin") return "project_admin";
	if (p === "editor") return "editor";
	return "viewer";
}

export function permissionOf(r: Role): "viewer" | "editor" | "admin" {
	return r === "project_admin" ? "admin" : r;
}

export type BoardSync = "off" | "read" | "write_with_confirmation" | "write";
const SYNC_TO: Record<BoardSync, string> = { off: "off", read: "read", write_with_confirmation: "write_confirm", write: "write_silent" };

export function syncOf(level: string | null | undefined): BoardSync {
	if (level === "read") return "read";
	if (level === "write_confirm") return "write_with_confirmation";
	if (level === "write_silent") return "write";
	return "off";
}

export function levelOf(s: BoardSync): string {
	return SYNC_TO[s];
}

export type LinkType = "finish_to_start" | "start_to_start" | "finish_to_finish" | "start_to_finish";
const TYPE_TO: Record<LinkType, string> = { finish_to_start: "EA", start_to_start: "AA", finish_to_finish: "EE", start_to_finish: "AE" };

export function linkTypeOf(t: string | null | undefined): LinkType {
	if (t === "AA") return "start_to_start";
	if (t === "EE") return "finish_to_finish";
	if (t === "AE") return "start_to_finish";
	return "finish_to_start";
}

export function ganttLinkType(t: LinkType): string {
	return TYPE_TO[t];
}

export type TaskStatus = "not_started" | "in_progress" | "blocked" | "done";
const STATUSES = new Set<string>(["not_started", "in_progress", "blocked", "done"]);

export function statusOf(s: string | null | undefined): TaskStatus {
	return s && STATUSES.has(s) ? (s as TaskStatus) : "not_started";
}

export function projectUrl(ctx: ToolCtx, projectId: number): string {
	return `${ctx.cfg.driveOrigin}/apps/nc_gantt/?project=${projectId}`;
}

export function taskUrl(ctx: ToolCtx, projectId: number, taskId: number): string {
	return `${ctx.cfg.driveOrigin}/apps/nc_gantt/?project=${projectId}&task=${taskId}`;
}

export function person(uid: string, name: string | null | undefined): { id: string; display_name: string | null } {
	return { id: `person:${uid}`, display_name: text(name, 200) };
}

export interface DepOut {
	after_task_id: number | null;
	after_milestone_id: number | null;
	type: LinkType;
	lag_days: number;
}

export function depOut(d: RawDep): DepOut | null {
	const m = /^([tm])-(\d{1,12})$/.exec(String(d.predecessor_id ?? ""));
	if (!m) return null;
	const id = Number(m[2]);
	return {
		after_task_id: m[1] === "t" ? id : null,
		after_milestone_id: m[1] === "m" ? id : null,
		type: linkTypeOf(d.dependency_type),
		lag_days: Number.isFinite(d.lag_days) ? Number(d.lag_days) : 0,
	};
}

export function depIn(d: { after_task_id?: number; after_milestone_id?: number; type?: LinkType; lag_days?: number }): { predecessor_id: string; dependency_type: string; lag_days: number } {
	const pred = d.after_task_id !== undefined ? `t-${d.after_task_id}` : `m-${d.after_milestone_id}`;
	return { predecessor_id: pred, dependency_type: ganttLinkType(d.type ?? "finish_to_start"), lag_days: d.lag_days ?? 0 };
}

/** A task's links as NoGantt holds them, in our form; links in a form we don't know are left out. */
export function linksOf(t: RawTask): DepOut[] {
	return (Array.isArray(t.dependencies) ? t.dependencies : []).map(depOut).filter((x): x is DepOut => x !== null);
}

/**
 * Links listed per task. NoGantt allows many (an import takes 500 links), so one task can't fill an
 * answer: beyond this, `depends_on_total` gives the count (DESIGN 25.7).
 */
export const TASK_LINKS_SHOWN = 100;

export function taskOut(ctx: ToolCtx, t: RawTask, notesMax = 300) {
	const progress = Number(t.manual_progress ?? 0);
	const links = linksOf(t);
	return {
		task_id: t.id,
		project_id: t.project_id,
		title: title(t.title),
		phase_id: t.subproject_id ?? null,
		start: day(t.start_date),
		end: day(t.end_date),
		status: statusOf(t.status),
		progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0,
		depends_on: links.slice(0, TASK_LINKS_SHOWN),
		...(links.length > TASK_LINKS_SHOWN ? { depends_on_total: links.length } : {}),
		// NoGantt's my-tasks counts both (TaskMapper::findAssignedToResources): a task's own resource_id,
		// which it sends next to `resources: []`, and its task_resources rows (DESIGN 25.10).
		assigned: (Array.isArray(t.resources) && t.resources.length > 0) || Number(t.resource_id ?? 0) > 0,
		board_card_id: t.deck_card_id ?? null,
		notes: text(t.description, notesMax),
		web_url: taskUrl(ctx, t.project_id, t.id),
	};
}
export type TaskOut = ReturnType<typeof taskOut>;

export function projectOut(ctx: ToolCtx, p: RawProject, descriptionMax = 2000) {
	return {
		project_id: p.id,
		title: title(p.title),
		description: text(p.description, descriptionMax),
		color: colour(p.color),
		owner: person(p.owner_id, p.owner_display_name),
		my_role: roleOf(p.permission),
		plan_start: day(p.plan_start),
		plan_end: day(p.plan_end),
		board: p.deck_board_id ? { board_id: p.deck_board_id, sync: syncOf(p.deck_sync_level) } : null,
		web_url: projectUrl(ctx, p.id),
	};
}
export type ProjectOut = ReturnType<typeof projectOut>;

export function milestoneOut(m: RawMilestone) {
	let follows: { kind: "task" | "phase" | "project"; id: number | null; at: "start" | "end" } | null = null;
	if (m.dependency_type) {
		const at = m.dependency_type === "AA" || m.dependency_type === "AE" ? "start" : "end";
		if (m.task_id) follows = { kind: "task", id: m.task_id, at };
		else if (m.subproject_id) follows = { kind: "phase", id: m.subproject_id, at };
		else follows = { kind: "project", id: null, at };
	}
	return {
		milestone_id: m.id,
		title: title(m.title),
		date: day(m.milestone_date),
		phase_id: m.subproject_id ?? null,
		follows,
	};
}

export interface BoardSummary {
	cards_updated: number;
	cards_failed: number;
	cards_kept_their_dates: number;
	cards_gone: number;
	waiting_for_confirmation: number;
}

/** The board side of a date change: what NoGantt did with linked NoBoard cards (every part of its summary). */
export function boardOut(d: RawDeckSummary | null | undefined): BoardSummary | null {
	if (!d || typeof d !== "object") return null;
	const n = (x: unknown) => (Array.isArray(x) ? x.length : 0);
	const out: BoardSummary = {
		cards_updated: n(d.updated),
		cards_failed: n(d.failed) + n(d.pending),
		cards_kept_their_dates: n(d.deviations),
		cards_gone: n(d.gone),
		waiting_for_confirmation: Math.max(0, Number(d.unconfirmed ?? 0) || 0),
	};
	return Object.values(out).every((v) => v === 0) ? null : out;
}

const cards = (n: number) => `${n} linked NoBoard card${n === 1 ? "" : "s"}`;

/**
 * Plain warnings for the cards NoGantt didn't give the plan's dates. `dates` is "new" after a change
 * and "old" after an undo (which also says which cards got the old dates back, because NoGantt
 * writes them without asking first). Cards waiting for confirmation are each tool's own warning.
 */
export function boardWarnings(b: BoardSummary | null, dates: "new" | "old"): string[] {
	if (!b) return [];
	const out: string[] = [];
	if (dates === "old" && b.cards_updated) out.push(`NoGantt also wrote the old dates back into ${cards(b.cards_updated)}.`);
	if (b.cards_failed) out.push(`${cards(b.cards_failed)} couldn't be given the ${dates} dates.`);
	if (b.cards_kept_their_dates) {
		const one = b.cards_kept_their_dates === 1;
		out.push(`${cards(b.cards_kept_their_dates)} kept ${one ? "its" : "their"} own dates, because ${one ? "it was" : "they were"} changed in NoBoard since NoGantt last wrote ${one ? "it" : "them"}.`);
	}
	if (b.cards_gone) out.push(`${cards(b.cards_gone)} no longer exist${b.cards_gone === 1 ? "s" : ""} in NoBoard.`);
	return out;
}

/** Tasks of a project, with a check that a given task belongs to it. */
export async function projectTasks(ctx: ToolCtx, projectId: number): Promise<RawTask[]> {
	const tasks = await gantt<RawTask[]>(ctx, "GET", `/projects/${projectId}/tasks`, { notFound: `There's no project ${projectId} that this person can see.` });
	return Array.isArray(tasks) ? tasks : [];
}

export async function findTask(ctx: ToolCtx, projectId: number, taskId: number): Promise<{ task: RawTask; all: RawTask[] }> {
	const all = await projectTasks(ctx, projectId);
	const task = all.find((t) => t.id === taskId);
	if (!task) {
		throw new ToolError("not_found", `Project ${projectId} has no task ${taskId}.`, { hint: "gantt_get_project lists its tasks.", field: "task_id" });
	}
	return { task, all };
}

export async function getProject(ctx: ToolCtx, projectId: number): Promise<RawProject> {
	return gantt<RawProject>(ctx, "GET", `/projects/${projectId}`, { notFound: `There's no project ${projectId} that this person can see.` });
}

/** Today's date in the person's time zone. */
export function today(ctx: ToolCtx): string {
	return ctx.time.format(ctx.time.now()).slice(0, 10);
}

/**
 * The largest prefix of `items` (at most `cap`) whose rendered JSON stays within `maxChars`. For the
 * parts of a result that aren't paged (phases and milestones of a plan, the critical path), so
 * structuredContent never outgrows the framed text (10.4). JSON.stringify keeps nulls, so it
 * measures a little more than the framed text does.
 */
export function fitWithin<T>(items: readonly T[], cap: number, maxChars: number, render: (items: T[]) => unknown): { items: T[]; cut: boolean } {
	const capped = items.slice(0, cap);
	const fits = (n: number) => JSON.stringify(render(capped.slice(0, n))).length <= maxChars;
	// Each item takes at least its own JSON and a comma, so no more than the items whose lengths add
	// up to maxChars can fit: the search starts there instead of rendering a long list whole.
	let hi = 0;
	for (let sum = 0; hi < capped.length; hi++) {
		sum += JSON.stringify(capped[hi] ?? null).length + 1;
		if (sum > maxChars) break;
	}
	if (hi === capped.length && fits(hi)) return { items: capped, cut: capped.length < items.length };
	let lo = 0;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (fits(mid)) lo = mid;
		else hi = mid - 1;
	}
	return { items: capped.slice(0, lo), cut: true };
}

/** The length of a value as JSON, which is how structuredContent and the framed text carry it. */
export function jsonChars(v: unknown): number {
	return JSON.stringify(v ?? null).length;
}

/**
 * Room kept in an answer for one task's own output (taskOut: a 255-character title, notes cut to
 * 300, up to 100 links), and for one project's (projectOut: a description cut to 2,000 and the
 * owner's name), each at its worst, when every character is a control character that JSON writes as
 * six (pinned in units.test.ts). The old values an update hands back get the rest of the answer
 * (DESIGN 25.7).
 */
export const TASK_OUT_ROOM = 15_000;
export const PROJECT_OUT_ROOM = 18_000;

// DEL and the C1 controls: JSON.stringify leaves them raw, and the framed text strips them (10.4).
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding them is the point
const UNSHOWABLE = /[\u007f-\u009f]/;

export type NotExact = "long" | "changed" | "spaces";

/**
 * A text NoGantt holds, as an undo would have to write it back: shown the way every other text is
 * (text()), and `exact` only when what is shown is the whole text, unchanged. It isn't exact when the
 * text is longer than the tool's own input limit (`why` "long"), or when showing it changes it:
 * NoGantt's own name in it becomes "NoGantt", and the framed text drops DEL and C1 control
 * characters (`why` "changed"). With `trimmed` (titles: the tools' title input trims), a text that
 * starts or ends with spaces isn't exact either (`why` "spaces"): NoGantt keeps them when a title is
 * typed in NoGantt itself, and the undo would drop them (DESIGN 25.9). A tool doesn't change a text it
 * couldn't put back.
 */
export function restorable(s: string | null | undefined, max: number, opts: { trimmed?: boolean } = {}): { value: string | null; exact: boolean; why: NotExact | null } {
	const raw = s === null || s === undefined ? "" : String(s);
	const value = text(raw, max);
	const why = raw.length > max ? "long" : brandText(raw) !== raw || UNSHOWABLE.test(raw) ? "changed" : opts.trimmed && raw !== raw.trim() ? "spaces" : null;
	return { value, exact: why === null, why };
}

/**
 * The refusal for a change whose undo couldn't put the old value back (DESIGN 25.6 #3 and 25.7):
 * nothing is written, and the person is sent to NoGantt itself.
 */
export function notUndoable(item: "task" | "project", field: string, why: NotExact | "big", limit: number, url: string): ToolError {
	const plural = field === "notes";
	const is = plural ? "are" : "is";
	const it = plural ? "them" : "it";
	const what = `This ${item}'s ${field}`;
	const reason =
		why === "long"
			? `${what} ${is} longer than ${String(limit).replace(/\B(?=(\d{3})+$)/g, ",")} characters`
			: why === "changed"
				? `${what} ${plural ? "hold" : "holds"} characters this connector doesn't show exactly`
				: why === "spaces"
					? `${what} ${plural ? "start or end" : "starts or ends"} with spaces, which the undo would drop`
					: `${what} would take up too much of one answer to keep a copy for the undo (quotes and control characters count several times)`;
	return new ToolError(why === "changed" || why === "spaces" ? "not_available" : "too_large", `${reason}, so changing ${it} here couldn't be undone. Nothing was changed.`, {
		hint: `Change ${it} in NoGantt itself: ${url}`,
		field,
	});
}

/**
 * Undo arguments that the undo tool's own input takes. Fields it would refuse (for example a date
 * NoGantt sent in an odd form, which reads as null) are left out and named; when nothing but the
 * ids in `keep` is left, there is no undo.
 */
export function checkedUndo(input: ZodType, args: Record<string, unknown>, keep: readonly string[]): { args: Record<string, unknown> | null; dropped: string[] } {
	const out = { ...args };
	const dropped: string[] = [];
	const none = { args: null, dropped: Object.keys(args).filter((k) => !keep.includes(k)) };
	// Each round drops at least one field, so this ends after at most one round per field.
	for (;;) {
		const r = input.safeParse(out);
		if (r.success) return { args: Object.keys(out).some((k) => !keep.includes(k)) ? out : null, dropped };
		const bad = new Set(r.error.issues.map((i) => String(i.path[0] ?? "")));
		if ([...bad].some((k) => k === "" || keep.includes(k) || !(k in out))) return none;
		for (const k of bad) {
			delete out[k];
			dropped.push(k);
		}
	}
}

/**
 * Room kept in an answer for what comes next to a list that is fitted on its own: totals and
 * counts, next_cursor (about 170 characters), has_more, a note and up to three warnings.
 */
export const ANSWER_REST = 1_000;

/**
 * Offset paging with a cursor bound to the call's arguments, shrunk so the whole answer fits.
 * It measures as structuredContent carries the answer (JSON with nulls kept, where a control
 * character takes six characters), as core's ctx.page.fit also does since section 30.7, and keeps
 * ANSWER_REST for the rest of the answer (DESIGN 25.7).
 */
export async function pageOf<T>(ctx: ToolCtx, all: readonly T[], limit: number, render: (items: T[]) => unknown): Promise<{ items: T[]; next_cursor: string | null; has_more: boolean; cut: boolean }> {
	const raw = await ctx.page.decode<number>();
	const offset = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
	const slice = all.slice(offset, offset + limit);
	const fitted = fitWithin(slice, slice.length, ctx.budget.chars - ANSWER_REST, render);
	const items = fitted.items.length === 0 && slice.length > 0 ? slice.slice(0, 1) : fitted.items;
	const next = offset + items.length;
	const has_more = next < all.length;
	return { items, has_more, next_cursor: has_more ? await ctx.page.encode(next) : null, cut: fitted.cut };
}
