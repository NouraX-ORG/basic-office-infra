/**
 * Events as the calendar tools show and write them (DESIGN 11.5).
 * - Times come back in the person's zone with an offset; all-day events give plain dates, and
 *   `end` is then the last day (inclusive), the same as the tools take it.
 * - Single timed events are written in UTC; repeating timed events with a TZID and a VTIMEZONE;
 *   all-day events with VALUE=DATE.
 * - Descriptions are cut to 2,000 characters on the way out.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import type { TimeApi } from "../../core/time";
import { toZonedIso, zonedToUtc } from "../../core/time";
import { addProp, type JComp, type JProp, mainComps, param, prop, props, removeProp, repeats, setProp, subs, text, utcStamp } from "../../pim/jcal";
import { addDays, type CalTime, dateString, daysBetween, durationSeconds, ianaOf, localDate, readTime, startOfDay, vtimezoneFor, wallString, type ZoneResolver } from "../../pim/tz";
import { eventWebUrl } from "./caldav";

export const ATTENDEES_OUT = 50;

export interface Attendee {
	name: string | null;
	email: string | null;
	status: string;
}

export interface EventOut {
	event_id: string;
	calendar_id: string;
	title: string;
	start: string;
	end: string;
	all_day: boolean;
	time_zone: string;
	location: string | null;
	description: string | null;
	status: "confirmed" | "tentative" | "cancelled";
	repeats: boolean;
	occurrence_start: string | null;
	reminder_minutes_before: number | null;
	attendees: Attendee[];
	/** Only when `attendees` is cut to the first ATTENDEES_OUT: how many the event lists in all. */
	attendees_total?: number;
	organizer: { name: string | null; email: string | null } | null;
	etag: string | null;
	web_url: string;
}

/** Start and end of one VEVENT, as read. */
export interface Span {
	allDay: boolean;
	/** Instants (for all-day: midnights in the display zone, end exclusive), for sorting and busy time. */
	startMs: number;
	endMs: number;
	/** All-day only: first and last day (inclusive). */
	firstDay?: { y: number; mo: number; d: number };
	lastDay?: { y: number; mo: number; d: number };
	tzid: string | null;
}

export function spanOf(vev: JComp, r: ZoneResolver, zone: string): Span | null {
	const ds = prop(vev, "dtstart");
	const st = readTime(ds, r);
	if (!st) return null;
	const tzid = ds ? param(ds, "tzid") : null;
	let en: CalTime | null = readTime(prop(vev, "dtend") ?? prop(vev, "due"), r);
	if (!en) {
		const dur = durationSeconds(prop(vev, "duration")?.[3]);
		if (st.kind === "date") {
			const days = dur !== null && dur > 0 ? Math.max(1, Math.round(dur / 86400)) : 1;
			en = { kind: "date", ...addDays(st, days) };
		} else en = { kind: "instant", utcMs: st.utcMs + Math.max(0, dur ?? 0) * 1000 };
	}
	if (st.kind === "date") {
		const endDate = en.kind === "date" ? en : localDate(en.utcMs, zone);
		const days = Math.max(1, daysBetween(st, endDate));
		const lastDay = addDays(st, days - 1);
		return {
			allDay: true,
			startMs: startOfDay(st, zone),
			endMs: startOfDay(addDays(st, days), zone),
			firstDay: { y: st.y, mo: st.mo, d: st.d },
			lastDay,
			tzid: null,
		};
	}
	const endMs = en.kind === "instant" ? en.utcMs : st.utcMs;
	return { allDay: false, startMs: st.utcMs, endMs: Math.max(endMs, st.utcMs), tzid };
}

function statusOf(vev: JComp): EventOut["status"] {
	const s = (text(vev, "status") ?? "").toUpperCase();
	if (s === "CANCELLED") return "cancelled";
	if (s === "TENTATIVE") return "tentative";
	return "confirmed";
}

function address(p: JProp): { name: string | null; email: string | null } {
	const v = typeof p[3] === "string" ? p[3] : "";
	const email = /^mailto:/i.test(v) ? v.slice(7).slice(0, 254) : null;
	const name = param(p, "cn");
	return { name: name ? name.slice(0, 200) : null, email };
}

/**
 * The first ATTENDEES_OUT attendees, and how many there are in all (fix round 3: the cut used to be
 * silent, so an event with 80 people looked as if it had exactly 50).
 */
