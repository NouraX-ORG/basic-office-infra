/**
 * Time zones for calendar data (DESIGN 11.5).
 * - Reading: a DATE-TIME with a TZID is turned into an instant. IANA names (the usual case, and
 *   what NoCalendar writes) go through Intl; other names (Outlook's "W. Europe Standard Time",
 *   "/mozilla.org/.../Europe/Berlin") use the VTIMEZONE in the same object; a floating time is read
 *   in the person's zone.
 * - Writing: repeating timed events carry a TZID plus a VTIMEZONE from timezones-ical-library, so
 *   they keep their wall-clock time across daylight-saving changes (phone clients want the block).
 *
 * A VTIMEZONE comes from whoever wrote the object: a colleague who shares a task list or calendar,
 * or an organizer whose invitation NoCalendar copied in. ical.js expands a VTIMEZONE's rules from
 * their DTSTART up to the year asked for, whatever their frequency, so a crafted block
 * (FREQ=MINUTELY from 1970) kept the Worker busy for tens of seconds in one synchronous loop
 * (security review, fix round 2). Such blocks are therefore never given to ical.js. RuleZone below
 * reads them itself, in bounded work and without walking through the years:
 * - only the shapes real time zones use: STANDARD and DAYLIGHT parts with a DTSTART, the two
 *   offsets, RDATE lists and at most one RRULE each, which must be FREQ=YEARLY with one month, at
 *   most one weekday (like "-1SU") and at most 7 month days (like 8 to 14); COUNT only where each
 *   year has exactly one change;
 * - at most 64 parts, 8 of them with a rule, and 1,000 RDATE values per block;
 * - each lookup works out the changes of a few years around the instant asked for (at most 6 rule
 *   years back, VTZ_LIMITS.stepsBack), so its cost doesn't depend on DTSTART or on how far away the
 *   year is.
 * Zone names are read without Intl unless the name is a real one (fix round 3, zoneName below).
 * Anything else makes the block unusable: its X-LIC-LOCATION is used when that names an IANA zone,
 * otherwise the time is read as floating (in the person's zone), as a broken block always was.
 */
import ICAL from "ical.js";
import { tzlib_get_ical_block, tzlib_get_timezones } from "timezones-ical-library";
import { isValidZone, partsIn, toDateString, zonedToUtc } from "../core/time";
import { type JComp, type JProp, param, prop, props, subs } from "./jcal";

export type CalTime = { kind: "date"; y: number; mo: number; d: number } | { kind: "instant"; utcMs: number };

