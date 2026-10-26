/**
 * Making a task list from the Worker (DESIGN 11.6: a list called "Tasks" when the person has none).
 *
 * workerd's fetch refuses the MKCALENDAR method ("Invalid HTTP method string", checked 2026-10-25),
 * so a list is an extended MKCOL (RFC 5689) with resourcetype calendar and a VTODO-only component
 * set (checked live with curl: 201, and 405 when the name is taken). Core's egress rule
 * dav-calendars allows MKCOL since fix round 3, one level below the calendar home only (never the
 * trash, inbox or outbox) and only with a plain-calendar body, so tasks_create makes the list by
 * itself (it asks canMakeLists on every call, and LISTS_MAKEABLE picks the description that
 * matches). If the rule were narrowed again, tasks_create would say plainly that a list has to be
 * made in NoTasks first.
 */
import { checkEgress, EgressDenied, RULES } from "../../core/egress";
import { ToolError } from "../../core/errors";
import type { ToolCtx } from "../../core/tool";
import { rawXml, xml } from "../../core/xml";
import { XMLNS } from "../../nc/index";
import { calendarPath } from "../calendar/caldav";

const NEW_LIST_IDS = ["tasks", "tasks-2", "tasks-3"];

/** Whether core's egress table has MKCOL on calendars at all (chooses tasks_create's description). */
export const LISTS_MAKEABLE = RULES.some((r) => r.id === "dav-calendars" && r.methods.includes("MKCOL"));

/** The extended MKCOL body for a VTODO-only list called "Tasks", in Nourax cobalt. */
export function taskListBody(): string {
	return xml`<?xml version="1.0" encoding="utf-8"?><d:mkcol ${rawXml(XMLNS)}><d:set><d:prop><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Tasks</d:displayname><x1:calendar-color>#2563EB</x1:calendar-color><cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set></d:prop></d:set></d:mkcol>`.xml;
}

/** Whether the egress allowlist lets this Worker make a calendar collection for this person. */
export function canMakeLists(ctx: ToolCtx): boolean {
	try {
		checkEgress(ctx.cfg, `${ctx.cfg.driveOrigin}${calendarPath(ctx.uid, "tasks")}`, { method: "MKCOL", body: taskListBody() }, ctx.uid);
		return true;
	} catch (e) {
		if (e instanceof EgressDenied) return false;
		throw e;
	}
}

/** Makes the "Tasks" list under the first free name. Returns its id. */
export async function makeTaskList(ctx: ToolCtx, taken: ReadonlySet<string>, allowed: boolean = canMakeLists(ctx)): Promise<string> {
	if (!allowed) {
		throw new ToolError("not_available", "This person has no task list yet, and one can't be made from here.", { hint: "Make a list in NoTasks, then try again." });
	}
	for (const id of NEW_LIST_IDS) {
		if (taken.has(id)) continue;
		const res = await ctx.nc.dav.mkcol(calendarPath(ctx.uid, id), taskListBody(), { allow: [405, 409, 429] });
		await res.body?.cancel();
		if (res.status === 201) return id;
		if (res.status === 429) throw new ToolError("rate_limited", "NoCalendar allows only a few new lists an hour. Try again later, or give a list_id.", { retryAfterSec: 600 });
	}
	throw new ToolError("not_available", "No task list could be made.", { hint: "Make a list in NoTasks, then try again." });
}
