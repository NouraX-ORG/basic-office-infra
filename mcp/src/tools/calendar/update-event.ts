/**
 * calendar_update_event (DESIGN 11.5). GET the event as jCal, change only the fields given, PUT it
 * back with If-Match (a 412 is fetched again and retried once, unless expected_etag was given).
 * - Repeating events need scope: "this" edits or adds the override for occurrence_start, "series"
 *   edits the master. Moving a series' start also moves its single-occurrence changes and
 *   exceptions by the same amount, so they stay attached to their occurrences.
 * - A calendar move is a DAV MOVE of the object (the target must hold events and be writable;
 *   NoCalendar itself would accept an event in a task-only list, checked live).
 * - Attendees already invited are told inside the workspace when CALENDAR_ATTENDEES=internal
 *   (scheduling stays on); otherwise X-NC-Scheduling: false and the result says they weren't told.
 *   `notified` lists them as Person ids (people.ts); attendees who match nobody the person can see
 *   are counted in a warning, never claimed.
 * - Review fix round 2: only the organizer's changes reach the invited people (people.ts,
 *   schedulingRole). When the person is an attendee, or the event has no organizer or someone
 *   else's, the change is saved with X-NC-Scheduling: false (NoCalendar would pass it on to nobody,
 *   and a new single-occurrence change could send the organizer a stray reply), `notified` is
 *   empty and a warning says the change is in this person's copy only. The sharees searches behind
 *   `notified` are counted against the read limit before anything is written.
 * - A reminder change touches only the reminder reminder_minutes_before stands for (events.ts,
 *   setReminder); when the undo can't rebuild every reminder the event had, a warning says so.
 * - Review fix round 1:
 *   - the undo can always run: a field whose current text is longer than this tool takes (title 255,
 *     location 500, description 10,000) isn't changed here (too_large, nothing written), because
 *     its old text could never be put back;
 *   - a move is checked before anything is written (the object's name must end in ".ics", which is
 *     all the egress rule lets MOVE reach, and the target must not hold that name); if the MOVE still
 *     fails after the change was saved, the result says so and keeps the undo of the change;
 *   - moving a series' start also moves the occurrences that were only changed in other ways (their
 *     own start was still their original one), so they don't stay at the old time.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import { defineTool, type ToolCtx } from "../../core/tool";
import { partsIn, toZonedIso, zonedToUtc } from "../../core/time";
import { cleanLine, cleanText, type JComp, type JProp, mainComps, param, prop, props, removeProp, repeats, setProp, text, utcStamp } from "../../pim/jcal";
import { addDays, type CalTime, dateString, daysBetween, ianaOf, readTime, ZoneResolver } from "../../pim/tz";
import { getObject, movableName, moveObject, objectPath, parseObjectId, putObject } from "./caldav";
import { etagArg, guardPublished, loadHome, occurrenceArg, pickById, schedulingFor, scopeArg } from "./common";
import {
	attendeesCutNote,
	checkZone,
	ensureVtimezones,
	hasAttendees,
	masterOf,
	occurrenceProp,
	parseWhen,
	resolveTimes,
	setReminder,
	showEvent,
	spanOf,
	timeArg,
	touch,
	type When,
	writeTimes,
	zoneArg,
} from "./events";
import { findOverride, occurrenceKey, overrideFor } from "./occurrence";
import { notifiedPeople, notifySearches, notToldWarning, PeopleLookup, type SchedulingRole, schedulingRole } from "./people";

/** The longest location this tool (and calendar_create_event) takes. */
export const LOCATION_CHARS = 500;

const input = z
	.object({
		event_id: z.string().max(420).describe("From calendar_list_events."),
		scope: scopeArg(),
		occurrence_start: occurrenceArg(),
		title: z.string().max(LIMITS.titleChars).optional().describe("New title."),
		start: timeArg("New start; length kept.").optional(),
		end: timeArg("New end; all-day: last day.").optional(),
		all_day: z.boolean().optional().describe("All-day or timed."),
		time_zone: zoneArg().optional(),
		location: z.string().max(LOCATION_CHARS).nullable().optional().describe("null removes."),
		description: z.string().max(LIMITS.descriptionInChars).nullable().optional().describe("Notes; null removes."),
		reminder_minutes_before: z.number().int().min(0).max(40_320).nullable().optional().describe("null removes."),
		move_to_calendar_id: z.string().max(200).optional().describe("Target calendar_id."),
		expected_etag: etagArg(),
	})
	.strict();

