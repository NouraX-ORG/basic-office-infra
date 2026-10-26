/**
 * Fix round 2 (DESIGN 11.5): only the organizer's changes reach the invited people (Sabre's ITip
 * Broker, NC 35.0.2), so calendar_update_event and calendar_cancel_event name people in `notified`
 * only when the person (or the owner of a calendar shared with them) organises the event. Also: the
 * sharees searches behind `notified` and calendar_add_attendees are counted against the person's
 * read limit before anything is written, and an address on two accounts is reported as that.
 */
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JComp } from "../../../src/pim/jcal";
import { notToldWarning } from "../../../src/tools/calendar/people";
import { type Vault, vaultFor } from "../../../src/vault/vault";
import { env as nxEnv } from "../../helpers/index";
import { calCalls, callTool, errCode, propOf, QA, resetTokens, type Setup, setup, vevent } from "./_helpers";

let s: Setup;
const A = "qa-t1-91@example.invalid";
const B = "qa-t1-92@example.invalid";
const THIRD = "qa-t1-94";
const C = `${THIRD}@example.invalid`;

const org = (email: string, cn: string): JComp[1][number] => ["organizer", { cn }, "cal-address", `mailto:${email}`];
const att = (email: string, cn: string): JComp[1][number] => ["attendee", { cn, partstat: "NEEDS-ACTION" }, "cal-address", `mailto:${email}`];

beforeEach(async () => {
	s = setup();
	await resetTokens();
	s.fake.addUser({ uid: THIRD, password: "FAKEAPPPASS-qa-t1-94-0123456789abcdef", displayName: "QA t1 94", email: C, groups: ["qa-team"] });
	s.cal.home(QA.a);
	s.cal.home(QA.b);
	s.cal.home(THIRD);
	// QA.a's copy of an invitation organised by QA.b, with three people on it.
	s.cal.put(QA.a, "personal", "inv.ics", vevent("inv", "2030-11-07T10:00:00Z", "2030-11-07T11:00:00Z", [org(B, "QA t1 92"), att(A, "QA t1 91"), att(B, "QA t1 92"), att(C, "QA t1 94")]));
});
afterEach(() => vi.restoreAllMocks());

const stored = (cal: string, obj: string) => s.cal.get(QA.a, cal, obj)?.jcal as JComp;

/** The person's read units counted this minute and the next (the vault's per-minute keys). */
async function readUnits(uid: string): Promise<number> {
	return runInDurableObject(vaultFor(nxEnv, uid), async (_i: Vault, state) => {
		const rows = state.storage.sql.exec<{ n: number }>("SELECT n FROM counters WHERE k LIKE 'm:read:%'").toArray();
		return rows.reduce((a, r) => a + Number(r.n), 0);
	});
}

async function fillReads(uid: string): Promise<void> {
	const minute = Math.floor(Date.now() / 60_000);
	await runInDurableObject(vaultFor(nxEnv, uid), async (_i: Vault, state) => {
		for (const m of [minute - 1, minute, minute + 1]) {
			state.storage.sql.exec("INSERT INTO counters (k, n, exp) VALUES (?, 120, ?) ON CONFLICT(k) DO UPDATE SET n = 120", `m:read:${m}`, (m + 3) * 60);
		}
	});
}

