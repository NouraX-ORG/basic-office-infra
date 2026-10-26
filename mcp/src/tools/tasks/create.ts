/**
 * tasks_create (DESIGN 11.6). The person's first own writable task list is used unless list_id
 * names one (a list shared with them included), then a jCal PUT with If-None-Match: *.
 *
 * Without list_id, only the person's own lists are used, never a list someone shared with them, so
 * a task never lands where a colleague reads it unless the person chose that list (review fix
 * round 1). A person with no list of their own (a new account: its "personal" calendar holds
 * events only) gets a new VTODO-only list called "Tasks" (DESIGN 11.6), made with an extended MKCOL
 * (new-list.ts) when core's egress rule allows it. Today it doesn't (workerd refuses MKCALENDAR and
 * the dav-calendars rule has no MKCOL), so the answer is a plain not_available pointing to NoTasks
 * and to list_id, and the description says so; once core adds MKCOL to the rule, the list is made
 * and the description says that instead (fix round 2).
 *
 * A list published by link serves its tasks to anyone with the link, so writing one there is
 * sharing it: refused without workspace.share, and passed over as the default list (fix round 4,
 * guardPublished in ../calendar/common.ts).
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import { allowDuplicateArg } from "../../core/shapes";
import { defineTool, type ToolCtx } from "../../core/tool";
import { cleanLine, cleanText, type JComp, setProp, utcStamp, vcalendar } from "../../pim/jcal";
import { type CalInfo, getObject, newObjectId, putObject } from "../calendar/caldav";
import { canShare, guardPublished, loadHome, pickById } from "../calendar/common";
import { canMakeLists, LISTS_MAKEABLE, makeTaskList } from "./new-list";
import { PRIORITY_VALUE, START_CHANGED_NOTE, showTask, startBeforeOrAtDue, startMatchingDue, todoOf, writeTaskTime } from "./todos";

export const MADE_LIST_NOTE = 'This person had no task list of their own, so a new list called "Tasks" was made for this task.';

/**
 * The person's first own writable task list, or null. `published` false leaves out lists published
 * by link (fix round 4: a task there is shown to anyone with the link).
 */
export function ownTaskList(cals: readonly CalInfo[], published = true): CalInfo | null {
	return cals.find((c) => c.tasks && !c.readOnly && !c.sharedBy && (published || !c.published)) ?? null;
}

/**
 * The list a task goes to without list_id: the person's first own writable task list, else a new
 * "Tasks" list where the connector may make one, else a plain refusal. Without workspace.share a
 * list published by link is passed over (writing there would share the task); with it, the first
 * own list is used as before and guardPublished warns (fix round 4).
 */
export async function defaultTaskList(ctx: ToolCtx, cals: readonly CalInfo[]): Promise<{ list: { id: string; sharedBy: string | null }; made: boolean }> {
	const share = canShare(ctx);
	const own = ownTaskList(cals, share);
	if (own) {
		guardPublished(ctx, own, "list_id", "tasks");
		return { list: own, made: false };
	}
	if (!share && ownTaskList(cals) !== null) {
		// Every list of the person's own is published by link: no second list is made beside them.
		throw new ToolError("not_available", "This person's own task lists are published by link, and this connection can't share, so no task was made.", {
			hint: "Give list_id for a list that isn't published (tasks_list shows the lists), or reconnect with sharing allowed.",
		});
	}
	if (canMakeLists(ctx)) {
		const id = await makeTaskList(ctx, new Set(cals.map((c) => c.id.toLowerCase())), true);
		return { list: { id, sharedBy: null }, made: true };
	}
	const shared = cals.some((c) => c.tasks && !c.readOnly);
	throw new ToolError("not_available", "This person has no task list of their own, and one can't be made from here.", {
		hint: shared ? "Make a list in NoTasks, or give list_id for a list shared with them (tasks_list shows the lists)." : "Make a list in NoTasks, then try again.",
	});
}