const UTC_NAMES = new Set(["utc", "z", "gmt", "etc/utc", "etc/gmt", "zulu", "universal"]);
const REGION = /(?:^|\/)((?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?)$/;
/** No zone name is this long (Outlook's names, the longest real TZIDs, are about 60 characters). */
const TZID_MAX = 255;

let known: Set<string> | null = null;
/** timezones-ical-library's zone names (601 in 2.3.2, links such as "US/Eastern" included), by lower case. */
let byLower: Map<string, string> | null = null;
/** Whether Intl accepts each of those names, asked once per name (at most 601 entries). */
const accepted = new Map<string, string | null>();

function zoneList(): Set<string> {
	if (!known) {
		try {
			const list = tzlib_get_timezones();
			known = new Set(Array.isArray(list) ? list : (JSON.parse(list) as string[]));
		} catch {
			known = new Set();
		}
	}
	return known;
}

/**
 * The library's spelling of a zone name, when Intl accepts it too; null otherwise.
 * Fix round 3: an unknown name such as "Europe/Nope" used to cost a failed Intl.DateTimeFormat
 * (about 26 µs) on every time read from it, and core caches only the zones that work, so a shared
 * list of 5,000 tasks with a made-up TZID was read about three times slower than with a real one.
 * Now a name reaches Intl only when it is in the library's list, and each one at most once. Every
 * name Intl accepts is in that list (checked 2026-10-26 against the 597 names of the IANA database:
 * none missing), so nothing real is lost; the four the list adds itself (CT, ET, MT, PT) fail the
 * Intl check and stay unknown. A case variant ("europe/london") comes back in the list's spelling,
 * so core's per-zone formatter cache stays bounded by the list too.
 */
function zoneName(candidate: string): string | null {
	if (!byLower) {
		byLower = new Map();
		for (const n of zoneList()) byLower.set(n.toLowerCase(), n);
	}
	// Never expected (the list is built in): without it, ask Intl directly, as before fix round 3.
	if (byLower.size === 0) return /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(candidate) && isValidZone(candidate) ? candidate : null;
	const name = byLower.get(candidate.toLowerCase());
	if (!name) return null;
	let ok = accepted.get(name);
	if (ok === undefined) {
		ok = isValidZone(name) ? name : null;
		accepted.set(name, ok);
	}
	return ok;
}

/** The IANA name a TZID stands for, or null when it isn't one we can read without a VTIMEZONE. */
export function ianaOf(tzid: string | null | undefined): string | null {
	if (!tzid || tzid.length > TZID_MAX) return null;
	const t = tzid.trim();
	if (UTC_NAMES.has(t.toLowerCase())) return "UTC";
	const direct = zoneName(t);
	if (direct) return direct;
	// "/mozilla.org/20050126_1/America/New_York" and similar prefixed names.
	const m = REGION.exec(t);
	return m?.[1] && m[1] !== t ? zoneName(m[1]) : null;
}

const blockCache = new Map<string, JComp | null>();

/**
 * The VTIMEZONE component for an IANA zone, or null (UTC needs none; unknown zones get none).
 * The blocks come from timezones-ical-library (pinned, trusted data), so ical.js parses them.
 */
export function vtimezoneFor(zone: string): JComp | null {
	if (zone === "UTC") return null;
	if (blockCache.has(zone)) return blockCache.get(zone) ?? null;
	let out: JComp | null = null;
	try {
		// Asking for an unknown zone makes the library print a line, so only known ones are asked for.
		if (zoneList().has(zone)) {
			const r = tzlib_get_ical_block(zone);
			const block = Array.isArray(r) ? r[0] : null;
			if (typeof block === "string" && block.startsWith("BEGIN:VTIMEZONE")) {
				const parsed = ICAL.parse(`BEGIN:VCALENDAR\r\n${block}\r\nEND:VCALENDAR`) as unknown as JComp;
				const vtz = subs(parsed, "vtimezone")[0];
				if (vtz && prop(vtz, "tzid")?.[3] === zone) out = vtz;
			}
		}
	} catch {
		out = null;
	}
	if (blockCache.size > 500) blockCache.clear();
	blockCache.set(zone, out);
	return out;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Date.UTC for every year 0 to 9999 (Date.UTC alone reads 0 to 99 as 1900 to 1999). */
export function utcOf(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
	if (y >= 100) return Date.UTC(y, mo - 1, d, h, mi, s);
	const t = new Date(Date.UTC(2000, mo - 1, d, h, mi, s));
	t.setUTCFullYear(y);
	return t.getTime();
}

// ---- VTIMEZONE rules, read in bounded work (fix round 2) ---------------------------------------

/** The limits for one VTIMEZONE block; over any of them the block is not used. */
export const VTZ_LIMITS = {
	/** STANDARD and DAYLIGHT parts. */
	observances: 64,
	/** Parts with an RRULE (a full-history block of a real zone has up to 8). */
	ruled: 8,
	/** RDATE values in all. */
	rdates: 1_000,
	/** VTIMEZONE blocks looked at in one object. */
	blocks: 32,
	/** Rule years looked at, going back from the year asked for (each has exactly one change). */
	stepsBack: 6,
} as const;

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const RULE_KEYS = new Set(["freq", "interval", "until", "count", "bymonth", "byday", "bymonthday", "wkst"]);
const OFFSET_RE = /^([+-])(\d{2}):?(\d{2})(?::?(\d{2}))?$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

interface Wall {
	y: number;
	mo: number;
	d: number;
	h: number;
	mi: number;
	s: number;
}

/**
 * A yearly rule with exactly one change each year, in one month, on one of:
 * - "nth": the nth weekday (1 to 4) or the nth from the end (-1 to -4), like "-1SU";
 * - "week": the given weekday inside a run of 7 month days, like BYMONTHDAY=8..14;BYDAY=SU;
 * - "day": one month day (negative counts from the end), or DTSTART's day when none is given.
 * Shapes that some years would skip (a 5th weekday, the 29th of February) are not accepted.
 */
interface Rule {
	interval: number;
	month: number;
	kind: "nth" | "week" | "day";
	/** 0 Sunday to 6 Saturday ("nth" and "week"). */
	weekday: number;
	/** "nth": the n; "week": the first day of the run (-7: the last 7 days); "day": the day. */
	n: number;
	/** The last allowed change, as an instant (inclusive). */
	untilMs: number | null;
	/** With COUNT: the last year a rule change may fall in. */
	lastYear: number | null;
}

interface Observance {
	fromS: number;
	toS: number;
	start: Wall;
	/** DTSTART was written in UTC (with Z); the rule's changes are then in UTC too. */
	startUtc: boolean;
	startMs: number;
	/** RDATE changes, as instants, sorted. */
	rdates: number[];
	rule: Rule | null;
}

class Unusable extends Error {}

function bad(): never {
	throw new Unusable();
}

function isLeap(y: number): boolean {
	return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysIn(y: number, mo: number): number {
	return mo === 2 && isLeap(y) ? 29 : (MONTH_DAYS[mo - 1] ?? 0);
}

/** The fewest days a month ever has (February: 28). */
function minDays(mo: number): number {
	return MONTH_DAYS[mo - 1] ?? 0;
}

/** 0 Sunday to 6 Saturday. */
function weekdayOf(y: number, mo: number, d: number): number {
	return new Date(utcOf(y, mo, d)).getUTCDay();
}

function offsetSeconds(v: unknown): number {
	const m = typeof v === "string" ? OFFSET_RE.exec(v) : null;
	if (!m) bad();
	const s = (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0)) * (m[1] === "-" ? -1 : 1);
	if (Math.abs(s) >= 24 * 3600 || Number(m[3]) > 59 || Number(m[4] ?? 0) > 59) bad();
	return s;
}

/** A local date-time "YYYY-MM-DDTHH:MM:SS" (or with Z: then `utc` is true). */
function wallOf(v: unknown): { wall: Wall; utc: boolean } {
	const m = typeof v === "string" ? LOCAL_RE.exec(v) : null;
	if (!m) bad();
	const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
	if (y < 1000 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || s > 60) bad();
	return { wall: { y, mo, d, h, mi, s }, utc: Boolean(m[7]) };
}

/** The instant of a change written as a local time in the offset before the change (RFC 5545 3.6.5). */
function changeMs(w: Wall, utc: boolean, fromS: number): number {
	return utcOf(w.y, w.mo, w.d, w.h, w.mi, w.s) - (utc ? 0 : fromS * 1000);
}

function list(v: unknown): unknown[] {
	if (v === undefined || v === null) return [];
	return Array.isArray(v) ? v : [v];
}

function intIn(v: unknown, min: number, max: number): number {
	const n = typeof v === "number" ? v : typeof v === "string" && /^[+-]?\d{1,4}$/.test(v) ? Number(v) : Number.NaN;
	if (!Number.isInteger(n) || n < min || n > max) bad();
	return n;
}

/** The day of the month of the rule's one change in a year. */
function dayOfRule(r: Rule, y: number): number {
	if (r.kind === "day") return r.n > 0 ? r.n : daysIn(y, r.month) + 1 + r.n;
	if (r.kind === "week") {
		const first = r.n > 0 ? r.n : daysIn(y, r.month) - 6;
		return first + ((r.weekday - weekdayOf(y, r.month, first) + 7) % 7);
	}
	const first = 1 + ((r.weekday - weekdayOf(y, r.month, 1) + 7) % 7);
	if (r.n > 0) return first + 7 * (r.n - 1);
	const last = first + 7 * Math.floor((daysIn(y, r.month) - first) / 7);
	return last + 7 * (r.n + 1);
}

/** The instant of the rule's change in a year. */
function ruleChange(o: Observance, r: Rule, y: number): number {
	return changeMs({ ...o.start, y, mo: r.month, d: dayOfRule(r, y) }, o.startUtc, o.fromS);
}

function ruleOf(v: unknown, o: Observance): Rule {
	if (typeof v !== "object" || v === null || Array.isArray(v)) bad();
	const parts: Record<string, unknown> = {};
	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		const key = k.toLowerCase();
		if (!RULE_KEYS.has(key)) bad();
		parts[key] = val;
	}
	if (String(parts.freq ?? "").toUpperCase() !== "YEARLY") bad();
	const interval = parts.interval === undefined ? 1 : intIn(parts.interval, 1, 1000);
	const months = list(parts.bymonth);
	if (months.length > 1) bad();
	const month = months.length ? intIn(months[0], 1, 12) : o.start.mo;
	const days = list(parts.byday);
	const rawDays = list(parts.bymonthday);
	if (days.length > 1 || rawDays.length > 7) bad();
	const monthDays = rawDays.map((d) => intIn(d, -31, 31));
	if (monthDays.includes(0)) bad();
	let kind: Rule["kind"];
	let weekday = 0;
	let n: number;
	if (days.length) {
		const m = typeof days[0] === "string" ? /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(days[0]) : null;
		if (!m) bad();
		weekday = WEEKDAYS[(m[2] as string).toUpperCase()] as number;
		if (m[1] !== undefined) {
			// The nth weekday: 1 to 4 (or -1 to -4) exist in every month.
			n = Number(m[1]);
			if (n === 0 || Math.abs(n) > 4 || monthDays.length) bad();
			kind = "nth";
		} else {
			// A weekday in a run of 7 month days that every year has.
			const s = [...monthDays].sort((a, b) => a - b);
			const run = s.length === 7 && s.every((d, i) => i === 0 || d === (s[i - 1] as number) + 1);
			const first = s[0] as number;
			if (!run || !((first >= 1 && first + 6 <= minDays(month)) || first === -7)) bad();
			n = first;
			kind = "week";
		}
	} else {
		if (monthDays.length > 1) bad();
		n = monthDays[0] ?? o.start.d;
		if (Math.abs(n) > minDays(month)) bad();
		kind = "day";
	}
	if (parts.wkst !== undefined && !(typeof parts.wkst === "string" && parts.wkst.toUpperCase() in WEEKDAYS)) bad();
	let untilMs: number | null = null;
	if (parts.until !== undefined) {
		const u = parts.until;
		const dm = typeof u === "string" ? DATE_RE.exec(u) : null;
		if (dm) untilMs = changeMs({ y: Number(dm[1]), mo: Number(dm[2]), d: Number(dm[3]), h: 23, mi: 59, s: 59 }, false, o.fromS);
		else {
			const w = wallOf(u);
			untilMs = changeMs(w.wall, w.utc, o.fromS);
		}
	}
	const rule: Rule = { interval, month, kind, weekday, n, untilMs, lastYear: null };
	if (parts.count !== undefined) {
		if (untilMs !== null) bad();
		const count = intIn(parts.count, 1, 1000);
		// COUNT counts DTSTART as the first change; the rule's own changes after it make up the rest.
		const firstYear = ruleChange(o, rule, o.start.y) > o.startMs ? o.start.y : o.start.y + interval;
		rule.lastYear = firstYear + (count - 2) * interval;
	}
	return rule;
}

function observanceOf(c: JComp, budget: { rdates: number; ruled: number }): Observance | null {
	const ds = prop(c, "dtstart");
	const fromP = prop(c, "tzoffsetfrom");
	const toP = prop(c, "tzoffsetto");
	// A part without these is skipped, as ical.js always did.
	if (!ds || !fromP || !toP) return null;
	if (ds[2] !== "date-time") bad();
	const fromS = offsetSeconds(fromP[3]);
	const toS = offsetSeconds(toP[3]);
	const st = wallOf(ds[3]);
	const o: Observance = { fromS, toS, start: st.wall, startUtc: st.utc, startMs: changeMs(st.wall, st.utc, fromS), rdates: [], rule: null };
	for (const p of props(c, "rdate")) {
		for (const v of p.slice(3)) {
			if (--budget.rdates < 0) bad();
			if (p[2] === "date") {
				const m = typeof v === "string" ? DATE_RE.exec(v) : null;
				if (!m) bad();
				o.rdates.push(changeMs({ ...st.wall, y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) }, st.utc, fromS));
			} else if (p[2] === "date-time") {
				const w = wallOf(v);
				o.rdates.push(changeMs(w.wall, w.utc, fromS));
			} else bad();
		}
	}
	o.rdates.sort((a, b) => a - b);
	const rules = props(c, "rrule");
	if (rules.length > 1) bad();
	if (rules[0]) {
		if (--budget.ruled < 0) bad();
		o.rule = ruleOf(rules[0][3], o);
	}
	return o;
}

