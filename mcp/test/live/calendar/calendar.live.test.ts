/**
 * Lane D live cases (DESIGN 17.6): every calendar tool for real against drive.nourax.org, as the
 * lane's QA organizer, with an internal invitation to the lane's second QA account (they share the
 * QA group qa-t1-26-24, which privacy between organisations needs). Works only in the lane's own QA
 * calendars and only on items whose titles carry this run's id; it removes them at the end (the
 * rule-3 exception). Dates are in 2030, so nothing is "in the past".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ATTENDEE, calPath, code, dav, ensureCollection, ORGANIZER, OUTSIDER, QA_CAL as A, QA_CAL2 as B, RUN_ID, shareCalendar, token, tool, toolNames } from "./_live";

/** Repeating events this run made (removed with scope "series"). */
const seriesIds = new Set<string>();
/** The second person's own QA calendar that is shared with the organizer, read-only, during the run. */
const SHARED = process.env.NX_LIVE_D_SHARED ?? "mcp-qa-d-shared";

let t = "";
let t2 = "";
const made: string[] = [];

beforeAll(async () => {
	await ensureCollection(ORGANIZER, A, "MCP QA D", ["VEVENT"]);
	await ensureCollection(ORGANIZER, B, "MCP QA D2", ["VEVENT"]);
	await ensureCollection(ATTENDEE, SHARED, "MCP QA D shared", ["VEVENT"]);
	t = await token(ORGANIZER);
	t2 = await token(ATTENDEE, ["workspace.read"]);
});

/** This run's events in a range, as one person sees them. */
async function mine(tok: string, start: string, end: string, ids?: string[]) {
	const r = await tool(tok, "calendar_list_events", { start, end, query: RUN_ID, ...(ids ? { calendar_ids: ids } : {}) });
	return (r.structuredContent.events ?? []) as { event_id: string; title: string; start: string; status: string; occurrence_start: string | null; organizer: { email: string | null } | null }[];
}

afterAll(async () => {
	// Rule-3 exception: only this run's own items (the copy delivered to the attendee included).
	for (const e of await mine(t, "2030-10-01", "2030-12-31", [A, B])) await dav(ORGANIZER, "DELETE", `/remote.php/dav/calendars/${ORGANIZER}/${e.event_id}`, undefined, { "x-nc-scheduling": "false" });
	for (const e of await mine(t2, "2030-10-01", "2030-12-31")) await dav(ATTENDEE, "DELETE", `/remote.php/dav/calendars/${ATTENDEE}/${e.event_id}`, undefined, { "x-nc-scheduling": "false" });
	// The read-only share made by this run is taken away again (the calendar itself is kept for the next run).
	await shareCalendar(ATTENDEE, SHARED, ORGANIZER, false);
});

const ev = (r: { structuredContent: Record<string, unknown>; isError?: boolean; content: { text: string }[] }) => {
	if (r.isError) throw new Error(r.content[0]?.text);
	return r.structuredContent.event as Record<string, unknown>;
};