export const createTask = defineTool({
	name: "tasks_create",
	title: "Create a task",
	description: LISTS_MAKEABLE
		? "Adds a task to the person's first own NoTasks list (a list called \"Tasks\" is made when they have none), or to list_id (a shared list too). Optional due, start, notes and priority; a date means that day."
		: "Adds a task to the person's first own NoTasks list, or to list_id (a shared list too); a person with no list needs one made in NoTasks first. Optional due, start, notes and priority; a date means that day.",
	input: z
		.object({
			title: z.string().max(LIMITS.titleChars).describe("Title."),
			list_id: z.string().max(200).optional().describe("From tasks_list."),
			due: z.string().max(40).optional().describe("Date or date-time."),
			start: z.string().max(40).optional().describe("Date or date-time."),
			notes: z.string().max(LIMITS.descriptionInChars).optional().describe("Notes."),
			priority: z.enum(["high", "normal", "low"]).optional().describe("Priority."),
			allow_duplicate: allowDuplicateArg().describe("true makes a second copy."),
		})
		.strict(),
	async run(ctx, args) {
		const zone = ctx.time.zone;
		const title = cleanLine(args.title);
		if (!title) throw new ToolError("invalid_input", "title can't be empty.", { field: "title" });
		const due = args.due !== undefined ? ctx.time.parse(args.due, "due") : null;
		const asked = args.start !== undefined ? ctx.time.parse(args.start, "start") : null;
		const { start, changed: startChanged } = startMatchingDue(asked, due, zone);
		if (!startBeforeOrAtDue(start, due, zone)) throw new ToolError("invalid_input", "start must not be after due.", { field: "start" });

		const { cals } = await loadHome(ctx.nc);
		let picked: { list: { id: string; sharedBy: string | null }; made: boolean };
		if (args.list_id) {
			const chosen = pickById(cals, args.list_id, "tasks", true, "list_id");
			// A list published by link shows its tasks to anyone with the link (fix round 4).
			guardPublished(ctx, chosen, "list_id", "tasks");
			picked = { list: chosen, made: false };
		} else picked = await defaultTaskList(ctx, cals);
		const list = picked.list;
		const listId = list.id;

		const now = ctx.time.now();
		const build = (uid: string): JComp => {
			const todo: JComp = ["vtodo", [], []];
			setProp(todo, "uid", {}, "text", uid);
			setProp(todo, "dtstamp", {}, "date-time", utcStamp(now));
			setProp(todo, "created", {}, "date-time", utcStamp(now));
			setProp(todo, "last-modified", {}, "date-time", utcStamp(now));
			setProp(todo, "summary", {}, "text", title);
			const notes = args.notes !== undefined ? cleanText(args.notes) : "";
			if (notes) setProp(todo, "description", {}, "text", notes);
			if (start) writeTaskTime(todo, "dtstart", start);
			if (due) writeTaskTime(todo, "due", due);
			if (args.priority) setProp(todo, "priority", {}, "integer", PRIORITY_VALUE[args.priority]);
			setProp(todo, "status", {}, "text", "NEEDS-ACTION");
			return vcalendar([todo]);
		};
		let ids = newObjectId();
		let status = await putObject(ctx.nc, listId, ids.objId, build(ids.uid), { create: true, scheduling: false });
		if (status === 412) {
			ids = newObjectId();
			status = await putObject(ctx.nc, listId, ids.objId, build(ids.uid), { create: true, scheduling: false });
			if (status === 412) throw new ToolError("conflict", "NoTasks refused a new task name twice. Try again.");
		}
		const back = await getObject(ctx.nc, listId, ids.objId, "task");
		const shown = showTask(todoOf(back.cal), back.cal, { listId, objId: ids.objId, etag: back.etag, zone, driveOrigin: ctx.cfg.driveOrigin });
		const warnings = [...(picked.made ? [MADE_LIST_NOTE] : []), ...(startChanged ? [START_CHANGED_NOTE] : [])];
		return {
			data: { task: shown.task },
			summary: `Created a task${list.sharedBy ? " in a list shared with the person" : picked.made ? " in a new list called Tasks" : ""}.`,
			...(warnings.length ? { warnings } : {}),
		};
	},
});