type Args = z.output<typeof input>;

interface Prev {
	title?: string;
	start?: string;
	end?: string;
	all_day?: boolean;
	location?: string | null;
	description?: string | null;
	reminder_minutes_before?: number | null;
}

function shownTimes(comp: JComp, r: ZoneResolver, zone: string): { start: string; end: string; allDay: boolean; startMs: number; endMs: number } | null {
	const s = spanOf(comp, r, zone);
	if (!s) return null;
	if (s.allDay && s.firstDay && s.lastDay) return { start: dateString(s.firstDay), end: dateString(s.lastDay), allDay: true, startMs: s.startMs, endMs: s.endMs };
	return { start: toZonedIso(s.startMs, zone), end: toZonedIso(s.endMs, zone), allDay: false, startMs: s.startMs, endMs: s.endMs };
}

/**
 * Moves RECURRENCE-IDs of overrides and EXDATEs along with the series start. For a series written
 * with a TZID the move is in wall-clock time of that zone (09:00 stays 09:00 across daylight-saving
 * changes); otherwise in UTC; date values move by whole days.
 */
function shiftExceptions(master: JComp, overrides: JComp[], oldStartMs: number, newStartMs: number, zone: string | null, r: ZoneResolver): void {
	const wall = (ms: number): number => {
		if (!zone) return ms;
		const p = partsIn(ms, zone);
		return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
	};
	const deltaMs = wall(newStartMs) - wall(oldStartMs);
	if (deltaMs === 0) return;
	const move = (ms: number): number => {
		if (!zone) return ms + deltaMs;
		const w = new Date(wall(ms) + deltaMs);
		return zonedToUtc(w.getUTCFullYear(), w.getUTCMonth() + 1, w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds(), zone);
	};
	const shift = (p: JProp): void => {
		const t = readTime(p, r);
		if (!t) return;
		if (t.kind === "date") {
			const days = Math.round(deltaMs / 86_400_000);
			p[3] = dateString(addDays(t, days));
			p.length = 4;
			return;
		}
		const moved = move(t.utcMs);
		const np = occurrenceProp(p[0] === "exdate" ? "exdate" : "recurrence-id", master, { kind: "instant", utcMs: moved });
		p[1] = np[1];
		p[2] = np[2];
		p[3] = np[3];
		p.length = 4;
	};
	/** The override's own start and end follow, when it still started at its original time. */
	const shiftOwnTimes = (o: JComp, ridBefore: CalTime): void => {
		const ds = prop(o, "dtstart");
		const st = readTime(ds, r);
		if (!st || !sameTime(st, ridBefore)) return;
		const en = readTime(prop(o, "dtend"), r);
		if (st.kind === "date") {
			const days = Math.round(deltaMs / 86_400_000);
			const length = en && en.kind === "date" ? Math.max(1, daysBetween(st, en)) : 1;
			const first = addDays(st, days);
			setProp(o, "dtstart", {}, "date", dateString(first));
			setProp(o, "dtend", {}, "date", dateString(addDays(first, length)));
			removeProp(o, "duration");
			return;
		}
		const startMs = move(st.utcMs);
		const lengthMs = en && en.kind === "instant" ? Math.max(0, en.utcMs - st.utcMs) : 0;
		const tz = ds ? param(ds, "tzid") : null;
		writeTimes(o, { allDay: false, startMs, endMs: startMs + lengthMs }, { tzid: tz });
	};
	for (const p of props(master, "exdate")) shift(p);
	for (const o of overrides) {
		const rid = prop(o, "recurrence-id");
		if (!rid) continue;
		const before = readTime(rid, r);
		shift(rid);
		if (before) shiftOwnTimes(o, before);
	}
}