describe("only the organizer's changes reach the invited people", () => {
	it("an invited person's change (3 people on it) is saved in their own copy only: scheduling off, nobody named, a warning", async () => {
		s.fake.requests.length = 0;
		const r = await callTool("calendar_update_event", { event_id: "personal/inv.ics", title: "My own title" });
		expect(r.isError).toBeFalsy();
		expect(calCalls(s.fake, "PUT")[0]?.headers.get("x-nc-scheduling")).toBe("false");
		expect(r.structuredContent.notified).toEqual([]);
		expect(r.structuredContent.warnings).toEqual([notToldWarning("attendee", "change", false)]);
		expect(r.content[0]?.text.split("\n")[0]).toBe("Changed the event.");
		expect(s.cal.deliveries).toEqual([]);
		// The organizer's own copy (and the third person's) never hears of it.
		expect(propOf(stored("personal", "inv.ics"), "vevent", "summary")?.[3]).toBe("My own title");
		// No sharees search was needed to know that.
		expect(s.fake.driveCalls().filter((c) => c.url.pathname.endsWith("/sharees"))).toHaveLength(0);
	});

	it("an invited person marking it cancelled changes their copy only; removing it tells the organizer they declined", async () => {
		s.fake.requests.length = 0;
		const mark = await callTool("calendar_cancel_event", { event_id: "personal/inv.ics" });
		expect(mark.isError).toBeFalsy();
		expect(calCalls(s.fake, "PUT")[0]?.headers.get("x-nc-scheduling")).toBe("false");
		expect(mark.structuredContent.notified).toEqual([]);
		expect(mark.structuredContent.warnings).toEqual([notToldWarning("attendee", "mark", false)]);
		expect(mark.content[0]?.text.split("\n")[0]).toBe("Marked the event as cancelled.");
		expect(s.cal.deliveries).toEqual([]);

		s.cal.put(QA.a, "personal", "inv2.ics", vevent("inv2", "2030-11-08T10:00:00Z", "2030-11-08T11:00:00Z", [org(B, "QA t1 92"), att(A, "QA t1 91"), att(C, "QA t1 94")]));
		s.fake.requests.length = 0;
		const rm = await callTool("calendar_cancel_event", { event_id: "personal/inv2.ics", mode: "remove" });
		expect(rm.isError).toBeFalsy();
		// Scheduling stays on for the removal, so NoCalendar sends the organizer a decline (as its own pages do).
		expect(calCalls(s.fake, "DELETE")[0]?.headers.get("x-nc-scheduling")).toBeNull();
		expect(s.cal.deliveries).toEqual([{ to: QA.b, uid: "inv2", kind: "reply" }]);
		expect(rm.structuredContent.notified).toEqual([]);
		expect(rm.structuredContent.warnings).toEqual(["NoCalendar's trash keeps it for 30 days; it can be restored from there.", notToldWarning("attendee", "remove", true)]);
		expect(rm.content[0]?.text.split("\n")[0]).toBe("Moved the event to NoCalendar's trash.");
	});

	it("an invited person removing a copy that is already cancelled sends nothing, and the warning says so", async () => {
		s.cal.put(QA.a, "personal", "gone.ics", vevent("gone", "2030-11-08T12:00:00Z", "2030-11-08T13:00:00Z", [org(B, "QA t1 92"), att(A, "QA t1 91"), ["status", {}, "text", "CANCELLED"]]));
		const r = await callTool("calendar_cancel_event", { event_id: "personal/gone.ics", mode: "remove" });
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent.warnings).toContain(notToldWarning("attendee", "remove", false));
		expect(notToldWarning("attendee", "remove", false)).toMatch(/the organizer isn't told/);
		expect(s.cal.deliveries).toEqual([]);
	});

	it("an invited person removing one occurrence keeps scheduling on (the organizer hears of the decline) and claims nobody", async () => {
		s.cal.put(QA.a, "personal", "weekly.ics", vevent("weekly", "2030-11-04T10:00:00Z", "2030-11-04T11:00:00Z", [["rrule", {}, "recur", { freq: "WEEKLY", count: 4 }], org(B, "QA t1 92"), att(A, "QA t1 91"), att(C, "QA t1 94")]));
		s.fake.requests.length = 0;
		const r = await callTool("calendar_cancel_event", { event_id: "personal/weekly.ics", scope: "this", occurrence_start: "2030-11-11T10:00:00Z", mode: "remove" });
		expect(r.isError).toBeFalsy();
		expect(calCalls(s.fake, "PUT")[0]?.headers.get("x-nc-scheduling")).toBeNull();
		expect(r.structuredContent.notified).toEqual([]);
		expect(r.structuredContent.warnings).toContain(notToldWarning("attendee", "remove_one", true));
		expect(r.content[0]?.text.split("\n")[0]).toBe("Removed one occurrence of the series.");
	});

	it("an event with no organizer, or someone else's the person isn't invited to, reaches nobody", async () => {
		s.cal.put(QA.a, "personal", "noorg.ics", vevent("noorg", "2030-11-09T10:00:00Z", "2030-11-09T11:00:00Z", [att(C, "QA t1 94")]));
		s.cal.put(QA.a, "personal", "other.ics", vevent("other", "2030-11-09T12:00:00Z", "2030-11-09T13:00:00Z", [org(B, "QA t1 92"), att(C, "QA t1 94")]));
		s.fake.requests.length = 0;
		const a = await callTool("calendar_update_event", { event_id: "personal/noorg.ics", location: "Room 2" });
		expect(a.structuredContent.notified).toEqual([]);
		expect(a.structuredContent.warnings).toEqual([notToldWarning("no_organizer", "change", false)]);
		const b = await callTool("calendar_cancel_event", { event_id: "personal/other.ics" });
		expect(b.structuredContent.notified).toEqual([]);
		expect(b.structuredContent.warnings).toEqual([notToldWarning("other", "mark", false)]);
		expect(calCalls(s.fake, "PUT").map((c) => c.headers.get("x-nc-scheduling"))).toEqual(["false", "false"]);
		expect(s.cal.deliveries).toEqual([]);
	});

	it("the organizer's change still names who NoCalendar tells, never the person or the organizer", async () => {
		s.cal.put(QA.a, "personal", "mine.ics", vevent("mine", "2030-11-10T10:00:00Z", "2030-11-10T11:00:00Z", [org(A, "QA t1 91"), att(A, "QA t1 91"), att(B, "QA t1 92"), att(C, "QA t1 94")]));
		const r = await callTool("calendar_update_event", { event_id: "personal/mine.ics", title: "Moved on" });
		expect(r.structuredContent.notified).toEqual([
			{ id: `person:${QA.b}`, display_name: "QA t1 92" },
			{ id: `person:${THIRD}`, display_name: "QA t1 94" },
		]);
		expect(r.content[0]?.text.split("\n")[0]).toBe("Changed the event; NoCalendar tells 2 invited people in the workspace.");
		expect(s.cal.deliveries.map((d) => d.to).sort()).toEqual([QA.b, THIRD]);
	});

	it("in a calendar shared with the person, an event its owner organises still reaches the invited people", async () => {
		s.cal.addCalendar(QA.a, { uri: "team_shared_by_qa-t1-92", displayname: "Their calendar", comps: ["VEVENT"], owner: QA.b });
		s.cal.put(QA.a, "team_shared_by_qa-t1-92", "owned.ics", vevent("owned", "2030-11-11T10:00:00Z", "2030-11-11T11:00:00Z", [org(B, "QA t1 92"), att(C, "QA t1 94")]));
		s.fake.requests.length = 0;
		const r = await callTool("calendar_update_event", { event_id: "team_shared_by_qa-t1-92/owned.ics", title: "Owner's event, changed" });
		expect(r.isError).toBeFalsy();
		expect(calCalls(s.fake, "PUT")[0]?.headers.get("x-nc-scheduling")).toBeNull();
		expect(r.structuredContent.notified).toEqual([{ id: `person:${THIRD}`, display_name: "QA t1 94" }]);
		expect(s.cal.deliveries).toEqual([{ to: THIRD, uid: "owned", kind: "request" }]);
	});
});

