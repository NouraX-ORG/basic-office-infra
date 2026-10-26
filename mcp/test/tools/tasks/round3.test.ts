/** Fix round 3: tasks_complete says what its undo can't put back (DESIGN 27). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JComp } from "../../../src/pim/jcal";
import { undoNoteForDone, undoNoteForNotDone } from "../../../src/tools/tasks/complete";
import { callTool, propOf, QA, resetTokens, type Setup, setup, vtodo } from "../calendar/_helpers";

let s: Setup;
beforeEach(async () => {
	s = setup();
	await resetTokens();
	s.cal.home(QA.a);
	s.cal.addCalendar(QA.a, { uri: "todo", displayname: "To do", comps: ["VTODO"], order: 1 });
	s.cal.put(QA.a, "todo", "doing.ics", vtodo("doing", [["status", {}, "text", "IN-PROCESS"], ["percent-complete", {}, "integer", 40]]));
	s.cal.put(QA.a, "todo", "dropped.ics", vtodo("dropped", [["status", {}, "text", "CANCELLED"]]));
	s.cal.put(QA.a, "todo", "fresh.ics", vtodo("fresh", [["status", {}, "text", "NEEDS-ACTION"]]));
	s.cal.put(QA.a, "todo", "done.ics", vtodo("done", [["status", {}, "text", "COMPLETED"], ["completed", {}, "date-time", "2030-10-01T10:00:00Z"], ["percent-complete", {}, "integer", 100]]));
});
afterEach(() => vi.restoreAllMocks());

const stored = (obj: string) => s.cal.get(QA.a, "todo", obj)?.jcal as JComp;

describe("tasks_complete: warnings for what the undo can't rebuild", () => {
	it("a task in progress at 40%: done, with a warning that the undo gives 0%; the undo does what it says", async () => {
		const r = await callTool("tasks_complete", { task_id: "todo/doing.ics" });
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent.warnings).toEqual(["This task was in progress before (40% done); the undo marks it not done at 0%, and NoTasks can set the progress again."]);
		expect(r.structuredContent.undo).toEqual({ tool: "tasks_complete", arguments: { task_id: "todo/doing.ics", completed: false } });
		const undo = await callTool("tasks_complete", { task_id: "todo/doing.ics", completed: false });
		expect(undo.isError).toBeFalsy();
		expect(propOf(stored("doing.ics"), "vtodo", "status")?.[3]).toBe("NEEDS-ACTION");
		expect(propOf(stored("doing.ics"), "vtodo", "percent-complete")?.[3]).toBe(0);
	});

	it("a cancelled task: done, with a warning that the undo marks it not done instead", async () => {
		const r = await callTool("tasks_complete", { task_id: "todo/dropped.ics" });
		expect(r.structuredContent.warnings).toEqual(["This task was cancelled before; the undo marks it not done instead, and NoTasks can cancel it again."]);
	});

	it("a done task: not done, with a warning naming the old completion time", async () => {
		const r = await callTool("tasks_complete", { task_id: "todo/done.ics", completed: false });
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent.warnings).toEqual(["This task was marked done at 2030-10-01T10:00:00+00:00; the undo marks it done again at the time the undo runs."]);
		expect(propOf(stored("done.ics"), "vtodo", "completed")).toBeUndefined();
	});

	it("no warning when the undo puts everything back, and none when nothing changed", async () => {
		const r = await callTool("tasks_complete", { task_id: "todo/fresh.ics" });
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent).not.toHaveProperty("warnings");
		const same = await callTool("tasks_complete", { task_id: "todo/fresh.ics" });
		expect(same.structuredContent).not.toHaveProperty("warnings");
		expect(same.structuredContent.undo).toBeNull();
	});

	it("the notes themselves", () => {
		expect(undoNoteForDone("NEEDS-ACTION", 0)).toBeNull();
		expect(undoNoteForDone("", null)).toBeNull();
		expect(undoNoteForDone("IN-PROCESS", null)).toBe("This task was in progress before; the undo marks it not done at 0%, and NoTasks can set the progress again.");
		expect(undoNoteForDone("NEEDS-ACTION", 70)).toContain("(70% done)");
		expect(undoNoteForNotDone(null)).toBeNull();
	});
});
