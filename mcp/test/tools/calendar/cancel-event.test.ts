/** Contract test for calendar_cancel_event (DESIGN 17.3). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JComp } from "../../../src/pim/jcal";
import { OCCURRENCE_GONE_WARNING, OCCURRENCE_LAG_WARNING } from "../../../src/tools/calendar/cancel-event";
import { calCalls, callTool, errCode, propOf, QA, resetTokens, type Setup, setup, vevent } from "./_helpers";

let s: Setup;
const A = "qa-t1-91@example.invalid";
const B = "qa-t1-92@example.invalid";

beforeEach(async () => {
	s = setup();
	await resetTokens();
	s.cal.home(QA.a);
	s.cal.put(QA.a, "personal", "single.ics", vevent("single", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z"));
	s.cal.put(QA.a, "personal", "daily.ics", vevent("daily", "2030-11-04T08:00:00Z", "2030-11-04T08:15:00Z", [["rrule", {}, "recur", { freq: "DAILY", count: 5 }]]));
	s.cal.put(QA.a, "personal", "meet.ics", vevent("meet", "2030-11-07T10:00:00Z", "2030-11-07T11:00:00Z", [
		["organizer", {}, "cal-address", `mailto:${A}`],
		["attendee", { cn: "QA t1 92" }, "cal-address", `mailto:${B}`],
	]));
});
afterEach(() => vi.restoreAllMocks());

const stored = (obj: string) => s.cal.get(QA.a, "personal", obj)?.jcal as JComp;

describe("calendar_cancel_event", () => {
	it("marks an event cancelled by default (STATUS, SEQUENCE, If-Match, scheduling off)", async () => {
		const etag = s.cal.get(QA.a, "personal", "single.ics")?.etag;
		s.fake.requests.length = 0;
		const r = await callTool("calendar_cancel_event", { event_id: "personal/single.ics" });
		expect(r.isError).toBeFalsy();
		const put = calCalls(s.fake, "PUT")[0];
		expect(put?.headers.get("if-match")).toBe(etag);
		expect(put?.headers.get("x-nc-scheduling")).toBe("false");
		expect(propOf(stored("single.ics"), "vevent", "status")?.[3]).toBe("CANCELLED");
		expect(propOf(stored("single.ics"), "vevent", "sequence")?.[3]).toBe(1);
		expect(r.structuredContent).toMatchObject({ event_id: "personal/single.ics", mode: "mark_cancelled", scope: null, notified: [], undo: null });
		// Plain English (spec review of fix round 2: it used to say "Marked as cancelled the event.").
		expect(r.content[0]?.text.split("\n")[0]).toBe("Marked the event as cancelled.");
		s.fake.requests.length = 0;
		const again = await callTool("calendar_cancel_event", { event_id: "personal/single.ics" });
		expect(again.content[0]?.text.split("\n")[0]).toBe("The event was already marked as cancelled; nothing changed.");
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
	});

	it("removes an event with one DELETE of the object, to NoCalendar's trash", async () => {
		const etag = s.cal.get(QA.a, "personal", "single.ics")?.etag;
		s.fake.requests.length = 0;
		const r = await callTool("calendar_cancel_event", { event_id: "personal/single.ics", mode: "remove" });
		const del = calCalls(s.fake, "DELETE");
		expect(del).toHaveLength(1);
		expect(del[0]?.url.pathname).toBe(`/remote.php/dav/calendars/${QA.a}/personal/single.ics`);
		expect(del[0]?.headers.get("if-match")).toBe(etag);
		expect(del[0]?.headers.get("x-nc-scheduling")).toBe("false");
		expect(s.cal.trash.map((t) => t.obj)).toEqual(["single.ics"]);
		expect(r.structuredContent.warnings).toEqual(["NoCalendar's trash keeps it for 30 days; it can be restored from there."]);
		expect(errCode(await callTool("calendar_cancel_event", { event_id: "personal/single.ics", mode: "remove" }))).toBe("not_found");
	});

	it("cancels one occurrence: an EXDATE for remove, a cancelled override for mark_cancelled", async () => {
		expect(errCode(await callTool("calendar_cancel_event", { event_id: "personal/daily.ics" }))).toBe("invalid_input");
		const rm = await callTool("calendar_cancel_event", { event_id: "personal/daily.ics", scope: "this", occurrence_start: "2030-11-05T08:00:00Z", mode: "remove" });
		expect(rm.isError).toBeFalsy();
		expect(calCalls(s.fake, "DELETE")).toHaveLength(0);
		expect(propOf(stored("daily.ics"), "vevent", "exdate")).toEqual(["exdate", {}, "date-time", "2030-11-05T08:00:00Z"]);
		// One occurrence never reaches the trash: the result says it can't be put back (review fix round 1).
		expect(rm.structuredContent.warnings).toEqual([OCCURRENCE_GONE_WARNING]);
		expect(rm.structuredContent.undo).toBeNull();
		const mc = await callTool("calendar_cancel_event", { event_id: "personal/daily.ics", scope: "this", occurrence_start: "2030-11-06T08:00:00Z" });
		expect(mc.isError).toBeFalsy();
		expect(rm.content[0]?.text.split("\n")[0]).toBe("Removed one occurrence of the series.");
		expect(mc.content[0]?.text.split("\n")[0]).toBe("Marked one occurrence of the series as cancelled.");
		const ov = stored("daily.ics")[2].find((c) => c[0] === "vevent" && c[1].some((p) => p[0] === "recurrence-id"));
		expect(ov?.[1].find((p) => p[0] === "status")?.[3]).toBe("CANCELLED");
		const list = await callTool("calendar_list_events", { start: "2030-11-04", end: "2030-11-10" });
		const ev = list.structuredContent.events as { start: string; status: string; event_id: string }[];
		expect(ev.filter((e) => e.event_id === "personal/daily.ics").map((e) => e.start.slice(0, 10))).toEqual(["2030-11-04", "2030-11-06", "2030-11-07", "2030-11-08"]);
		expect(ev.map((e) => `${e.start.slice(0, 10)} ${e.status}`)).toEqual(["2030-11-04 confirmed", "2030-11-05 confirmed", "2030-11-06 cancelled", "2030-11-07 confirmed", "2030-11-07 confirmed", "2030-11-08 confirmed"]);
		expect(errCode(await callTool("calendar_cancel_event", { event_id: "personal/daily.ics", scope: "this", occurrence_start: "2030-11-20T08:00:00Z", mode: "remove" }))).toBe("not_found");
		const series = await callTool("calendar_cancel_event", { event_id: "personal/daily.ics", scope: "series" });
		expect(series.content[0]?.text.split("\n")[0]).toBe("Marked the whole series as cancelled.");
	});

	it("tells attendees inside the workspace when cancelling (scheduling on)", async () => {
		s.fake.requests.length = 0;
		const r = await callTool("calendar_cancel_event", { event_id: "personal/meet.ics", mode: "remove" });
		expect(calCalls(s.fake, "DELETE")[0]?.headers.get("x-nc-scheduling")).toBeNull();
		// Person ids (DESIGN 11.0), never addresses.
		expect(r.structuredContent.notified).toEqual([{ id: `person:${QA.b}`, display_name: "QA t1 92" }]);
		expect(JSON.stringify(r.structuredContent.notified)).not.toContain(B);
		expect(s.cal.deliveries).toEqual([{ to: QA.b, uid: "meet", kind: "cancel" }]);
		expect(r.content[0]?.text.split("\n")[0]).toBe("Moved the event to NoCalendar's trash; NoCalendar tells 1 invited person in the workspace.");
	});

	it("marks the whole event cancelled with scheduling on and names who NoCalendar tells", async () => {
		const r = await callTool("calendar_cancel_event", { event_id: "personal/meet.ics" });
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent.notified).toEqual([{ id: `person:${QA.b}`, display_name: "QA t1 92" }]);
		expect(s.cal.deliveries).toEqual([{ to: QA.b, uid: "meet", kind: "request" }]);
	});

	it("one occurrence marked cancelled claims nobody was told, and says why (live review)", async () => {
		s.cal.put(QA.a, "personal", "weekly.ics", vevent("weekly", "2030-11-04T10:00:00Z", "2030-11-04T11:00:00Z", [
			["rrule", {}, "recur", { freq: "WEEKLY", count: 4 }],
			["organizer", {}, "cal-address", `mailto:${A}`],
			["attendee", { cn: "QA t1 92" }, "cal-address", `mailto:${B}`],
		]));
		s.fake.requests.length = 0;
		const r = await callTool("calendar_cancel_event", { event_id: "personal/weekly.ics", scope: "this", occurrence_start: "2030-11-11T10:00:00Z" });
		expect(r.isError).toBeFalsy();
		// Scheduling stays on (NoCalendar is asked to tell them), but the attendee's copy is known to lag.
		expect(calCalls(s.fake, "PUT")[0]?.headers.get("x-nc-scheduling")).toBeNull();
		expect(r.structuredContent.notified).toEqual([]);
		expect(r.structuredContent.warnings).toEqual([OCCURRENCE_LAG_WARNING]);
		expect(r.content[0]?.text.split("\n")[0]).toBe("Marked one occurrence of the series as cancelled.");
	});

	it("an attendee who matches nobody the person can see is counted, never claimed", async () => {
		s.cal.put(QA.a, "personal", "ext.ics", vevent("ext", "2030-11-07T10:00:00Z", "2030-11-07T11:00:00Z", [
			["organizer", {}, "cal-address", `mailto:${A}`],
			["attendee", { cn: "Visitor" }, "cal-address", "mailto:visitor@example.org"],
		]));
		const r = await callTool("calendar_cancel_event", { event_id: "personal/ext.ics" });
		expect(r.structuredContent.notified).toEqual([]);
		expect(r.structuredContent.warnings).toEqual([
			"1 attendee isn't anyone this person can find in the workspace; NoCalendar tells only workspace accounts, and no email goes out while workspace email is off.",
		]);
	});

	it("refuses to remove an item another app saved under a name that isn't *.ics, before writing anything", async () => {
		s.cal.put(QA.a, "personal", "imported-123", vevent("imp", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z"));
		s.fake.requests.length = 0;
		const r = await callTool("calendar_cancel_event", { event_id: "personal/imported-123", mode: "remove" });
		expect(errCode(r)).toBe("not_available");
		expect(r._meta?.["nourax/error"]?.field).toBe("mode");
		expect(calCalls(s.fake).filter((c) => ["PUT", "DELETE", "MOVE"].includes(c.method))).toHaveLength(0);
		expect(s.cal.get(QA.a, "personal", "imported-123")).toBeDefined();
		// Marking it cancelled is a PUT, which works for any name.
		const mark = await callTool("calendar_cancel_event", { event_id: "personal/imported-123" });
		expect(mark.isError).toBeFalsy();
	});

	it("refuses bad ids and a stale etag", async () => {
		expect(errCode(await callTool("calendar_cancel_event", { event_id: "trashbin/objects" }))).toBe("invalid_input");
		expect(errCode(await callTool("calendar_cancel_event", { event_id: "personal/single.ics", expected_etag: '"x"' }))).toBe("conflict");
		expect(errCode(await callTool("calendar_cancel_event", { event_id: "personal/single.ics", mode: "purge" }))).toBe("invalid_input");
	});
});