export function attendeesOf(vev: JComp): { attendees: Attendee[]; total: number } {
	const all = props(vev, "attendee");
	return {
		attendees: all.slice(0, ATTENDEES_OUT).map((p) => ({ ...address(p), status: (param(p, "partstat") ?? "NEEDS-ACTION").toLowerCase().slice(0, 20) })),
		total: all.length,
	};
}

/** A warning for a single-event result whose attendee list was cut, or null. */
export function attendeesCutNote(e: EventOut): string | null {
	return e.attendees_total ? `This event lists ${e.attendees_total} attendees; only the first ${ATTENDEES_OUT} are shown.` : null;
}

/** One warning for a list in which any event's attendees were cut, or null. */
export function attendeesCutInList(events: readonly EventOut[]): string | null {
	return events.some((e) => e.attendees_total) ? `Some events list more than ${ATTENDEES_OUT} attendees; only the first ${ATTENDEES_OUT} are shown, and attendees_total gives the full count.` : null;
}

/** Seconds before the start of a reminder that is set relative to the start (at or before it), or null. */
function beforeStart(alarm: JComp): number | null {
	const trig = prop(alarm, "trigger");
	if (!trig || trig[2] !== "duration" || (param(trig, "related") ?? "START").toUpperCase() !== "START") return null;
	const s = durationSeconds(trig[3]);
	return s !== null && s <= 0 ? -s : null;
}

/** Minutes before the start of the first reminder set relative to the start, or null. */
export function reminderOf(vev: JComp): number | null {
	for (const a of subs(vev, "valarm")) {
		const s = beforeStart(a);
		if (s !== null) return Math.round(s / 60);
	}
	return null;
}

export interface ShowCtx {
	calId: string;
	objId: string;
	etag: string | null;
	uid: string;
	driveOrigin: string;
	zone: string;
	/** True when this VEVENT is one occurrence of a series (expanded or an override). */
	seriesMember: boolean;
}

