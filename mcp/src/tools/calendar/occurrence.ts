/**
 * One occurrence of a repeating event (scope "this"). An override VEVENT carries the occurrence's
 * RECURRENCE-ID, written the way the master's DTSTART is (TZID, UTC or a date). Whether the
 * occurrence exists is asked of NoCalendar itself: a calendar-multiget of the one object, expanded
 * in a small window around occurrence_start (checked live: it honours RRULE, EXDATE and overrides).
 */
import { ToolError } from "../../core/errors";
import type { ToolCtx } from "../../core/tool";
import { cloneComp, type JComp, type JProp, parseJcal, prop, removeProp, setProp, subs } from "../../pim/jcal";
import { addDays, dateString, daysBetween, readTime, ZoneResolver } from "../../pim/tz";
import { NS, propText } from "../../nc/index";
import { calendarPath, multigetExpandBody } from "./caldav";
import { instantKey, occurrenceProp, spanOf, type When, writeTimes } from "./events";

/**
 * Properties an override may differ in from its series without that being a change of its own:
 * stamps and SEQUENCE, STATUS (marking one occurrence cancelled is what calendar_cancel_event's
 * mark_cancelled does), the occurrence's own times (checked separately) and the series' rules.
 */
const NOT_OWN = new Set(["dtstamp", "last-modified", "created", "sequence", "status", "recurrence-id", "dtstart", "dtend", "duration", "rrule", "rdate", "exdate", "exrule"]);
/** Parameters NoCalendar writes itself after each delivery (never something a person changed). */
const SERVER_PARAMS = new Set(["schedule-status", "schedule-force-send", "schedule-agent"]);

function canonProp(p: JProp): string {
	const params = Object.entries(p[1])
		.map(([k, v]) => [k.toLowerCase(), v] as const)
		.filter(([k]) => !SERVER_PARAMS.has(k))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return JSON.stringify([p[0].toLowerCase(), params, p[2].toLowerCase(), ...p.slice(3)]);
}

function canonComp(c: JComp): string {
	return JSON.stringify([c[0].toLowerCase(), c[1].map(canonProp).sort(), c[2].map(canonComp).sort()]);
}

/**
 * Whether an override holds something of its own that removing the occurrence would lose for good
 * (fix round 3): another start than its occurrence's, another length than the series', or any
 * other property, reminder or attendee answer that differs from the series. An override that only
 * marks the occurrence cancelled, or a plain copy of the series, has nothing of its own.
 */
export function hasOwnChanges(override: JComp, master: JComp, r: ZoneResolver, zone: string): boolean {
	const rid = instantKey(prop(override, "recurrence-id"), r);
	const own = spanOf(override, r, zone);
	const series = spanOf(master, r, zone);
	if (rid === null || !own || !series || own.allDay !== series.allDay) return true;
	if (own.allDay) {
		if (!own.firstDay || !own.lastDay || !series.firstDay || !series.lastDay) return true;
		if (Date.UTC(own.firstDay.y, own.firstDay.mo - 1, own.firstDay.d) !== rid) return true;
		if (daysBetween(own.firstDay, own.lastDay) !== daysBetween(series.firstDay, series.lastDay)) return true;
	} else if (own.startMs !== rid || own.endMs - own.startMs !== series.endMs - series.startMs) return true;
	const rest = (c: JComp): string[] => c[1].filter((p) => !NOT_OWN.has(p[0].toLowerCase())).map(canonProp).sort();
	if (JSON.stringify(rest(override)) !== JSON.stringify(rest(master))) return true;
	return JSON.stringify(override[2].map(canonComp).sort()) !== JSON.stringify(master[2].map(canonComp).sort());
}

/** The key an occurrence is matched by: its UTC instant, or a date as UTC midnight. */
export function occurrenceKey(master: JComp, occ: When): number {
	const isDate = prop(master, "dtstart")?.[2] === "date";
	if (isDate) {
		if (occ.kind === "date") return Date.UTC(occ.y, occ.mo - 1, occ.d);
		const d = new Date(occ.utcMs);
		return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	}
	if (occ.kind === "date") throw new ToolError("invalid_input", "occurrence_start needs the time of that occurrence, as calendar_list_events gives it.", { field: "occurrence_start" });
	return occ.utcMs;
}

export function findOverride(overrides: readonly JComp[], key: number, r: ZoneResolver): JComp | null {
	return overrides.find((o) => instantKey(prop(o, "recurrence-id"), r) === key) ?? null;
}

/** The expanded occurrence at `key`, as NoCalendar computes it, or null when there is none. */
async function expandedAt(ctx: ToolCtx, calId: string, objId: string, isDate: boolean, key: number, zone: string): Promise<JComp | null> {
	const from = isDate ? key - 86_400_000 : key - 60_000;
	const to = isDate ? key + 2 * 86_400_000 : key + 60_000;
	const res = await ctx.nc.dav.report(calendarPath(ctx.uid, calId), multigetExpandBody(ctx.uid, calId, objId, from, to), { depth: 1 });
	for (const r of res) {
		const data = propText(r, NS.cal, "calendar-data");
		if (!data) continue;
		let cal: JComp;
		try {
			cal = parseJcal(data);
		} catch {
			continue;
		}
		const zr = new ZoneResolver(cal, zone);
		for (const v of subs(cal, "vevent")) if (instantKey(prop(v, "recurrence-id"), zr) === key) return v;
	}
	return null;
}

/**
 * The override for one occurrence: the existing one, or a new one copied from the master with the
 * occurrence's own start and end. Throws not_found when the series has no such occurrence.
 */
export async function overrideFor(
	ctx: ToolCtx,
	ids: { calId: string; objId: string },
	work: JComp,
	master: JComp,
	overrides: readonly JComp[],
	occ: When,
	zone: string,
): Promise<{ comp: JComp; created: boolean }> {
	const r = new ZoneResolver(work, zone);
	const key = occurrenceKey(master, occ);
	const existing = findOverride(overrides, key, r);
	if (existing) return { comp: existing, created: false };
	const isDate = prop(master, "dtstart")?.[2] === "date";
	const inst = await expandedAt(ctx, ids.calId, ids.objId, isDate, key, zone);
	if (!inst) {
		throw new ToolError("not_found", "That repeating event has no occurrence at occurrence_start.", {
			field: "occurrence_start",
			hint: "calendar_list_events lists each occurrence with its occurrence_start.",
		});
	}
	const span = spanOf(inst, new ZoneResolver(null, zone), zone);
	const comp = cloneComp(master);
	for (const n of ["rrule", "rdate", "exdate", "exrule", "recurrence-id"]) removeProp(comp, n);
	const rid = occurrenceProp("recurrence-id", master, occ);
	comp[1].push(rid);
	if (span) {
		const ds = prop(master, "dtstart");
		const tz = ds?.[1].tzid;
		if (isDate && span.firstDay && span.lastDay) {
			const endDay = addDays(span.lastDay, 1);
			setProp(comp, "dtstart", {}, "date", dateString(span.firstDay));
			setProp(comp, "dtend", {}, "date", dateString(endDay));
			removeProp(comp, "duration");
		} else {
			writeTimes(comp, { allDay: false, startMs: span.startMs, endMs: span.endMs }, { tzid: typeof tz === "string" ? tz : null });
		}
	}
	work[2].push(comp);
	return { comp, created: true };
}

/** Read the start of an occurrence for undo hints and results. */
export function occurrenceStartOf(comp: JComp, zone: string): ReturnType<typeof readTime> {
	return readTime(prop(comp, "recurrence-id"), new ZoneResolver(null, zone));
}
