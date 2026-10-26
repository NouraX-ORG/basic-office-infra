/**
 * tasks_set_due_date (DESIGN 11.6): replace or remove DUE (VALUE=DATE or a UTC date-time), with
 * If-Match. DURATION is dropped when DUE is set (RFC 5545 allows only one of them).
 *
 * A change in a list published by link is shown to anyone with the link: refused without
 * workspace.share, done with a warning with it, and checked only when something is saved (fix
 * round 4, guardPublished).
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { defineTool } from "../../core/tool";
import { toZonedIso } from "../../core/time";
import { prop, removeProp } from "../../pim/jcal";
import { type CalTime, dateString, readTime, ZoneResolver } from "../../pim/tz";
import { parseObjectId } from "../calendar/caldav";
import { guardPublished, loadHome, pickById } from "../calendar/common";
import { editTask, START_CHANGED_NOTE, START_UNDO_NOTE, showTask, startBeforeOrAtDue, startMatchingDue, todoOf, touchTask, writeTaskTime } from "./todos";

function same(a: CalTime | null, b: CalTime | null): boolean {
	if (!a || !b) return a === b;
	if (a.kind === "date" && b.kind === "date") return a.y === b.y && a.mo === b.mo && a.d === b.d;
	if (a.kind === "instant" && b.kind === "instant") return a.utcMs === b.utcMs;
	return false;
}

export const setTaskDue = defineTool({
	name: "tasks_set_due_date",
	title: "Change a task's due date",
	description:
		"Sets, changes or clears (null) a NoTasks task's due date. A date means that day.",
	input: z
		.object({
			task_id: z.string().max(420).describe("From tasks_list."),
			due: z.string().max(40).nullable().describe("Date, date-time or null."),
		})
		.strict(),
	async run(ctx, args) {
		const zone = ctx.time.zone;
		const ids = parseObjectId(args.task_id, "task_id", "task");
		const next: CalTime | null = args.due === null ? null : ctx.time.parse(args.due, "due");
		const { cals } = await loadHome(ctx.nc);
		const list = pickById(cals, ids.calId, "tasks", true, "task_id");
		const now = ctx.time.now();
		const res = await editTask(ctx, list, ids.objId, (todo, cal) => {
			const r = new ZoneResolver(cal, zone);
			const before = readTime(prop(todo, "due"), r);
			const prev = before ? (before.kind === "date" ? dateString(before) : toZonedIso(before.utcMs, zone)) : null;
			if (same(before, next)) return { save: false, info: { prev, startChanged: false } };
			const { start, changed } = startMatchingDue(readTime(prop(todo, "dtstart"), r), next, zone);
			if (!startBeforeOrAtDue(start, next, zone)) {
				throw new ToolError("invalid_input", "The task's start is after that due date. Pick a later due date.", { field: "due" });
			}
			guardPublished(ctx, list, "task_id", "tasks");
			removeProp(todo, "duration");
			writeTaskTime(todo, "due", next);
			if (changed) writeTaskTime(todo, "dtstart", start);
			touchTask(todo, now);
			return { save: true, info: { prev, startChanged: changed } };
		});
		const shown = showTask(todoOf(res.cal), res.cal, { listId: list.id, objId: ids.objId, etag: res.etag, zone, driveOrigin: ctx.cfg.driveOrigin });
		if (!res.saved) return { data: { task: shown.task }, summary: "The task already had that due date; nothing changed.", undo: null };
		const warnings = res.info.startChanged ? [START_CHANGED_NOTE, START_UNDO_NOTE] : undefined;
		return {
			data: { task: shown.task },
			summary: next === null ? "Removed the task's due date." : "Changed the task's due date.",
			undo: { tool: "tasks_set_due_date", arguments: { task_id: shown.task.task_id, due: res.info.prev } },
			...(warnings ? { warnings } : {}),
		};
	},
});