function clip(s: string | null, max: number): string | null {
	if (s === null) return null;
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

export interface Shown {
	event: EventOut;
	span: Span;
}

/** One VEVENT (an expanded occurrence, an override or a single event) as the tools show it. */
export function showEvent(vev: JComp, r: ZoneResolver, c: ShowCtx): Shown | null {
	const span = spanOf(vev, r, c.zone);
	if (!span) return null;
	const rid = readTime(prop(vev, "recurrence-id"), r);
	const ridMs = rid ? (rid.kind === "date" ? Date.UTC(rid.y, rid.mo - 1, rid.d) : rid.utcMs) : null;
	const start = span.allDay && span.firstDay ? dateString(span.firstDay) : toZonedIso(span.startMs, c.zone);
	const end = span.allDay && span.lastDay ? dateString(span.lastDay) : toZonedIso(span.endMs, c.zone);
	const org = prop(vev, "organizer");
	const zoneOfEvent = ianaOf(span.tzid) ?? c.zone;
	const day = span.allDay && span.firstDay ? dateString(span.firstDay) : dateString(localDate(span.startMs, c.zone));
	const people = attendeesOf(vev);
	const event: EventOut = {
		event_id: `${c.calId}/${c.objId}`,
		calendar_id: c.calId,
		title: (text(vev, "summary") ?? "").slice(0, 300),
		start,
		end,
		all_day: span.allDay,
		time_zone: zoneOfEvent,
		location: clip(text(vev, "location"), 500),
		description: clip(text(vev, "description"), LIMITS.descriptionOutChars),
		status: statusOf(vev),
		repeats: c.seriesMember || repeats(vev) || ridMs !== null,
		occurrence_start: rid ? (rid.kind === "date" ? dateString(rid) : toZonedIso(rid.utcMs, c.zone)) : null,
		reminder_minutes_before: reminderOf(vev),
		attendees: people.attendees,
		...(people.total > people.attendees.length ? { attendees_total: people.total } : {}),
		organizer: org ? address(org) : null,
		etag: c.etag,
		web_url: eventWebUrl(c.driveOrigin, c.uid, c.calId, c.objId, rid && rid.kind === "instant" ? rid.utcMs : null, day),
	};
	return { event, span };
}

// ---- Input shapes shared by create and update --------------------------------------------------

export const timeArg = (what: string) => z.string().max(40).describe(what);

export const zoneArg = () => z.string().max(64).describe("IANA zone name.");

export const repeatArg = () =>
	z
		.object({
			frequency: z.enum(["daily", "weekly", "monthly", "yearly"]).describe("How often."),
			interval: z.number().int().min(1).max(99).default(1).describe("Every n."),
			count: z.number().int().min(1).max(730).optional().describe("Times in all."),
			until: z.string().max(10).optional().describe("Last day."),
			weekdays: z
				.array(z.enum(["mo", "tu", "we", "th", "fr", "sa", "su"]))
				.min(1)
				.max(7)
				.optional()
				.describe("Daily or weekly only."),
		})
		.strict()
		.describe("Repeat.");

export type RepeatIn = z.output<ReturnType<typeof repeatArg>>;

export function checkZone(raw: string | undefined, fallback: string, field = "time_zone"): string {
	if (raw === undefined) return fallback;
	const z0 = ianaOf(raw);
	if (!z0) throw new ToolError("invalid_input", `The time zone "${raw.slice(0, 64)}" isn't known. Use an IANA name such as "Europe/London".`, { field });
	return z0;
}

/** A start or end from input: a date (all-day) or an instant. */
export type When = { kind: "date"; y: number; mo: number; d: number } | { kind: "instant"; utcMs: number };

export function parseWhen(time: TimeApi, raw: string, field: string, zone: string): When {
	const t = time.parse(raw, field, zone);
	return t.kind === "date" ? { kind: "date", y: t.y, mo: t.mo, d: t.d } : { kind: "instant", utcMs: t.utcMs };
}

const MAX_EVENT_MS = 366 * 86_400_000;

export interface NewTimes {
	allDay: boolean;
	startMs: number;
	endMs: number;
	firstDay?: { y: number; mo: number; d: number };
	/** All-day: the day after the last day (DTEND, exclusive). */
	endDay?: { y: number; mo: number; d: number };
}

/** Works out start and end from create-style input; refuses impossible combinations plainly. */
export function resolveTimes(a: { start: When; end?: When; durationMin?: number; allDay?: boolean }, zone: string): NewTimes {
	const wantAllDay = a.allDay ?? a.start.kind === "date";
	if (wantAllDay) {
		const first = a.start.kind === "date" ? a.start : localDate(a.start.utcMs, zone);
		let last = first;
		if (a.end) last = a.end.kind === "date" ? a.end : localDate(a.end.utcMs, zone);
		else if (a.durationMin !== undefined) last = addDays(first, Math.max(1, Math.ceil(a.durationMin / 1440)) - 1);
		const days = daysBetween(first, last) + 1;
		if (days < 1) throw new ToolError("invalid_input", `end (${dateString(last)}) is before start (${dateString(first)}). For all-day events end is the last day.`, { field: "end" });
		if (days > 366) throw new ToolError("invalid_input", "An event can last at most 366 days.", { field: "end" });
		const endDay = addDays(first, days);
		return { allDay: true, startMs: Date.UTC(first.y, first.mo - 1, first.d), endMs: Date.UTC(endDay.y, endDay.mo - 1, endDay.d), firstDay: first, endDay };
	}
	if (a.start.kind === "date") throw new ToolError("invalid_input", 'start needs a time unless all_day is true (for example "2026-11-03T14:30").', { field: "start" });
	const startMs = a.start.utcMs;
	let endMs: number;
	if (a.end) {
		if (a.end.kind === "date") throw new ToolError("invalid_input", 'end needs a time too (for example "2026-11-03T15:30").', { field: "end" });
		endMs = a.end.utcMs;
	} else endMs = startMs + (a.durationMin ?? 60) * 60_000;
	if (endMs <= startMs) {
		throw new ToolError("invalid_input", `end must be after start (you gave ${toZonedIso(startMs, zone)} to ${toZonedIso(endMs, zone)}).`, { field: "end" });
	}
	if (endMs - startMs > MAX_EVENT_MS) throw new ToolError("invalid_input", "An event can last at most 366 days.", { field: "end" });
	return { allDay: false, startMs, endMs };
}

const WEEKDAY: Record<string, string> = { mo: "MO", tu: "TU", we: "WE", th: "TH", fr: "FR", sa: "SA", su: "SU" };

/** The jCal recur value for a repeat; `until` is the last day, inclusive, in the event's zone. */
export function recurValue(r: RepeatIn, allDay: boolean, zone: string, startMs: number): Record<string, unknown> {
	if (r.count !== undefined && r.until !== undefined) throw new ToolError("invalid_input", "Give count or until, not both.", { field: "repeat" });
	if (r.weekdays && r.frequency !== "daily" && r.frequency !== "weekly") {
		throw new ToolError("invalid_input", "weekdays works with a daily or weekly repeat.", { field: "repeat.weekdays" });
	}
	const out: Record<string, unknown> = { freq: r.frequency.toUpperCase() };
	if (r.interval > 1) out.interval = r.interval;
	if (r.count !== undefined) out.count = r.count;
	if (r.until !== undefined) {
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.until);
		const d = m ? { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) } : null;
		if (!d || dateString(d) !== r.until || Number.isNaN(Date.UTC(d.y, d.mo - 1, d.d))) throw new ToolError("invalid_input", "repeat.until must be a date like 2026-12-31.", { field: "repeat.until" });
		const startDay = allDay ? { y: new Date(startMs).getUTCFullYear(), mo: new Date(startMs).getUTCMonth() + 1, d: new Date(startMs).getUTCDate() } : localDate(startMs, zone);
		if (daysBetween(startDay, d) < 0) throw new ToolError("invalid_input", "repeat.until is before the first time.", { field: "repeat.until" });
		// For timed events: the last second of that day in the event's zone, in UTC (RFC 5545 3.3.10).
		out.until = allDay ? r.until : utcStamp(zonedToUtc(d.y, d.mo, d.d, 23, 59, 59, zone));
	}
	if (r.weekdays?.length) out.byday = [...new Set(r.weekdays)].map((w) => WEEKDAY[w]);
	return out;
}