function sameTime(a: CalTime, b: CalTime): boolean {
	if (a.kind === "date" && b.kind === "date") return a.y === b.y && a.mo === b.mo && a.d === b.d;
	if (a.kind === "instant" && b.kind === "instant") return a.utcMs === b.utcMs;
	return false;
}

/**
 * A field whose current text is longer than this tool takes can't be put back by the undo, so it
 * isn't changed here at all (review fix round 1; lane G's tools do the same, DESIGN 25.6).
 */
function guardRestorable(field: "title" | "location" | "description", current: string | null, max: number, webUrl: string): void {
	if (current !== null && current.length > max) {
		throw new ToolError("too_large", `The event's current ${field} is longer than ${max.toLocaleString("en-GB")} characters, so an undo couldn't put it back; it wasn't changed.`, {
			field,
			hint: `Change it in NoCalendar: ${webUrl}`,
		});
	}
}

interface Plan {
	comp: JComp;
	prev: Prev;
	changedFields: string[];
	/** Plain notes about what the undo can't put back. */
	notes: string[];
}

async function apply(ctx: ToolCtx, args: Args, ids: { calId: string; objId: string }, work: JComp, zone: string): Promise<Plan> {
	const r = new ZoneResolver(work, zone);
	const { master, overrides } = masterOf(work);
	const isRepeating = repeats(master);
	if (isRepeating && !args.scope) {
		throw new ToolError("invalid_input", 'This event repeats: give scope "this" (with occurrence_start) or "series".', { field: "scope" });
	}
	const one = isRepeating && args.scope === "this";
	let comp = master;
	if (one) {
		if (!args.occurrence_start) throw new ToolError("invalid_input", 'scope "this" needs occurrence_start (from calendar_list_events).', { field: "occurrence_start" });
		const occ: When = parseWhen(ctx.time, args.occurrence_start, "occurrence_start", zone);
		comp = (await overrideFor(ctx, ids, work, master, overrides, occ, zone)).comp;
	}
	const prev: Prev = {};
	const changed: string[] = [];
	const notes: string[] = [];
	const now = ctx.time.now();
	const webUrl = (): string =>
		showEvent(comp, r, { calId: ids.calId, objId: ids.objId, etag: null, uid: ctx.uid, driveOrigin: ctx.cfg.driveOrigin, zone, seriesMember: isRepeating })?.event.web_url ??
		`${ctx.cfg.driveOrigin}/apps/calendar`;
	if (args.title !== undefined) guardRestorable("title", text(comp, "summary"), LIMITS.titleChars, webUrl());
	if (args.location !== undefined) guardRestorable("location", text(comp, "location"), LOCATION_CHARS, webUrl());
	if (args.description !== undefined) guardRestorable("description", text(comp, "description"), LIMITS.descriptionInChars, webUrl());

	if (args.title !== undefined) {
		const t = cleanLine(args.title);
		if (!t) throw new ToolError("invalid_input", "title can't be empty.", { field: "title" });
		prev.title = text(comp, "summary") ?? "";
		setProp(comp, "summary", {}, "text", t);
		changed.push("title");
	}
	if (args.location !== undefined) {
		prev.location = text(comp, "location");
		const v = args.location === null ? "" : cleanLine(args.location);
		if (v) setProp(comp, "location", {}, "text", v);
		else removeProp(comp, "location");
		changed.push("location");
	}
	if (args.description !== undefined) {
		prev.description = text(comp, "description");
		const v = args.description === null ? "" : cleanText(args.description);
		if (v) setProp(comp, "description", {}, "text", v);
		else removeProp(comp, "description");
		changed.push("description");
	}
	if (args.reminder_minutes_before !== undefined) {
		const set = setReminder(comp, args.reminder_minutes_before, text(comp, "summary") ?? "");
		prev.reminder_minutes_before = set.before;
		notes.push(...set.notes);
		changed.push("reminder");
	}
	if (args.start !== undefined || args.end !== undefined || args.all_day !== undefined) {
		const cur = shownTimes(comp, r, zone);
		if (!cur) throw new ToolError("upstream_unavailable", "This event's times couldn't be read, so they can't be changed safely.");
		prev.start = cur.start;
		prev.end = cur.end;
		prev.all_day = cur.allDay;
		const start: When = args.start !== undefined ? parseWhen(ctx.time, args.start, "start", zone) : cur.allDay ? dateOf(cur.start) : { kind: "instant", utcMs: cur.startMs };
		const allDay = args.all_day ?? (args.start !== undefined ? start.kind === "date" : cur.allDay);
		let end: When | undefined;
		if (args.end !== undefined) end = parseWhen(ctx.time, args.end, "end", zone);
		else if (allDay === cur.allDay && args.start !== undefined) {
			// Only the start moved: keep the length.
			if (allDay) {
				const days = Math.round((cur.endMs - cur.startMs) / 86_400_000);
				const s = start.kind === "date" ? start : dateOf(toZonedIso(start.utcMs, zone).slice(0, 10));
				end = { kind: "date", ...addDays(s, Math.max(1, days) - 1) };
			} else if (start.kind === "instant") end = { kind: "instant", utcMs: start.utcMs + (cur.endMs - cur.startMs) };
		} else if (allDay === cur.allDay && !allDay) end = { kind: "instant", utcMs: cur.endMs };
		else if (allDay === cur.allDay && allDay) end = dateOf(cur.end);
		const times = resolveTimes({ start, end, allDay }, zone);
		if (isRepeating && !one && allDay !== cur.allDay && (overrides.length || props(master, "exdate").length)) {
			throw new ToolError("invalid_input", "This series has single occurrences that differ or were removed, so it can't switch between all-day and timed. Change it in NoCalendar.", { field: "all_day" });
		}
		const ds = prop(master, "dtstart");
		const masterTz = ds ? param(ds, "tzid") : null;
		const tzid = times.allDay ? null : isRepeating ? (args.time_zone ? zone : ianaOf(masterTz) ? masterTz : zone) : null;
		const oldStart = cur.startMs;
		writeTimes(comp, times, { tzid });
		if (isRepeating && !one) {
			const iana = ianaOf(tzid);
			if (allDay === cur.allDay && !times.allDay) shiftExceptions(master, overrides, oldStart, times.startMs, iana && iana !== "UTC" ? iana : null, r);
			if (allDay === cur.allDay && times.allDay && times.firstDay) shiftExceptions(master, overrides, 0, daysBetween(dateOf(cur.start), times.firstDay) * 86_400_000, null, r);
			fixUntil(master, times.allDay, zone);
		}
		changed.push("time");
	}
	touch(comp, now);
	if (comp !== master) {
		// The master's stamp moves too, so every client sees the object changed.
		setProp(master, "dtstamp", {}, "date-time", utcStamp(now));
	}
	ensureVtimezones(work);
	return { comp, prev, changedFields: changed, notes };
}

