/**
 * VTIMEZONE blocks written by other people (fix round 2, security review): RuleZone reads them in
 * bounded work. It must agree with the real zones (Intl) and with ical.js on the shapes real zones
 * use, and finish at once on crafted blocks that made ical.js loop for tens of seconds.
 */
import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { isValidZone, zonedToUtc } from "../../../src/core/time";
import type { JComp } from "../../../src/pim/jcal";
import { ianaOf, RuleZone, utcOf, VTZ_LIMITS, vtimezoneFor, ZoneResolver } from "../../../src/pim/tz";
import { showEvent } from "../../../src/tools/calendar/events";
import { showTask } from "../../../src/tools/tasks/todos";

type Part = JComp;

function renamed(zone: string, tzid: string): JComp {
	const vtz = vtimezoneFor(zone);
	if (!vtz) throw new Error(`no block for ${zone}`);
	const copy = JSON.parse(JSON.stringify(vtz)) as JComp;
	copy[1] = copy[1].filter((p) => p[0] !== "x-lic-location" && p[0] !== "tzurl").map((p) => (p[0] === "tzid" ? ["tzid", {}, "text", tzid] : p)) as JComp[1];
	return copy;
}

function block(tzid: string, parts: Part[], extra: JComp[1] = []): JComp {
	return ["vtimezone", [["tzid", {}, "text", tzid], ...extra], parts];
}

function part(kind: "standard" | "daylight", dtstart: string, from: string, to: string, more: JComp[1] = []): Part {
	return [kind, [["dtstart", {}, "date-time", dtstart], ["tzoffsetfrom", {}, "utc-offset", from], ["tzoffsetto", {}, "utc-offset", to], ...more], []];
}

const rrule = (v: Record<string, unknown>): JComp[1][number] => ["rrule", {}, "recur", v];
const cal = (...c: JComp[]): JComp => ["vcalendar", [], c];

/** Outlook's own block for Central European time, as Exchange writes it. */
const OUTLOOK_BERLIN = block("W. Europe Standard Time", [
	part("standard", "1601-01-01T03:00:00", "+02:00", "+01:00", [rrule({ freq: "YEARLY", interval: 1, byday: "-1SU", bymonth: 10 })]),
	part("daylight", "1601-01-01T02:00:00", "+01:00", "+02:00", [rrule({ freq: "YEARLY", interval: 1, byday: "-1SU", bymonth: 3 })]),
]);

/** Local wall times that probe both changes of a year and ordinary days. */
function probes(years: number[]): [number, number, number, number, number][] {
	const out: [number, number, number, number, number][] = [];
	for (const y of years) {
		for (let mo = 1; mo <= 12; mo++) {
			for (const d of [1, 7, 8, 14, 15, 21, 22, 25, 26, 27, 28, 29, 30, 31]) {
				if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) continue;
				for (const [h, mi] of [
					[0, 30],
					[1, 30],
					[2, 30],
					[3, 30],
					[12, 0],
					[23, 45],
				] as const)
					out.push([y, mo, d, h, mi]);
			}
		}
	}
	return out;
}