/** Writes DTSTART/DTEND for new times: all-day as dates, repeating timed with TZID, else UTC. */
export function writeTimes(vev: JComp, t: NewTimes, opts: { tzid: string | null }): void {
	removeProp(vev, "duration");
	if (t.allDay && t.firstDay && t.endDay) {
		setProp(vev, "dtstart", {}, "date", dateString(t.firstDay));
		setProp(vev, "dtend", {}, "date", dateString(t.endDay));
		return;
	}
	// A TZID we can't compute wall times for (no IANA name behind it) is written in UTC instead.
	const iana = ianaOf(opts.tzid);
	if (opts.tzid && iana && iana !== "UTC") {
		setProp(vev, "dtstart", { tzid: opts.tzid }, "date-time", wallString(t.startMs, iana));
		setProp(vev, "dtend", { tzid: opts.tzid }, "date-time", wallString(t.endMs, iana));
		return;
	}
	setProp(vev, "dtstart", {}, "date-time", utcStamp(t.startMs));
	setProp(vev, "dtend", {}, "date-time", utcStamp(t.endMs));
}

/** Makes sure the calendar object carries a VTIMEZONE for every IANA TZID it uses. */
export function ensureVtimezones(cal: JComp): void {
	const used = new Set<string>();
	for (const c of cal[2]) {
		for (const p of c[1]) {
			const tz = param(p, "tzid");
			if (tz) used.add(tz);
		}
	}
	const have = new Set(subs(cal, "vtimezone").map((v) => String(prop(v, "tzid")?.[3] ?? "")));
	for (const tz of used) {
		if (have.has(tz) || ianaOf(tz) !== tz) continue;
		const block = vtimezoneFor(tz);
		if (block) cal[2].unshift(JSON.parse(JSON.stringify(block)) as JComp);
	}
}

function trigger(minutes: number): string {
	return minutes === 0 ? "PT0S" : `-PT${minutes}M`;
}

/**
 * Sets the reminder that reminder_minutes_before stands for: the first one set relative to the start
 * (fix round 2: other reminders used to be thrown away, so an undo couldn't bring them back).
 * - A number changes that reminder's time in place (its other details stay), or adds a display
 *   reminder when there is none; every other reminder stays.
 * - null removes the reminders set before the start; reminders at a fixed time or after the start
 *   stay (reminder_minutes_before never shows them).
 * Returns the old value (for the undo) and plain notes when the undo can't rebuild what was there.
 */
export function setReminder(vev: JComp, minutes: number | null, title: string): { before: number | null; notes: string[] } {
	const alarms = subs(vev, "valarm");
	const covered = alarms.filter((a) => beforeStart(a) !== null);
	const before = reminderOf(vev);
	const notes: string[] = [];
	const others = alarms.length - covered.length;
	if (minutes === null) {
		vev[2] = vev[2].filter((c) => !covered.includes(c));
		if (covered.length > 1) notes.push(`This event had ${covered.length} reminders before its start; the undo puts back only the first one (${before} minutes before).`);
		if (others) notes.push(`${others} other reminder${others === 1 ? "" : "s"} (at a set time, or after the start) ${others === 1 ? "stays" : "stay"}; NoCalendar can change ${others === 1 ? "it" : "them"}.`);
		return { before, notes };
	}
	const first = covered[0];
	const trig = first ? prop(first, "trigger") : undefined;
	if (trig) {
		trig[1] = {};
		trig[2] = "duration";
		trig[3] = trigger(minutes);
		trig.length = 4;
		return { before, notes };
	}
	vev[2].push([
		"valarm",
		[
			["action", {}, "text", "DISPLAY"],
			["description", {}, "text", title.slice(0, 255) || "Reminder"],
			["trigger", {}, "duration", trigger(minutes)],
		],
		[],
	]);
	return { before, notes };
}

