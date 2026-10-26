/**
 * Fix round 3 contract tests (DESIGN 27):
 * - calendar_add_attendees publishes a person-only schema;
 * - an event's attendee list says when it was cut to 50;
 * - removing one occurrence that was changed on its own is refused before anything is written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JComp } from "../../../src/pim/jcal";
import { OCCURRENCE_GONE_WARNING, OWN_CHANGES_HINT, OWN_CHANGES_REFUSAL } from "../../../src/tools/calendar/cancel-event";
import { ATTENDEES_OUT } from "../../../src/tools/calendar/events";
import { mcpPost, rpcResult } from "../../helpers/index";
import { calCalls, callTool, errCode, propOf, QA, resetTokens, type Setup, setup, tokenFor, vevent } from "./_helpers";

let s: Setup;
const A = "qa-t1-91@example.invalid";
const B = "qa-t1-92@example.invalid";

beforeEach(async () => {
	s = setup();
	await resetTokens();
	s.cal.home(QA.a);
	s.cal.home(QA.b);
});
afterEach(() => vi.restoreAllMocks());

const stored = (obj: string) => s.cal.get(QA.a, "personal", obj)?.jcal as JComp;
const writes = () => calCalls(s.fake).filter((c) => ["PUT", "DELETE", "MOVE"].includes(c.method));

describe("calendar_add_attendees takes person ids only (the schema says what the tool does)", () => {
	it("publishes ^person:.+$ for each attendee, and a group or team id fails in the schema, naming the field", async () => {
		const token = await tokenFor(QA.a);
		const list = await rpcResult(await mcpPost(token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
		const tool = (list.result as { tools: { name: string; inputSchema: { properties: Record<string, { items?: { pattern?: string } }> } }[] }).tools.find((t) => t.name === "calendar_add_attendees");
		expect(tool?.inputSchema.properties.attendees?.items?.pattern).toBe("^person:.+$");
		s.cal.put(QA.a, "personal", "plan.ics", vevent("plan", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z"));
		for (const id of ["group:qa-team", "team:7", "persons:x", "person:"]) {
			s.fake.requests.length = 0;
			const r = await callTool("calendar_add_attendees", { event_id: "personal/plan.ics", attendees: [`person:${QA.b}`, id] });
			expect(errCode(r), id).toBe("invalid_input");
			expect(r._meta?.["nourax/error"]?.field ?? "", id).toMatch(/^attendees/);
			// Refused before any search or write.
			expect(s.fake.driveCalls().filter((c) => c.url.pathname.endsWith("/sharees") || c.method === "PUT")).toHaveLength(0);
		}
	});
});

describe("attendee lists say when they are cut", () => {
	const many = (n: number): JComp[1] => [
		["organizer", {}, "cal-address", "mailto:boss@example.org"],
		...Array.from({ length: n }, (_, i) => ["attendee", { cn: `Guest ${i}` }, "cal-address", `mailto:guest${i}@example.org`] as JComp[1][number]),
	];

	it("calendar_list_events: attendees_total only on an event with more than 50, plus one warning", async () => {
		s.cal.put(QA.a, "personal", "big.ics", vevent("big", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z", many(ATTENDEES_OUT + 30)));
		s.cal.put(QA.a, "personal", "full.ics", vevent("full", "2030-11-05T12:00:00Z", "2030-11-05T13:00:00Z", many(ATTENDEES_OUT)));
		const r = await callTool("calendar_list_events", { start: "2030-11-05", end: "2030-11-05" });
		expect(r.isError).toBeFalsy();
		const ev = r.structuredContent.events as { event_id: string; attendees: unknown[]; attendees_total?: number }[];
		const big = ev.find((e) => e.event_id === "personal/big.ics");
		const full = ev.find((e) => e.event_id === "personal/full.ics");
		expect(big?.attendees).toHaveLength(ATTENDEES_OUT);
		expect(big?.attendees_total).toBe(ATTENDEES_OUT + 30);
		expect(full?.attendees).toHaveLength(ATTENDEES_OUT);
		expect(full).not.toHaveProperty("attendees_total");
		expect(r.structuredContent.warnings).toEqual(["Some events list more than 50 attendees; only the first 50 are shown, and attendees_total gives the full count."]);
		// Without a cut event there is no such warning.
		const plain = await callTool("calendar_list_events", { start: "2030-11-05T11:30:00Z", end: "2030-11-05T14:00:00Z" });
		expect(plain.structuredContent.warnings).toBeUndefined();
	});

	it("calendar_update_event: the single event result warns too", async () => {
		s.cal.put(QA.a, "personal", "big.ics", vevent("big", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z", many(ATTENDEES_OUT + 1)));
		const r = await callTool("calendar_update_event", { event_id: "personal/big.ics", location: "Room 2" });
		expect(r.isError).toBeFalsy();
		expect((r.structuredContent.event as { attendees_total?: number }).attendees_total).toBe(ATTENDEES_OUT + 1);
		expect(r.structuredContent.warnings).toContain(`This event lists ${ATTENDEES_OUT + 1} attendees; only the first ${ATTENDEES_OUT} are shown.`);
	});

	it("calendar_add_attendees: warns when the invited event's list is cut", async () => {
		const guests: JComp[1] = [
			["organizer", { cn: "QA t1 91" }, "cal-address", `mailto:${A}`],
			...Array.from({ length: ATTENDEES_OUT }, (_, i) => ["attendee", { cn: `Guest ${i}` }, "cal-address", `mailto:guest${i}@example.org`] as JComp[1][number]),
		];
		s.cal.put(QA.a, "personal", "town.ics", vevent("town", "2030-11-06T10:00:00Z", "2030-11-06T11:00:00Z", guests));
		const r = await callTool("calendar_add_attendees", { event_id: "personal/town.ics", attendees: [`person:${QA.b}`] });
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent.invited).toEqual([{ id: `person:${QA.b}`, display_name: "QA t1 92" }]);
		const e = r.structuredContent.event as { attendees: { email: string | null }[]; attendees_total?: number };
		expect(e.attendees_total).toBe(ATTENDEES_OUT + 1);
		// The new person is the 51st, so not among those shown: the warning is what tells the client.
		expect(e.attendees.map((x) => x.email)).not.toContain(B);
		expect(r.structuredContent.warnings).toContain(`This event lists ${ATTENDEES_OUT + 1} attendees; only the first ${ATTENDEES_OUT} are shown.`);
	});
});

describe("removing one occurrence never loses changes made to it alone", () => {
	beforeEach(() => {
		s.cal.put(QA.a, "personal", "daily.ics", vevent("daily", "2030-11-04T08:00:00Z", "2030-11-04T08:30:00Z", [["rrule", {}, "recur", { freq: "DAILY", count: 7 }], ["location", {}, "text", "Room 1"]]));
	});
	const overrides = () => stored("daily.ics")[2].filter((c) => c[0] === "vevent" && c[1].some((p) => p[0] === "recurrence-id"));
	const removeOne = (start: string) => callTool("calendar_cancel_event", { event_id: "personal/daily.ics", scope: "this", occurrence_start: start, mode: "remove" });

	it("refuses an occurrence with its own title, writing nothing, and points to mark_cancelled", async () => {
		const ch = await callTool("calendar_update_event", { event_id: "personal/daily.ics", scope: "this", occurrence_start: "2030-11-05T08:00:00Z", title: "Special" });
		expect(ch.isError).toBeFalsy();
		const before = JSON.stringify(stored("daily.ics"));
		s.fake.requests.length = 0;
		const r = await removeOne("2030-11-05T08:00:00Z");
		expect(errCode(r)).toBe("not_available");
		expect(r._meta?.["nourax/error"]?.field).toBe("mode");
		expect(r.content[0]?.text).toBe(`${OWN_CHANGES_REFUSAL} ${OWN_CHANGES_HINT}`);
		expect(writes()).toHaveLength(0);
		expect(JSON.stringify(stored("daily.ics"))).toBe(before);
		// mark_cancelled still works and keeps the occurrence's own title.
		const mark = await callTool("calendar_cancel_event", { event_id: "personal/daily.ics", scope: "this", occurrence_start: "2030-11-05T08:00:00Z" });
		expect(mark.isError).toBeFalsy();
		const ov = overrides().find((c) => propOf(["vcalendar", [], [c]], "vevent", "summary")?.[3] === "Special");
		expect(ov?.[1].find((p) => p[0] === "status")?.[3]).toBe("CANCELLED");
	});

	it("refuses an occurrence moved to another time, or given another length", async () => {
		await callTool("calendar_update_event", { event_id: "personal/daily.ics", scope: "this", occurrence_start: "2030-11-06T08:00:00Z", start: "2030-11-06T09:00:00Z" });
		expect(errCode(await removeOne("2030-11-06T08:00:00Z"))).toBe("not_available");
		await callTool("calendar_update_event", { event_id: "personal/daily.ics", scope: "this", occurrence_start: "2030-11-07T08:00:00Z", end: "2030-11-07T09:30:00Z" });
		expect(errCode(await removeOne("2030-11-07T08:00:00Z"))).toBe("not_available");
	});

	it("refuses an occurrence whose reminder or an attendee's answer differs from the series", async () => {
		await callTool("calendar_update_event", { event_id: "personal/daily.ics", scope: "this", occurrence_start: "2030-11-08T08:00:00Z", reminder_minutes_before: 10 });
		expect(errCode(await removeOne("2030-11-08T08:00:00Z"))).toBe("not_available");
		const series: JComp = vevent("team", "2030-11-04T08:00:00Z", "2030-11-04T08:30:00Z", [
			["rrule", {}, "recur", { freq: "DAILY", count: 3 }],
			["organizer", {}, "cal-address", "mailto:boss@example.org"],
			["attendee", { partstat: "NEEDS-ACTION" }, "cal-address", `mailto:${A}`],
		]);
		const answered = JSON.parse(JSON.stringify(series[2][0])) as JComp;
		answered[1] = answered[1].filter((p) => p[0] !== "rrule" && p[0] !== "dtstart" && p[0] !== "dtend");
		answered[1].push(["recurrence-id", {}, "date-time", "2030-11-05T08:00:00Z"], ["dtstart", {}, "date-time", "2030-11-05T08:00:00Z"], ["dtend", {}, "date-time", "2030-11-05T08:30:00Z"]);
		const att = answered[1].find((p) => p[0] === "attendee");
		if (att) att[1] = { partstat: "DECLINED" };
		series[2].push(answered);
		s.cal.put(QA.a, "personal", "team.ics", series);
		s.fake.requests.length = 0;
		expect(errCode(await callTool("calendar_cancel_event", { event_id: "personal/team.ics", scope: "this", occurrence_start: "2030-11-05T08:00:00Z", mode: "remove" }))).toBe("not_available");
		expect(writes()).toHaveLength(0);
	});

	it("still removes an occurrence that was only marked cancelled, or is a plain copy of the series", async () => {
		const mark = await callTool("calendar_cancel_event", { event_id: "personal/daily.ics", scope: "this", occurrence_start: "2030-11-05T08:00:00Z" });
		expect(mark.isError).toBeFalsy();
		expect(overrides()).toHaveLength(1);
		const r = await removeOne("2030-11-05T08:00:00Z");
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent.warnings).toEqual([OCCURRENCE_GONE_WARNING]);
		expect(overrides()).toHaveLength(0);
		expect(propOf(stored("daily.ics"), "vevent", "exdate")).toEqual(["exdate", {}, "date-time", "2030-11-05T08:00:00Z"]);
		// A copy that differs only in stamps, SEQUENCE and NoCalendar's delivery codes has nothing of its own.
		const cal = stored("daily.ics");
		const master = cal[2][0] as JComp;
		const copy = JSON.parse(JSON.stringify(master)) as JComp;
		copy[1] = copy[1].filter((p) => !["rrule", "exdate", "dtstart", "dtend", "dtstamp", "sequence"].includes(p[0]));
		copy[1].push(
			["recurrence-id", {}, "date-time", "2030-11-06T08:00:00Z"],
			["dtstart", {}, "date-time", "2030-11-06T08:00:00Z"],
			["dtend", {}, "date-time", "2030-11-06T08:30:00Z"],
			["dtstamp", {}, "date-time", "2030-11-01T00:00:00Z"],
			["sequence", {}, "integer", 3],
		);
		cal[2].push(copy);
		s.cal.put(QA.a, "personal", "daily.ics", cal);
		const plain = await removeOne("2030-11-06T08:00:00Z");
		expect(plain.isError).toBeFalsy();
		expect(overrides()).toHaveLength(0);
	});
});
