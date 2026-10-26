/**
 * Fix round 2 (spec review): a reminder change touches only the reminder reminder_minutes_before
 * stands for, so its undo puts back what was there; when it can't, a warning says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JComp } from "../../../src/pim/jcal";
import { reminderOf, setReminder } from "../../../src/tools/calendar/events";
import { callTool, QA, resetTokens, type Setup, setup, vevent } from "./_helpers";

let s: Setup;

const alarm = (trigger: JComp[1][number], action = "DISPLAY"): JComp => ["valarm", [["action", {}, "text", action], ["description", {}, "text", "x"], trigger], []];
const before = (min: number): JComp[1][number] => ["trigger", {}, "duration", `-PT${min}M`];
const fixedAt = (t: string): JComp[1][number] => ["trigger", { value: "DATE-TIME" }, "date-time", t];

/** What the alarms are, in order: minutes before the start, or the fixed time. */
function alarms(cal: JComp): (number | string)[] {
	const v = cal[2].find((c) => c[0] === "vevent") as JComp;
	return v[2]
		.filter((c) => c[0] === "valarm")
		.map((a) => {
			const t = a[1].find((p) => p[0] === "trigger");
			return t?.[2] === "duration" ? Math.round(-Number(/PT(\d+)M/.exec(String(t[3]))?.[1] ?? 0)) * -1 : String(t?.[3]);
		});
}

beforeEach(async () => {
	s = setup();
	await resetTokens();
	s.cal.home(QA.a);
});
afterEach(() => vi.restoreAllMocks());

const stored = (obj: string) => s.cal.get(QA.a, "personal", obj)?.jcal as JComp;

describe("setReminder", () => {
	it("changes the first reminder before the start in place and keeps the others", () => {
		const v: JComp = ["vevent", [], [alarm(before(15), "AUDIO"), alarm(before(60)), alarm(fixedAt("2030-11-05T08:00:00Z"))]];
		expect(setReminder(v, 10, "Plan")).toEqual({ before: 15, notes: [] });
		expect(reminderOf(v)).toBe(10);
		expect(v[2]).toHaveLength(3);
		expect(v[2][0]?.[1].find((p) => p[0] === "action")?.[3]).toBe("AUDIO");
		const n = setReminder(v, null, "Plan");
		expect(n.before).toBe(10);
		expect(n.notes).toEqual([
			"This event had 2 reminders before its start; the undo puts back only the first one (10 minutes before).",
			"1 other reminder (at a set time, or after the start) stays; NoCalendar can change it.",
		]);
		expect(v[2]).toHaveLength(1);
		expect(reminderOf(v)).toBeNull();
	});
});

describe("calendar_update_event: reminder undo", () => {
	it("15 and 60 minutes, changed to 10: the undo gives back 15 and 60", async () => {
		s.cal.put(QA.a, "personal", "two.ics", vevent("two", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z", [], [alarm(before(15)), alarm(before(60))]));
		const r = await callTool("calendar_update_event", { event_id: "personal/two.ics", reminder_minutes_before: 10 });
		expect(r.isError).toBeFalsy();
		expect(alarms(stored("two.ics"))).toEqual([10, 60]);
		expect(r.structuredContent.warnings).toBeUndefined();
		const undo = r.structuredContent.undo as { tool: string; arguments: Record<string, unknown> };
		expect(undo.arguments.reminder_minutes_before).toBe(15);
		expect((await callTool(undo.tool, undo.arguments)).isError).toBeFalsy();
		expect(alarms(stored("two.ics"))).toEqual([15, 60]);
	});

	it("only a reminder at a fixed time, then 10 minutes: the undo takes the new one away and keeps the fixed one", async () => {
		s.cal.put(QA.a, "personal", "abs.ics", vevent("abs", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z", [], [alarm(fixedAt("2030-11-05T08:00:00Z"))]));
		const r = await callTool("calendar_update_event", { event_id: "personal/abs.ics", reminder_minutes_before: 10 });
		expect(alarms(stored("abs.ics"))).toEqual(["2030-11-05T08:00:00Z", 10]);
		const undo = r.structuredContent.undo as { tool: string; arguments: Record<string, unknown> };
		expect(undo.arguments.reminder_minutes_before).toBeNull();
		expect((await callTool(undo.tool, undo.arguments)).isError).toBeFalsy();
		expect(alarms(stored("abs.ics"))).toEqual(["2030-11-05T08:00:00Z"]);
	});

	it("removing two reminders says the undo brings back only the first", async () => {
		s.cal.put(QA.a, "personal", "rm.ics", vevent("rm", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z", [], [alarm(before(15)), alarm(before(60))]));
		const r = await callTool("calendar_update_event", { event_id: "personal/rm.ics", reminder_minutes_before: null });
		expect(alarms(stored("rm.ics"))).toEqual([]);
		expect(r.structuredContent.warnings).toEqual(["This event had 2 reminders before its start; the undo puts back only the first one (15 minutes before)."]);
		expect((r.structuredContent.undo as { arguments: Record<string, unknown> }).arguments.reminder_minutes_before).toBe(15);
	});
});
