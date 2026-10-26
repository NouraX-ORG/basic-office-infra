/**
 * Core's ctx.page.fit measures what structuredContent carries: JSON with every null kept (third
 * system review, section 30.7). It measured without nulls before, so a page of plain events (location,
 * description, organizer and more null) fitted to the cap carried about a quarter more than the
 * 60,000 characters in structuredContent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../../src/core/limits";
import { compactJson } from "../../../src/core/result";
import { callTool, QA, resetTokens, type Setup, setup, vevent } from "./_helpers";

let s: Setup;
beforeEach(async () => {
	s = setup();
	await resetTokens();
	s.cal.home(QA.a);
	s.cal.addCalendar(QA.a, { uri: "work", displayname: "Work", comps: ["VEVENT"], order: 1 });
	// 200 plain, non-repeating events: no location, description, organizer or reminder (all null).
	for (let i = 0; i < 200; i++) {
		const day = String(1 + (i % 28)).padStart(2, "0");
		const uid = `plain-${String(i).padStart(3, "0")}-${"p".repeat(60)}`;
		s.cal.put(QA.a, "work", `${uid}.ics`, vevent(uid, `2026-11-${day}T09:00:00Z`, `2026-11-${day}T10:00:00Z`));
	}
});
afterEach(() => vi.restoreAllMocks());

describe("ctx.page.fit with nulls kept", () => {
	it("calendar_list_events with 200 null-heavy events: structuredContent and the text both stay within 60,000 characters", async () => {
		const r = await callTool("calendar_list_events", { start: "2026-11-01", end: "2026-11-30", limit: 200 });
		expect(r.isError).toBeFalsy();
		const sc = r.structuredContent as { events: Record<string, unknown>[]; has_more: boolean; next_cursor: string | null };
		// The page was cut to fit (so this measures the fit, not a small answer).
		expect(sc.has_more).toBe(true);
		expect(sc.events.length).toBeGreaterThan(0);
		expect(sc.events.length).toBeLessThan(200);
		// The events really are null-heavy: the JSON with nulls is clearly longer than without.
		const withNulls = JSON.stringify(sc).length;
		expect(withNulls - compactJson(sc).length).toBeGreaterThan(sc.events.length * 50);
		expect(withNulls).toBeLessThanOrEqual(LIMITS.resultChars);
		expect(r.content[0]?.text.length).toBeLessThanOrEqual(LIMITS.resultChars);
		// And the next page goes on from where this one stopped.
		const next = await callTool("calendar_list_events", { start: "2026-11-01", end: "2026-11-30", limit: 200, cursor: sc.next_cursor });
		expect(JSON.stringify(next.structuredContent).length).toBeLessThanOrEqual(LIMITS.resultChars);
		const firstIds = new Set(sc.events.map((e) => `${e.event_id}`));
		expect((next.structuredContent.events as Record<string, unknown>[]).some((e) => firstIds.has(`${e.event_id}`))).toBe(false);
	});
});
