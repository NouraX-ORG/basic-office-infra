/**
 * Lane D live cases for review fix round 2 (DESIGN 17.6), against drive.nourax.org through a local
 * `wrangler dev --env dev`:
 * - an invited person's change stays in their own copy (nobody named as told), and their removal
 *   sends the organizer a decline;
 * - a reminder change keeps the event's other reminders, and its undo puts them back;
 * - a task whose VTIMEZONE has a FREQ=MINUTELY rule is read at once (the CPU finding);
 * - tasks_create for a person without a task list of their own says so and makes nothing.
 * Only this run's own items (titles or names with RUN_ID) are made and removed (the rule-3 exception).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ATTENDEE, calPath, code, dav, davText, ensureCollection, ORGANIZER, QA_CAL as A, QA_TASKS as L, RUN_ID, THIRD, token, tool } from "./_live";

let tOrg = "";
let tAtt = "";
let tThird = "";

type Ev = { event_id: string; title: string; status: string; attendees: { email: string | null; status: string }[] };

async function find(tok: string, title: string, day: string): Promise<Ev | undefined> {
	const r = await tool(tok, "calendar_list_events", { start: day, end: day, query: RUN_ID });
	return ((r.structuredContent.events ?? []) as Ev[]).find((e) => e.title === title);
}

beforeAll(async () => {
	await ensureCollection(ORGANIZER, A, "MCP QA D", ["VEVENT"]);
	await ensureCollection(ORGANIZER, L, "MCP QA tasks", ["VTODO"]);
	tOrg = await token(ORGANIZER);
	tAtt = await token(ATTENDEE);
	if (THIRD) tThird = await token(THIRD, ["workspace.read"]);
});

afterAll(async () => {
	// Rule-3 exception: this run's own objects only, in each person's calendars, without scheduling.
	for (const [uid, tok] of [
		[ORGANIZER, tOrg],
		[ATTENDEE, tAtt],
		...(THIRD ? [[THIRD, tThird] as [string, string]] : []),
	] as [string, string][]) {
		const r = await tool(tok, "calendar_list_events", { start: "2030-11-01", end: "2030-11-30", query: RUN_ID });
		for (const e of (r.structuredContent.events ?? []) as Ev[]) await dav(uid, "DELETE", `/remote.php/dav/calendars/${uid}/${e.event_id}`, undefined, { "x-nc-scheduling": "false" });
	}
	await dav(ORGANIZER, "DELETE", `${calPath(ORGANIZER, A)}rem-${RUN_ID}.ics`, undefined, { "x-nc-scheduling": "false" });
	await dav(ORGANIZER, "DELETE", `${calPath(ORGANIZER, L)}tz-${RUN_ID}.ics`);
});

describe("live: only the organizer's changes reach the invited people (fix round 2)", () => {
	it("an invited person's change stays in their own copy; their removal tells the organizer they declined", async () => {
		const title = `Copy test ${RUN_ID}`;
		const made = await tool(tOrg, "calendar_create_event", { title, start: "2030-11-14T10:00:00Z", calendar_id: A });
		const id = (made.structuredContent.event as { event_id: string }).event_id;
		const inv = await tool(tOrg, "calendar_add_attendees", { event_id: id, attendees: [`person:${ATTENDEE}`, ...(THIRD ? [`person:${THIRD}`] : [])] });
		expect(inv.isError, inv.content[0]?.text).toBeFalsy();
		const copy = await find(tAtt, title, "2030-11-14");
		expect(copy, "the invited person's copy arrived").toBeDefined();

		const changed = await tool(tAtt, "calendar_update_event", { event_id: copy?.event_id, title: `${title} (mine)` });
		expect(changed.isError, changed.content[0]?.text).toBeFalsy();
		expect(changed.structuredContent.notified).toEqual([]);
		expect(changed.structuredContent.warnings).toEqual([expect.stringMatching(/invited to this event, not its organizer, so the change is in their own copy only/)]);
		expect(changed.content[0]?.text.split("\n")[0]).toBe("Changed the event.");
		// Nobody else sees it: the organizer's event (and the third person's copy) keep the old title.
		expect((await find(tOrg, title, "2030-11-14"))?.title).toBe(title);
		if (THIRD) expect((await find(tThird, title, "2030-11-14"))?.title).toBe(title);

		const removed = await tool(tAtt, "calendar_cancel_event", { event_id: copy?.event_id, mode: "remove" });
		expect(removed.isError, removed.content[0]?.text).toBeFalsy();
		expect(removed.structuredContent.notified).toEqual([]);
		expect(removed.structuredContent.warnings).toContainEqual(expect.stringMatching(/NoCalendar tells the organizer that they declined/));
		// The organizer's event now shows that the invited person declined.
		const org = await find(tOrg, title, "2030-11-14");
		expect(org?.attendees.find((a) => a.email === `${ATTENDEE}@example.invalid`)?.status).toBe("declined");
	});

	it("an invited person marking it cancelled changes only their own copy", async () => {
		const title = `Mark test ${RUN_ID}`;
		const made = await tool(tOrg, "calendar_create_event", { title, start: "2030-11-15T10:00:00Z", calendar_id: A });
		const id = (made.structuredContent.event as { event_id: string }).event_id;
		expect((await tool(tOrg, "calendar_add_attendees", { event_id: id, attendees: [`person:${ATTENDEE}`] })).isError).toBeFalsy();
		const copy = await find(tAtt, title, "2030-11-15");
		const mark = await tool(tAtt, "calendar_cancel_event", { event_id: copy?.event_id });
		expect(mark.isError, mark.content[0]?.text).toBeFalsy();
		expect(mark.content[0]?.text.split("\n")[0]).toBe("Marked the event as cancelled.");
		expect(mark.structuredContent.warnings).toEqual([expect.stringMatching(/marked cancelled in their own copy only/)]);
		expect((await find(tAtt, title, "2030-11-15"))?.status).toBe("cancelled");
		expect((await find(tOrg, title, "2030-11-15"))?.status).toBe("confirmed");
		// The organizer's own cancel still reaches the invited person (and reads in plain English).
		const own = await tool(tOrg, "calendar_cancel_event", { event_id: id });
		expect(own.content[0]?.text.split("\n")[0]).toMatch(/^Marked the event as cancelled(; NoCalendar tells 1 invited person in the workspace)?\.$/);
	});
});

describe("live: reminders (fix round 2)", () => {
	it("a reminder change keeps the event's other reminders, and the undo puts them back", async () => {
		const name = `rem-${RUN_ID}.ics`;
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//QA//EN",
			"BEGIN:VEVENT",
			`UID:rem-${RUN_ID}`,
			"DTSTAMP:20301001T000000Z",
			"DTSTART:20301116T100000Z",
			"DTEND:20301116T110000Z",
			`SUMMARY:Reminders ${RUN_ID}`,
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			"DESCRIPTION:first",
			"TRIGGER:-PT15M",
			"END:VALARM",
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			"DESCRIPTION:second",
			"TRIGGER:-PT1H",
			"END:VALARM",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		].join("\r\n");
		expect([201, 204]).toContain(await dav(ORGANIZER, "PUT", `${calPath(ORGANIZER, A)}${name}`, ics, { "content-type": "text/calendar; charset=utf-8", "x-nc-scheduling": "false" }));
		const r = await tool(tOrg, "calendar_update_event", { event_id: `${A}/${name}`, reminder_minutes_before: 10 });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		let stored = (await davText(ORGANIZER, `${calPath(ORGANIZER, A)}${name}`)).text;
		expect(stored).toMatch(/TRIGGER:-PT10M/);
		expect(stored).toMatch(/TRIGGER:-PT1H/);
		expect(stored).not.toMatch(/TRIGGER:-PT15M/);
		const undo = r.structuredContent.undo as { tool: string; arguments: Record<string, unknown> };
		expect(undo.arguments.reminder_minutes_before).toBe(15);
		expect((await tool(tOrg, undo.tool, undo.arguments)).isError).toBeFalsy();
		stored = (await davText(ORGANIZER, `${calPath(ORGANIZER, A)}${name}`)).text;
		expect(stored).toMatch(/TRIGGER:-PT15M/);
		expect(stored).toMatch(/TRIGGER:-PT1H/);
		expect(stored).not.toMatch(/TRIGGER:-PT10M/);
	});
});

describe("live: tasks (fix round 2)", () => {
	it("a task whose VTIMEZONE has a FREQ=MINUTELY rule is read at once, its time read as floating", async () => {
		const name = `tz-${RUN_ID}.ics`;
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//QA//EN",
			"BEGIN:VTIMEZONE",
			"TZID:Office Time",
			"BEGIN:STANDARD",
			"DTSTART:19700101T000000",
			"TZOFFSETFROM:+0100",
			"TZOFFSETTO:+0200",
			"RRULE:FREQ=MINUTELY",
			"END:STANDARD",
			"END:VTIMEZONE",
			"BEGIN:VTODO",
			`UID:tz-${RUN_ID}`,
			"DTSTAMP:20301001T000000Z",
			`SUMMARY:Crafted zone ${RUN_ID}`,
			"DUE;TZID=Office Time:20301030T120000",
			"END:VTODO",
			"END:VCALENDAR",
			"",
		].join("\r\n");
		const st = await dav(ORGANIZER, "PUT", `${calPath(ORGANIZER, L)}${name}`, ics, { "content-type": "text/calendar; charset=utf-8" });
		console.log(`[lane D live] NoCalendar answered ${st} to a VTIMEZONE with FREQ=MINUTELY`);
		if (st !== 201 && st !== 204) {
			// NoCalendar refused the block itself; nothing more to read.
			expect([400, 403, 415]).toContain(st);
			return;
		}
		const t0 = Date.now();
		const r = await tool(tOrg, "tasks_list", { list_id: L, query: RUN_ID });
		const ms = Date.now() - t0;
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		expect(ms).toBeLessThan(10_000);
		const tk = (r.structuredContent.tasks as { title: string; due: string | null }[]).find((x) => x.title === `Crafted zone ${RUN_ID}`);
		expect(tk?.due).toMatch(/^2030-10-30T12:00:00[+-]\d\d:\d\d$/);
		console.log(`[lane D live] tasks_list with the crafted block took ${ms} ms`);
	});

	it("a person without a task list of their own gets a plain refusal, and no list is made", async () => {
		const before = ((await tool(tAtt, "calendar_list_calendars")).structuredContent.calendars as { calendar_id: string; holds: string[]; read_only: boolean; shared_by: unknown }[]) ?? [];
		const own = before.filter((c) => c.holds.includes("tasks") && !c.read_only && !c.shared_by);
		if (own.length) {
			console.log(`[lane D live] ${ATTENDEE} has an own task list (${own.map((c) => c.calendar_id).join(", ")}); the refusal case needs a person without one`);
			return;
		}
		const r = await tool(tAtt, "tasks_create", { title: `No list ${RUN_ID}` });
		expect(code(r)).toBe("not_available");
		const after = (await tool(tAtt, "calendar_list_calendars")).structuredContent.calendars as { calendar_id: string }[];
		expect(after.map((c) => c.calendar_id).sort()).toEqual(before.map((c) => c.calendar_id).sort());
	});
});
