/** Contract test for calendar_find_free_time (DESIGN 17.3). Dates are in 2030 so they stay ahead. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calCalls, callTool, errCode, QA, resetTokens, type Setup, setup, vevent } from "./_helpers";

let s: Setup;
const me = "qa-t1-91@example.invalid";
beforeEach(async () => {
	s = setup();
	await resetTokens();
	s.cal.home(QA.a);
	s.cal.addCalendar(QA.a, { uri: "holidays", displayname: "Holidays", comps: ["VEVENT"], transparent: true });
	s.cal.addCalendar(QA.a, { uri: "team_shared_by_qa-t1-92", displayname: "Team", comps: ["VEVENT"], owner: QA.b, readOnly: true });
	// Monday 2030-11-04: busy 09:00-10:00 and 13:00-15:00; free events, cancelled and declined ones don't count.
	s.cal.put(QA.a, "personal", "a.ics", vevent("a", "2030-11-04T09:00:00Z", "2030-11-04T10:00:00Z"));
	s.cal.put(QA.a, "personal", "b.ics", vevent("b", "2030-11-04T13:00:00Z", "2030-11-04T15:00:00Z"));
	s.cal.put(QA.a, "personal", "free.ics", vevent("free", "2030-11-04T10:00:00Z", "2030-11-04T11:00:00Z", [["transp", {}, "text", "TRANSPARENT"]]));
	s.cal.put(QA.a, "personal", "cancelled.ics", vevent("cancelled", "2030-11-04T11:00:00Z", "2030-11-04T12:00:00Z", [["status", {}, "text", "CANCELLED"]]));
	s.cal.put(QA.a, "personal", "declined.ics", vevent("declined", "2030-11-04T12:00:00Z", "2030-11-04T13:00:00Z", [["attendee", { partstat: "DECLINED" }, "cal-address", `mailto:${me}`]]));
	s.cal.put(QA.a, "holidays", "h.ics", vevent("h", "2030-11-04T15:00:00Z", "2030-11-04T17:00:00Z"));
	s.cal.put(QA.a, "team_shared_by_qa-t1-92", "t.ics", vevent("t", "2030-11-04T10:00:00Z", "2030-11-04T12:00:00Z"));
});
afterEach(() => vi.restoreAllMocks());

const base = { start: "2030-11-04", end: "2030-11-04", duration_minutes: 60 };
const starts = (r: { structuredContent: Record<string, unknown> }) => (r.structuredContent.slots as { start: string }[]).map((x) => x.start.slice(11, 16));

describe("calendar_find_free_time", () => {
	it("counts only the person's own opaque calendars and leaves out free, cancelled and declined events", async () => {
		s.fake.requests.length = 0;
		const r = await callTool("calendar_find_free_time", base);
		expect(r.isError).toBeFalsy();
		expect(starts(r)).toEqual(["10:00", "11:00", "12:00", "15:00", "16:00"]);
		expect(r.structuredContent).toMatchObject({ time_zone: "UTC", calendars_checked: ["personal"] });
		expect(calCalls(s.fake, "REPORT").map((c) => c.url.pathname)).toEqual([`/remote.php/dav/calendars/${QA.a}/personal/`]);
		expect(r.content[0]?.text.split("\n")[0]).toBe("Found 5 free slots of 60 minutes.");
	});

	it("uses exactly the calendars given, shared ones too", async () => {
		const r = await callTool("calendar_find_free_time", { ...base, calendar_ids: ["personal", "team_shared_by_qa-t1-92", "holidays"] });
		expect(starts(r)).toEqual(["12:00"]);
	});

	it("follows working hours, weekdays, step and zone", async () => {
		const r = await callTool("calendar_find_free_time", { ...base, duration_minutes: 30, step_minutes: 15, working_hours: { from: "08:00", to: "09:30", weekdays: [1] }, max_results: 3 });
		expect(starts(r)).toEqual(["08:00", "08:30"]);
		const weekend = await callTool("calendar_find_free_time", { start: "2030-11-09", end: "2030-11-10", duration_minutes: 60 });
		expect(weekend.structuredContent.slots).toEqual([]);
		expect(weekend.content[0]?.text.split("\n")[0]).toContain("No free slot");
		const ny = await callTool("calendar_find_free_time", { ...base, time_zone: "America/New_York", working_hours: { from: "09:00", to: "11:00", weekdays: [1] } });
		expect((ny.structuredContent.slots as { start: string }[])[0]?.start).toBe("2030-11-04T10:00:00-05:00");
		expect(ny.structuredContent.time_zone).toBe("America/New_York");
	});

	it("fills working hours that are only partly given from the defaults, field by field", async () => {
		// Only "from" given: to stays 17:00 and the weekdays stay Monday to Friday.
		const r = await callTool("calendar_find_free_time", { ...base, working_hours: { from: "15:00" } });
		expect(starts(r)).toEqual(["15:00", "16:00"]);
		const sat = await callTool("calendar_find_free_time", { start: "2030-11-09", end: "2030-11-09", duration_minutes: 60, working_hours: { to: "12:00" } });
		expect(sat.structuredContent.slots).toEqual([]);
	});

	it("never offers time in the past", async () => {
		const r = await callTool("calendar_find_free_time", { start: "2020-01-06", end: "2020-01-07", duration_minutes: 30 });
		expect(r.structuredContent.slots).toEqual([]);
		expect(r.structuredContent.warnings).toEqual(["The part of the range that is already past was left out."]);
	});

	it("refuses impossible input plainly", async () => {
		const cases: [Record<string, unknown>, string][] = [
			[{ ...base, working_hours: { from: "17:00", to: "09:00" } }, "working_hours.to"],
			[{ ...base, duration_minutes: 480, working_hours: { from: "09:00", to: "12:00" } }, "duration_minutes"],
			[{ ...base, end: "2030-12-31" }, "end"],
			[{ ...base, time_zone: "Mars/Base" }, "time_zone"],
			[{ ...base, step_minutes: 20 }, "step_minutes"],
			// DESIGN 11.5 allows 15, 30 or 60 only (review fix round 1: 45 used to pass).
			[{ ...base, step_minutes: 45 }, "step_minutes"],
			[{ ...base, duration_minutes: 5 }, "duration_minutes"],
		];
		for (const [args, field] of cases) {
			const r = await callTool("calendar_find_free_time", args);
			expect(errCode(r), JSON.stringify(args)).toBe("invalid_input");
			expect(r._meta?.["nourax/error"]?.field, JSON.stringify(args)).toBe(field);
		}
	});
});