describe("live: calendar (lane D)", () => {
	it("lists the 7 calendar tools and the person's calendars", async () => {
		const names = await toolNames(t);
		for (const n of ["calendar_list_calendars", "calendar_list_events", "calendar_find_free_time", "calendar_create_event", "calendar_update_event", "calendar_cancel_event", "calendar_add_attendees"]) expect(names).toContain(n);
		const r = await tool(t, "calendar_list_calendars");
		expect(r.isError).toBeFalsy();
		const cals = r.structuredContent.calendars as { calendar_id: string; holds: string[]; is_default: boolean; read_only: boolean }[];
		expect(cals.find((c) => c.calendar_id === A)).toMatchObject({ holds: ["events"], read_only: false });
		// The default (if the home has one) takes events; at most one is marked.
		const defaults = cals.filter((c) => c.is_default);
		expect(defaults.length).toBeLessThanOrEqual(1);
		for (const d of defaults) expect(d.holds).toContain("events");
	});

	it("creates a single event and a weekly one (TZID), and lists them occurrence by occurrence", async () => {
		const one = await tool(t, "calendar_create_event", { title: `Review ${RUN_ID}`, start: "2030-11-05T10:00:00Z", duration_minutes: 60, calendar_id: A, location: "Room 1", description: "Line one\nBEGIN:VALARM\nline three" });
		expect(ev(one)).toMatchObject({ calendar_id: A, start: "2030-11-05T10:00:00+00:00", end: "2030-11-05T11:00:00+00:00", description: "Line one\nBEGIN:VALARM\nline three", reminder_minutes_before: null });
		made.push(ev(one).event_id as string);
		const weekly = await tool(t, "calendar_create_event", {
			title: `Standup ${RUN_ID}`,
			start: "2030-11-04T09:00",
			end: "2030-11-04T09:15",
			time_zone: "Europe/London",
			calendar_id: A,
			repeat: { frequency: "weekly", count: 4 },
			reminder_minutes_before: 10,
		});
		expect(ev(weekly)).toMatchObject({ repeats: true, time_zone: "Europe/London", reminder_minutes_before: 10 });
		made.push(ev(weekly).event_id as string);
		const events = await mine(t, "2030-11-01", "2030-11-30", [A]);
		expect(events.map((e) => `${e.start} ${e.title.split(" ")[0]}`)).toEqual([
			"2030-11-04T09:00:00+00:00 Standup",
			"2030-11-05T10:00:00+00:00 Review",
			"2030-11-11T09:00:00+00:00 Standup",
			"2030-11-18T09:00:00+00:00 Standup",
			"2030-11-25T09:00:00+00:00 Standup",
		]);
		expect(events[2]?.occurrence_start).toBe("2030-11-11T09:00:00+00:00");
	});

	it("changes one occurrence, then the single event, with undo", async () => {
		const weeklyId = made[1] as string;
		const one = await tool(t, "calendar_update_event", { event_id: weeklyId, scope: "this", occurrence_start: "2030-11-11T09:00:00+00:00", title: `Standup moved ${RUN_ID}`, start: "2030-11-11T11:00" });
		expect(ev(one)).toMatchObject({ start: "2030-11-11T11:00:00+00:00", end: "2030-11-11T11:15:00+00:00", occurrence_start: "2030-11-11T09:00:00+00:00" });
		const missing = await tool(t, "calendar_update_event", { event_id: weeklyId, scope: "this", occurrence_start: "2030-11-12T09:00:00Z", title: "x" });
		expect(code(missing)).toBe("not_found");
		const single = await tool(t, "calendar_update_event", { event_id: made[0], title: `Review changed ${RUN_ID}`, start: "2030-11-05T14:00" });
		expect(ev(single)).toMatchObject({ start: "2030-11-05T14:00:00+00:00", end: "2030-11-05T15:00:00+00:00" });
		const undo = single.structuredContent.undo as { tool: string; arguments: Record<string, unknown> };
		expect(undo.tool).toBe("calendar_update_event");
		const back = await tool(t, undo.tool, undo.arguments);
		expect(ev(back)).toMatchObject({ title: `Review ${RUN_ID}`, start: "2030-11-05T10:00:00+00:00" });
		expect((await mine(t, "2030-11-10", "2030-11-12", [A])).map((e) => e.title)).toEqual([`Standup moved ${RUN_ID}`]);
	});

	it("finds free time around the events", async () => {
		const r = await tool(t, "calendar_find_free_time", { start: "2030-11-05", end: "2030-11-05", duration_minutes: 60, calendar_ids: [A], working_hours: { from: "09:00", to: "13:00" } });
		expect(r.isError).toBeFalsy();
		expect((r.structuredContent.slots as { start: string }[]).map((s) => s.start)).toEqual(["2030-11-05T09:00:00+00:00", "2030-11-05T11:00:00+00:00", "2030-11-05T12:00:00+00:00"]);
	});

	it("moves an event to another calendar and back", async () => {
		const mv = await tool(t, "calendar_update_event", { event_id: made[0], move_to_calendar_id: B });
		expect(ev(mv).calendar_id).toBe(B);
		const undo = mv.structuredContent.undo as { tool: string; arguments: Record<string, unknown> };
		const back = await tool(t, undo.tool, undo.arguments);
		expect(ev(back).calendar_id).toBe(A);
	});

	it("invites the second QA person inside the workspace; their copy arrives, follows the change, and is cancelled", async () => {
		const meet = await tool(t, "calendar_create_event", { title: `Invite ${RUN_ID}`, start: "2030-11-06T15:00:00Z", calendar_id: A });
		const id = ev(meet).event_id as string;
		made.push(id);
		const inv = await tool(t, "calendar_add_attendees", { event_id: id, attendees: [`person:${ATTENDEE}`, `person:${OUTSIDER}`, `person:${ORGANIZER}`] });
		expect(inv.isError).toBeFalsy();
		// "invited" (added to the event): SCHEDULE-STATUS can't prove delivery, so the copy is checked below.
		expect(inv.structuredContent.invited).toEqual([{ id: `person:${ATTENDEE}`, display_name: expect.any(String) }]);
		const nd = inv.structuredContent.not_invited as { id: string }[];
		expect(nd.map((x) => x.id).sort()).toEqual([`person:${OUTSIDER}`, `person:${ORGANIZER}`].sort());
		const copy = (await mine(t2, "2030-11-06", "2030-11-06")).find((e) => e.title === `Invite ${RUN_ID}`);
		expect(copy).toMatchObject({ status: "confirmed", organizer: { email: `${ORGANIZER}@example.invalid` } });
		const moved = await tool(t, "calendar_update_event", { event_id: id, start: "2030-11-06T16:00" });
		// Person ids (DESIGN 11.0), never addresses.
		expect(moved.structuredContent.notified).toEqual([{ id: `person:${ATTENDEE}`, display_name: expect.any(String) }]);
		expect((await mine(t2, "2030-11-06", "2030-11-06")).find((e) => e.title === `Invite ${RUN_ID}`)?.start).toBe("2030-11-06T16:00:00+00:00");
		const cancel = await tool(t, "calendar_cancel_event", { event_id: id });
		expect(cancel.isError).toBeFalsy();
		const c2 = (await mine(t2, "2030-11-06", "2030-11-06")).find((e) => e.title === `Invite ${RUN_ID}`);
		expect(c2).toMatchObject({ status: "cancelled", start: "2030-11-06T16:00:00+00:00" });
	});

	it("cancelling one occurrence of an invited series claims nobody was told, and says why", async () => {
		const series = await tool(t, "calendar_create_event", { title: `Series invite ${RUN_ID}`, start: "2030-12-02T10:00:00Z", duration_minutes: 30, calendar_id: A, repeat: { frequency: "weekly", count: 3 } });
		const id = ev(series).event_id as string;
		made.push(id);
		seriesIds.add(id);
		expect((await tool(t, "calendar_add_attendees", { event_id: id, attendees: [`person:${ATTENDEE}`] })).structuredContent.invited).toHaveLength(1);
		const one = await tool(t, "calendar_cancel_event", { event_id: id, scope: "this", occurrence_start: "2030-12-09T10:00:00+00:00" });
		expect(one.isError).toBeFalsy();
		expect(one.structuredContent.notified).toEqual([]);
		expect(one.structuredContent.warnings).toEqual([expect.stringMatching(/may not see this one occurrence as cancelled/)]);
		const own = (await mine(t, "2030-12-01", "2030-12-31", [A])).filter((e) => e.event_id === id);
		expect(own.map((e) => `${e.start.slice(0, 10)} ${e.status}`)).toEqual(["2030-12-02 confirmed", "2030-12-09 cancelled", "2030-12-16 confirmed"]);
	});

	it("moving a series' start takes along an occurrence that was only renamed (live review)", async () => {
		const s = await tool(t, "calendar_create_event", { title: `Weekly ${RUN_ID}`, start: "2030-10-07T09:00", end: "2030-10-07T09:30", time_zone: "Europe/London", calendar_id: B, repeat: { frequency: "weekly", count: 3 } });
		const id = ev(s).event_id as string;
		made.push(id);
		seriesIds.add(id);
		const renamed = await tool(t, "calendar_update_event", { event_id: id, scope: "this", occurrence_start: "2030-10-14T08:00:00+00:00", title: `Weekly renamed ${RUN_ID}` });
		expect(renamed.isError, renamed.content[0]?.text).toBeFalsy();
		const moved = await tool(t, "calendar_update_event", { event_id: id, scope: "series", start: "2030-10-07T10:00", time_zone: "Europe/London" });
		expect(moved.isError, moved.content[0]?.text).toBeFalsy();
		const all = (await mine(t, "2030-10-01", "2030-10-31", [B])).filter((e) => e.event_id === id);
		// London is on summer time (+01:00) until 2030-10-27: 10:00 local is 09:00 UTC; the renamed one moved too.
		expect(all.map((e) => `${e.start} ${e.title.split(" ")[1]}`)).toEqual([
			`2030-10-07T09:00:00+00:00 ${RUN_ID}`,
			"2030-10-14T09:00:00+00:00 renamed",
			`2030-10-21T09:00:00+00:00 ${RUN_ID}`,
		]);
	});

	it("shows the owner's name on a calendar shared with the person (live review)", async () => {
		expect([200, 204]).toContain(await shareCalendar(ATTENDEE, SHARED, ORGANIZER, true));
		const r = await tool(t, "calendar_list_calendars");
		const cals = r.structuredContent.calendars as { calendar_id: string; read_only: boolean; shared_by: { id: string; display_name: string | null } | null }[];
		const shared = cals.find((c) => c.shared_by?.id === `person:${ATTENDEE}`);
		expect(shared, JSON.stringify(cals.map((c) => c.calendar_id))).toBeDefined();
		expect(shared?.read_only).toBe(true);
		expect(shared?.shared_by?.display_name).toEqual(expect.any(String));
		// A shared calendar is never written to by default, and refused when named.
		expect(code(await tool(t, "calendar_create_event", { title: `x ${RUN_ID}`, start: "2030-11-20T10:00:00Z", calendar_id: shared?.calendar_id }))).toBe("permission_denied");
	});

	it("refuses to move an item another app saved under a non-.ics name, before changing it", async () => {
		const name = `imported-${RUN_ID}`;
		const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//QA//EN\r\nBEGIN:VEVENT\r\nUID:${name}\r\nDTSTAMP:20301001T000000Z\r\nDTSTART:20301120T100000Z\r\nDTEND:20301120T110000Z\r\nSUMMARY:Imported ${RUN_ID}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
		expect([201, 204]).toContain(await dav(ORGANIZER, "PUT", `${calPath(ORGANIZER, A)}${name}`, ics, { "content-type": "text/calendar; charset=utf-8", "x-nc-scheduling": "false" }));
		made.push(`${A}/${name}`);
		const r = await tool(t, "calendar_update_event", { event_id: `${A}/${name}`, title: `Changed ${RUN_ID}`, move_to_calendar_id: B });
		expect(code(r)).toBe("not_available");
		const still = (await mine(t, "2030-11-20", "2030-11-20", [A])).find((e) => e.event_id === `${A}/${name}`);
		expect(still?.title).toBe(`Imported ${RUN_ID}`);
		// Changing it without the move works (PUT reaches any name); removing it is refused the same way.
		expect((await tool(t, "calendar_update_event", { event_id: `${A}/${name}`, title: `Changed ${RUN_ID}` })).isError).toBeFalsy();
		expect(code(await tool(t, "calendar_cancel_event", { event_id: `${A}/${name}`, mode: "remove" }))).toBe("not_available");
		// Test clean-up of this run's own object (the rule-3 exception), straight through NoDrive.
		expect([204, 404]).toContain(await dav(ORGANIZER, "DELETE", `${calPath(ORGANIZER, A)}${name}`, undefined, { "x-nc-scheduling": "false" }));
		made.splice(made.indexOf(`${A}/${name}`), 1);
	});

	it("cancels one occurrence and removes the rest to the trash", async () => {
		const weeklyId = made[1] as string;
		const one = await tool(t, "calendar_cancel_event", { event_id: weeklyId, scope: "this", occurrence_start: "2030-11-18T09:00:00+00:00", mode: "remove" });
		expect(one.isError).toBeFalsy();
		const standups = (await mine(t, "2030-11-01", "2030-11-30", [A])).filter((e) => e.title.startsWith("Standup"));
		expect(standups.map((e) => e.start.slice(0, 10))).toEqual(["2030-11-04", "2030-11-11", "2030-11-25"]);
		for (const id of made) {
			const r = await tool(t, "calendar_cancel_event", { event_id: id, mode: "remove", ...(id === weeklyId || seriesIds.has(id) ? { scope: "series" } : {}) });
			expect(r.isError, id).toBeFalsy();
		}
		expect(await mine(t, "2030-11-01", "2030-11-30", [A, B])).toEqual([]);
	});

	it("refuses other people's calendars and traversal before calling NoDrive", async () => {
		for (const id of [`../${ATTENDEE}/personal/x.ics`, "trashbin/objects", `${A}/..`, "personal/%2e%2e"]) {
			expect(code(await tool(t, "calendar_cancel_event", { event_id: id })), id).toBe("invalid_input");
		}
		expect(code(await tool(t, "calendar_list_events", { start: "2030-11-01", end: "2030-11-02", calendar_ids: [`../${ATTENDEE}/personal`] }))).toBe("invalid_input");
	});
});
