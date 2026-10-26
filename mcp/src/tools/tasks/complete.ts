/**
 * tasks_complete (DESIGN 11.6): STATUS:COMPLETED, PERCENT-COMPLETE:100 and COMPLETED:<utc>, or the
 * reverse with completed false, with If-Match. Doing it twice changes nothing the second time.
 *
 * Fix round 3: the undo is this same tool with the other value, so it can't rebuild every state a
 * task can be in. Not done again means NEEDS-ACTION at 0% (as NoTasks does it), and done again
 * stamps the time the undo runs. When that differs from what the task had (it was in progress, or
 * cancelled, or it was done at a known time), a warning says what the undo won't put back, as
 * calendar_update_event does for reminders (DESIGN 27).
 *
 * A change in a list published by link is shown to anyone with the link: refused without
 * workspace.share, done with a warning with it, and checked only when something is saved (fix
 * round 4, guardPublished).
 */
import { z } from "zod";
import { defineTool } from "../../core/tool";
import { toZonedIso } from "../../core/time";
import { num, prop, removeProp, setProp, text, utcStamp } from "../../pim/jcal";
import { dateString, readTime, ZoneResolver } from "../../pim/tz";
import { parseObjectId } from "../calendar/caldav";
import { guardPublished, loadHome, pickById } from "../calendar/common";
import { editTask, isCompleted, showTask, todoOf, touchTask } from "./todos";

/** What the undo of marking a task done won't put back, or null. */
export function undoNoteForDone(status: string, percent: number | null): string | null {
	if (status === "CANCELLED") return "This task was cancelled before; the undo marks it not done instead, and NoTasks can cancel it again.";
	if (status === "IN-PROCESS" || (percent !== null && percent > 0 && percent < 100)) {
		return `This task was in progress before${percent !== null && percent > 0 && percent < 100 ? ` (${percent}% done)` : ""}; the undo marks it not done at 0%, and NoTasks can set the progress again.`;
	}
	return null;
}

/** What the undo of marking a task not done won't put back, or null. */
export function undoNoteForNotDone(doneAt: string | null): string | null {
	return doneAt ? `This task was marked done at ${doneAt}; the undo marks it done again at the time the undo runs.` : null;
}

export const completeTask = defineTool({
	name: "tasks_complete",
	title: "Complete a task",
	description: "Marks a NoTasks task done, or not done again with completed false.",
	input: z
		.object({
			task_id: z.string().max(420).describe("From tasks_list."),
			completed: z.boolean().default(true).describe("false: not done."),
		})
		.strict(),
	async run(ctx, args) {
		const zone = ctx.time.zone;
		const ids = parseObjectId(args.task_id, "task_id", "task");
		const { cals } = await loadHome(ctx.nc);
		const list = pickById(cals, ids.calId, "tasks", true, "task_id");
		const now = ctx.time.now();
		const res = await editTask(ctx, list, ids.objId, (todo, cal) => {
			const was = isCompleted(todo);
			if (was === args.completed) return { save: false, info: { was, note: null as string | null } };
			guardPublished(ctx, list, "task_id", "tasks");
			let note: string | null;
			if (args.completed) {
				note = undoNoteForDone((text(todo, "status") ?? "").toUpperCase(), num(todo, "percent-complete"));
				setProp(todo, "status", {}, "text", "COMPLETED");
				setProp(todo, "percent-complete", {}, "integer", 100);
				setProp(todo, "completed", {}, "date-time", utcStamp(now));
			} else {
				const at = readTime(prop(todo, "completed"), new ZoneResolver(cal, zone));
				note = undoNoteForNotDone(at ? (at.kind === "date" ? dateString(at) : toZonedIso(at.utcMs, zone)) : null);
				setProp(todo, "status", {}, "text", "NEEDS-ACTION");
				setProp(todo, "percent-complete", {}, "integer", 0);
				removeProp(todo, "completed");
			}
			touchTask(todo, now);
			return { save: true, info: { was, note } };
		});
		const shown = showTask(todoOf(res.cal), res.cal, { listId: list.id, objId: ids.objId, etag: res.etag, zone, driveOrigin: ctx.cfg.driveOrigin });
		if (!res.saved) {
			return {
				data: { task: shown.task },
				summary: `The task was already ${args.completed ? "done" : "not done"}; nothing changed.`,
				undo: null,
			};
		}
		return {
			data: { task: shown.task },
			summary: args.completed ? "Marked the task as done." : "Marked the task as not done.",
			undo: { tool: "tasks_complete", arguments: { task_id: shown.task.task_id, completed: res.info.was } },
			...(res.info.note ? { warnings: [res.info.note] } : {}),
		};
	},
});
