/**
 * tasks_list (DESIGN 11.6): a calendar-query with comp-filter VTODO, as jCal. For open tasks the
 * server is asked for tasks without COMPLETED; STATUS COMPLETED and CANCELLED are left out in the
 * Worker (a prop-filter with text-match is false when STATUS is missing, so it can't be done there;
 * checked live).
 */
import { z } from "zod";
import { LIMITS } from "../../core/limits";
import { cursorArg, limitArg } from "../../core/shapes";
import { defineTool } from "../../core/tool";
import { subs } from "../../pim/jcal";
import { todoQueryBody } from "../calendar/caldav";
import { loadHome, pickById } from "../calendar/common";
import { leftOutWarnings, readCalendars } from "../calendar/fan-out";
import { dueKey, isCancelled, isCompleted, type ShownTask, showTask } from "./todos";

export const listTasks = defineTool({
	name: "tasks_list",
	title: "List tasks",
	description:
		"Lists the person's NoTasks tasks, earliest due first, with due date, priority and list. Filters: list, status (default open), due on or before a date, text in title or notes. Also returns the task lists.",
	input: z
		.object({
			list_id: z.string().max(200).optional().describe("Only this list."),
			status: z.enum(["open", "completed", "all"]).default("open").describe("Which tasks."),
			due_before: z.string().max(40).optional().describe("A date (inclusive) or date-time."),
			query: z.string().max(200).optional().describe("Text to match."),
			limit: limitArg(LIMITS.listMax, 50).describe("How many."),
			cursor: cursorArg().describe("From next_cursor."),
		})
		.strict(),
	async run(ctx, args) {
		const zone = ctx.time.zone;
		let dueLimit: number | null = null;
		if (args.due_before !== undefined) {
			const t = ctx.time.parse(args.due_before, "due_before");
			dueLimit = t.kind === "date" ? dueKey(t, zone) : t.utcMs - 1;
		}
		const { cals } = await loadHome(ctx.nc);
		const lists = cals.filter((c) => c.tasks);
		const targets = args.list_id ? [pickById(cals, args.list_id, "tasks", false, "list_id")] : lists;
		const body = todoQueryBody(args.status === "open");
		// Both sides in NFC, so combining accents typed in the query or stored by a client still match (DESIGN 29.9).
		const fold = (s: string) => s.normalize("NFC").toLowerCase();
		const q = args.query === undefined ? undefined : fold(args.query);
		// One memory budget over every list (fan-out.ts); each list's answer becomes small records at once.
		const res = await readCalendars(ctx, targets, body, (objects) => {
			const out: ShownTask[] = [];
			for (const o of objects) {
				const todo = subs(o.cal, "vtodo").find((t) => !t[1].some((p) => p[0] === "recurrence-id")) ?? subs(o.cal, "vtodo")[0];
				if (!todo) continue;
				const done = isCompleted(todo);
				if (args.status === "open" && (done || isCancelled(todo))) continue;
				if (args.status === "completed" && !done) continue;
				const s = showTask(todo, o.cal, { listId: o.calId, objId: o.objId, etag: o.etag, zone, driveOrigin: ctx.cfg.driveOrigin });
				if (dueLimit !== null) {
					const k = dueKey(s.due, zone);
					if (k === null || k > dueLimit) continue;
				}
				if (q && ![s.task.title, s.task.notes ?? ""].some((x) => fold(x).includes(q))) continue;
				out.push(s);
			}
			return out;
		});
		const found = res.items;
		found.sort((a, b) => {
			const ka = dueKey(a.due, zone);
			const kb = dueKey(b.due, zone);
			if (ka !== kb) return ka === null ? 1 : kb === null ? -1 : ka - kb;
			const pa = a.priorityValue && a.priorityValue > 0 ? a.priorityValue : 10;
			const pb = b.priorityValue && b.priorityValue > 0 ? b.priorityValue : 10;
			return pa - pb || a.task.title.localeCompare(b.task.title) || a.task.task_id.localeCompare(b.task.task_id);
		});
		const offset = (await ctx.page.decode<number>()) ?? 0;
		const off = Number.isInteger(offset) && offset >= 0 ? offset : 0;
		const window = found.slice(off, off + args.limit).map((s) => s.task);
		const listOut = lists.map((l) => ({ list_id: l.id, name: l.name, read_only: l.readOnly }));
		const fitted = ctx.page.fit(window, (items) => ({ tasks: items, lists: listOut, next_cursor: "x".repeat(200), has_more: true })).items;
		const items = fitted.length ? fitted : window.slice(0, 1);
		const next = off + items.length;
		const has_more = next < found.length;
		const left = leftOutWarnings(res, "task list", (one) => `${one ? "it is" : "they are"} left out.`);
		const warnings = left.length ? left : undefined;
		return {
			data: { tasks: items, lists: listOut, next_cursor: has_more ? await ctx.page.encode(next) : null, has_more },
			summary: `Found ${found.length} ${args.status === "all" ? "" : `${args.status} `}task${found.length === 1 ? "" : "s"} in ${targets.length} list${targets.length === 1 ? "" : "s"}${has_more ? `; showing ${items.length}, next_cursor continues` : ""}.`,
			...(warnings ? { warnings } : {}),
		};
	},
});
