/** Contract test for calendar_update_event (DESIGN 17.3). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JComp } from "../../../src/pim/jcal";
import { vtimezoneFor } from "../../../src/pim/tz";
import { calCalls, callTool, errCode, propOf, QA, resetTokens, type Setup, setup, vevent } from "./_helpers";

let s: Setup;
const A = "qa-t1-91@example.invalid";
const B = "qa-t1-92@example.invalid";

function weeklyBerlin(): JComp {
	const cal = vevent("weekly", "2030-11-04T09:00:00", "2030-11-04T09:30:00", [["rrule", {}, "recur", { freq: "WEEKLY", count: 5 }]]);
	for (const p of cal[2][0]?.[1] ?? []) if (p[0] === "dtstart" || p[0] === "dtend") p[1] = { tzid: "Europe/Berlin" };
	const vtz = vtimezoneFor("Europe/Berlin");
	if (vtz) cal[2].unshift(vtz);
	return cal;
}

beforeEach(async () => {
	s = setup();
	await resetTokens();
	s.cal.home(QA.a);
	s.cal.addCalendar(QA.a, { uri: "work", displayname: "Work", comps: ["VEVENT"] });
	s.cal.addCalendar(QA.a, { uri: "todo", displayname: "To do", comps: ["VTODO"] });
	s.cal.addCalendar(QA.a, { uri: "team_shared_by_qa-t1-92", displayname: "Team", comps: ["VEVENT"], owner: QA.b, readOnly: true });
	s.cal.put(QA.a, "personal", "single.ics", vevent("single", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z", [["location", {}, "text", "Room 1"], ["sequence", {}, "integer", 2]]));
	s.cal.put(QA.a, "personal", "weekly.ics", weeklyBerlin());
	s.cal.put(QA.a, "team_shared_by_qa-t1-92", "t.ics", vevent("t", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z"));
});
afterEach(() => vi.restoreAllMocks());

const stored = (cal: string, obj: string) => s.cal.get(QA.a, cal, obj)?.jcal as JComp;

describe("calendar_update_event", () => {
	it("GETs, changes only the fields given and PUTs back with If-Match and scheduling off", async () => {
		const etag = s.cal.get(QA.a, "personal", "single.ics")?.etag;
		s.fake.requests.length = 0;
		const r = await callTool("calendar_update_event", { event_id: "personal/single.ics", title: "New title", location: null });
		expect(r.isError).toBeFalsy();
		const get = calCalls(s.fake, "GET")[0];
		expect(get?.headers.get("accept")).toBe("application/calendar+json");
		const put = calCalls(s.fake, "PUT")[0];
		expect(put?.url.pathname).toBe(`/remote.php/dav/calendars/${QA.a}/personal/single.ics`);
		expect(put?.headers.get("if-match")).toBe(etag);
		expect(put?.headers.get("x-nc-scheduling")).toBe("false");
		const cal = stored("personal", "single.ics");
		expect(propOf(cal, "vevent", "summary")?.[3]).toBe("New title");
		expect(propOf(cal, "vevent", "location")).toBeUndefined();
		expect(propOf(cal, "vevent", "sequence")?.[3]).toBe(3);
		expect(propOf(cal, "vevent", "dtstart")?.[3]).toBe("2030-11-05T10:00:00Z");
		expect(r.structuredContent.undo).toEqual({ tool: "calendar_update_event", arguments: { event_id: "personal/single.ics", title: "Event single", location: "Room 1" } });
		expect(r.structuredContent.notified).toEqual([]);
		expect(r.structuredContent.event).toMatchObject({ title: "New title", location: null });
	});

	it("moves the start and keeps the length; switches to all-day", async () => {
		const r = await callTool("calendar_update_event", { event_id: "personal/single.ics", start: "2030-11-06T14:00" });
		expect(r.structuredContent.event).toMatchObject({ start: "2030-11-06T14:00:00+00:00", end: "2030-11-06T15:00:00+00:00" });
		expect((r.structuredContent.undo as { arguments: Record<string, unknown> }).arguments).toMatchObject({ start: "2030-11-05T10:00:00+00:00", end: "2030-11-05T11:00:00+00:00", all_day: false });
		const d = await callTool("calendar_update_event", { event_id: "personal/single.ics", all_day: true });
		expect(d.structuredContent.event).toMatchObject({ all_day: true, start: "2030-11-06", end: "2030-11-06" });
		expect(propOf(stored("personal", "single.ics"), "vevent", "dtend")).toEqual(["dtend", {}, "date", "2030-11-07"]);
	});

	it("refuses a stale expected_etag, and retries once by itself after a 412", async () => {
		s.fake.requests.length = 0;
		const stale = await callTool("calendar_update_event", { event_id: "personal/single.ics", title: "X", expected_etag: '"old"' });
		expect(errCode(stale)).toBe("conflict");
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
		let n = 0;
		s.fake.on("GET", /^\/remote\.php\/dav\/calendars\/[^/]+\/personal\/single\.ics$/, () => {
			const o = s.cal.get(QA.a, "personal", "single.ics");
			if (!o) return new Response("", { status: 404 });
			const res = new Response(JSON.stringify(o.jcal), { status: 200, headers: { etag: o.etag, "content-type": "application/calendar+json" } });
			if (n++ === 0) o.etag = s.cal.etag();
			return res;
		});
		s.fake.requests.length = 0;
		const r = await callTool("calendar_update_event", { event_id: "personal/single.ics", title: "After race" });
		expect(r.isError).toBeFalsy();
		expect(calCalls(s.fake, "PUT").length).toBe(2);
		expect(propOf(stored("personal", "single.ics"), "vevent", "summary")?.[3]).toBe("After race");
	});

	it("needs scope for a repeating event; 'this' adds an override for that occurrence only", async () => {
		expect(errCode(await callTool("calendar_update_event", { event_id: "personal/weekly.ics", title: "X" }))).toBe("invalid_input");
		expect(errCode(await callTool("calendar_update_event", { event_id: "personal/weekly.ics", scope: "this", title: "X" }))).toBe("invalid_input");
		s.fake.requests.length = 0;
		const r = await callTool("calendar_update_event", { event_id: "personal/weekly.ics", scope: "this", occurrence_start: "2030-11-11T08:00:00+00:00", title: "Moved one", start: "2030-11-11T12:00" });
		expect(r.isError).toBeFalsy();
		const mg = calCalls(s.fake, "REPORT")[0];
		expect(mg?.body).toContain("calendar-multiget");
		expect(mg?.body).toContain("<cal:expand");
		const cal = stored("personal", "weekly.ics");
		const events = cal[2].filter((c) => c[0] === "vevent");
		expect(events).toHaveLength(2);
		const ov = events.find((c) => c[1].some((p) => p[0] === "recurrence-id"));
		expect(ov?.[1].find((p) => p[0] === "recurrence-id")).toEqual(["recurrence-id", { tzid: "Europe/Berlin" }, "date-time", "2030-11-11T09:00:00"]);
		expect(ov?.[1].find((p) => p[0] === "summary")?.[3]).toBe("Moved one");
		expect(ov?.[1].find((p) => p[0] === "rrule")).toBeUndefined();
		expect(r.structuredContent.event).toMatchObject({ title: "Moved one", start: "2030-11-11T12:00:00+00:00", occurrence_start: "2030-11-11T08:00:00+00:00", repeats: true });
		expect((r.structuredContent.undo as { arguments: Record<string, unknown> }).arguments).toMatchObject({ scope: "this", occurrence_start: "2030-11-11T08:00:00+00:00", title: "Event weekly" });
		const list = await callTool("calendar_list_events", { start: "2030-11-01", end: "2030-12-15", calendar_ids: ["personal"] });
		const titles = (list.structuredContent.events as { title: string }[]).map((e) => e.title);
		expect(titles.filter((t) => t === "Moved one")).toHaveLength(1);
		expect(titles.filter((t) => t === "Event weekly")).toHaveLength(4);
	});

	it("says plainly when the series has no such occurrence", async () => {
		const r = await callTool("calendar_update_event", { event_id: "personal/weekly.ics", scope: "this", occurrence_start: "2030-11-12T08:00:00Z", title: "X" });
		expect(errCode(r)).toBe("not_found");
		expect(r._meta?.["nourax/error"]?.field).toBe("occurrence_start");
	});

	it("moving a series' start moves its single-occurrence changes and exceptions with it", async () => {
		const cal = weeklyBerlin();
		const master = cal[2].find((c) => c[0] === "vevent") as JComp;
		master[1].push(["exdate", { tzid: "Europe/Berlin" }, "date-time", "2030-11-18T09:00:00"]);
		// An override that was only renamed: it still starts at its original time.
		const ov: JComp = JSON.parse(JSON.stringify(master));
		ov[1] = ov[1].filter((p) => !["rrule", "exdate", "dtstart", "dtend", "summary"].includes(p[0]));
		ov[1].push(["summary", {}, "text", "Renamed one"]);
		ov[1].push(["dtstart", { tzid: "Europe/Berlin" }, "date-time", "2030-11-11T09:00:00"], ["dtend", { tzid: "Europe/Berlin" }, "date-time", "2030-11-11T09:30:00"]);
		ov[1].push(["recurrence-id", { tzid: "Europe/Berlin" }, "date-time", "2030-11-11T09:00:00"]);
		cal[2].push(ov);
		s.cal.put(QA.a, "personal", "weekly.ics", cal);
		const r = await callTool("calendar_update_event", { event_id: "personal/weekly.ics", scope: "series", start: "2030-11-04T10:00", time_zone: "Europe/Berlin" });
		expect(r.isError).toBeFalsy();
		const back = stored("personal", "weekly.ics");
		const m = back[2].find((c) => c[0] === "vevent" && !c[1].some((p) => p[0] === "recurrence-id")) as JComp;
		expect(m[1].find((p) => p[0] === "dtstart")).toEqual(["dtstart", { tzid: "Europe/Berlin" }, "date-time", "2030-11-04T10:00:00"]);
		expect(m[1].find((p) => p[0] === "exdate")?.[3]).toBe("2030-11-18T10:00:00");
		const o = back[2].find((c) => c[0] === "vevent" && c[1].some((p) => p[0] === "recurrence-id")) as JComp;
		expect(o[1].find((p) => p[0] === "recurrence-id")?.[3]).toBe("2030-11-11T10:00:00");
		// The override was only renamed (its own start was its original one), so its times move too (live review).
		expect(o[1].find((p) => p[0] === "dtstart")).toEqual(["dtstart", { tzid: "Europe/Berlin" }, "date-time", "2030-11-11T10:00:00"]);
		expect(o[1].find((p) => p[0] === "dtend")).toEqual(["dtend", { tzid: "Europe/Berlin" }, "date-time", "2030-11-11T10:30:00"]);
	});

	it("an occurrence rescheduled on its own keeps its own time when the series moves", async () => {
		const cal = weeklyBerlin();
		const master = cal[2].find((c) => c[0] === "vevent") as JComp;
		const ov: JComp = JSON.parse(JSON.stringify(master));
		ov[1] = ov[1].filter((p) => !["rrule", "dtstart", "dtend"].includes(p[0]));
		ov[1].push(["recurrence-id", { tzid: "Europe/Berlin" }, "date-time", "2030-11-11T09:00:00"]);
		ov[1].push(["dtstart", { tzid: "Europe/Berlin" }, "date-time", "2030-11-11T15:00:00"], ["dtend", { tzid: "Europe/Berlin" }, "date-time", "2030-11-11T15:30:00"]);
		cal[2].push(ov);
		s.cal.put(QA.a, "personal", "weekly.ics", cal);
		const r = await callTool("calendar_update_event", { event_id: "personal/weekly.ics", scope: "series", start: "2030-11-04T10:00", time_zone: "Europe/Berlin" });
		expect(r.isError).toBeFalsy();
		const o = stored("personal", "weekly.ics")[2].find((c) => c[0] === "vevent" && c[1].some((p) => p[0] === "recurrence-id")) as JComp;
		expect(o[1].find((p) => p[0] === "recurrence-id")?.[3]).toBe("2030-11-11T10:00:00");
		expect(o[1].find((p) => p[0] === "dtstart")?.[3]).toBe("2030-11-11T15:00:00");
	});

	it("moves exceptions by wall-clock time when the series start crosses a daylight-saving change", async () => {
		// Weekly at 09:00 Berlin from Monday 2030-10-14 (summer time); the clocks change on 2030-10-27.
		const cal = vevent("dst", "2030-10-14T09:00:00", "2030-10-14T09:30:00", [["rrule", {}, "recur", { freq: "WEEKLY", count: 8 }]]);
		const master = cal[2][0] as JComp;
		for (const p of master[1]) if (p[0] === "dtstart" || p[0] === "dtend") p[1] = { tzid: "Europe/Berlin" };
		master[1].push(["exdate", { tzid: "Europe/Berlin" }, "date-time", "2030-11-11T09:00:00"]);
		const ov: JComp = JSON.parse(JSON.stringify(master));
		ov[1] = ov[1].filter((p) => !["rrule", "exdate"].includes(p[0]));
		ov[1].push(["recurrence-id", { tzid: "Europe/Berlin" }, "date-time", "2030-11-04T09:00:00"]);
		cal[2].push(ov);
		const vtz = vtimezoneFor("Europe/Berlin");
		if (vtz) cal[2].unshift(vtz);
		s.cal.put(QA.a, "personal", "dst.ics", cal);
		// Two weeks later, same wall time: 2030-10-28 09:00 is winter time.
		const r = await callTool("calendar_update_event", { event_id: "personal/dst.ics", scope: "series", start: "2030-10-28T09:00", time_zone: "Europe/Berlin" });
		expect(r.isError).toBeFalsy();
		const back = stored("personal", "dst.ics");
		const m = back[2].find((c) => c[0] === "vevent" && !c[1].some((p) => p[0] === "recurrence-id")) as JComp;
		expect(m[1].find((p) => p[0] === "exdate")?.[3]).toBe("2030-11-25T09:00:00");
		const o = back[2].find((c) => c[0] === "vevent" && c[1].some((p) => p[0] === "recurrence-id")) as JComp;
		expect(o[1].find((p) => p[0] === "recurrence-id")?.[3]).toBe("2030-11-18T09:00:00");
	});

	it("checks a move before writing anything: a taken name or a name MOVE can't reach changes nothing", async () => {
		s.cal.put(QA.a, "work", "single.ics", vevent("other", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z"));
		s.fake.requests.length = 0;
		const taken = await callTool("calendar_update_event", { event_id: "personal/single.ics", title: "Moved", move_to_calendar_id: "work" });
		expect(errCode(taken)).toBe("already_exists");
		expect(calCalls(s.fake).filter((c) => ["PUT", "MOVE", "DELETE"].includes(c.method))).toHaveLength(0);
		expect(propOf(stored("personal", "single.ics"), "vevent", "summary")?.[3]).toBe("Event single");
		s.cal.put(QA.a, "personal", "imported-7", vevent("imp", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z"));
		s.fake.requests.length = 0;
		const odd = await callTool("calendar_update_event", { event_id: "personal/imported-7", title: "Moved", move_to_calendar_id: "work" });
		expect(errCode(odd)).toBe("not_available");
		expect(calCalls(s.fake).filter((c) => ["PUT", "MOVE", "DELETE"].includes(c.method))).toHaveLength(0);
		// Without the move, such an item can still be changed (PUT works for any name).
		expect((await callTool("calendar_update_event", { event_id: "personal/imported-7", title: "Renamed" })).isError).toBeFalsy();
	});

	it("when the MOVE fails after the change was saved, says so and keeps the undo of the change", async () => {
		s.fake.on("MOVE", /^\/remote\.php\/dav\/calendars\//, () => new Response("Sabre trace", { status: 500 }));
		const r = await callTool("calendar_update_event", { event_id: "personal/single.ics", title: "Saved anyway", move_to_calendar_id: "work" });
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent.warnings).toEqual(["The changes were saved, but the event couldn't be moved to the other calendar; it is still in its old one."]);
		expect(r.structuredContent.event).toMatchObject({ event_id: "personal/single.ics", title: "Saved anyway" });
		expect(r.structuredContent.undo).toEqual({ tool: "calendar_update_event", arguments: { event_id: "personal/single.ics", title: "Event single" } });
		expect(r.content[0]?.text.split("\n")[0]).toBe("Changed the event.");
		expect(JSON.stringify(r)).not.toMatch(/sabre/i);
		// A move alone that fails is a plain error (nothing was changed).
		expect(errCode(await callTool("calendar_update_event", { event_id: "personal/single.ics", move_to_calendar_id: "work" }))).toBe("upstream_unavailable");
	});

	it("moves an event to another calendar with a MOVE that never overwrites", async () => {
		s.fake.requests.length = 0;
		const r = await callTool("calendar_update_event", { event_id: "personal/single.ics", move_to_calendar_id: "work" });
		expect(r.isError).toBeFalsy();
		const mv = calCalls(s.fake, "MOVE")[0];
		expect(mv?.headers.get("destination")).toBe(`https://drive.nourax.org/remote.php/dav/calendars/${QA.a}/work/single.ics`);
		expect(mv?.headers.get("overwrite")).toBe("F");
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
		expect(r.structuredContent.event).toMatchObject({ event_id: "work/single.ics", calendar_id: "work" });
		expect(r.structuredContent.undo).toEqual({ tool: "calendar_update_event", arguments: { event_id: "work/single.ics", move_to_calendar_id: "personal" } });
		expect(errCode(await callTool("calendar_update_event", { event_id: "work/single.ics", move_to_calendar_id: "todo" }))).toBe("invalid_input");
		expect(errCode(await callTool("calendar_update_event", { event_id: "personal/weekly.ics", scope: "this", occurrence_start: "2030-11-11T08:00:00Z", move_to_calendar_id: "work" }))).toBe("invalid_input");
	});

	it("tells attendees inside the workspace (scheduling stays on) and lists them", async () => {
		s.cal.put(QA.a, "personal", "meet.ics", vevent("meet", "2030-11-07T10:00:00Z", "2030-11-07T11:00:00Z", [
			["organizer", { cn: "QA t1 91" }, "cal-address", `mailto:${A}`],
			["attendee", { cn: "QA t1 92", partstat: "NEEDS-ACTION" }, "cal-address", `mailto:${B}`],
		]));
		s.fake.requests.length = 0;
		const r = await callTool("calendar_update_event", { event_id: "personal/meet.ics", start: "2030-11-07T12:00" });
		expect(calCalls(s.fake, "PUT")[0]?.headers.get("x-nc-scheduling")).toBeNull();
		// Person ids (DESIGN 11.0), never addresses (review fix round 1).
		expect(r.structuredContent.notified).toEqual([{ id: `person:${QA.b}`, display_name: "QA t1 92" }]);
		expect(JSON.stringify(r.structuredContent.notified)).not.toContain(B);
		expect(s.cal.deliveries).toEqual([{ to: QA.b, uid: "meet", kind: "request" }]);
		expect(r.content[0]?.text.split("\n")[0]).toBe("Changed the event; NoCalendar tells 1 invited person in the workspace.");
	});

	it("doesn't change a text whose current value is longer than this tool takes, so the undo can always run", async () => {
		const long = "x".repeat(20_000);
		s.cal.put(QA.a, "personal", "long.ics", vevent("long", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z", [["description", {}, "text", long]]));
		s.fake.requests.length = 0;
		const r = await callTool("calendar_update_event", { event_id: "personal/long.ics", description: "short" });
		expect(errCode(r)).toBe("too_large");
		expect(r._meta?.["nourax/error"]?.field).toBe("description");
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
		expect(propOf(stored("personal", "long.ics"), "vevent", "description")?.[3]).toBe(long);
		// Other fields still change, and the undo carries only what it can put back.
		const t = await callTool("calendar_update_event", { event_id: "personal/long.ics", title: "Renamed" });
		expect(t.isError).toBeFalsy();
		expect(t.structuredContent.undo).toEqual({ tool: "calendar_update_event", arguments: { event_id: "personal/long.ics", title: "Event long" } });
		expect(JSON.stringify(t.structuredContent).length).toBeLessThan(10_000);
		// A long title or location is guarded the same way.
		const lt = vevent("lt", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z", [["location", {}, "text", "l".repeat(600)]]);
		const sum = lt[2][0]?.[1].find((p) => p[0] === "summary");
		if (sum) sum[3] = "t".repeat(300);
		s.cal.put(QA.a, "personal", "longtitle.ics", lt);
		expect(errCode(await callTool("calendar_update_event", { event_id: "personal/longtitle.ics", title: "New" }))).toBe("too_large");
		expect(errCode(await callTool("calendar_update_event", { event_id: "personal/longtitle.ics", location: null }))).toBe("too_large");
	});

	it("an undo runs as given and puts the old values back", async () => {
		const r = await callTool("calendar_update_event", { event_id: "personal/single.ics", title: "Changed", location: "Room 9", description: "New notes", start: "2030-11-06T09:00" });
		const undo = r.structuredContent.undo as { tool: string; arguments: Record<string, unknown> };
		const back = await callTool(undo.tool, undo.arguments);
		expect(back.isError).toBeFalsy();
		const cal = stored("personal", "single.ics");
		expect(propOf(cal, "vevent", "summary")?.[3]).toBe("Event single");
		expect(propOf(cal, "vevent", "location")?.[3]).toBe("Room 1");
		expect(propOf(cal, "vevent", "description")).toBeUndefined();
		expect(propOf(cal, "vevent", "dtstart")?.[3]).toBe("2030-11-05T10:00:00Z");
	});

	it("refuses bad ids, read-only calendars, missing events and empty changes", async () => {
		s.fake.requests.length = 0;
		for (const id of ["../qa-t1-92/personal/x.ics", "personal/..", "trashbin/x.ics", "personal/x.ics/y", "personal"]) {
			expect(errCode(await callTool("calendar_update_event", { event_id: id, title: "X" })), id).toBe("invalid_input");
		}
		expect(calCalls(s.fake)).toHaveLength(0);
		expect(errCode(await callTool("calendar_update_event", { event_id: "team_shared_by_qa-t1-92/t.ics", title: "X" }))).toBe("permission_denied");
		expect(errCode(await callTool("calendar_update_event", { event_id: "personal/missing.ics", title: "X" }))).toBe("not_found");
		expect(errCode(await callTool("calendar_update_event", { event_id: "personal/single.ics" }))).toBe("invalid_input");
		expect(errCode(await callTool("calendar_update_event", { event_id: "personal/single.ics", end: "2030-11-05T09:00" }))).toBe("invalid_input");
	});
});