describe("person lookups count against the read limit", () => {
	it("50 attendees behind notified: their searches are counted before the write, and a full limit writes nothing", async () => {
		const many = Array.from({ length: 50 }, (_, i) => att(`guest${i}@example.org`, `Guest ${i}`));
		s.cal.put(QA.a, "personal", "big.ics", vevent("big", "2030-11-12T10:00:00Z", "2030-11-12T11:00:00Z", [org(A, "QA t1 91"), ...many]));
		const before = await readUnits(QA.a);
		const r = await callTool("calendar_update_event", { event_id: "personal/big.ics", title: "Big meeting" });
		expect(r.isError).toBeFalsy();
		// 50 addresses x 2 searches (address, then name) = 100; the first 5 are the call's own, then 1 read per 5.
		expect((await readUnits(QA.a)) - before).toBe(19);
		const searches = s.fake.driveCalls().filter((c) => c.url.pathname.endsWith("/sharees"));
		expect(searches.length).toBeLessThanOrEqual(100);
		await fillReads(QA.a);
		const etag = s.cal.get(QA.a, "personal", "big.ics")?.etag;
		s.fake.requests.length = 0;
		const refused = await callTool("calendar_update_event", { event_id: "personal/big.ics", title: "Again" });
		expect(errCode(refused)).toBe("rate_limited");
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
		expect(s.cal.get(QA.a, "personal", "big.ics")?.etag).toBe(etag);
	});

	it("calendar_add_attendees counts up to 3 searches a person before any search, and searches each term once", async () => {
		s.cal.put(QA.a, "personal", "plan.ics", vevent("plan", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z"));
		s.fake.requests.length = 0;
		const one = await callTool("calendar_add_attendees", { event_id: "personal/plan.ics", attendees: [`person:${QA.b}`] });
		expect(one.isError).toBeFalsy();
		// One search by uid (the re-check and the address at once), one by the address.
		expect(s.fake.driveCalls().filter((c) => c.url.pathname.endsWith("/sharees")).map((c) => c.url.searchParams.get("search"))).toEqual([QA.b, B]);
		const before = await readUnits(QA.a);
		const ids = Array.from({ length: 50 }, (_, i) => `person:qa-t1-${300 + i}`);
		const r = await callTool("calendar_add_attendees", { event_id: "personal/plan.ics", attendees: ids });
		expect(r.isError).toBeFalsy();
		expect((r.structuredContent.not_invited as unknown[]).length).toBe(50);
		// 50 x 3 = 150 searches reserved: 1 read per 5 beyond the call's own 5.
		expect((await readUnits(QA.a)) - before).toBe(29);
	});
});

describe("plain reasons", () => {
	it("an attendee whose address another account has too is reported as that, not as someone nobody can find", async () => {
		s.fake.addUser({ uid: "qa-t1-95", password: "FAKEAPPPASS-qa-t1-95-0123456789abcdef", displayName: "QA t1 95", email: C, groups: ["qa-team"] });
		s.cal.put(QA.a, "personal", "dup.ics", vevent("dup", "2030-11-13T10:00:00Z", "2030-11-13T11:00:00Z", [org(A, "QA t1 91"), att(C, "QA t1 94"), att("visitor@example.org", "Visitor")]));
		const r = await callTool("calendar_update_event", { event_id: "personal/dup.ics", title: "Dup" });
		expect(r.structuredContent.notified).toEqual([]);
		expect(r.structuredContent.warnings).toEqual([
			"1 attendee isn't anyone this person can find in the workspace; NoCalendar tells only workspace accounts, and no email goes out while workspace email is off.",
			"1 attendee has an email address that another account has too, so NoCalendar can't tell them.",
		]);
	});
});
