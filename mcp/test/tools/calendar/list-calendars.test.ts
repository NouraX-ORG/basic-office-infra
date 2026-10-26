/** Contract test for calendar_list_calendars against the fake (DESIGN 17.3). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callTool, errCode, payload, QA, resetTokens, type Setup, setup } from "./_helpers";

let s: Setup;
beforeEach(async () => {
	s = setup();
	await resetTokens();
	s.cal.home(QA.a);
	s.cal.addCalendar(QA.a, { uri: "work", displayname: "Work", comps: ["VEVENT"], order: 1, color: "#F97316", transparent: false });
	s.cal.addCalendar(QA.a, { uri: "holidays", displayname: "Holidays", comps: ["VEVENT"], order: 2, transparent: true });
	s.cal.addCalendar(QA.a, { uri: "todo", displayname: "To do", comps: ["VTODO"], order: 3 });
	s.cal.addCalendar(QA.a, { uri: "team_shared_by_qa-t1-92", displayname: "Team", comps: ["VEVENT"], order: 4, owner: QA.b, ownerName: "QA t1 92", readOnly: true });
	s.cal.addCalendar(QA.a, { uri: "contact_birthdays", displayname: "Contact birthdays", comps: ["VEVENT"] });
	s.cal.addCalendar(QA.a, { uri: "app-generated--deck--board-1", displayname: "Deck: Welcome", comps: ["VTODO"] });
	s.cal.addCalendar(QA.a, { uri: "subscribed-1", displayname: "Feed", comps: ["VEVENT"], subscription: true });
});
afterEach(() => vi.restoreAllMocks());

describe("calendar_list_calendars", () => {
	it("asks the principal and the home with Basic auth and two PROPFINDs", async () => {
		s.fake.requests.length = 0;
		const r = await callTool("calendar_list_calendars");
		expect(r.isError).toBeFalsy();
		const calls = s.fake.driveCalls().filter((c) => c.method === "PROPFIND" && /principals|calendars/.test(c.url.pathname));
		const home = calls.find((c) => c.url.pathname === `/remote.php/dav/calendars/${QA.a}/`);
		expect(home?.headers.get("depth")).toBe("1");
		expect(home?.auth).toBe(QA.a);
		expect(home?.headers.get("authorization")).toMatch(/^Basic /);
		expect(home?.body).toContain("supported-calendar-component-set");
		expect(calls.some((c) => c.url.pathname === `/remote.php/dav/principals/users/${QA.a}/`)).toBe(true);
	});

	it("lists calendars and task lists, shared ones with their owner, and leaves the others out", async () => {
		const r = await callTool("calendar_list_calendars");
		const cals = r.structuredContent.calendars as Record<string, unknown>[];
		expect(cals.map((c) => c.calendar_id)).toEqual(["personal", "work", "holidays", "todo", "team_shared_by_qa-t1-92"]);
		const byId = Object.fromEntries(cals.map((c) => [c.calendar_id, c]));
		expect(byId.personal).toMatchObject({ name: "Personal", holds: ["events", "tasks"], read_only: false, is_default: true, counts_for_free_time: true, shared_by: null });
		expect(byId.work).toMatchObject({ color: "#F97316", holds: ["events"], is_default: false, counts_for_free_time: true });
		expect(byId.holidays).toMatchObject({ counts_for_free_time: false });
		expect(byId.todo).toMatchObject({ holds: ["tasks"], counts_for_free_time: false });
		expect(byId["team_shared_by_qa-t1-92"]).toMatchObject({ read_only: true, shared_by: { id: "person:qa-t1-92", display_name: "QA t1 92" }, counts_for_free_time: false });
		expect(r.content[0]?.text.split("\n")[0]).toBe("Listed 5 calendars.");
		expect(payload(r).calendars).toHaveLength(5);
	});

	it("shows the old upstream default blue as Nourax cobalt", async () => {
		const r = await callTool("calendar_list_calendars");
		const personal = (r.structuredContent.calendars as Record<string, unknown>[]).find((c) => c.calendar_id === "personal");
		expect(personal?.color).toBe("#2563EB");
		expect(JSON.stringify(r)).not.toMatch(/0082c9/i);
	});

	it("maps a NoCalendar failure to a plain error without server text", async () => {
		s.fake.on("PROPFIND", /^\/remote\.php\/dav\/calendars\/[^/]+\/$/, () => new Response("Sabre\\DAV\\Exception trace /var/www", { status: 500 }));
		const r = await callTool("calendar_list_calendars");
		expect(r.isError).toBe(true);
		expect(errCode(r)).toBe("upstream_unavailable");
		expect(r.content[0]?.text).not.toMatch(/sabre|var\/www/i);
	});

	it("refuses unknown input", async () => {
		const r = await callTool("calendar_list_calendars", { surprise: true });
		expect(errCode(r)).toBe("invalid_input");
	});
});
