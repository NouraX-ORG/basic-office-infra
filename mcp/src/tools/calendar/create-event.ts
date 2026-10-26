/**
 * calendar_create_event (DESIGN 11.5). The schema has no attendee or organizer fields, so nobody can
 * be invited from here (calendar_add_attendees does that); the PUT sends X-NC-Scheduling: false and
 * If-None-Match: *. The duplicate guard is core's (catalogue flag), with allow_duplicate.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import { allowDuplicateArg } from "../../core/shapes";
import { defineTool } from "../../core/tool";
import { cleanLine, cleanText, type JComp, setProp, utcStamp, vcalendar } from "../../pim/jcal";
import { ZoneResolver } from "../../pim/tz";
import { getObject, newObjectId, putObject } from "./caldav";
import { defaultEventCalendar, guardPublished, loadHome, pickById } from "./common";
import {
	checkZone,
	ensureVtimezones,
	masterOf,
	parseWhen,
	recurValue,
	repeatArg,
	resolveTimes,
	setReminder,
	showEvent,
	timeArg,
	writeTimes,
	zoneArg,
} from "./events";

export const createEvent = defineTool({
	name: "calendar_create_event",
	title: "Create an event",
	description:
		"Creates an event in the default calendar or calendar_id, with optional location, notes, reminder and repeat. A date start means all-day, end being the last day. Nobody is invited; calendar_add_attendees does that.",
	input: z
		.object({
			title: z.string().max(LIMITS.titleChars).describe("Title."),
			start: timeArg("Date-time, or a date for all-day."),
			end: timeArg("All-day: the last day.").optional(),
			duration_minutes: z.number().int().min(1).max(20_160).optional().describe("Instead of end; default 60."),
			all_day: z.boolean().optional().describe("Default: start is a date."),
			time_zone: zoneArg().optional(),
			calendar_id: z.string().max(200).optional().describe("Default: the default one."),
			location: z.string().max(500).optional().describe("Location."),
			description: z.string().max(LIMITS.descriptionInChars).optional().describe("Notes."),
			reminder_minutes_before: z.number().int().min(0).max(40_320).optional().describe("Minutes before."),
			repeat: repeatArg().optional(),
			allow_duplicate: allowDuplicateArg().describe("true makes a second copy."),
		})
		.strict(),
	async run(ctx, args) {
		if (args.end !== undefined && args.duration_minutes !== undefined) {
			throw new ToolError("invalid_input", "Give end or duration_minutes, not both.", { field: "duration_minutes" });
		}
		const zone = checkZone(args.time_zone, ctx.time.zone);
		const start = parseWhen(ctx.time, args.start, "start", zone);
		const end = args.end !== undefined ? parseWhen(ctx.time, args.end, "end", zone) : undefined;
		const times = resolveTimes({ start, end, durationMin: args.duration_minutes, allDay: args.all_day }, zone);
		const title = cleanLine(args.title);
		if (!title) throw new ToolError("invalid_input", "title can't be empty.", { field: "title" });

		const { cals } = await loadHome(ctx.nc);
		const cal = args.calendar_id ? pickById(cals, args.calendar_id, "events", true, "calendar_id") : defaultEventCalendar(cals);
		guardPublished(ctx, cal, "calendar_id");

		const now = ctx.time.now();
		const build = (uid: string): JComp => {
			const vev: JComp = ["vevent", [], []];
			setProp(vev, "uid", {}, "text", uid);
			setProp(vev, "dtstamp", {}, "date-time", utcStamp(now));
			setProp(vev, "created", {}, "date-time", utcStamp(now));
			setProp(vev, "last-modified", {}, "date-time", utcStamp(now));
			setProp(vev, "sequence", {}, "integer", 0);
			setProp(vev, "summary", {}, "text", title);
			writeTimes(vev, times, { tzid: args.repeat && !times.allDay ? zone : null });
			const location = args.location !== undefined ? cleanLine(args.location) : "";
			if (location) setProp(vev, "location", {}, "text", location);
			const description = args.description !== undefined ? cleanText(args.description) : "";
			if (description) setProp(vev, "description", {}, "text", description);
			setProp(vev, "status", {}, "text", "CONFIRMED");
			if (args.repeat) setProp(vev, "rrule", {}, "recur", recurValue(args.repeat, times.allDay, zone, times.startMs));
			if (args.reminder_minutes_before !== undefined) setReminder(vev, args.reminder_minutes_before, title);
			const vcal = vcalendar([vev]);
			ensureVtimezones(vcal);
			return vcal;
		};

		let ids = newObjectId();
		let status = await putObject(ctx.nc, cal.id, ids.objId, build(ids.uid), { create: true, scheduling: false });
		if (status === 412) {
			ids = newObjectId();
			status = await putObject(ctx.nc, cal.id, ids.objId, build(ids.uid), { create: true, scheduling: false });
			if (status === 412) throw new ToolError("conflict", "NoCalendar refused a new event name twice. Try again.");
		}
		const back = await getObject(ctx.nc, cal.id, ids.objId, "event");
		const { master } = masterOf(back.cal);
		const shown = showEvent(master, new ZoneResolver(back.cal, ctx.time.zone), {
			calId: cal.id,
			objId: ids.objId,
			etag: back.etag,
			uid: ctx.uid,
			driveOrigin: ctx.cfg.driveOrigin,
			zone: ctx.time.zone,
			seriesMember: false,
		});
		if (!shown) throw new ToolError("upstream_unavailable", "The event was saved but couldn't be read back. calendar_list_events shows it.");
		const warnings: string[] = [];
		if (times.endMs <= now) warnings.push("This event is in the past.");
		const event_id = shown.event.event_id;
		return {
			data: { event: shown.event },
			// Summaries sit outside the data boundary, so they name no ids or titles people chose.
			summary: `Created an event${args.repeat ? ` that repeats ${args.repeat.frequency}` : ""}${cal.isDefault ? " in the default calendar" : ""}.`,
			undo: { tool: "calendar_cancel_event", arguments: { event_id, mode: "remove", ...(args.repeat ? { scope: "series" } : {}) } },
			...(warnings.length ? { warnings } : {}),
		};
	},
});