/** Bumps SEQUENCE and the change stamps (RFC 5545: every significant change). */
export function touch(vev: JComp, now: number): void {
	const seq = Number(prop(vev, "sequence")?.[3] ?? 0);
	setProp(vev, "sequence", {}, "integer", Number.isFinite(seq) ? seq + 1 : 1);
	setProp(vev, "dtstamp", {}, "date-time", utcStamp(now));
	setProp(vev, "last-modified", {}, "date-time", utcStamp(now));
}

/** Whether any VEVENT of the object has attendees (scheduling then matters). */
export function hasAttendees(cal: JComp): boolean {
	return subs(cal, "vevent").some((v) => props(v, "attendee").length > 0);
}

/** The SCHEDULE-STATUS codes NoCalendar wrote on the attendees, by lower-case email address. */
export function scheduleStatuses(cal: JComp): Map<string, string> {
	const out = new Map<string, string>();
	for (const v of subs(cal, "vevent")) {
		for (const p of props(v, "attendee")) {
			const a = typeof p[3] === "string" ? p[3] : "";
			const s = param(p, "schedule-status");
			if (/^mailto:/i.test(a) && s) out.set(a.slice(7).toLowerCase(), s);
		}
	}
	return out;
}

/**
 * Whether SCHEDULE-STATUS proves that NoCalendar could not hand the message over inside the
 * workspace: "3.x" (no such person, no permission) or "5.2" (no inbox). Nothing proves success:
 * the email step (iMIP) runs after the delivery inside the workspace and overwrites its code for
 * every event still to come ("5.0" while the server has no outgoing mail), so a failed local
 * delivery can hide behind "5.0", "1.x" or no code at all (review fix round 1). The tools therefore
 * report people as invited or asked to be told, never as having received anything.
 */
export function deliveryFailed(code: string | undefined): boolean {
	if (!code) return false;
	return /^3\./.test(code) || /^5\.2/.test(code);
}

/** The master VEVENT, or a plain error when the object is not an event. */
export function masterOf(cal: JComp): { master: JComp; overrides: JComp[] } {
	const { master, overrides } = mainComps(cal, "vevent");
	if (master) return { master, overrides };
	if (overrides.length) return { master: overrides[0] as JComp, overrides: overrides.slice(1) };
	throw new ToolError("not_found", "That id isn't an event. calendar_list_events finds events and their ids.");
}

/** The UTC instant (or date as midnight UTC) of a RECURRENCE-ID or DTSTART-like property. */
export function instantKey(p: JProp | undefined, r: ZoneResolver): number | null {
	const t = readTime(p, r);
	if (!t) return null;
	return t.kind === "date" ? Date.UTC(t.y, t.mo - 1, t.d) : t.utcMs;
}

/** A RECURRENCE-ID/EXDATE property for one occurrence, written the way the master's DTSTART is. */
export function occurrenceProp(name: "recurrence-id" | "exdate", master: JComp, occ: When): JProp {
	const ds = prop(master, "dtstart");
	if (ds?.[2] === "date") {
		const d = occ.kind === "date" ? occ : { y: new Date(occ.utcMs).getUTCFullYear(), mo: new Date(occ.utcMs).getUTCMonth() + 1, d: new Date(occ.utcMs).getUTCDate() };
		return [name, {}, "date", dateString(d)];
	}
	if (occ.kind === "date") throw new ToolError("invalid_input", "occurrence_start needs the time of that occurrence, as calendar_list_events gives it.", { field: "occurrence_start" });
	const tz = ds ? param(ds, "tzid") : null;
	const iana = ianaOf(tz);
	if (tz && iana && iana !== "UTC") return [name, { tzid: tz }, "date-time", wallString(occ.utcMs, iana)];
	return [name, {}, "date-time", utcStamp(occ.utcMs)];
}

export function addOccurrenceProp(vev: JComp, p: JProp): void {
	addProp(vev, p[0], p[1], p[2], ...p.slice(3));
}
