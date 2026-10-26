/**
 * Tasks as the NoTasks tools show and write them (DESIGN 11.6). Tasks are VTODOs in calendars whose
 * supported-calendar-component-set includes VTODO ("task lists"). Dates without a time are
 * VALUE=DATE; times are written in UTC. Priority: high 1, normal 5, low 9 (RFC 5545 3.8.1.9).
 */
import { ToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import type { ToolCtx } from "../../core/tool";
import { toZonedIso } from "../../core/time";
import { cloneComp, type JComp, mainComps, prop, setProp, text, utcStamp } from "../../pim/jcal";
import { type CalTime, dateString, localDate, readTime, ZoneResolver } from "../../pim/tz";
import { type CalInfo, getObject, putObject, taskWebUrl } from "../calendar/caldav";

export interface TaskOut {
	task_id: string;
	list_id: string;
	title: string;
	notes: string | null;
	due: string | null;
	start: string | null;
	priority: "high" | "normal" | "low" | null;
	completed: boolean;
	completed_at: string | null;
	etag: string | null;
	web_url: string;
}

export function priorityOf(v: number | null): TaskOut["priority"] {
	if (v === null || v <= 0 || v > 9) return null;
	if (v < 5) return "high";
	if (v === 5) return "normal";
	return "low";
}

export const PRIORITY_VALUE = { high: 1, normal: 5, low: 9 } as const;

export function isCompleted(todo: JComp): boolean {
	return (text(todo, "status") ?? "").toUpperCase() === "COMPLETED" || Boolean(prop(todo, "completed"));
}

export function isCancelled(todo: JComp): boolean {
	return (text(todo, "status") ?? "").toUpperCase() === "CANCELLED";
}

function show(t: CalTime | null, zone: string): string | null {
	if (!t) return null;
	return t.kind === "date" ? dateString(t) : toZonedIso(t.utcMs, zone);
}

/** The instant a due value stands for, for sorting and filters: a date is the end of that day. */
export function dueKey(t: CalTime | null, zone: string): number | null {
	if (!t) return null;
	if (t.kind === "instant") return t.utcMs;
	return new ZoneResolver(null, zone).toUtc(`${dateString(t)}T23:59:59`, zone);
}

export interface ShownTask {
	task: TaskOut;
	due: CalTime | null;
	priorityValue: number | null;
}

export function showTask(todo: JComp, cal: JComp, c: { listId: string; objId: string; etag: string | null; zone: string; driveOrigin: string }): ShownTask {
	const r = new ZoneResolver(cal, c.zone);
	const due = readTime(prop(todo, "due"), r);
	const start = readTime(prop(todo, "dtstart"), r);
	const completedAt = readTime(prop(todo, "completed"), r);
	const pv = prop(todo, "priority")?.[3];
	const p = typeof pv === "number" ? pv : typeof pv === "string" && /^\d$/.test(pv) ? Number(pv) : null;
	const notes = text(todo, "description");
	return {
		task: {
			task_id: `${c.listId}/${c.objId}`,
			list_id: c.listId,
			title: (text(todo, "summary") ?? "").slice(0, 300),
			notes: notes === null ? null : notes.length > LIMITS.notesOutChars ? `${notes.slice(0, LIMITS.notesOutChars)}…` : notes,
			due: show(due, c.zone),
			start: show(start, c.zone),
			priority: priorityOf(p),
			completed: isCompleted(todo),
			completed_at: show(completedAt, c.zone),
			etag: c.etag,
			web_url: taskWebUrl(c.driveOrigin, c.listId, c.objId),
		},
		due,
		priorityValue: p,
	};
}

/** The VTODO of a calendar object (the master), or a plain not_found. */
export function todoOf(cal: JComp): JComp {
	const { master, overrides } = mainComps(cal, "vtodo");
	const t = master ?? overrides[0];
	if (!t) throw new ToolError("not_found", "That id isn't a task. tasks_list finds tasks and their ids.");
	return t;
}

/** Writes a DUE/DTSTART value: a plain date as VALUE=DATE, an instant in UTC; null removes it. */
export function writeTaskTime(todo: JComp, name: "due" | "dtstart", t: CalTime | null): void {
	if (t === null) {
		todo[1] = todo[1].filter((p) => p[0].toLowerCase() !== name);
		return;
	}
	if (t.kind === "date") setProp(todo, name, {}, "date", dateString(t));
	else setProp(todo, name, {}, "date-time", utcStamp(t.utcMs));
}

/**
 * NoCalendar refuses a VTODO whose DTSTART and DUE differ in value type ("The value type (DATE or
 * DATE-TIME) must be identical for DUE and DTSTART", checked live 2026-10-25; RFC 5545 3.8.2.3).
 * The due date is what the person asked for, so the start follows it: a date start becomes
 * midnight of that day in the person's zone, a timed start becomes its local date. Returns the
 * start to write and whether it changed.
 */
export function startMatchingDue(start: CalTime | null, due: CalTime | null, zone: string): { start: CalTime | null; changed: boolean } {
	if (!start || !due || start.kind === due.kind) return { start, changed: false };
	if (due.kind === "instant" && start.kind === "date") {
		const ms = new ZoneResolver(null, zone).toUtc(`${dateString(start)}T00:00:00`, zone);
		return ms === null ? { start, changed: false } : { start: { kind: "instant", utcMs: ms }, changed: true };
	}
	if (due.kind === "date" && start.kind === "instant") return { start: { kind: "date", ...localDate(start.utcMs, zone) }, changed: true };
	return { start, changed: false };
}

export const START_CHANGED_NOTE = "The start was rewritten as a date or a date and time to match the due date, as NoTasks needs both the same.";

/** tasks_set_due_date: its undo puts back the due date only (no tool sets a start). */
export const START_UNDO_NOTE = "The undo puts back the old due date; the start keeps its new form, so it may not get its old time back.";

/** Compares two task times: a date counts as its start for DTSTART and its end for DUE. */
export function startBeforeOrAtDue(start: CalTime | null, due: CalTime | null, zone: string): boolean {
	if (!start || !due) return true;
	const s = start.kind === "date" ? new ZoneResolver(null, zone).toUtc(`${dateString(start)}T00:00:00`, zone) : start.utcMs;
	const d = dueKey(due, zone);
	return s === null || d === null || s <= d;
}

export function touchTask(todo: JComp, now: number): void {
	const seq = Number(prop(todo, "sequence")?.[3] ?? 0);
	setProp(todo, "sequence", {}, "integer", Number.isFinite(seq) ? seq + 1 : 1);
	setProp(todo, "dtstamp", {}, "date-time", utcStamp(now));
	setProp(todo, "last-modified", {}, "date-time", utcStamp(now));
}

/**
 * GET, change, PUT with If-Match; a 412 (someone changed it in between) is fetched again and
 * retried once. `change` returns false when nothing needs saving.
 */
export async function editTask<T>(
	ctx: ToolCtx,
	list: CalInfo,
	objId: string,
	change: (todo: JComp, cal: JComp) => { save: boolean; info: T },
): Promise<{ info: T; saved: boolean; cal: JComp; etag: string | null }> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const obj = await getObject(ctx.nc, list.id, objId, "task");
		const work = cloneComp(obj.cal);
		const todo = todoOf(work);
		const { save, info } = change(todo, work);
		if (!save) return { info, saved: false, cal: obj.cal, etag: obj.etag };
		const status = await putObject(ctx.nc, list.id, objId, work, { ifMatch: obj.etag, scheduling: false });
		if (status === 412) continue;
		const back = await getObject(ctx.nc, list.id, objId, "task");
		return { info, saved: true, cal: back.cal, etag: back.etag };
	}
	throw new ToolError("conflict", "The task changed while it was being saved. Try again.");
}
