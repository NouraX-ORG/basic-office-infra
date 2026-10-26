/**
 * Lane D live cases for fix round 3 (DESIGN 27), against drive.nourax.org through a local
 * `wrangler dev --env dev` (lane D's own runs use :8830):
 * - removing one occurrence is refused when NoCalendar holds changes of its own for it, and still
 *   works when it was only marked cancelled or never changed (hasOwnChanges on what NoCalendar
 *   really stores);
 * - an event with more than 50 attendees says so (attendees_total and a warning);
 * - calendar_add_attendees publishes and takes person ids only;
 * - tasks_complete says what its undo can't put back;
 * - a task whose TZID names no real zone is read as floating time, as before.
 * Only this run's own items (titles or names with RUN_ID) are made and removed (the rule-3 exception).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calPath, code, dav, davText, ensureCollection, LIVE_BASE, ORGANIZER, QA_CAL as A, QA_TASKS as L, RUN_ID, token, tool } from "./_live";

let t = "";
/** Objects this run PUT directly (setup), removed at the end. */
const made: string[] = [];

type Ev = { event_id: string; title: string; status: string; occurrence_start: string | null; attendees: unknown[]; attendees_total?: number };

beforeAll(async () => {
	await ensureCollection(ORGANIZER, A, "MCP QA D", ["VEVENT"]);
	await ensureCollection(ORGANIZER, L, "MCP QA tasks", ["VTODO"]);
	t = await token(ORGANIZER);
});

afterAll(async () => {
	const evs = await tool(t, "calendar_list_events", { start: "2030-11-01", end: "2030-12-31", query: RUN_ID, limit: 200 });
	const objects = new Set(((evs.structuredContent.events ?? []) as Ev[]).map((e) => e.event_id));
	for (const id of objects) await dav(ORGANIZER, "DELETE", `/remote.php/dav/calendars/${ORGANIZER}/${id}`, undefined, { "x-nc-scheduling": "false" });
	const tasks = await tool(t, "tasks_list", { status: "all", query: RUN_ID, limit: 200 });
	for (const x of (tasks.structuredContent.tasks ?? []) as { task_id: string }[]) await dav(ORGANIZER, "DELETE", `/remote.php/dav/calendars/${ORGANIZER}/${x.task_id}`);
	for (const p of made) await dav(ORGANIZER, "DELETE", p, undefined, { "x-nc-scheduling": "false" });
});

/** PUTs one iCalendar object of this run's own (setup only). */
async function putIcs(cal: string, name: string, lines: string[]): Promise<number> {
	const path = `${calPath(ORGANIZER, cal)}${name}`;
	const status = await dav(ORGANIZER, "PUT", path, `${["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Nourax QA//EN", ...lines, "END:VCALENDAR"].join("\r\n")}\r\n`, {
		"content-type": "text/calendar; charset=utf-8",
		"if-none-match": "*",
		"x-nc-scheduling": "false",
	});
	if (status === 201 || status === 204) made.push(path);
	return status;
}

async function occurrences(eventId: string, from: string, to: string): Promise<Ev[]> {
	const r = await tool(t, "calendar_list_events", { start: from, end: to, query: RUN_ID, limit: 200 });
	return ((r.structuredContent.events ?? []) as Ev[]).filter((e) => e.event_id === eventId);
}