function dateOf(s: string): { kind: "date"; y: number; mo: number; d: number } {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
	return { kind: "date", y: Number(m?.[1]), mo: Number(m?.[2]), d: Number(m?.[3]) };
}

/** UNTIL must have the type of DTSTART: a date for all-day series, a UTC date-time otherwise. */
function fixUntil(master: JComp, allDay: boolean, zone: string): void {
	const rr = prop(master, "rrule");
	const v = rr?.[3];
	if (!rr || typeof v !== "object" || v === null) return;
	const recur = v as Record<string, unknown>;
	const until = recur.until;
	if (typeof until !== "string") return;
	const day = until.slice(0, 10);
	if (allDay && until.length > 10) recur.until = day;
	if (!allDay && until.length === 10) {
		const d = dateOf(day);
		if (d.kind === "date") {
			const endOfDay = new ZoneResolver(null, zone).toUtc(`${day}T23:59:59`, zone);
			if (endOfDay !== null) recur.until = `${new Date(endOfDay).toISOString().slice(0, 19)}Z`;
		}
	}
}

export const updateEvent = defineTool({
	name: "calendar_update_event",
	title: "Change an event",
	description:
		'Changes only the given fields of an event, or moves it to another calendar. Repeating events need scope "this" (with occurrence_start) or "series". If the person organises it, invited people are told in NoCalendar.',
	input,
	async run(ctx, args) {
		const zone = checkZone(args.time_zone, ctx.time.zone);
		const ids = parseObjectId(args.event_id, "event_id", "event");
		const fieldChange = [args.title, args.start, args.end, args.all_day, args.location, args.description, args.reminder_minutes_before].some((v) => v !== undefined);
		if (!fieldChange && !args.move_to_calendar_id) {
			throw new ToolError("invalid_input", "Nothing to change: give at least one field, or move_to_calendar_id.");
		}
		const { principal, cals } = await loadHome(ctx.nc);
		const calendar = pickById(cals, ids.calId, "events", true, "event_id");
		// A field change in a published calendar is visible to anyone with its link (fix round 3).
		if (fieldChange) guardPublished(ctx, calendar, "event_id");
		const mine = new Set(principal.addresses.map((a) => a.toLowerCase()));
		const lookup = new PeopleLookup(ctx);
		let target: string | null = null;
		if (args.move_to_calendar_id) {
			const t = pickById(cals, args.move_to_calendar_id, "events", true, "move_to_calendar_id");
			if (t.id !== ids.calId) {
				target = t.id;
				guardPublished(ctx, t, "move_to_calendar_id");
			}
		}
		if (target) {
			// Checked before anything is written, so a change never half-happens.
			if (!movableName(ids.objId)) {
				throw new ToolError("not_available", "This event was saved by another app under a name that can't be moved from here; nothing was changed.", {
					field: "move_to_calendar_id",
					hint: "Move it in NoCalendar, or change it here without move_to_calendar_id.",
				});
			}
			const there = await ctx.nc.dav.get(objectPath(ctx.uid, target, ids.objId), { headers: { accept: "application/calendar+json" }, allow: [404] });
			await there.body?.cancel();
			if (there.status !== 404) throw new ToolError("already_exists", "That calendar already has an item with the same name, so nothing was changed or moved.", { field: "move_to_calendar_id" });
		}

		let plan: Plan | null = null;
		let scheduling = false;
		let attendeesPresent = false;
		let sched: SchedulingRole | null = null;
		let wasOne = false;
		for (let attempt = 0; attempt < 2; attempt++) {
			const obj = await getObject(ctx.nc, ids.calId, ids.objId, "event");
			if (args.expected_etag && obj.etag !== args.expected_etag) {
				throw new ToolError("conflict", `The event changed since it was read (etag now ${obj.etag ?? "unknown"}). List it again first.`, { field: "expected_etag" });
			}
			const work = JSON.parse(JSON.stringify(obj.cal)) as JComp;
			const { master } = masterOf(work);
			wasOne = repeats(master) && args.scope === "this";
			if (wasOne && target) throw new ToolError("invalid_input", 'One occurrence can\'t move to another calendar. Move the series (scope "series").', { field: "move_to_calendar_id" });
			attendeesPresent = hasAttendees(work);
			// Only the organizer's changes reach the invited people (people.ts); anyone else's change is
			// saved without scheduling.
			sched = attendeesPresent ? await schedulingRole(lookup, work, mine, calendar) : null;
			scheduling = schedulingFor(ctx, attendeesPresent) && Boolean(sched?.tellsInvited);
			if (!fieldChange) {
				if (repeats(master) && !args.scope) {
					throw new ToolError("invalid_input", 'This event repeats: give scope "series" to move the whole series.', { field: "scope" });
				}
				plan = { comp: master, prev: {}, changedFields: [], notes: [] };
				break;
			}
			plan = await apply(ctx, args, ids, work, zone);
			// The searches behind `notified` are counted before anything is written.
			if (scheduling && sched && attempt === 0) await lookup.reserve(notifySearches(work, sched.exclude));
			const status = await putObject(ctx.nc, ids.calId, ids.objId, work, { ifMatch: obj.etag, scheduling });
			if (status !== 412) break;
			if (args.expected_etag || attempt === 1) throw new ToolError("conflict", "The event changed while it was being saved. Read it again and retry.");
			plan = null;
		}
		if (!plan) throw new ToolError("conflict", "The event changed while it was being saved. Read it again and retry.");

		let calId = ids.calId;
		const warnings: string[] = [];
		let moveFailed = false;
		if (target) {
			try {
				const status = await moveObject(ctx.nc, ids.calId, ids.objId, target, null);
				if (status === 412) throw new ToolError("already_exists", "That calendar already has an item with the same name, so the event wasn't moved.", { field: "move_to_calendar_id" });
				calId = target;
			} catch (e) {
				// Nothing was changed yet: the plain error stands. Otherwise the saved change is reported.
				if (!fieldChange) throw e;
				moveFailed = true;
				warnings.push("The changes were saved, but the event couldn't be moved to the other calendar; it is still in its old one.");
			}
		}

		const back = await getObject(ctx.nc, calId, ids.objId, "event");
		const r = new ZoneResolver(back.cal, zone);
		const { master, overrides } = mainComps(back.cal, "vevent");
		let comp = master ?? overrides[0] ?? null;
		if (wasOne && args.occurrence_start && master) {
			const occ = parseWhen(ctx.time, args.occurrence_start, "occurrence_start", zone);
			comp = findOverride(overrides, occurrenceKey(master, occ), r) ?? comp;
		}
		const shown = comp
			? showEvent(comp, new ZoneResolver(back.cal, ctx.time.zone), {
					calId,
					objId: ids.objId,
					etag: back.etag,
					uid: ctx.uid,
					driveOrigin: ctx.cfg.driveOrigin,
					zone: ctx.time.zone,
					seriesMember: repeats(master),
				})
			: null;
		if (!shown) throw new ToolError("upstream_unavailable", "The change was saved but the event couldn't be read back. calendar_list_events shows it.");

		let notified: { id: string; display_name: string | null }[] = [];
		if (fieldChange && attendeesPresent && sched) {
			if (!sched.tellsInvited) warnings.push(notToldWarning(sched.role, "change", false));
			else if (scheduling) {
				const told = await notifiedPeople(lookup, back.cal, sched.exclude);
				notified = told.notified;
				warnings.push(...told.warnings);
			} else warnings.push("Attendees were not told about this change.");
		}
		warnings.push(...plan.notes);
		const cut = attendeesCutNote(shown.event);
		if (cut) warnings.push(cut);
		const event_id = `${calId}/${ids.objId}`;
		const undoArgs: Record<string, unknown> = { event_id };
		if (wasOne) {
			undoArgs.scope = "this";
			undoArgs.occurrence_start = shown.event.occurrence_start ?? args.occurrence_start;
		} else if (repeats(master)) undoArgs.scope = "series";
		const p = plan.prev;
		if (p.title !== undefined) undoArgs.title = p.title || "(no title)";
		if (p.start !== undefined) {
			undoArgs.start = p.start;
			undoArgs.end = p.end;
			undoArgs.all_day = p.all_day;
		}
		if (p.location !== undefined) undoArgs.location = p.location;
		if (p.description !== undefined) undoArgs.description = p.description;
		if (p.reminder_minutes_before !== undefined) undoArgs.reminder_minutes_before = p.reminder_minutes_before;
		const moved = Boolean(target) && !moveFailed;
		if (moved) undoArgs.move_to_calendar_id = ids.calId;
		return {
			data: { event: shown.event, notified },
			summary: `Changed the event${wasOne ? " (one occurrence)" : ""}${moved ? " and moved it to the other calendar" : ""}${notified.length ? `; NoCalendar tells ${notified.length} invited ${notified.length === 1 ? "person" : "people"} in the workspace` : ""}.`,
			undo: { tool: "calendar_update_event", arguments: undoArgs },
			...(warnings.length ? { warnings } : {}),
		};
	},
});