describe("RuleZone: agrees with the real zones", () => {
	const zones = ["Europe/Berlin", "Europe/London", "Europe/Dublin", "America/New_York", "America/Los_Angeles", "Australia/Sydney", "Pacific/Auckland", "Pacific/Chatham", "Asia/Kolkata", "Asia/Tehran", "Europe/Moscow"];
	for (const zone of zones) {
		it(`reads ${zone}'s block under another name exactly as Intl reads ${zone}`, () => {
			const r = new ZoneResolver(cal(renamed(zone, "Office Time")), "UTC");
			const bad: string[] = [];
			for (const [y, mo, d, h, mi] of probes([2026, 2027, 2031])) {
				const local = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00`;
				const want = zonedToUtc(y, mo, d, h, mi, 0, zone);
				const got = r.toUtc(local, "Office Time");
				if (got !== want) bad.push(`${local}: ${got === null ? "null" : new Date(got).toISOString()} != ${new Date(want).toISOString()}`);
			}
			expect(bad.slice(0, 5)).toEqual([]);
		});
	}

	it("reads Outlook's block (rules from 1601) like Europe/Berlin and like ical.js", () => {
		const r = new ZoneResolver(cal(OUTLOOK_BERLIN), "UTC");
		const tz = new ICAL.Timezone(new ICAL.Component(JSON.parse(JSON.stringify(OUTLOOK_BERLIN)) as unknown[]));
		for (const [y, mo, d, h, mi] of probes([2008, 2026, 2035])) {
			const local = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00`;
			const got = r.toUtc(local, "W. Europe Standard Time");
			const ical = ICAL.Time.fromData({ year: y, month: mo, day: d, hour: h, minute: mi, second: 0, isDate: false }, tz).toUnixTime() * 1000;
			expect(got, local).toBe(zonedToUtc(y, mo, d, h, mi, 0, "Europe/Berlin"));
			// ical.js reads the skipped hour of the spring change its own way; everywhere else all three agree.
			if (mo !== 3) expect(got, local).toBe(ical);
		}
	});

	it("follows RDATE lists, UNTIL and COUNT as ical.js does", () => {
		const custom = block("Custom", [
			part("standard", "1990-01-01T00:00:00", "+01:00", "+01:00"),
			part("daylight", "2000-03-26T02:00:00", "+01:00", "+02:00", [rrule({ freq: "YEARLY", bymonth: "3", byday: "-1SU", count: 3 })]),
			part("standard", "2000-10-29T03:00:00", "+02:00", "+01:00", [rrule({ freq: "YEARLY", bymonth: 10, byday: "-1SU", until: "2002-10-27T01:00:00Z" })]),
			// Generators repeat DTSTART as the first RDATE (ical.js skips a DTSTART that has RDATEs and no
			// RRULE), and ical.js reads only the first value of an RDATE, so each has its own here.
			part("daylight", "2004-04-04T02:00:00", "+01:00", "+02:00", [
				["rdate", {}, "date-time", "2004-04-04T02:00:00"],
				["rdate", {}, "date-time", "2005-04-03T02:00:00"],
				["rdate", {}, "date-time", "2006-04-02T02:00:00"],
			]),
			part("standard", "2004-10-31T03:00:00", "+02:00", "+01:00", [
				["rdate", {}, "date-time", "2004-10-31T03:00:00"],
				["rdate", {}, "date-time", "2005-10-30T03:00:00"],
			]),
		]);
		const r = new ZoneResolver(cal(custom), "UTC");
		const tz = new ICAL.Timezone(new ICAL.Component(JSON.parse(JSON.stringify(custom)) as unknown[]));
		for (const [y, mo, d, h, mi] of probes([1999, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007])) {
			if (mo === 3 || mo === 4) continue; // the spring changes' skipped hour is read differently by ical.js
			const local = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00`;
			const ical = ICAL.Time.fromData({ year: y, month: mo, day: d, hour: h, minute: mi, second: 0, isDate: false }, tz).toUnixTime() * 1000;
			expect(r.toUtc(local, "Custom"), local).toBe(ical);
		}
		// COUNT=3 stops after 2002's summer time; UNTIL stops after 2002's winter time; 2003 stays +01:00.
		expect(r.toUtc("2003-07-01T12:00:00", "Custom")).toBe(Date.UTC(2003, 6, 1, 11));
		expect(r.toUtc("2002-07-01T12:00:00", "Custom")).toBe(Date.UTC(2002, 6, 1, 10));
		expect(r.toUtc("2006-07-01T12:00:00", "Custom")).toBe(Date.UTC(2006, 6, 1, 10));
		// RFC 5545 3.6.5: DTSTART is the first change even when only RDATEs follow it.
		const dtstartOnly = block("Custom", [
			part("standard", "1990-01-01T00:00:00", "+01:00", "+01:00"),
			part("daylight", "2004-04-04T02:00:00", "+01:00", "+02:00", [["rdate", {}, "date-time", "2005-04-03T02:00:00"]]),
		]);
		expect(new ZoneResolver(cal(dtstartOnly), "UTC").toUtc("2004-05-01T00:30:00", "Custom")).toBe(Date.UTC(2004, 3, 30, 22, 30));
		// One RDATE with several values (RFC 5545 3.8.5.2): every value is a change.
		const multi = block("Custom", [
			part("standard", "1990-01-01T00:00:00", "+01:00", "+01:00", [["rdate", {}, "date-time", "2004-10-31T03:00:00", "2005-10-30T03:00:00"]]),
			part("daylight", "2004-04-04T02:00:00", "+01:00", "+02:00", [["rdate", {}, "date-time", "2004-04-04T02:00:00", "2005-04-03T02:00:00"]]),
		]);
		const m = new ZoneResolver(cal(multi), "UTC");
		expect(m.toUtc("2005-05-01T00:30:00", "Custom")).toBe(Date.UTC(2005, 3, 30, 22, 30));
		expect(m.toUtc("2005-12-01T12:00:00", "Custom")).toBe(Date.UTC(2005, 11, 1, 11));
	});

	it("reads a weekday inside a run of month days, and a fixed day", () => {
		// Old US rule: the last Sunday of April written as "Sunday from the 24th to the 30th".
		const z = block("Old Eastern", [
			part("daylight", "1976-04-25T02:00:00", "-05:00", "-04:00", [rrule({ freq: "YEARLY", bymonth: 4, byday: "SU", bymonthday: [24, 25, 26, 27, 28, 29, 30] })]),
			part("standard", "1976-10-31T02:00:00", "-04:00", "-05:00", [rrule({ freq: "YEARLY", bymonth: 10, byday: "SU", bymonthday: [-7, -6, -5, -4, -3, -2, -1] })]),
		]);
		const fixed = block("Fixed", [
			part("standard", "2000-09-21T00:00:00", "+04:30", "+03:30", [rrule({ freq: "YEARLY", bymonth: 9, bymonthday: 21 })]),
			part("daylight", "2000-03-21T00:00:00", "+03:30", "+04:30", [rrule({ freq: "YEARLY" })]),
		]);
		const r = new ZoneResolver(cal(z, fixed), "UTC");
		// 1985: the last Sunday of April is the 28th, of October the 27th.
		expect(r.toUtc("1985-04-28T03:00:00", "Old Eastern")).toBe(Date.UTC(1985, 3, 28, 7));
		expect(r.toUtc("1985-04-27T12:00:00", "Old Eastern")).toBe(Date.UTC(1985, 3, 27, 17));
		expect(r.toUtc("1985-10-27T12:00:00", "Old Eastern")).toBe(Date.UTC(1985, 9, 27, 17));
		expect(r.toUtc("1985-10-26T12:00:00", "Old Eastern")).toBe(Date.UTC(1985, 9, 26, 16));
		expect(r.toUtc("2010-06-01T12:00:00", "Fixed")).toBe(Date.UTC(2010, 5, 1, 7, 30));
		expect(r.toUtc("2010-12-01T12:00:00", "Fixed")).toBe(Date.UTC(2010, 11, 1, 8, 30));
	});

	it("reads times before every change in the first part's offset, and years 0 to 99 correctly", () => {
		const r = new ZoneResolver(cal(renamed("Europe/Berlin", "Office Time")), "UTC");
		expect(r.toUtc("1960-01-01T12:00:00", "Office Time")).toBe(Date.UTC(1960, 0, 1, 11));
		expect(utcOf(50, 1, 1)).toBe(new Date("0050-01-01T00:00:00Z").getTime());
		expect(new ZoneResolver(null, "UTC").toUtc("0050-01-01T00:00:00Z", null)).toBe(new Date("0050-01-01T00:00:00Z").getTime());
	});
});

describe("RuleZone: crafted blocks are refused at once", () => {
	const crafted: Record<string, JComp> = {
		minutely: block("Office Time", [part("standard", "1970-01-01T00:00:00", "+01:00", "+02:00", [rrule({ freq: "MINUTELY" })])]),
		secondly: block("Office Time", [part("standard", "1000-01-01T00:00:00", "+01:00", "+02:00", [rrule({ freq: "SECONDLY" })])]),
		hourly: block("Office Time", [part("standard", "1970-01-01T00:00:00", "+01:00", "+02:00", [rrule({ freq: "HOURLY" })])]),
		daily: block("Office Time", [part("standard", "1000-01-01T00:00:00", "+01:00", "+02:00", [rrule({ freq: "DAILY" })])]),
		weekly: block("Office Time", [part("standard", "1000-01-01T00:00:00", "+01:00", "+02:00", [rrule({ freq: "WEEKLY" })])]),
		monthly: block("Office Time", [part("standard", "1000-01-01T00:00:00", "+01:00", "+02:00", [rrule({ freq: "MONTHLY", byday: "-1SU" })])]),
		bysecond: block("Office Time", [part("standard", "1970-01-01T00:00:00", "+01:00", "+02:00", [rrule({ freq: "YEARLY", bysecond: [0, 1, 2, 3, 4, 5], byminute: [0, 1, 2], byhour: [0, 1] })])]),
		bysetpos: block("Office Time", [part("standard", "1970-01-01T00:00:00", "+01:00", "+02:00", [rrule({ freq: "YEARLY", bymonth: 3, byday: "SU", bysetpos: -1 })])]),
		byyearday: block("Office Time", [part("standard", "1970-01-01T00:00:00", "+01:00", "+02:00", [rrule({ freq: "YEARLY", byyearday: [1, 2, 3] })])]),
		fifth: block("Office Time", [part("standard", "1970-02-01T00:00:00", "+01:00", "+02:00", [rrule({ freq: "YEARLY", bymonth: 2, byday: "5SU" })])]),
		everySunday: block("Office Time", [part("standard", "1970-03-01T00:00:00", "+01:00", "+02:00", [rrule({ freq: "YEARLY", bymonth: 3, byday: "SU" })])]),
		twoMonths: block("Office Time", [part("standard", "1970-03-01T00:00:00", "+01:00", "+02:00", [rrule({ freq: "YEARLY", bymonth: [3, 10], byday: "-1SU" })])]),
		feb29: block("Office Time", [part("standard", "1972-02-29T00:00:00", "+01:00", "+02:00", [rrule({ freq: "YEARLY", bymonth: 2, bymonthday: 29 })])]),
		never: block("Office Time", [part("standard", "1970-02-01T00:00:00", "+01:00", "+02:00", [rrule({ freq: "YEARLY", bymonth: 2, bymonthday: 31 })])]),
		twoRules: block("Office Time", [part("standard", "1970-01-01T00:00:00", "+01:00", "+02:00", [rrule({ freq: "YEARLY" }), rrule({ freq: "YEARLY" })])]),
		period: block("Office Time", [part("standard", "1970-01-01T00:00:00", "+01:00", "+02:00", [["rdate", {}, "period", "1971-01-01T00:00:00/PT1H"]])]),
		manyRdates: block("Office Time", [
			part("standard", "1970-01-01T00:00:00", "+01:00", "+02:00", [["rdate", {}, "date-time", ...Array.from({ length: VTZ_LIMITS.rdates + 1 }, (_, i) => `${1971 + (i % 900)}-01-01T00:00:00`)]]),
		]),
		manyParts: block(
			"Office Time",
			Array.from({ length: VTZ_LIMITS.observances + 1 }, (_, i) => part("standard", `${1971 + i}-01-01T00:00:00`, "+01:00", "+02:00")),
		),
		manyRules: block(
			"Office Time",
			Array.from({ length: VTZ_LIMITS.ruled + 1 }, (_, i) => part("standard", `${1971 + i}-03-01T00:00:00`, "+01:00", "+02:00", [rrule({ freq: "YEARLY", bymonth: 3, byday: "-1SU" })])),
		),
		badOffset: block("Office Time", [part("standard", "1970-01-01T00:00:00", "+25:00", "+02:00")]),
		earlyYear: block("Office Time", [part("standard", "0099-01-01T00:00:00", "+01:00", "+02:00", [rrule({ freq: "YEARLY" })])]),
	};
	for (const [name, vtz] of Object.entries(crafted)) {
		it(`${name}: not used, and the time is read as floating, in well under 50 ms`, () => {
			expect(RuleZone.of(vtz)).toBeNull();
			const t0 = Date.now();
			const r = new ZoneResolver(cal(vtz), "Europe/London");
			for (let i = 0; i < 20; i++) expect(r.toUtc("2026-07-01T12:00:00", "Office Time")).toBe(Date.UTC(2026, 6, 1, 11));
			expect(Date.now() - t0).toBeLessThan(50);
		});
	}

	it("an unusable block still names its IANA zone through X-LIC-LOCATION", () => {
		const vtz = crafted.minutely as JComp;
		const named = block("Office Time", vtz[2], [["x-lic-location", {}, "text", "America/New_York"]]);
		expect(new ZoneResolver(cal(named), "UTC").toUtc("2026-07-01T12:00:00", "Office Time")).toBe(Date.UTC(2026, 6, 1, 16));
	});

	it("far years, huge intervals and COUNT 1000 cost the same few steps", () => {
		const z = block("Office Time", [
			part("daylight", "1000-03-26T02:00:00", "+01:00", "+02:00", [rrule({ freq: "YEARLY", bymonth: 3, byday: "-1SU", count: 1000 })]),
			part("standard", "1000-10-29T03:00:00", "+02:00", "+01:00", [rrule({ freq: "YEARLY", bymonth: 10, byday: "-1SU", interval: 997 })]),
		]);
		const r = new ZoneResolver(cal(z), "UTC");
		const t0 = Date.now();
		for (let y = 1000; y <= 9999; y += 7) r.toUtc(`${y}-07-01T12:00:00`, "Office Time");
		expect(Date.now() - t0).toBeLessThan(200);
		// COUNT 1000 from the year 1000 ends with the summer time of 1998 or 1999, after the winter rule's
		// change of 1997 (it repeats every 997 years), so 2500 is still in summer time.
		expect(r.toUtc("1998-07-01T12:00:00", "Office Time")).toBe(Date.UTC(1998, 6, 1, 10));
		expect(r.toUtc("2500-07-01T12:00:00", "Office Time")).toBe(Date.UTC(2500, 6, 1, 10));
	});

	it("the reviewer's case: a FREQ=MINUTELY block reaches showTask and showEvent, which finish in under 50 ms", () => {
		const vtz = crafted.minutely as JComp;
		const todo: JComp = ["vtodo", [["uid", {}, "text", "t"], ["summary", {}, "text", "T"], ["due", { tzid: "Office Time" }, "date-time", "2026-10-30T12:00:00"]], []];
		const vev: JComp = ["vevent", [["uid", {}, "text", "e"], ["dtstart", { tzid: "Office Time" }, "date-time", "2026-10-30T12:00:00"], ["dtend", { tzid: "Office Time" }, "date-time", "2026-10-30T13:00:00"]], []];
		const t0 = Date.now();
		const t = showTask(todo, cal(vtz, todo), { listId: "l", objId: "t.ics", etag: null, zone: "UTC", driveOrigin: "https://drive.nourax.org" });
		const e = showEvent(vev, new ZoneResolver(cal(vtz, vev), "UTC"), { calId: "c", objId: "e.ics", etag: null, uid: "u", driveOrigin: "https://drive.nourax.org", zone: "UTC", seriesMember: false });
		expect(Date.now() - t0).toBeLessThan(50);
		expect(t.task.due).toBe("2026-10-30T12:00:00+00:00");
		expect(e?.event.start).toBe("2026-10-30T12:00:00+00:00");
	});

	it("many objects, each with the largest block allowed, stay cheap (no amplification)", () => {
		const parts: JComp[] = [];
		for (let i = 0; i < VTZ_LIMITS.ruled; i++) {
			parts.push(part(i % 2 ? "standard" : "daylight", `${1600 + i}-03-01T02:00:00`, "+01:00", "+02:00", [rrule({ freq: "YEARLY", bymonth: 3 + i, byday: "SU", bymonthday: [-7, -6, -5, -4, -3, -2, -1] })]));
		}
		const per = Math.floor(VTZ_LIMITS.rdates / (VTZ_LIMITS.observances - VTZ_LIMITS.ruled));
		for (let i = parts.length; i < VTZ_LIMITS.observances; i++) {
			parts.push(part("standard", `${1700 + i}-01-01T00:00:00`, "+02:00", "+01:00", [["rdate", {}, "date-time", ...Array.from({ length: per }, (_, k) => `${1800 + k * 3}-0${1 + (i % 9)}-01T00:00:00`)]]));
		}
		const vtz = block("Office Time", parts);
		expect(RuleZone.of(vtz)).not.toBeNull();
		const t0 = Date.now();
		for (let n = 0; n < 500; n++) {
			const r = new ZoneResolver(cal(JSON.parse(JSON.stringify(vtz)) as JComp), "UTC");
			for (const local of ["2026-10-30T12:00:00", "2026-11-01T00:00:00", "2031-03-30T02:30:00"]) r.toUtc(local, "Office Time");
		}
		// 500 objects with 3 times each, every block parsed again: a few milliseconds apiece at most.
		expect(Date.now() - t0).toBeLessThan(2_000);
	});
});

/**
 * Fix round 3 (security review): a TZID that looks like a zone but isn't one ("Europe/Nope") used to
 * cost a failed Intl.DateTimeFormat on every time read from it, because core caches only the zones
 * that work. Now a name reaches Intl only when timezones-ical-library lists it, once per name.
 */
describe("zone names: unknown TZIDs cost no Intl work", () => {
	/** Counts every Intl.DateTimeFormat made while `run` runs. */
	function formattersMade(run: () => void): number {
		const real = Intl.DateTimeFormat;
		let n = 0;
		Intl.DateTimeFormat = new Proxy(real, {
			construct(target, args, newTarget) {
				n++;
				return Reflect.construct(target, args, newTarget);
			},
			apply(target, self, args) {
				n++;
				return Reflect.apply(target, self, args);
			},
		});
		try {
			run();
		} finally {
			Intl.DateTimeFormat = real;
		}
		return n;
	}

	const task = (tzid: string): JComp => ["vtodo", [["uid", {}, "text", "t"], ["summary", {}, "text", "T"], ["dtstart", { tzid }, "date-time", "2026-10-29T09:00:00"], ["due", { tzid }, "date-time", "2026-10-30T12:00:00"]], []];
	const show = (todo: JComp, zone = "Europe/Berlin") => showTask(todo, cal(todo), { listId: "l", objId: "t.ics", etag: null, zone, driveOrigin: "https://drive.nourax.org" });

	it("the counter sees what the old check cost: core's isValidZone makes a formatter for every unknown name", () => {
		// Core caches only zones that work, so the old ianaOf paid this on every time it read.
		expect(formattersMade(() => {
			for (let i = 0; i < 10; i++) isValidZone("Europe/Nope");
		})).toBe(10);
	});

	it("the reviewer's case: 5,000 tasks with a made-up zone, one name or each its own, make no formatter", () => {
		// Warm up the zone the times are shown in (core keeps one formatter per real zone).
		show(task("Europe/Nope"));
		const same = formattersMade(() => {
			for (let i = 0; i < 5000; i++) show(task("Europe/Nope"));
		});
		const each = formattersMade(() => {
			for (let i = 0; i < 5000; i++) show(task(`Europe/Nope${i}`));
		});
		const others = formattersMade(() => {
			for (const tzid of ["Custom/Zone", "W. Europe Standard Time", "/mozilla.org/20050126_1/Europe/Nope", "x".repeat(300), "Etc/GMT+99"]) {
				for (let i = 0; i < 200; i++) show(task(tzid));
			}
		});
		expect({ same, each, others }).toEqual({ same: 0, each: 0, others: 0 });
		// Read as floating, in the person's zone, as before.
		expect(show(task("Europe/Nope")).task.due).toBe("2026-10-30T12:00:00+01:00");
	});

	it("each real name is checked against Intl at most once, whatever its spelling", () => {
		show(task("Asia/Tokyo"));
		const n = formattersMade(() => {
			for (let i = 0; i < 2000; i++) for (const tzid of ["Asia/Tokyo", "asia/tokyo", "ASIA/TOKYO", " Asia/Tokyo "]) show(task(tzid), "UTC");
		});
		expect(n).toBe(0);
		expect(show(task("asia/tokyo"), "UTC").task.due).toBe("2026-10-30T03:00:00+00:00");
	});

	it("reads the same names as before: IANA names in any case, links, prefixed names and UTC", () => {
		expect(ianaOf("Europe/London")).toBe("Europe/London");
		expect(ianaOf("europe/london")).toBe("Europe/London");
		expect(ianaOf(" Europe/Berlin ")).toBe("Europe/Berlin");
		expect(ianaOf("US/Eastern")).toBe("US/Eastern");
		expect(ianaOf("Asia/Calcutta")).toBe("Asia/Calcutta");
		expect(ianaOf("GB")).toBe("GB");
		expect(ianaOf("Etc/GMT+5")).toBe("Etc/GMT+5");
		expect(ianaOf("/mozilla.org/20050126_1/America/New_York")).toBe("America/New_York");
		for (const u of ["UTC", "Z", "gmt", "Etc/UTC", "Zulu"]) expect(ianaOf(u)).toBe("UTC");
		for (const bad of ["Europe/Nope", "CT", "PT", "W. Europe Standard Time", "Custom/Zone", "", "x".repeat(300), null, undefined]) expect(ianaOf(bad)).toBeNull();
	});

	it("loses no zone this runtime knows: every Intl zone name is found", () => {
		const names = Intl.supportedValuesOf("timeZone");
		expect(names.length).toBeGreaterThan(300);
		const missing = names.filter((n) => ianaOf(n) === null);
		expect(missing).toEqual([]);
	});
});
