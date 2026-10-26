/** Contract test for calendar_create_event (DESIGN 17.3). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JComp } from "../../../src/pim/jcal";
import { calCalls, callTool, errCode, propOf, QA, resetTokens, type Setup, setup, tokenFor } from "./_helpers";

let s: Setup;
beforeEach(async () => {
	s = setup();
	await resetTokens();
	s.cal.home(QA.a);
	s.cal.addCalendar(QA.a, { uri: "todo", displayname: "To do", comps: ["VTODO"] });
	s.cal.addCalendar(QA.a, { uri: "team_shared_by_qa-t1-92", displayname: "Team", comps: ["VEVENT"], owner: QA.b, readOnly: true });
});
afterEach(() => vi.restoreAllMocks());

function sentBody(): JComp {
	const put = calCalls(s.fake, "PUT").pop();
	return JSON.parse(put?.body ?? "null") as JComp;
}

describe("calendar_create_event", () => {
	it("PUTs a new jCal object with If-None-Match and scheduling off, in the default calendar, in UTC", async () => {
		s.fake.requests.length = 0;
		const r = await callTool("calendar_create_event", { title: "Plan\nBEGIN:VALARM", start: "2030-11-04T09:00", duration_minutes: 45, location: "Room 2", description: "Line 1\nLine 2" });
		expect(r.isError).toBeFalsy();
		const put = calCalls(s.fake, "PUT").pop();
		expect(put?.url.pathname).toMatch(new RegExp(`^/remote\\.php/dav/calendars/${QA.a}/personal/[0-9a-f-]{36}\\.ics$`));
		expect(put?.headers.get("if-none-match")).toBe("*");
		expect(put?.headers.get("x-nc-scheduling")).toBe("false");
		expect(put?.headers.get("content-type")).toBe("application/calendar+json");
		expect(put?.headers.get("authorization")).toMatch(/^Basic /);
		const body = sentBody();
		expect(propOf(body, "vevent", "summary")?.[3]).toBe("Plan BEGIN:VALARM");
		expect(propOf(body, "vevent", "dtstart")).toEqual(["dtstart", {}, "date-time", "2030-11-04T09:00:00Z"]);
		expect(propOf(body, "vevent", "dtend")).toEqual(["dtend", {}, "date-time", "2030-11-04T09:45:00Z"]);
		expect(propOf(body, "vevent", "description")?.[3]).toBe("Line 1\nLine 2");
		expect(propOf(body, "vevent", "attendee")).toBeUndefined();
		expect(propOf(body, "vevent", "organizer")).toBeUndefined();
		expect(body[2].some((c) => c[0] === "vtimezone")).toBe(false);
		const ev = r.structuredContent.event as Record<string, unknown>;
		expect(ev).toMatchObject({ calendar_id: "personal", title: "Plan BEGIN:VALARM", start: "2030-11-04T09:00:00+00:00", end: "2030-11-04T09:45:00+00:00", all_day: false, location: "Room 2", repeats: false });
		expect(r.structuredContent.undo).toEqual({ tool: "calendar_cancel_event", arguments: { event_id: ev.event_id, mode: "remove" } });
		// The read-back gives the ETag (a jCal PUT answers without one).
		expect(calCalls(s.fake, "GET").length).toBe(1);
		expect(ev.etag).toMatch(/^"etag/);
	});

	it("writes all-day events as dates, with end as the last day", async () => {
		const r = await callTool("calendar_create_event", { title: "Away", start: "2030-11-04", end: "2030-11-06" });
		const body = sentBody();
		expect(propOf(body, "vevent", "dtstart")).toEqual(["dtstart", {}, "date", "2030-11-04"]);
		expect(propOf(body, "vevent", "dtend")).toEqual(["dtend", {}, "date", "2030-11-07"]);
		expect(r.structuredContent.event).toMatchObject({ all_day: true, start: "2030-11-04", end: "2030-11-06" });
	});

	it("writes repeating timed events with a TZID, a VTIMEZONE and an RRULE, plus a reminder", async () => {
		const r = await callTool("calendar_create_event", {
			title: "Standup",
			start: "2030-11-04T09:00",
			end: "2030-11-04T09:15",
			time_zone: "Europe/Berlin",
			repeat: { frequency: "weekly", weekdays: ["mo", "we"], until: "2030-12-31" },
			reminder_minutes_before: 10,
		});
		expect(r.isError).toBeFalsy();
		const body = sentBody();
		expect(propOf(body, "vevent", "dtstart")).toEqual(["dtstart", { tzid: "Europe/Berlin" }, "date-time", "2030-11-04T09:00:00"]);
		expect(propOf(body, "vevent", "rrule")).toEqual(["rrule", {}, "recur", { freq: "WEEKLY", until: "2030-12-31T22:59:59Z", byday: ["MO", "WE"] }]);
		expect(body[2].find((c) => c[0] === "vtimezone")?.[1].find((p) => p[0] === "tzid")?.[3]).toBe("Europe/Berlin");
		const alarm = body[2].find((c) => c[0] === "vevent")?.[2][0];
		expect(alarm?.[0]).toBe("valarm");
		expect(alarm?.[1].find((p) => p[0] === "trigger")?.[3]).toBe("-PT10M");
		expect(r.structuredContent.event).toMatchObject({ start: "2030-11-04T08:00:00+00:00", repeats: true, reminder_minutes_before: 10, time_zone: "Europe/Berlin" });
		expect(r.content[0]?.text.split("\n")[0]).toBe("Created an event that repeats weekly in the default calendar.");
	});

	it("returns the earlier event for a repeat call within 10 minutes, unless allow_duplicate", async () => {
		const token = await tokenFor(QA.a);
		const args = { title: "Once", start: "2030-11-05T10:00" };
		const a = await callTool("calendar_create_event", args, { token });
		const b = await callTool("calendar_create_event", args, { token });
		expect((b.structuredContent.event as { event_id: string }).event_id).toBe((a.structuredContent.event as { event_id: string }).event_id);
		expect(b.content[0]?.text).toMatch(/^This matches a call made/);
		const c = await callTool("calendar_create_event", { ...args, allow_duplicate: true }, { token });
		expect((c.structuredContent.event as { event_id: string }).event_id).not.toBe((a.structuredContent.event as { event_id: string }).event_id);
		expect(s.cal.home(QA.a).get("personal")?.objects.size).toBe(2);
	});

	it("uses the calendar given and refuses ones that can't take the event", async () => {
		s.cal.addCalendar(QA.a, { uri: "work", displayname: "Work", comps: ["VEVENT"] });
		const ok = await callTool("calendar_create_event", { title: "W", start: "2030-11-05T10:00", calendar_id: "work" });
		expect((ok.structuredContent.event as { calendar_id: string }).calendar_id).toBe("work");
		expect(errCode(await callTool("calendar_create_event", { title: "W", start: "2030-11-05T10:00", calendar_id: "team_shared_by_qa-t1-92" }))).toBe("permission_denied");
		expect(errCode(await callTool("calendar_create_event", { title: "W", start: "2030-11-05T10:00", calendar_id: "todo" }))).toBe("invalid_input");
		expect(errCode(await callTool("calendar_create_event", { title: "W", start: "2030-11-05T10:00", calendar_id: "gone" }))).toBe("not_found");
		expect(errCode(await callTool("calendar_create_event", { title: "W", start: "2030-11-05T10:00", calendar_id: "trashbin" }))).toBe("invalid_input");
	});

	it("refuses impossible input before calling NoCalendar", async () => {
		s.fake.requests.length = 0;
		const cases: Record<string, unknown>[] = [
			{ title: "X", start: "2030-11-05T10:00", end: "2030-11-05T11:00", duration_minutes: 30 },
			{ title: "X", start: "2030-11-05T10:00", end: "2030-11-05T09:00" },
			{ title: "X", start: "2030-11-05", all_day: false },
			{ title: "X", start: "2030-11-05T10:00", time_zone: "Nowhere/Land" },
			{ title: "   ", start: "2030-11-05T10:00" },
			{ title: "X", start: "2030-11-05T10:00", repeat: { frequency: "monthly", weekdays: ["mo"] } },
			{ title: "X", start: "2030-11-05T10:00", attendees: ["person:qa-t1-92"] },
			{ title: "X", start: "2030-11-05T10:00", organizer: "mailto:x@example.org" },
			{ title: "x".repeat(256), start: "2030-11-05T10:00" },
		];
		for (const c of cases) expect(errCode(await callTool("calendar_create_event", c)), JSON.stringify(c).slice(0, 80)).toBe("invalid_input");
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
	});

	it("maps refusals: quota full and a server error", async () => {
		s.fake.on("PUT", /^\/remote\.php\/dav\/calendars\//, () => new Response("<s:message>Insufficient storage</s:message>", { status: 507 }));
		expect(errCode(await callTool("calendar_create_event", { title: "Q", start: "2030-11-05T10:00" }))).toBe("quota_exceeded");
		s.fake.on("PUT", /^\/remote\.php\/dav\/calendars\//, () => new Response("Sabre\\Exception", { status: 500 }));
		const r = await callTool("calendar_create_event", { title: "Q", start: "2030-11-05T10:00", allow_duplicate: true });
		expect(errCode(r)).toBe("upstream_unavailable");
		expect(r.content[0]?.text).not.toMatch(/sabre/i);
	});
});
