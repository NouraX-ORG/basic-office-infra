/**
 * Lane D live cases for NoTasks (DESIGN 17.6), as the lane's QA account, in the lane's own QA task
 * list. Only tasks whose titles carry this run's id are asserted on and removed at the end (the
 * rule-3 exception).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { code, dav, ensureCollection, ORGANIZER, QA_TASKS as L, RUN_ID, token, tool, toolNames } from "../calendar/_live";

let t = "";

beforeAll(async () => {
	await ensureCollection(ORGANIZER, L, "MCP QA tasks", ["VTODO"]);
	t = await token(ORGANIZER);
});

afterAll(async () => {
	const r = await tool(t, "tasks_list", { status: "all", query: RUN_ID, limit: 200 });
	for (const x of (r.structuredContent.tasks ?? []) as { task_id: string }[]) await dav(ORGANIZER, "DELETE", `/remote.php/dav/calendars/${ORGANIZER}/${x.task_id}`);
});

type Task = Record<string, unknown> & { task_id: string };
const task = (r: { structuredContent: Record<string, unknown>; isError?: boolean; content: { text: string }[] }) => {
	if (r.isError) throw new Error(r.content[0]?.text);
	return r.structuredContent.task as Task;
};
const ids = async (args: Record<string, unknown>) => ((await tool(t, "tasks_list", { query: RUN_ID, ...args })).structuredContent.tasks as Task[]).map((x) => x.task_id);

describe("live: tasks (lane D)", () => {
	it("creates, lists, completes, re-opens and re-dates tasks", async () => {
		const names = await toolNames(t);
		for (const n of ["tasks_list", "tasks_create", "tasks_complete", "tasks_set_due_date"]) expect(names).toContain(n);

		const a = await tool(t, "tasks_create", { title: `Pay invoice ${RUN_ID}`, list_id: L, due: "2030-11-07", priority: "high", notes: "Ref 42" });
		expect(task(a)).toMatchObject({ list_id: L, due: "2030-11-07", priority: "high", completed: false, notes: "Ref 42" });
		// A date start with a timed due is refused by NoCalendar; the start is rewritten to match.
		const b = await tool(t, "tasks_create", { title: `Call back ${RUN_ID}`, list_id: L, due: "2030-11-03T16:30:00Z", start: "2030-11-02" });
		expect(task(b)).toMatchObject({ due: "2030-11-03T16:30:00+00:00", start: "2030-11-02T00:00:00+00:00" });
		expect(b.structuredContent.warnings).toHaveLength(1);
		expect(code(await tool(t, "tasks_create", { title: "x", list_id: L, start: "2030-11-09", due: "2030-11-08" }))).toBe("invalid_input");

		expect(await ids({ list_id: L })).toEqual([task(b).task_id, task(a).task_id]);
		const lists = (await tool(t, "tasks_list", { list_id: L })).structuredContent.lists as { list_id: string }[];
		expect(lists.some((x) => x.list_id === L)).toBe(true);
		expect(await ids({ list_id: L, due_before: "2030-11-04" })).toEqual([task(b).task_id]);

		const done = await tool(t, "tasks_complete", { task_id: task(a).task_id });
		expect(task(done)).toMatchObject({ completed: true });
		expect(String(task(done).completed_at)).toMatch(/^20\d\d-/);
		expect(await ids({ list_id: L })).toEqual([task(b).task_id]);
		expect(await ids({ list_id: L, status: "completed" })).toEqual([task(a).task_id]);
		const undo = done.structuredContent.undo as { tool: string; arguments: Record<string, unknown> };
		expect(task(await tool(t, undo.tool, undo.arguments))).toMatchObject({ completed: false, completed_at: null });

		const due = await tool(t, "tasks_set_due_date", { task_id: task(a).task_id, due: "2030-12-01T09:00" });
		expect(task(due).due).toBe("2030-12-01T09:00:00+00:00");
		expect((due.structuredContent.undo as { arguments: { due: string } }).arguments.due).toBe("2030-11-07");
		const cleared = await tool(t, "tasks_set_due_date", { task_id: task(a).task_id, due: null });
		expect(task(cleared).due).toBeNull();
		expect(code(await tool(t, "tasks_set_due_date", { task_id: task(b).task_id, due: "2030-11-01" }))).toBe("invalid_input");
		const toDate = await tool(t, "tasks_set_due_date", { task_id: task(b).task_id, due: "2030-11-04" });
		expect(task(toDate)).toMatchObject({ due: "2030-11-04", start: "2030-11-02" });
	});

	it("puts a task without list_id in the person's first own writable list, in listing order", async () => {
		const cals = (await tool(t, "calendar_list_calendars")).structuredContent.calendars as { calendar_id: string; holds: string[]; read_only: boolean; shared_by: unknown }[];
		const first = cals.find((c) => c.holds.includes("tasks") && !c.read_only && !c.shared_by)?.calendar_id;
		const tk = task(await tool(t, "tasks_create", { title: `Default list ${RUN_ID}` }));
		expect(tk.list_id).toBe(first);
		expect(String(tk.web_url)).toBe(`https://drive.nourax.org/apps/tasks/calendars/${first}/tasks/${tk.task_id.split("/")[1]}`);
	});

	it("refuses traversal and unknown ids plainly", async () => {
		expect(code(await tool(t, "tasks_complete", { task_id: `${L}/../x.ics` }))).toBe("invalid_input");
		expect(code(await tool(t, "tasks_complete", { task_id: `${L}/missing.ics` }))).toBe("not_found");
		expect(code(await tool(t, "tasks_list", { list_id: "no-such-list" }))).toBe("not_found");
	});
});
