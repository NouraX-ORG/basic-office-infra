/**
 * Shared steps of the calendar and tasks tools: finding the person's calendars once per call,
 * choosing one by id with plain refusals, ranges and the scheduling rule.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import type { ToolCtx } from "../../core/tool";
import type { Nc } from "../../nc/index";
import { addDays, startOfDay } from "../../pim/tz";
import { type CalInfo, listCalendars, parseCalendarId, type PrincipalInfo, principalInfo } from "./caldav";

export interface Home {
	principal: PrincipalInfo;
	cals: CalInfo[];
}

/** The principal and every calendar, in one round of two parallel requests. */
export async function loadHome(nc: Nc): Promise<Home> {
	const [principal, cals] = await Promise.all([principalInfo(nc), listCalendars(nc, null)]);
	for (const c of cals) c.isDefault = c.id === principal.defaultCalId;
	return { principal, cals };
}

export type Need = "events" | "tasks";

function noun(need: Need): string {
	return need === "events" ? "calendar" : "task list";
}

/** One calendar by id, checked: it exists, holds that kind of item and (for writes) is writable. */
export function pickById(cals: readonly CalInfo[], rawId: string, need: Need, write: boolean, field: string): CalInfo {
	const id = parseCalendarId(rawId, field);
	const c = cals.find((x) => x.id === id);
	const listTool = need === "events" ? "calendar_list_calendars" : "tasks_list";
	if (!c) throw new ToolError("not_found", `There's no ${noun(need)} with that id.`, { field, hint: `${listTool} shows the ids.` });
	if (need === "events" && !c.events) throw new ToolError("invalid_input", "That calendar holds only tasks, not events.", { field });
	if (need === "tasks" && !c.tasks) throw new ToolError("invalid_input", "That calendar holds only events, not tasks.", { field });
	if (write && c.readOnly) throw new ToolError("permission_denied", `That ${noun(need)} is read-only for this person.`, { field });
	return c;
}

/**
 * A calendar published by link shows its events to anyone with the link, so writing an event there
 * is sharing it (fix round 3): refused without workspace.share, else done with a warning.
 *
 * The same for tasks (fix round 4): NC 35.0.2's PublicCalendar (apps/dav/lib/CalDAV/
 * PublicCalendar.php, read on the server) hides only CLASS:PRIVATE objects from the link, so a
 * published calendar that takes tasks (createCalendar defaults to VEVENT,VTODO,VJOURNAL) serves its
 * VTODOs to anyone with the link too. `need` picks the words.
 */
export function guardPublished(ctx: ToolCtx, c: CalInfo, field: string, need: Need = "events"): void {
	if (!c.published) return;
	const events = need === "events";
	if (!canShare(ctx)) {
		throw new ToolError("not_available", `That ${events ? "calendar" : "task list"} is published by link, and this connection can't share, so nothing was written there.`, {
			field,
			hint: events
				? "Choose another calendar (calendar_list_calendars shows them), or reconnect with sharing allowed."
				: "Choose another list (tasks_list shows them), or reconnect with sharing allowed.",
		});
	}
	ctx.warn(events ? "That calendar is published by link, so anyone with the link can see this event." : "That task list is published by link, so anyone with the link can see this task.");
}

/** Whether this connection may share (workspace.share), which writing into a published calendar is. */
export function canShare(ctx: ToolCtx): boolean {
	return ctx.connection.scopes.includes("workspace.share");
}

/** The calendar new events go to: the person's default when it takes events, else the first own writable one. */
export function defaultEventCalendar(cals: readonly CalInfo[]): CalInfo {
	const usable = (c: CalInfo) => c.events && !c.readOnly && !c.sharedBy;
	const c = cals.find((x) => x.isDefault && usable(x)) ?? cals.find(usable);
	if (!c) throw new ToolError("not_available", "This person has no calendar that can take new events.", { hint: "Make one in NoCalendar first." });
	return c;
}

export const calendarIdsArg = () =>
	z.array(z.string().max(200)).min(1).max(20).optional().describe("Default: all.");

export const occurrenceArg = () =>
	z.string().max(40).optional().describe('Needed with scope "this".');

export const scopeArg = () => z.enum(["this", "series"]).optional().describe("For a repeating event.");

export const etagArg = () => z.string().max(200).optional().describe("Refused if the event changed since.");

/** Whether a write should let NoCalendar tell the attendees (DESIGN 11.5: internal scheduling only). */
export function schedulingFor(ctx: ToolCtx, eventHasAttendees: boolean): boolean {
	return eventHasAttendees && ctx.cfg.calendarAttendees === "internal";
}

export interface Range {
	startMs: number;
	endMs: number;
}

/** A start..end range from input. A plain date starts at midnight; a plain end date includes that day. */
export function parseRange(ctx: ToolCtx, rawStart: string, rawEnd: string, maxDays: number, zone: string): Range {
	const s = ctx.time.parse(rawStart, "start", zone);
	const e = ctx.time.parse(rawEnd, "end", zone);
	const startMs = s.kind === "date" ? startOfDay(s, zone) : s.utcMs;
	const endMs = e.kind === "date" ? startOfDay(addDays(e, 1), zone) : e.utcMs;
	if (endMs <= startMs) throw new ToolError("invalid_input", `end must be after start (you gave ${rawStart.slice(0, 40)} to ${rawEnd.slice(0, 40)}).`, { field: "end" });
	if (endMs - startMs > maxDays * 86_400_000) throw new ToolError("invalid_input", `The range can be at most ${maxDays} days. Ask for a shorter range.`, { field: "end" });
	return { startMs, endMs };
}

export function person(uid: string | null, name: string | null): { id: string; display_name: string | null } | null {
	return uid ? { id: `person:${uid}`, display_name: name } : null;
}
