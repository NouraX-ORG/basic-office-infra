/** Contract test for calendar_add_attendees (DESIGN 17.3): internal invitations only. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JComp } from "../../../src/pim/jcal";
import { INVITED_NOTE } from "../../../src/tools/calendar/add-attendees";
import { mcpPost, rpcResult } from "../../helpers/index";
import { ALL_SCOPES, calCalls, callTool, errCode, OUTSIDER, QA, resetTokens, type Setup, setup, tokenFor, vevent } from "./_helpers";

let s: Setup;
const A = "qa-t1-91@example.invalid";
const B = "qa-t1-92@example.invalid";

beforeEach(async () => {
	s = setup();
	await resetTokens();
	s.cal.home(QA.a);
	s.cal.home(QA.b);
	s.cal.put(QA.a, "personal", "plan.ics", vevent("plan", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z"));
	s.cal.put(QA.a, "personal", "theirs.ics", vevent("theirs", "2030-11-05T12:00:00Z", "2030-11-05T13:00:00Z", [["organizer", {}, "cal-address", "mailto:someone@example.org"]]));
});
afterEach(() => vi.restoreAllMocks());

const stored = () => s.cal.get(QA.a, "personal", "plan.ics")?.jcal as JComp;

describe("calendar_add_attendees", () => {
	it("re-checks each person, adds ORGANIZER and ATTENDEE, and PUTs with scheduling on", async () => {
		s.fake.requests.length = 0;
		const r = await callTool("calendar_add_attendees", { event_id: "personal/plan.ics", attendees: [`person:${QA.b}`] });
		expect(r.isError).toBeFalsy();
		const sharees = s.fake.driveCalls().filter((c) => c.url.pathname.endsWith("/sharees"));
		expect(sharees.length).toBeGreaterThanOrEqual(1);
		expect(sharees[0]?.url.searchParams.get("search")).toBe(QA.b);
		expect(sharees[0]?.headers.get("ocs-apirequest")).toBe("true");
		const put = calCalls(s.fake, "PUT")[0];
		expect(put?.headers.get("x-nc-scheduling")).toBeNull();
		expect(put?.headers.get("if-match")).toMatch(/^"etag/);
		const vev = stored()[2].find((c) => c[0] === "vevent") as JComp;
		expect(vev[1].find((p) => p[0] === "organizer")).toEqual(["organizer", { cn: "QA t1 91" }, "cal-address", `mailto:${A}`]);
		const att = vev[1].find((p) => p[0] === "attendee");
		expect(att?.[3]).toBe(`mailto:${B}`);
		expect(att?.[1]).toMatchObject({ cn: "QA t1 92", partstat: "NEEDS-ACTION", rsvp: "TRUE", role: "REQ-PARTICIPANT", cutype: "INDIVIDUAL", "schedule-status": "5.0" });
		// A new attendee is a significant change: SEQUENCE goes up (DESIGN 11.5; review fix round 1).
		expect(vev[1].find((p) => p[0] === "sequence")?.[3]).toBe(1);
		expect(s.cal.deliveries).toEqual([{ to: QA.b, uid: "plan", kind: "request" }]);
		// "invited" (added to the event), never "delivered": SCHEDULE-STATUS can't prove delivery.
		expect(r.structuredContent).toMatchObject({ invited: [{ id: `person:${QA.b}`, display_name: "QA t1 92" }], not_invited: [], undo: null });
		expect(r.structuredContent).not.toHaveProperty("delivered");
		expect(r.structuredContent.warnings).toEqual([INVITED_NOTE]);
		expect((r.structuredContent.event as { attendees: unknown[] }).attendees).toEqual([{ name: "QA t1 92", email: B, status: "needs-action" }]);
		expect(r.content[0]?.text.split("\n")[0]).toBe("Invited 1 person from the workspace (added to the event).");
	});

	it("bumps SEQUENCE from the stored value on every VEVENT it changes", async () => {
		s.cal.put(QA.a, "personal", "seq.ics", vevent("seq", "2030-11-06T10:00:00Z", "2030-11-06T11:00:00Z", [["sequence", {}, "integer", 4]]));
		const r = await callTool("calendar_add_attendees", { event_id: "personal/seq.ics", attendees: [`person:${QA.b}`] });
		expect(r.isError).toBeFalsy();
		const vev = (s.cal.get(QA.a, "personal", "seq.ics")?.jcal as JComp)[2].find((c) => c[0] === "vevent") as JComp;
		expect(vev[1].find((p) => p[0] === "sequence")?.[3]).toBe(5);
	});

	it("says who wasn't invited and why, and writes nothing when nobody is left", async () => {
		s.fake.requests.length = 0;
		const r = await callTool("calendar_add_attendees", { event_id: "personal/plan.ics", attendees: [`person:${OUTSIDER}`, `person:${QA.a}`, "person:nobody-here"] });
		expect(r.isError).toBeFalsy();
		const nd = r.structuredContent.not_invited as { id: string; reason: string }[];
		expect(nd.map((x) => x.id).sort()).toEqual([`person:${OUTSIDER}`, `person:${QA.a}`, "person:nobody-here"].sort());
		expect(nd.find((x) => x.id === `person:${OUTSIDER}`)?.reason).toMatch(/Not found among the people/);
		expect(r.structuredContent.invited).toEqual([]);
		expect(r.content[0]?.text.split("\n")[0]).toBe("Nobody was invited; not_invited says why.");
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
		await callTool("calendar_add_attendees", { event_id: "personal/plan.ics", attendees: [`person:${QA.b}`] });
		const again = await callTool("calendar_add_attendees", { event_id: "personal/plan.ics", attendees: [`person:${QA.b}`] });
		expect(again.structuredContent.not_invited).toEqual([{ id: `person:${QA.b}`, reason: "Already invited to this event." }]);
	});

	it("moves someone to not_invited only on a definite failure code (3.x), and claims nothing more on others", async () => {
		s.cal.scheduleStatusFor = () => "3.7;Could not find principal.";
		const r = await callTool("calendar_add_attendees", { event_id: "personal/plan.ics", attendees: [`person:${QA.b}`] });
		expect(r.structuredContent.invited).toEqual([]);
		expect(r.structuredContent.not_invited).toEqual([{ id: `person:${QA.b}`, reason: "NoCalendar couldn't deliver the invitation to this person." }]);
		// No code at all proves nothing either way: the person is listed as invited (added), not as having received it.
		s.cal.put(QA.a, "personal", "plan2.ics", vevent("plan2", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z"));
		s.cal.scheduleStatusFor = () => "";
		const quiet = await callTool("calendar_add_attendees", { event_id: "personal/plan2.ics", attendees: [`person:${QA.b}`] });
		expect(quiet.structuredContent.invited).toEqual([{ id: `person:${QA.b}`, display_name: "QA t1 92" }]);
		expect(quiet.content[0]?.text).not.toMatch(/delivered|received/i);
	});

	it("refuses an address that another account the person can see has too, and writes nothing", async () => {
		s.fake.addUser({ uid: "qa-t1-94", password: "FAKEAPPPASS-qa-t1-94-0123456789abcdef", displayName: "QA t1 94", email: B, groups: ["qa-team"] });
		s.fake.requests.length = 0;
		const r = await callTool("calendar_add_attendees", { event_id: "personal/plan.ics", attendees: [`person:${QA.b}`] });
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent.invited).toEqual([]);
		expect(r.structuredContent.not_invited).toEqual([{ id: `person:${QA.b}`, reason: "This person's email address belongs to another account too, so NoCalendar couldn't deliver to them." }]);
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
	});

	it("refuses an event that lists people but has no organizer (inviting would resend it to all of them)", async () => {
		s.cal.put(QA.a, "personal", "imported.ics", vevent("imported", "2030-11-08T10:00:00Z", "2030-11-08T11:00:00Z", [["attendee", { cn: "Someone" }, "cal-address", "mailto:someone@example.org"]]));
		s.fake.requests.length = 0;
		const r = await callTool("calendar_add_attendees", { event_id: "personal/imported.ics", attendees: [`person:${QA.b}`] });
		expect(errCode(r)).toBe("invalid_input");
		expect(r.content[0]?.text).toMatch(/no organizer/);
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
		expect(s.cal.deliveries).toEqual([]);
	});

	it("refuses events organised by someone else, people without an email, and other id kinds", async () => {
		expect(errCode(await callTool("calendar_add_attendees", { event_id: "personal/theirs.ics", attendees: [`person:${QA.b}`] }))).toBe("permission_denied");
		expect(errCode(await callTool("calendar_add_attendees", { event_id: "personal/plan.ics", attendees: ["group:qa-team"] }))).toBe("invalid_input");
		expect(errCode(await callTool("calendar_add_attendees", { event_id: "personal/plan.ics", attendees: [] }))).toBe("invalid_input");
		const b = s.fake.users.get(QA.b);
		if (b) b.email = null;
		const noMail = await callTool("calendar_add_attendees", { event_id: "personal/plan.ics", attendees: [`person:${QA.b}`] });
		expect((noMail.structuredContent.not_invited as { reason: string }[])[0]?.reason).toMatch(/no email address/);
		const a = s.fake.users.get(QA.a);
		if (a) a.email = null;
		expect(errCode(await callTool("calendar_add_attendees", { event_id: "personal/plan.ics", attendees: [`person:${QA.b}`] }))).toBe("not_available");
	});

	it("is hidden without the share scope and asks for it on a call (step-up)", async () => {
		const scopes = ALL_SCOPES.filter((x) => x !== "workspace.share");
		const token = await tokenFor(QA.a, scopes);
		const list = await rpcResult(await mcpPost(token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
		const names = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name);
		expect(names).toContain("calendar_create_event");
		expect(names).not.toContain("calendar_add_attendees");
		const res = await mcpPost(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "calendar_add_attendees", arguments: { event_id: "personal/plan.ics", attendees: [`person:${QA.b}`] } } });
		expect(res.status).toBe(403);
		expect(res.headers.get("www-authenticate")).toContain("insufficient_scope");
	});
});