/** The latest RDATE at or before an instant (binary search), or -Infinity. */
function latestRdate(o: Observance, utcMs: number): number {
	let lo = 0;
	let hi = o.rdates.length - 1;
	let best = Number.NEGATIVE_INFINITY;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const v = o.rdates[mid] as number;
		if (v <= utcMs) {
			best = v;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return best;
}

/**
 * The latest change of an observance's rule at or before an instant, or -Infinity. Every rule year
 * has exactly one change, so going back from the year after the instant's finds it within a few
 * steps (the limit also covers UNTIL and changes that fall on the other side of New Year in UTC).
 */
function latestRuleChange(o: Observance, utcMs: number): number {
	const r = o.rule;
	if (!r) return Number.NEGATIVE_INFINITY;
	let top = new Date(utcMs).getUTCFullYear() + 1;
	if (r.untilMs !== null) top = Math.min(top, new Date(r.untilMs).getUTCFullYear() + 1);
	if (r.lastYear !== null) top = Math.min(top, r.lastYear);
	if (top < o.start.y) return Number.NEGATIVE_INFINITY;
	let y = o.start.y + Math.floor((top - o.start.y) / r.interval) * r.interval;
	for (let k = 0; k < VTZ_LIMITS.stepsBack && y >= o.start.y; k++, y -= r.interval) {
		const t = ruleChange(o, r, y);
		// DTSTART is the first change; a rule change at or before it isn't one.
		if (t <= o.startMs) return Number.NEGATIVE_INFINITY;
		if (t <= utcMs && (r.untilMs === null || t <= r.untilMs)) return t;
	}
	return Number.NEGATIVE_INFINITY;
}

/** A VTIMEZONE's rules, read without ical.js (see the top of this file). */
export class RuleZone {
	private readonly earliest: Observance;
	private constructor(private readonly obs: Observance[]) {
		this.earliest = obs.reduce((a, b) => (b.startMs < a.startMs ? b : a));
	}

	/** The rules of a VTIMEZONE, or null when the block is unusable or over the limits. */
	static of(vtz: JComp): RuleZone | null {
		try {
			const parts = vtz[2].filter((c) => {
				const n = c[0].toLowerCase();
				return n === "standard" || n === "daylight";
			});
			if (parts.length === 0 || parts.length > VTZ_LIMITS.observances) return null;
			const budget = { rdates: VTZ_LIMITS.rdates, ruled: VTZ_LIMITS.ruled };
			const obs: Observance[] = [];
			for (const c of parts) {
				const o = observanceOf(c, budget);
				if (o) obs.push(o);
			}
			return obs.length ? new RuleZone(obs) : null;
		} catch (e) {
			if (e instanceof Unusable) return null;
			throw e;
		}
	}

	/** The zone's offset from UTC in seconds at an instant. Before every change: the first one's "from". */
	offsetAt(utcMs: number): number {
		let best = Number.NEGATIVE_INFINITY;
		let off: number | null = null;
		for (const o of this.obs) {
			let t = o.startMs <= utcMs ? o.startMs : Number.NEGATIVE_INFINITY;
			t = Math.max(t, latestRdate(o, utcMs), latestRuleChange(o, utcMs));
			if (t > Number.NEGATIVE_INFINITY && t >= best) {
				best = t;
				off = o.toS;
			}
		}
		return off ?? this.earliest.fromS;
	}

	/** The instant of a wall-clock time, in the same two steps as core's zonedToUtc. */
	toUtc(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
		const guess = utcOf(y, mo, d, h, mi, s);
		const first = guess - this.offsetAt(guess) * 1000;
		return guess - this.offsetAt(first) * 1000;
	}
}

type ZoneRead = { kind: "iana"; zone: string } | { kind: "rules"; tz: RuleZone } | { kind: "floating" };

/** Turns local wall-clock times of one calendar object into instants. */
export class ZoneResolver {
	/** The object's VTIMEZONE blocks by TZID, read only when a time needs one. */
	private readonly blocks = new Map<string, JComp>();
	private readonly read = new Map<string, ZoneRead>();
	constructor(
		vcal: JComp | null,
		private readonly floatingZone: string,
	) {
		let n = 0;
		for (const c of vcal ? subs(vcal, "vtimezone") : []) {
			if (++n > VTZ_LIMITS.blocks) break;
			const id = prop(c, "tzid")?.[3];
			if (typeof id === "string" && !this.blocks.has(id)) this.blocks.set(id, c);
		}
	}

	/**
	 * How a TZID is read, worked out once per object (fix round 3: the IANA check used to run on
	 * every time before this cache was asked). An IANA name wins over a VTIMEZONE of the same TZID,
	 * as it always did.
	 */
	private zoneOf(tzid: string): ZoneRead {
		const seen = this.read.get(tzid);
		if (seen) return seen;
		let out: ZoneRead = { kind: "floating" };
		const named = ianaOf(tzid);
		const vtz = named ? undefined : this.blocks.get(tzid);
		if (named) out = { kind: "iana", zone: named };
		else if (vtz) {
			const tz = RuleZone.of(vtz);
			if (tz) out = { kind: "rules", tz };
			else {
				// An unusable block may still say which IANA zone it stands for.
				const loc = prop(vtz, "x-lic-location")?.[3];
				const iana = typeof loc === "string" ? ianaOf(loc) : null;
				if (iana) out = { kind: "iana", zone: iana };
			}
		}
		this.read.set(tzid, out);
		return out;
	}

	/** The instant of "YYYY-MM-DDTHH:MM:SS" in the zone a TZID names (or floating). */
	toUtc(local: string, tzid: string | null): number | null {
		const m = LOCAL_RE.exec(local);
		if (!m) return null;
		const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
		if (m[7]) return utcOf(y, mo, d, h, mi, s);
		const z = tzid ? this.zoneOf(tzid) : ({ kind: "floating" } as const);
		if (z.kind === "rules") return z.tz.toUtc(y, mo, d, h, mi, s);
		return zonedToUtc(y, mo, d, h, mi, s, z.kind === "iana" ? z.zone : this.floatingZone);
	}
}

/** Reads a DTSTART-like property (date or date-time). */
export function readTime(p: JProp | undefined, r: ZoneResolver): CalTime | null {
	if (!p) return null;
	const v = p[3];
	if (typeof v !== "string") return null;
	if (p[2] === "date") {
		const m = DATE_RE.exec(v);
		if (!m) return null;
		return { kind: "date", y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
	}
	const ms = r.toUtc(v, param(p, "tzid"));
	return ms === null ? null : { kind: "instant", utcMs: ms };
}

/** "YYYY-MM-DDTHH:MM:SS" wall-clock time of an instant in a zone (for TZID values). */
export function wallString(utcMs: number, zone: string): string {
	const p = partsIn(utcMs, zone);
	const two = (n: number) => String(n).padStart(2, "0");
	return `${toDateString(p.y, p.mo, p.d)}T${two(p.h)}:${two(p.mi)}:${two(p.s)}`;
}

export function dateString(t: { y: number; mo: number; d: number }): string {
	return toDateString(t.y, t.mo, t.d);
}

/** A date plus some days (negative allowed). */
export function addDays(t: { y: number; mo: number; d: number }, days: number): { y: number; mo: number; d: number } {
	const ms = Date.UTC(t.y, t.mo - 1, t.d) + days * 86_400_000;
	const x = new Date(ms);
	return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate() };
}

/** Days from a to b (b - a). */
export function daysBetween(a: { y: number; mo: number; d: number }, b: { y: number; mo: number; d: number }): number {
	return Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / 86_400_000);
}

/** The local date of an instant in a zone. */
export function localDate(utcMs: number, zone: string): { y: number; mo: number; d: number } {
	const p = partsIn(utcMs, zone);
	return { y: p.y, mo: p.mo, d: p.d };
}

/** Midnight at the start of a date in a zone, as an instant. */
export function startOfDay(t: { y: number; mo: number; d: number }, zone: string): number {
	return zonedToUtc(t.y, t.mo, t.d, 0, 0, 0, zone);
}

/** Seconds of an iCalendar DURATION ("PT1H30M", "-P1D"), or null. */
export function durationSeconds(v: unknown): number | null {
	if (typeof v !== "string" || v.length > 40 || !/^[+-]?P/.test(v)) return null;
	try {
		const s = ICAL.Duration.fromString(v).toSeconds();
		return Number.isFinite(s) ? s : null;
	} catch {
		return null;
	}
}

/** "YYYYMMDDTHHMMSSZ" for CalDAV time-range and expand attributes. */
export function caldavUtc(ms: number): string {
	return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
}
