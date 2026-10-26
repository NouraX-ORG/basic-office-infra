/**
 * Free time (DESIGN 11.5, calendar_find_free_time): pure interval arithmetic, no I/O.
 * Busy times come from an expanded calendar-query over the person's own calendars (the tool
 * decides which events count as busy). Working hours are wall-clock times in one zone, so a
 * working day stays 09:00 to 17:00 across daylight-saving changes.
 */
import { partsIn, zonedToUtc } from "../core/time";
import { addDays, localDate } from "./tz";

export interface Interval {
	start: number;
	end: number;
}

export interface WorkingHours {
	/** Minutes after local midnight, 0..1439. */
	fromMin: number;
	/** Minutes after local midnight, 1..1440 (1440 = the next midnight). Always > fromMin. */
	toMin: number;
	/** 1 = Monday .. 7 = Sunday. */
	weekdays: readonly number[];
}

/** Sorted, with overlapping and touching intervals joined. Empty and inverted ones are dropped. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
	const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end);
	const out: Interval[] = [];
	for (const i of sorted) {
		const last = out[out.length - 1];
		if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
		else out.push({ start: i.start, end: i.end });
	}
	return out;
}

/** The working-hours windows between two instants, day by day in `zone`. */
export function workingWindows(range: Interval, wh: WorkingHours, zone: string): Interval[] {
	const out: Interval[] = [];
	if (range.end <= range.start) return out;
	let day = localDate(range.start, zone);
	const last = localDate(range.end, zone);
	for (let guard = 0; guard < 400; guard++) {
		const weekday = ((new Date(Date.UTC(day.y, day.mo - 1, day.d)).getUTCDay() + 6) % 7) + 1;
		if (wh.weekdays.includes(weekday)) {
			const from = zonedToUtc(day.y, day.mo, day.d, Math.floor(wh.fromMin / 60), wh.fromMin % 60, 0, zone);
			const next = addDays(day, 1);
			const to =
				wh.toMin >= 1440
					? zonedToUtc(next.y, next.mo, next.d, 0, 0, 0, zone)
					: zonedToUtc(day.y, day.mo, day.d, Math.floor(wh.toMin / 60), wh.toMin % 60, 0, zone);
			const s = Math.max(from, range.start);
			const e = Math.min(to, range.end);
			if (e > s) out.push({ start: s, end: e });
		}
		if (day.y === last.y && day.mo === last.mo && day.d === last.d) break;
		day = addDays(day, 1);
	}
	return out;
}

/** `windows` minus `busy` (both sorted and merged by the caller or not; this merges busy). */
export function subtract(windows: readonly Interval[], busy: readonly Interval[]): Interval[] {
	const b = mergeIntervals(busy);
	const out: Interval[] = [];
	for (const w of windows) {
		let cur = w.start;
		for (const x of b) {
			if (x.end <= cur) continue;
			if (x.start >= w.end) break;
			if (x.start > cur) out.push({ start: cur, end: Math.min(x.start, w.end) });
			cur = Math.max(cur, x.end);
			if (cur >= w.end) break;
		}
		if (cur < w.end) out.push({ start: cur, end: w.end });
	}
	return out;
}

/** The first instant at or after `t` that falls on a `stepMin` boundary of the local clock. */
export function alignUp(t: number, stepMin: number, zone: string): number {
	const p = partsIn(t, zone);
	const minutes = p.h * 60 + p.mi;
	const exact = p.s === 0 && t % 1000 === 0 && minutes % stepMin === 0;
	if (exact) return t;
	const startOfMinute = t - p.s * 1000 - (t % 1000);
	const add = stepMin - (minutes % stepMin);
	return startOfMinute + add * 60_000;
}

export interface FreeTimeQuery {
	range: Interval;
	busy: readonly Interval[];
	durationMin: number;
	stepMin: number;
	workingHours: WorkingHours;
	zone: string;
	max: number;
}

/**
 * Free slots of exactly `durationMin`, earliest first, starting on the local `stepMin` grid and
 * placed back to back inside each free gap (09:00-10:00, 10:00-11:00, ...), at most `max`.
 */
export function freeSlots(q: FreeTimeQuery): Interval[] {
	const dur = q.durationMin * 60_000;
	const advance = Math.ceil(q.durationMin / q.stepMin) * q.stepMin * 60_000;
	const gaps = subtract(workingWindows(q.range, q.workingHours, q.zone), q.busy);
	const out: Interval[] = [];
	for (const g of gaps) {
		let s = alignUp(g.start, q.stepMin, q.zone);
		while (s + dur <= g.end) {
			out.push({ start: s, end: s + dur });
			if (out.length >= q.max) return out;
			s += advance;
		}
	}
	return out;
}

/** "HH:MM" (00:00 to 24:00) to minutes, or null. */
export function hhmm(s: string): number | null {
	const m = /^(\d{2}):(\d{2})$/.exec(s);
	if (!m) return null;
	const h = Number(m[1]);
	const mi = Number(m[2]);
	if (mi > 59 || h > 24 || (h === 24 && mi !== 0)) return null;
	return h * 60 + mi;
}