describe("live: lane D fix round 3", () => {
	it("removing one occurrence: refused when it was changed on its own, allowed when only marked cancelled or untouched", async () => {
		const title = `Standup ${RUN_ID}`;
		const c = await tool(t, "calendar_create_event", { title, start: "2030-11-18T09:00", time_zone: "Europe/London", duration_minutes: 30, calendar_id: A, repeat: { frequency: "daily", count: 5 }, reminder_minutes_before: 10 });
		expect(c.isError, c.content[0]?.text).toBeFalsy();
		const id = (c.structuredContent.event as Ev).event_id;
		const occ = await occurrences(id, "2030-11-18", "2030-11-22");
		expect(occ.map((o) => o.occurrence_start)).toEqual(["2030-11-18", "2030-11-19", "2030-11-20", "2030-11-21", "2030-11-22"].map((d) => `${d}T09:00:00+00:00`));
		const at = (i: number) => occ[i]?.occurrence_start as string;
		const removeOne = (i: number) => tool(t, "calendar_cancel_event", { event_id: id, scope: "this", occurrence_start: at(i), mode: "remove" });
		const path = `/remote.php/dav/calendars/${ORGANIZER}/${id}`;

		// Its own title: refused, and the object stays exactly as it was.
		const ch = await tool(t, "calendar_update_event", { event_id: id, scope: "this", occurrence_start: at(1), title: `${title} special` });
		expect(ch.isError, ch.content[0]?.text).toBeFalsy();
		const before = await davText(ORGANIZER, path);
		const refused = await removeOne(1);
		expect(code(refused), refused.content[0]?.text).toBe("not_available");
		expect(refused.content[0]?.text).toMatch(/changed on its own/);
		expect((await davText(ORGANIZER, path)).text).toBe(before.text);

		// Only marked cancelled (NoCalendar stores an override for it): removing still works.
		const mark = await tool(t, "calendar_cancel_event", { event_id: id, scope: "this", occurrence_start: at(2) });
		expect(mark.isError, mark.content[0]?.text).toBeFalsy();
		const rm = await removeOne(2);
		expect(rm.isError, rm.content[0]?.text).toBeFalsy();
		expect(rm.content[0]?.text.split("\n")[0]).toBe("Removed one occurrence of the series.");

		// Never changed: removing works as before.
		const plain = await removeOne(3);
		expect(plain.isError, plain.content[0]?.text).toBeFalsy();

		// A moved occurrence is refused too.
		const moved = await tool(t, "calendar_update_event", { event_id: id, scope: "this", occurrence_start: at(4), start: "2030-11-22T10:00:00Z" });
		expect(moved.isError, moved.content[0]?.text).toBeFalsy();
		expect(code(await removeOne(4))).toBe("not_available");

		const left = await occurrences(id, "2030-11-18", "2030-11-22");
		expect(left.map((o) => [o.occurrence_start?.slice(0, 10), o.title])).toEqual([
			["2030-11-18", title],
			["2030-11-19", `${title} special`],
			["2030-11-22", title],
		]);
	});

	it("an event with 55 attendees lists the first 50 and says how many there are", async () => {
		const name = `crowd-${RUN_ID}.ics`;
		const guests = Array.from({ length: 55 }, (_, i) => `ATTENDEE;CN=Guest ${i};PARTSTAT=NEEDS-ACTION:mailto:guest${i}@example.invalid`);
		const st = await putIcs(A, name, ["BEGIN:VEVENT", `UID:crowd-${RUN_ID}`, "DTSTAMP:20301101T000000Z", "DTSTART:20301125T100000Z", "DTEND:20301125T110000Z", `SUMMARY:Crowd ${RUN_ID}`, "ORGANIZER;CN=Boss:mailto:boss@example.invalid", ...guests, "END:VEVENT"]);
		expect([201, 204]).toContain(st);
		const r = await tool(t, "calendar_list_events", { start: "2030-11-25", end: "2030-11-25", query: RUN_ID, calendar_ids: [A] });
		const ev = ((r.structuredContent.events ?? []) as Ev[]).find((e) => e.event_id === `${A}/${name}`);
		expect(ev?.attendees).toHaveLength(50);
		expect(ev?.attendees_total).toBe(55);
		expect(r.structuredContent.warnings).toContain("Some events list more than 50 attendees; only the first 50 are shown, and attendees_total gives the full count.");
		const u = await tool(t, "calendar_update_event", { event_id: `${A}/${name}`, location: "Hall" });
		expect(u.isError, u.content[0]?.text).toBeFalsy();
		expect(u.structuredContent.warnings).toContain("This event lists 55 attendees; only the first 50 are shown.");
	});

	it("calendar_add_attendees publishes person ids only and refuses a group id in the schema", async () => {
		const res = await fetch(`${LIVE_BASE}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${t}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
		const raw = await res.text();
		const json = raw.startsWith("{") ? raw : (raw.split(/\r?\n/).find((l) => l.startsWith("data:"))?.slice(5) ?? "{}");
		const tools = (JSON.parse(json) as { result: { tools: { name: string; inputSchema: { properties: Record<string, { items?: { pattern?: string } }> } }[] } }).result.tools;
		expect(tools.find((x) => x.name === "calendar_add_attendees")?.inputSchema.properties.attendees?.items?.pattern).toBe("^person:.+$");
		const c = await tool(t, "calendar_create_event", { title: `Group ${RUN_ID}`, start: "2030-11-26T10:00:00Z", calendar_id: A });
		const r = await tool(t, "calendar_add_attendees", { event_id: (c.structuredContent.event as Ev).event_id, attendees: ["group:qa-t1-d"] });
		expect(code(r)).toBe("invalid_input");
	});

	it("tasks_complete says what its undo can't put back", async () => {
		const name = `doing-${RUN_ID}.ics`;
		const st = await putIcs(L, name, ["BEGIN:VTODO", `UID:doing-${RUN_ID}`, "DTSTAMP:20301101T000000Z", `SUMMARY:Doing ${RUN_ID}`, "STATUS:IN-PROCESS", "PERCENT-COMPLETE:40", "END:VTODO"]);
		expect([201, 204]).toContain(st);
		const done = await tool(t, "tasks_complete", { task_id: `${L}/${name}` });
		expect(done.isError, done.content[0]?.text).toBeFalsy();
		expect(done.structuredContent.warnings).toEqual(["This task was in progress before (40% done); the undo marks it not done at 0%, and NoTasks can set the progress again."]);
		const at = (done.structuredContent.task as { completed_at: string }).completed_at;
		const back = await tool(t, "tasks_complete", { task_id: `${L}/${name}`, completed: false });
		expect(back.isError, back.content[0]?.text).toBeFalsy();
		expect(back.structuredContent.warnings).toEqual([`This task was marked done at ${at}; the undo marks it done again at the time the undo runs.`]);
	});

	it("a task whose TZID names no real zone is read as floating time (fix round 3 changed only the cost)", async () => {
		const name = `tz-nope-${RUN_ID}.ics`;
		const st = await putIcs(L, name, ["BEGIN:VTODO", `UID:tz-nope-${RUN_ID}`, "DTSTAMP:20301101T000000Z", `SUMMARY:Nope zone ${RUN_ID}`, "DUE;TZID=Europe/Nope:20301120T120000", "END:VTODO"]);
		if (st !== 201 && st !== 204) {
			// NoCalendar may refuse a TZID without a VTIMEZONE; then there is nothing to read.
			expect(st).toBeGreaterThanOrEqual(400);
			return;
		}
		const r = await tool(t, "tasks_list", { list_id: L, query: `Nope zone ${RUN_ID}` });
		const due = ((r.structuredContent.tasks ?? []) as { due: string | null }[])[0]?.due;
		expect(due).toMatch(/^2030-11-20T12:00:00[+-]\d\d:\d\d$/);
	});
});
