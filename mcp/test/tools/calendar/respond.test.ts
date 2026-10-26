/**
 * Contract test for calendar_respond (fix round 3): the invited person's own answer. Only their
 * ATTENDEE changes, with If-Match and scheduling on, so NoCalendar sends the organizer a reply; the
 * organizer and other people are never touched; the undo gives the earlier answer back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JComp } from "../../../src/pim/jcal";
import { calCalls, callTool, errCode, QA, resetTokens, type Setup, setup, vevent } from "./_helpers";

let s: Setup;
const A = "qa-t1-91@example.invalid";
const B = "qa-t1-92@example.invalid";
const org = (email: string, cn: string): JComp[1][number] => ["organizer", { cn }, "cal-address", `mailto:${email}`];
const att = (email: string, cn: string, partstat = "NEEDS-ACTION"): JComp[1][number] => ["attendee", { cn, partstat, rsvp: "TRUE" }, "cal-address", `mailto:${email}`];

beforeEach(async () => {
	s = setup();
	await resetTokens();
	s.cal.home(QA.a);
	s.cal.home(QA.b);
	// QA.a's copy of an invitation organised by QA.b.
	s.cal.put(QA.a, "personal", "inv.ics", vevent("inv", "2030-11-07T10:00:00Z", "2030-11-07T11:00:00Z", [org(B, "QA t1 92"), att(A, "QA t1 91"), att(B, "QA t1 92", "ACCEPTED")]));
	s.cal.put(QA.a, "personal", "own.ics", vevent("own", "2030-11-08T10:00:00Z", "2030-11-08T11:00:00Z", [org(A, "QA t1 91"), att(B, "QA t1 92")]));
	s.cal.put(QA.a, "personal", "plain.ics", vevent("plain", "2030-11-09T10:00:00Z", "2030-11-09T11:00:00Z"));
});
afterEach(() => vi.restoreAllMocks());

const partstatOf = (obj: string, email: string): unknown => {
	const cal = s.cal.get(QA.a, "personal", obj)?.jcal as JComp;
	const v = cal[2].find((c) => c[0] === "vevent");
	const p = v?.[1].find((x) => x[0] === "attendee" && String(x[3]).toLowerCase() === `mailto:${email}`);
	return (p?.[1] as Record<string, unknown> | undefined)?.partstat;
};

describe("calendar_respond", () => {
	it("accepts: only the person's own answer changes, with If-Match and scheduling on, and the organizer is told", async () => {
		s.fake.requests.length = 0;
		const r = await callTool("calendar_respond", { event_id: "personal/inv.ics", response: "accepted" });
		expect(r.isError).toBeFalsy();
		const put = calCalls(s.fake, "PUT").pop();
		expect(put?.headers.get("if-match")).toBeTruthy();
		expect(put?.headers.get("x-nc-scheduling")).toBeNull();
		expect(partstatOf("inv.ics", A)).toBe("ACCEPTED");
		expect(partstatOf("inv.ics", B)).toBe("ACCEPTED");
		expect(s.cal.deliveries).toContainEqual(expect.objectContaining({ to: QA.b, kind: "reply" }));
		expect(r.structuredContent).toMatchObject({ event_id: "personal/inv.ics", response: "accepted", previous_response: "needs_action", scope: null, undo: null });
		expect(r.content[0]?.text.split("\n")[0]).toBe("Accepted the invitation; NoCalendar tells the organizer.");
		// The same answer again changes nothing and sends nothing.
		s.fake.requests.length = 0;
		const again = await callTool("calendar_respond", { event_id: "personal/inv.ics", response: "accepted" });
		expect(again.content[0]?.text.split("\n")[0]).toBe("That was already the person's answer; nothing changed.");
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
	});
	it("declines after accepting, with an undo that gives the acceptance back", async () => {
		await callTool("calendar_respond", { event_id: "personal/inv.ics", response: "accepted" });
		const r = await callTool("calendar_respond", { event_id: "personal/inv.ics", response: "declined" });
		expect(partstatOf("inv.ics", A)).toBe("DECLINED");
		expect(r.structuredContent.undo).toEqual({ tool: "calendar_respond", arguments: { event_id: "personal/inv.ics", response: "accepted" } });
		const back = await callTool("calendar_respond", (r.structuredContent.undo as { arguments: Record<string, unknown> }).arguments);
		expect(back.isError).toBeFalsy();
		expect(partstatOf("inv.ics", A)).toBe("ACCEPTED");
	});
	it("refuses an event the person organises, or isn't invited to, and writes nothing", async () => {
		s.fake.requests.length = 0;
		const own = await callTool("calendar_respond", { event_id: "personal/own.ics", response: "declined" });
		expect(errCode(own)).toBe("not_available");
		expect(own.content[0]?.text).toContain("organises that event");
		const plain = await callTool("calendar_respond", { event_id: "personal/plain.ics", response: "accepted" });
		expect(errCode(plain)).toBe("not_available");
		expect(plain.content[0]?.text).toContain("isn't invited");
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
	});
	it("is idempotent and a write in the catalogue (workspace.write)", async () => {
		const { catalogEntry, annotationsFor } = await import("../../../src/mcp/catalog");
		const e = catalogEntry("calendar_respond");
		expect(e).toMatchObject({ app: "calendar", scope: "workspace.write", tier: "D", idempotent: true });
		expect(annotationsFor(e as never)).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
	});
});
