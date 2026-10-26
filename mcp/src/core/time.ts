/**
 * Times (DESIGN 10.6). Input is ISO 8601. A time without an offset is read in the given time zone
 * (the argument, else the person's zone). A plain date means all day. Output always carries an
 * offset. Built on Intl only, so it runs on workerd with no time-zone data of our own.
 */
import { ToolError } from "./errors";

const zoneCache = new Map<string, Intl.DateTimeFormat>();

function fmt(zone: string): Intl.DateTimeFormat {
	let f = zoneCache.get(zone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		zoneCache.set(zone, f);
	}
	return f;
}

export function isValidZone(zone: unknown): zone is string {
	if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) return false;
	try {
		fmt(zone);
		return true;
	} catch {
		return false;
	}
}

/** Wall-clock parts of an instant in a zone. */
export function partsIn(utcMs: number, zone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number; weekday: number } {
	const parts: Record<string, string> = {};
	for (const p of fmt(zone).formatToParts(new Date(utcMs))) parts[p.type] = p.value;
	const y = Number(parts.year);
	const mo = Number(parts.month);
	const d = Number(parts.day);
	const h = Number(parts.hour) % 24;
	const mi = Number(parts.minute);
	const s = Number(parts.second);
	const weekday = ((new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7) + 1; // 1 = Monday .. 7 = Sunday
	return { y, mo, d, h, mi, s, weekday };
}

/** Offset of the zone from UTC at an instant, in minutes (east positive). */
export function offsetMinutes(utcMs: number, zone: string): number {
	const p = partsIn(utcMs, zone);
	const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
	return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/** The instant for a wall-clock time in a zone. For a skipped (DST gap) time, the later valid one. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): number {
	const guess = Date.UTC(y, mo - 1, d, h, mi, s);
	let t = guess - offsetMinutes(guess, zone) * 60000;
	const off2 = offsetMinutes(t, zone);
	t = guess - off2 * 60000;
	return t;
}

function pad(n: number, w = 2): string {
	return String(Math.abs(n)).padStart(w, "0");
}

/** "2026-10-25T09:00:00+01:00" */
export function toZonedIso(utcMs: number, zone: string): string {
	const p = partsIn(utcMs, zone);
	const off = offsetMinutes(utcMs, zone);
	const sign = off >= 0 ? "+" : "-";
	return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

export function toDateString(y: number, mo: number, d: number): string {
	return `${pad(y, 4)}-${pad(mo)}-${pad(d)}`;
}

export type ParsedTime = { kind: "instant"; utcMs: number } | { kind: "date"; y: number; mo: number; d: number };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i;

function validDate(y: number, mo: number, d: number): boolean {
	if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return false;
	const t = new Date(Date.UTC(y, mo - 1, d));
	return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Parses an ISO 8601 date or date-time. Times without an offset are read in `zone`. */
export function parseTime(raw: unknown, zone: string, field = "time"): ParsedTime {
	if (typeof raw !== "string") throw new ToolError("invalid_input", `${field} must be an ISO 8601 date or date-time.`, { field });
	const s = raw.trim();
	const dm = DATE_RE.exec(s);
	if (dm) {
		const y = Number(dm[1]);
		const mo = Number(dm[2]);
		const d = Number(dm[3]);
		if (!validDate(y, mo, d)) throw new ToolError("invalid_input", `${field} isn't a real date (${s}).`, { field });
		return { kind: "date", y, mo, d };
	}
	const m = DT_RE.exec(s);
	if (!m) {
		throw new ToolError("invalid_input", `${field} must look like 2026-11-03 or 2026-11-03T14:30 (you gave "${s.slice(0, 40)}").`, { field });
	}
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	const h = Number(m[4]);
	const mi = Number(m[5]);
	const sec = Number(m[6] ?? "0");
	if (!validDate(y, mo, d) || h > 23 || mi > 59 || sec > 59) throw new ToolError("invalid_input", `${field} isn't a real time (${s}).`, { field });
	const off = m[7];
	if (off) {
		let minutes = 0;
		if (off.toUpperCase() !== "Z") {
			const om = /^([+-])(\d{2}):?(\d{2})$/.exec(off);
			if (!om) throw new ToolError("invalid_input", `${field} has an invalid offset.`, { field });
			minutes = (om[1] === "-" ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3]));
		}
		return { kind: "instant", utcMs: Date.UTC(y, mo - 1, d, h, mi, sec) - minutes * 60000 };
	}
	if (!isValidZone(zone)) throw new ToolError("invalid_input", `The time zone "${zone}" isn't known.`, { field: "time_zone" });
	return { kind: "instant", utcMs: zonedToUtc(y, mo, d, h, mi, sec, zone) };
}

/** Helpers handed to tools as ctx.time. */
export interface TimeApi {
	/** The person's zone for this call (argument > NoDrive setting > default calendar > DEFAULT_TIME_ZONE). */
	zone: string;
	parse(raw: unknown, field?: string, zone?: string): ParsedTime;
	format(utcMs: number, zone?: string): string;
	now(): number;
}

export function timeApi(zone: string): TimeApi {
	return {
		zone,
		parse: (raw, field, z) => parseTime(raw, z ?? zone, field),
		format: (utcMs, z) => toZonedIso(utcMs, z ?? zone),
		now: () => Date.now(),
	};
}
