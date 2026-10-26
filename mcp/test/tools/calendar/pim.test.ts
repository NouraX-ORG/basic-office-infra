/** Unit tests for lane D's pure modules: jCal, time zones, free time and the event helpers. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ToolError } from "../../../src/core/errors";
import { toZonedIso, zonedToUtc } from "../../../src/core/time";
import { alignUp, freeSlots, hhmm, mergeIntervals, subtract, workingWindows } from "../../../src/pim/freetime";
import { cleanLine, cleanText, type JComp, parseJcal, utcStamp } from "../../../src/pim/jcal";
import { caldavUtc, durationSeconds, ianaOf, readTime, vtimezoneFor, ZoneResolver } from "../../../src/pim/tz";
import { brandColor, canonSeg, eventWebUrl, parseCalendarId, parseObjectId, sabreSeg } from "../../../src/tools/calendar/caldav";
import { deliveryFailed, occurrenceProp, recurValue, reminderOf, resolveTimes, setReminder, spanOf } from "../../../src/tools/calendar/events";

const H = 3_600_000;

describe("jCal", () => {
	it("parses a calendar and refuses anything else", () => {
		expect(parseJcal('["vcalendar",[],[]]')[0]).toBe("vcalendar");
		for (const bad of ["{", '["vevent",[],[]]', '["vcalendar",{},[]]', '["vcalendar",[["x"]],[]]', '"x"', "null"]) {
			expect(() => parseJcal(bad), bad).toThrow(ToolError);
		}
		let deep: unknown = ["vevent", [], []];
		for (let i = 0; i < 12; i++) deep = ["x", [], [deep]];
		expect(() => parseJcal(JSON.stringify(["vcalendar", [], [deep]]))).toThrow(ToolError);
	});
	it("cleans text: no control characters, single-line titles", () => {
		expect(cleanText("a\r\nb\u0000c\u0007\td")).toBe("a\nbc\td");
		expect(cleanLine(" Plan\nBEGIN:VALARM\r\nx ")).toBe("Plan BEGIN:VALARM x");
		expect(utcStamp(Date.UTC(2026, 9, 25, 11, 0, 0, 500))).toBe("2026-10-25T11:00:00Z");
		expect(caldavUtc(Date.UTC(2026, 9, 25, 11, 2, 3))).toBe("20261025T110203Z");
	});
});

describe("time zones", () => {
	it("reads IANA names, UTC aliases and vendor prefixes", () => {
		expect(ianaOf("Europe/London")).toBe("Europe/London");
		expect(ianaOf("UTC")).toBe("UTC");
		expect(ianaOf("Z")).toBe("UTC");
		expect(ianaOf("/mozilla.org/20050126_1/Europe/Berlin")).toBe("Europe/Berlin");
		expect(ianaOf("W. Europe Standard Time")).toBeNull();
		expect(ianaOf("Mars/Olympus")).toBeNull();
		expect(ianaOf(null)).toBeNull();
	});
	it("builds VTIMEZONE blocks with ical.js from timezones-ical-library", () => {
		const vtz = vtimezoneFor("Europe/London");
		expect(vtz?.[0]).toBe("vtimezone");
		expect(vtz?.[1].find((p) => p[0] === "tzid")?.[3]).toBe("Europe/London");
		expect(vtz?.[2].map((c) => c[0]).sort()).toEqual(["daylight", "standard"]);
		expect(vtimezoneFor("UTC")).toBeNull();
		expect(vtimezoneFor("Not/AZone")).toBeNull();
	});
	it("turns TZID wall times into instants across daylight saving, also through a VTIMEZONE", () => {
		const r = new ZoneResolver(null, "UTC");
		expect(r.toUtc("2026-10-27T09:00:00", "America/New_York")).toBe(Date.UTC(2026, 9, 27, 13));
		expect(r.toUtc("2026-11-03T09:00:00", "America/New_York")).toBe(Date.UTC(2026, 10, 3, 14));
		expect(r.toUtc("2026-11-03T09:00:00Z", "America/New_York")).toBe(Date.UTC(2026, 10, 3, 9));
		const ny = vtimezoneFor("America/New_York") as JComp;
		const renamed = JSON.parse(JSON.stringify(ny).replace(/"America\/New_York"/g, '"Eastern Standard Time"')) as JComp;
		const r2 = new ZoneResolver(["vcalendar", [], [renamed]], "UTC");
		expect(r2.toUtc("2026-11-03T09:00:00", "Eastern Standard Time")).toBe(Date.UTC(2026, 10, 3, 14));
		const floating = new ZoneResolver(null, "Europe/Berlin");
		expect(floating.toUtc("2026-07-01T12:00:00", null)).toBe(Date.UTC(2026, 6, 1, 10));
		expect(floating.toUtc("not a time", null)).toBeNull();
		expect(readTime(["dtstart", {}, "date", "2026-11-03"], r)).toEqual({ kind: "date", y: 2026, mo: 11, d: 3 });
	});
	it("reads durations", () => {
		expect(durationSeconds("PT1H30M")).toBe(5400);
		expect(durationSeconds("-PT15M")).toBe(-900);
		expect(durationSeconds("P1D")).toBe(86400);
		expect(durationSeconds("garbage")).toBeNull();
		expect(durationSeconds(5)).toBeNull();
	});
});

describe("ids", () => {
	it("accepts only canonical segments and never the trash, inbox or outbox", () => {
		expect(canonSeg("personal")).toBe("personal");
		expect(canonSeg("a%20b.ics")).toBe("a%20b.ics");
		expect(canonSeg("it's(1).ics")).toBe("it%27s%281%29.ics");
		expect(canonSeg("..")).toBeNull();
		expect(canonSeg("%2e%2e")).toBeNull();
		expect(canonSeg("a%2Fb")).toBeNull();
		expect(canonSeg("%E0%A4%A")).toBeNull();
		expect(parseObjectId("personal/abc.ics", "event_id", "event")).toEqual({ calId: "personal", objId: "abc.ics" });
		for (const bad of ["personal", "personal/../x.ics", "../x/y.ics", "trashbin/x.ics", "inbox/x.ics", "a b/x.ics", "personal/a%2Fb.ics", "personal/x.ics/y", "https://evil/x"]) {
			expect(() => parseObjectId(bad, "event_id", "event"), bad).toThrow(ToolError);
		}
		expect(() => parseCalendarId("outbox")).toThrow(ToolError);
		expect(() => parseCalendarId("a/b")).toThrow(ToolError);
		expect(parseCalendarId("team_shared_by_qa-t1-92")).toBe("team_shared_by_qa-t1-92");
	});
	it("links events to NoCalendar and falls back to the day when the id can't travel in a path", () => {
		const url = eventWebUrl("https://drive.nourax.org", "u1", "personal", "a.ics", null, "2026-11-03");
		expect(url).toBe(`https://drive.nourax.org/apps/calendar/edit/${btoa("/remote.php/dav/calendars/u1/personal/a.ics")}`);
		expect(eventWebUrl("https://d", "u1", "personal", "a.ics", Date.UTC(2026, 10, 3, 9), "2026-11-03")).toMatch(/\/1793696400$/);
		// The base64 is of the href as the server writes it: Sabre leaves ' ( ) ! ~ unencoded.
		const odd = eventWebUrl("https://d", "u1", "personal", "it%27s%281%29%20x.ics", null, "2026-11-03");
		expect(atob(odd.split("/edit/")[1] ?? "")).toBe("/remote.php/dav/calendars/u1/personal/it's(1)%20x.ics");
		// Percent-encoded ASCII hrefs never give a "/" in base64, so the edit link always applies.
		fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 30 }), (s) => !btoa(`/remote.php/dav/calendars/u1/personal/${sabreSeg(encodeURIComponent(s))}`).includes("/")));
		expect(brandColor("#0082c9")).toBe("#2563EB");
		expect(brandColor("#00679Eff")).toBe("#2563EB");
		expect(brandColor("#f97316")).toBe("#F97316");
	});
});

describe("event helpers", () => {
	const zone = "Europe/London";
	it("works out times from create-style input", () => {
		const t = resolveTimes({ start: { kind: "instant", utcMs: Date.UTC(2026, 10, 3, 14) } }, zone);
		expect(t).toMatchObject({ allDay: false, endMs: Date.UTC(2026, 10, 3, 15) });
		const d = resolveTimes({ start: { kind: "date", y: 2026, mo: 11, d: 3 }, end: { kind: "date", y: 2026, mo: 11, d: 5 } }, zone);
		expect(d).toMatchObject({ allDay: true, firstDay: { y: 2026, mo: 11, d: 3 }, endDay: { y: 2026, mo: 11, d: 6 } });
		expect(() => resolveTimes({ start: { kind: "instant", utcMs: 10 * H }, end: { kind: "instant", utcMs: 9 * H } }, zone)).toThrow(/after start/);
		expect(() => resolveTimes({ start: { kind: "date", y: 2026, mo: 11, d: 3 }, allDay: false }, zone)).toThrow(/needs a time/);
		expect(() => resolveTimes({ start: { kind: "date", y: 2026, mo: 11, d: 5 }, end: { kind: "date", y: 2026, mo: 11, d: 3 } }, zone)).toThrow(/before start/);
		expect(() => resolveTimes({ start: { kind: "instant", utcMs: 0 }, durationMin: 367 * 1440 }, zone)).toThrow(/366 days/);
	});
	it("writes repeat rules, with UNTIL in UTC for timed events and as a date for all-day ones", () => {
		const start = Date.UTC(2026, 9, 27, 9);
		expect(recurValue({ frequency: "weekly", interval: 2, weekdays: ["tu", "th", "tu"] }, false, zone, start)).toEqual({ freq: "WEEKLY", interval: 2, byday: ["TU", "TH"] });
		expect(recurValue({ frequency: "daily", interval: 1, until: "2026-11-13" }, false, "America/New_York", start)).toEqual({ freq: "DAILY", until: "2026-11-14T04:59:59Z" });
		expect(recurValue({ frequency: "yearly", interval: 1, until: "2030-01-01" }, true, zone, Date.UTC(2026, 0, 1))).toEqual({ freq: "YEARLY", until: "2030-01-01" });
		expect(() => recurValue({ frequency: "weekly", interval: 1, count: 3, until: "2026-12-01" }, false, zone, start)).toThrow(/not both/);
		expect(() => recurValue({ frequency: "monthly", interval: 1, weekdays: ["mo"] }, false, zone, start)).toThrow(/daily or weekly/);
		expect(() => recurValue({ frequency: "daily", interval: 1, until: "2026-01-01" }, false, zone, start)).toThrow(/before the first/);
	});
	it("writes occurrence ids the way the master's start is written", () => {
		const tzMaster: JComp = ["vevent", [["dtstart", { tzid: "America/New_York" }, "date-time", "2026-10-27T09:00:00"]], []];
		expect(occurrenceProp("recurrence-id", tzMaster, { kind: "instant", utcMs: Date.UTC(2026, 10, 3, 14) })).toEqual(["recurrence-id", { tzid: "America/New_York" }, "date-time", "2026-11-03T09:00:00"]);
		const utcMaster: JComp = ["vevent", [["dtstart", {}, "date-time", "2026-10-27T09:00:00Z"]], []];
		expect(occurrenceProp("exdate", utcMaster, { kind: "instant", utcMs: Date.UTC(2026, 10, 3, 9) })).toEqual(["exdate", {}, "date-time", "2026-11-03T09:00:00Z"]);
		const dayMaster: JComp = ["vevent", [["dtstart", {}, "date", "2026-10-27"]], []];
		expect(occurrenceProp("exdate", dayMaster, { kind: "date", y: 2026, mo: 11, d: 3 })).toEqual(["exdate", {}, "date", "2026-11-03"]);
		expect(() => occurrenceProp("exdate", utcMaster, { kind: "date", y: 2026, mo: 11, d: 3 })).toThrow(ToolError);
	});
	it("reads spans: all-day end is the last day, missing DTEND uses DURATION", () => {
		const r = new ZoneResolver(null, zone);
		const allDay = spanOf(["vevent", [["dtstart", {}, "date", "2026-11-03"], ["dtend", {}, "date", "2026-11-05"]], []], r, zone);
		expect(allDay).toMatchObject({ allDay: true, lastDay: { y: 2026, mo: 11, d: 4 } });
		const dur = spanOf(["vevent", [["dtstart", {}, "date-time", "2026-11-03T09:00:00Z"], ["duration", {}, "duration", "PT45M"]], []], r, zone);
		expect(dur).toMatchObject({ allDay: false, startMs: Date.UTC(2026, 10, 3, 9), endMs: Date.UTC(2026, 10, 3, 9, 45) });
	});
	it("keeps one display reminder", () => {
		const v: JComp = ["vevent", [], [["valarm", [["trigger", {}, "duration", "-PT1H"]], []]]];
		expect(reminderOf(v)).toBe(60);
		setReminder(v, 15, "Plan");
		expect(v[2]).toHaveLength(1);
		expect(reminderOf(v)).toBe(15);
		setReminder(v, null, "Plan");
		expect(v[2]).toHaveLength(0);
	});
	it("knows which SCHEDULE-STATUS codes mean the workspace couldn't deliver", () => {
		for (const ok of [undefined, "1.2", "1.1", "5.0", "5.0; EMail delivery failed", "1.0"]) expect(deliveryFailed(ok), String(ok)).toBe(false);
		for (const bad of ["3.7", "3.8;insufficient privileges", "5.2", "5.2;Could not find local inbox"]) expect(deliveryFailed(bad), bad).toBe(true);
	});
});

describe("free time", () => {
	const zone = "Europe/London";
	const wh = { fromMin: 9 * 60, toMin: 17 * 60, weekdays: [1, 2, 3, 4, 5] };
	it("merges, subtracts and aligns", () => {
		expect(mergeIntervals([{ start: 5, end: 8 }, { start: 1, end: 3 }, { start: 3, end: 4 }, { start: 7, end: 9 }, { start: 9, end: 9 }])).toEqual([
			{ start: 1, end: 4 },
			{ start: 5, end: 9 },
		]);
		expect(subtract([{ start: 0, end: 10 }], [{ start: 2, end: 3 }, { start: 5, end: 12 }])).toEqual([
			{ start: 0, end: 2 },
			{ start: 3, end: 5 },
		]);
		expect(alignUp(Date.UTC(2026, 10, 3, 9, 7), 15, "UTC")).toBe(Date.UTC(2026, 10, 3, 9, 15));
		expect(alignUp(Date.UTC(2026, 10, 3, 9, 30), 30, "UTC")).toBe(Date.UTC(2026, 10, 3, 9, 30));
		expect(hhmm("24:00")).toBe(1440);
		expect(hhmm("24:01")).toBeNull();
		expect(hhmm("9:00")).toBeNull();
	});
	it("keeps working hours on the wall clock across the October change", () => {
		// 2026-10-23 is a Friday; the clocks go back on Sunday 2026-10-25 in London.
		const w = workingWindows({ start: Date.UTC(2026, 9, 23), end: Date.UTC(2026, 9, 27) }, wh, zone);
		expect(w.map((x) => [toZonedIso(x.start, zone), toZonedIso(x.end, zone)])).toEqual([
			["2026-10-23T09:00:00+01:00", "2026-10-23T17:00:00+01:00"],
			["2026-10-26T09:00:00+00:00", "2026-10-26T17:00:00+00:00"],
		]);
	});
	it("finds back-to-back slots around busy time, earliest first", () => {
		const day = (h: number, m = 0) => zonedToUtc(2026, 11, 3, h, m, 0, zone);
		const slots = freeSlots({
			range: { start: day(0), end: day(23) },
			busy: [{ start: day(9, 30), end: day(10, 15) }, { start: day(13), end: day(16) }],
			durationMin: 60,
			stepMin: 30,
			workingHours: wh,
			zone,
			max: 10,
		});
		expect(slots.map((s) => toZonedIso(s.start, zone).slice(11, 16))).toEqual(["10:30", "11:30", "16:00"]);
	});
	it("property: slots are inside working hours, never overlap busy time, and are sorted", () => {
		fc.assert(
			fc.property(
				fc.array(fc.record({ s: fc.integer({ min: 0, max: 7 * 24 * 4 }), len: fc.integer({ min: 1, max: 40 }) }), { maxLength: 30 }),
				fc.constantFrom(15, 30, 60, 90, 240),
				fc.constantFrom(15, 30, 60),
				fc.constantFrom("UTC", "Europe/London", "America/New_York", "Asia/Kolkata"),
				(busyRaw, dur, step, z) => {
					const base = Date.UTC(2026, 9, 19);
					const busy = busyRaw.map((b) => ({ start: base + b.s * 15 * 60_000, end: base + (b.s + b.len) * 15 * 60_000 }));
					const slots = freeSlots({ range: { start: base, end: base + 7 * 24 * H }, busy, durationMin: dur, stepMin: step, workingHours: wh, zone: z, max: 50 });
					for (let i = 0; i < slots.length; i++) {
						const x = slots[i] as { start: number; end: number };
						if (x.end - x.start !== dur * 60_000) return false;
						if (i > 0 && x.start < (slots[i - 1] as { end: number }).end) return false;
						if (busy.some((b) => b.start < x.end && x.start < b.end)) return false;
						const local = toZonedIso(x.start, z);
						const hh = Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
						if (hh < 9 * 60 || hh % step !== 0) return false;
						const endLocal = toZonedIso(x.end, z);
						const eh = Number(endLocal.slice(11, 13)) * 60 + Number(endLocal.slice(14, 16));
						if (endLocal.slice(0, 10) === local.slice(0, 10) && eh > 17 * 60) return false;
						const wd = ((new Date(`${local.slice(0, 10)}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
						if (wd > 5) return false;
					}
					return true;
				},
			),
			{ numRuns: 150 },
		);
	});
});
