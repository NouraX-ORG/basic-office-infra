/** Contract tests for the NoTasks tools (DESIGN 11.6 and 17.3). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCtx } from "../../../src/core/tool";
import type { JComp } from "../../../src/pim/jcal";
import { START_CHANGED_NOTE, START_UNDO_NOTE } from "../../../src/tools/tasks/todos";
import { RULES } from "../../../src/core/egress";
import { LISTS_MAKEABLE, makeTaskList } from "../../../src/tools/tasks/new-list";
import { calCalls, callTool, errCode, payload, propOf, QA, resetTokens, type Setup, setup, tokenFor, vevent, vtodo } from "../calendar/_helpers";

let s: Setup;
beforeEach(async () => {
	s = setup();
	await resetTokens();
	s.cal.home(QA.a);
	s.cal.addCalendar(QA.a, { uri: "todo", displayname: "To do", comps: ["VTODO"], order: 1 });
	s.cal.addCalendar(QA.a, { uri: "shared_by_qa-t1-92", displayname: "Their list", comps: ["VTODO"], order: 2, owner: QA.b, readOnly: true });
	s.cal.put(QA.a, "todo", "open1.ics", vtodo("open1", [["due", {}, "date", "2030-11-05"], ["priority", {}, "integer", 1], ["description", {}, "text", "Call the bank"]]));
	s.cal.put(QA.a, "todo", "open2.ics", vtodo("open2", [["due", {}, "date-time", "2030-11-03T17:00:00Z"]]));
	s.cal.put(QA.a, "todo", "nodue.ics", vtodo("nodue", [["priority", {}, "integer", 9]]));
	s.cal.put(QA.a, "todo", "done.ics", vtodo("done", [["status", {}, "text", "COMPLETED"], ["completed", {}, "date-time", "2030-10-01T10:00:00Z"], ["percent-complete", {}, "integer", 100]]));
	s.cal.put(QA.a, "todo", "cancelled.ics", vtodo("cancelled", [["status", {}, "text", "CANCELLED"]]));
	s.cal.put(QA.a, "shared_by_qa-t1-92", "theirs.ics", vtodo("theirs", [["due", {}, "date", "2030-11-04"]]));
	s.cal.put(QA.a, "personal", "ev.ics", vevent("ev", "2030-11-05T10:00:00Z", "2030-11-05T11:00:00Z"));
});
afterEach(() => vi.restoreAllMocks());

const stored = (list: string, obj: string) => s.cal.get(QA.a, list, obj)?.jcal as JComp;
const ids = (r: { structuredContent: Record<string, unknown> }) => (r.structuredContent.tasks as { task_id: string }[]).map((t) => t.task_id);

describe("tasks_list", () => {
	it("asks each task list for VTODOs without COMPLETED, and lists open tasks, earliest due first", async () => {
		s.fake.requests.length = 0;
		const r = await callTool("tasks_list");
		expect(r.isError).toBeFalsy();
		const reports = calCalls(s.fake, "REPORT");
		expect(reports.map((c) => c.url.pathname).sort()).toEqual([`/remote.php/dav/calendars/${QA.a}/personal/`, `/remote.php/dav/calendars/${QA.a}/shared_by_qa-t1-92/`, `/remote.php/dav/calendars/${QA.a}/todo/`].sort());
		expect(reports[0]?.body).toContain('<cal:comp-filter name="VTODO"><cal:prop-filter name="COMPLETED"><cal:is-not-defined/>');
		expect(ids(r)).toEqual(["todo/open2.ics", "shared_by_qa-t1-92/theirs.ics", "todo/open1.ics", "todo/nodue.ics"]);
		const t = (r.structuredContent.tasks as Record<string, unknown>[]).find((x) => x.task_id === "todo/open1.ics");
		expect(t).toMatchObject({ list_id: "todo", title: "Task open1", notes: "Call the bank", due: "2030-11-05", start: null, priority: "high", completed: false, completed_at: null, web_url: "https://drive.nourax.org/apps/tasks/calendars/todo/tasks/open1.ics" });
		expect((r.structuredContent.tasks as Record<string, unknown>[]).find((x) => x.task_id === "todo/open2.ics")?.due).toBe("2030-11-03T17:00:00+00:00");
		expect(r.structuredContent.lists).toEqual([
			{ list_id: "personal", name: "Personal", read_only: false },
			{ list_id: "todo", name: "To do", read_only: false },
			{ list_id: "shared_by_qa-t1-92", name: "Their list", read_only: true },
		]);
		expect(payload(r).tasks).toHaveLength(4);
	});

	it("filters by status, list, due date and text", async () => {
		expect(ids(await callTool("tasks_list", { status: "completed" }))).toEqual(["todo/done.ics"]);
		const done = (await callTool("tasks_list", { status: "completed" })).structuredContent.tasks as Record<string, unknown>[];
		expect(done[0]).toMatchObject({ completed: true, completed_at: "2030-10-01T10:00:00+00:00" });
		expect(ids(await callTool("tasks_list", { status: "all", list_id: "todo" })).sort()).toEqual(["todo/cancelled.ics", "todo/done.ics", "todo/nodue.ics", "todo/open1.ics", "todo/open2.ics"]);
		expect(ids(await callTool("tasks_list", { due_before: "2030-11-04" }))).toEqual(["todo/open2.ics", "shared_by_qa-t1-92/theirs.ics"]);
		expect(ids(await callTool("tasks_list", { due_before: "2030-11-03T17:00" }))).toEqual([]);
		expect(ids(await callTool("tasks_list", { query: "bank" }))).toEqual(["todo/open1.ics"]);
		expect(errCode(await callTool("tasks_list", { list_id: "nope" }))).toBe("not_found");
		expect(errCode(await callTool("tasks_list", { status: "late" }))).toBe("invalid_input");
	});

	it("pages with a bound cursor", async () => {
		const a = await callTool("tasks_list", { limit: 3 });
		expect(a.structuredContent.has_more).toBe(true);
		const b = await callTool("tasks_list", { limit: 3, cursor: a.structuredContent.next_cursor });
		expect(ids(b)).toEqual(["todo/nodue.ics"]);
		expect(b.structuredContent).toMatchObject({ has_more: false, next_cursor: null });
	});
});

describe("tasks_create", () => {
	it("adds a VTODO to the first own list with If-None-Match and scheduling off", async () => {
		s.fake.requests.length = 0;
		const r = await callTool("tasks_create", { title: "Pay invoice", due: "2030-11-07", start: "2030-11-04T09:00", notes: "Ref 42", priority: "low" });
		expect(r.isError).toBeFalsy();
		const put = calCalls(s.fake, "PUT")[0];
		expect(put?.url.pathname).toMatch(new RegExp(`^/remote\\.php/dav/calendars/${QA.a}/personal/[0-9a-f-]{36}\\.ics$`));
		expect(put?.headers.get("if-none-match")).toBe("*");
		expect(put?.headers.get("x-nc-scheduling")).toBe("false");
		const body = JSON.parse(put?.body ?? "null") as JComp;
		expect(propOf(body, "vtodo", "due")).toEqual(["due", {}, "date", "2030-11-07"]);
		// A timed start with a date due becomes its date (NoCalendar needs the same value type).
		expect(propOf(body, "vtodo", "dtstart")).toEqual(["dtstart", {}, "date", "2030-11-04"]);
		expect(r.structuredContent.warnings).toHaveLength(1);
		expect(propOf(body, "vtodo", "priority")?.[3]).toBe(9);
		expect(propOf(body, "vtodo", "status")?.[3]).toBe("NEEDS-ACTION");
		expect(r.structuredContent.task).toMatchObject({ list_id: "personal", title: "Pay invoice", due: "2030-11-07", priority: "low", completed: false, notes: "Ref 42" });
	});

	it("with no task list of the person's own: makes one only where core's egress rule allows it, else says so and writes nothing", async () => {
		const p = s.cal.home(QA.a);
		for (const k of [...p.keys()]) if (k !== "personal") p.delete(k);
		const personal = p.get("personal");
		if (personal) personal.comps = ["VEVENT"];
		s.fake.requests.length = 0;
		const r = await callTool("tasks_create", { title: "First" });
		if (LISTS_MAKEABLE) {
			// DESIGN 11.6: a VTODO-only list called "Tasks", made with an extended MKCOL.
			expect(r.isError).toBeFalsy();
			expect(s.fake.driveCalls().filter((c) => c.method === "MKCOL").map((c) => c.url.pathname)).toEqual([`/remote.php/dav/calendars/${QA.a}/tasks/`]);
			expect(r.structuredContent.task).toMatchObject({ list_id: "tasks" });
			return;
		}
		expect(errCode(r)).toBe("not_available");
		expect(r.content[0]?.text).toBe("This person has no task list of their own, and one can't be made from here. Make a list in NoTasks, then try again.");
		expect(s.fake.driveCalls().filter((c) => ["MKCOL", "MKCALENDAR", "PUT"].includes(c.method))).toHaveLength(0);
	});

	it("says in its description what it does for a person without a list, matching core's egress rule", async () => {
		expect(LISTS_MAKEABLE).toBe(RULES.some((r) => r.id === "dav-calendars" && r.methods.includes("MKCOL")));
		const { createTask } = await import("../../../src/tools/tasks/create");
		const d = (createTask as unknown as { description: string }).description;
		if (LISTS_MAKEABLE) expect(d).toContain('a list called "Tasks" is made when they have none');
		else expect(d).toContain("a person with no list needs one made in NoTasks first");
	});

	it("never writes into a list shared with the person unless list_id names it (review fix round 1)", async () => {
		const p = s.cal.home(QA.a);
		for (const k of [...p.keys()]) if (k !== "personal") p.delete(k);
		const personal = p.get("personal");
		if (personal) personal.comps = ["VEVENT"];
		s.cal.addCalendar(QA.a, { uri: "team_shared_by_qa-t1-92", displayname: "Team list", comps: ["VTODO"], order: 3, owner: QA.b });
		s.fake.requests.length = 0;
		const r = await callTool("tasks_create", { title: "Private note" });
		if (LISTS_MAKEABLE) {
			// Since fix round 3 the egress rule allows the MKCOL: the task goes to a new list of the
			// person's own, never to the shared one.
			expect(r.isError).toBeFalsy();
			expect(r.structuredContent.task).toMatchObject({ list_id: "tasks" });
		} else {
			expect(errCode(r)).toBe("not_available");
			expect(r.content[0]?.text).toBe(
				"This person has no task list of their own, and one can't be made from here. Make a list in NoTasks, or give list_id for a list shared with them (tasks_list shows the lists).",
			);
			expect(calCalls(s.fake, "PUT")).toHaveLength(0);
		}
		expect(s.cal.home(QA.a).get("team_shared_by_qa-t1-92")?.objects.size).toBe(0);
		// Named on purpose, the shared list is used, and the summary says whose list it is.
		const named = await callTool("tasks_create", { title: "For the team", list_id: "team_shared_by_qa-t1-92" });
		expect(named.isError).toBeFalsy();
		expect(named.structuredContent.task).toMatchObject({ list_id: "team_shared_by_qa-t1-92" });
		expect(named.content[0]?.text.split("\n")[0]).toBe("Created a task in a list shared with the person.");
	});

	it("prefers the person's own list over a writable shared one that comes first", async () => {
		s.cal.addCalendar(QA.a, { uri: "a_shared_by_qa-t1-92", displayname: "AAA shared", comps: ["VTODO"], order: -5, owner: QA.b });
		const r = await callTool("tasks_create", { title: "Mine" });
		expect(r.structuredContent.task).toMatchObject({ list_id: "personal" });
	});

	it("builds the list with an extended MKCOL: VTODO only, named Tasks, in cobalt, trying the next name when one is taken", async () => {
		const sent: { path: string; body: string }[] = [];
		const ctx = {
			uid: QA.a,
			nc: {
				dav: {
					mkcol: async (path: string, body: string) => {
						sent.push({ path, body });
						return new Response(null, { status: sent.length === 1 ? 405 : 201 });
					},
				},
			},
		} as unknown as ToolCtx;
		expect(await makeTaskList(ctx, new Set(["personal"]), true)).toBe("tasks-2");
		expect(sent.map((x) => x.path)).toEqual([`/remote.php/dav/calendars/${QA.a}/tasks/`, `/remote.php/dav/calendars/${QA.a}/tasks-2/`]);
		const body = sent[0]?.body ?? "";
		expect(body).toMatch(/^<\?xml version="1.0" encoding="utf-8"\?><d:mkcol /);
		expect(body).toContain("<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>");
		expect(body).toContain('<cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>');
		expect(body).toContain("<d:displayname>Tasks</d:displayname>");
		expect(body).toContain("#2563EB");
		expect(body).not.toContain("VEVENT");
		await expect(makeTaskList(ctx, new Set(), false)).rejects.toMatchObject({ code: "not_available" });
	});

	it("keeps duplicates out unless asked, and refuses bad input and read-only lists", async () => {
		const token = await tokenFor(QA.a);
		const a = await callTool("tasks_create", { title: "Same", list_id: "todo" }, { token });
		const b = await callTool("tasks_create", { title: "Same", list_id: "todo" }, { token });
		expect((b.structuredContent.task as { task_id: string }).task_id).toBe((a.structuredContent.task as { task_id: string }).task_id);
		expect(errCode(await callTool("tasks_create", { title: "X", start: "2030-11-08", due: "2030-11-07" }))).toBe("invalid_input");
		expect(errCode(await callTool("tasks_create", { title: "X", due: "soon" }))).toBe("invalid_input");
		expect(errCode(await callTool("tasks_create", { title: "X", list_id: "shared_by_qa-t1-92" }))).toBe("permission_denied");
		expect(errCode(await callTool("tasks_create", { title: "X", priority: "urgent" }))).toBe("invalid_input");
	});
});

describe("start and due share a value type (NoCalendar refuses a mix)", () => {
	it("tasks_create writes a date start as midnight when the due has a time, and says so", async () => {
		const r = await callTool("tasks_create", { title: "Mixed", list_id: "todo", start: "2030-11-02", due: "2030-11-03T16:30" });
		expect(r.isError).toBeFalsy();
		const put = calCalls(s.fake, "PUT").pop();
		const body = JSON.parse(put?.body ?? "null") as JComp;
		expect(propOf(body, "vtodo", "dtstart")).toEqual(["dtstart", {}, "date-time", "2030-11-02T00:00:00Z"]);
		expect(r.structuredContent.warnings).toEqual([START_CHANGED_NOTE]);
		expect(r.structuredContent.task).toMatchObject({ start: "2030-11-02T00:00:00+00:00", due: "2030-11-03T16:30:00+00:00" });
	});
	it("tasks_set_due_date turns a timed start into its date when the new due is a date", async () => {
		s.cal.put(QA.a, "todo", "timed.ics", vtodo("timed", [["dtstart", {}, "date-time", "2030-11-02T09:00:00Z"], ["due", {}, "date-time", "2030-11-03T09:00:00Z"]]));
		const r = await callTool("tasks_set_due_date", { task_id: "todo/timed.ics", due: "2030-11-04" });
		expect(r.isError).toBeFalsy();
		expect(propOf(stored("todo", "timed.ics"), "vtodo", "dtstart")).toEqual(["dtstart", {}, "date", "2030-11-02"]);
		// The undo puts back the due date only; the warnings say the start keeps its new form.
		expect(r.structuredContent.warnings).toEqual([START_CHANGED_NOTE, START_UNDO_NOTE]);
		expect(r.structuredContent.undo).toEqual({ tool: "tasks_set_due_date", arguments: { task_id: "todo/timed.ics", due: "2030-11-03T09:00:00+00:00" } });
	});
	it("maps NoCalendar's validation refusal (415) to a plain invalid_input", async () => {
		s.fake.on("PUT", /^\/remote\.php\/dav\/calendars\//, () => new Response("<s:message>Validation error in iCalendar</s:message>", { status: 415 }));
		const r = await callTool("tasks_create", { title: "Bad", list_id: "todo" });
		expect(errCode(r)).toBe("invalid_input");
		expect(r.content[0]?.text).toBe("NoCalendar refused that change as invalid.");
	});
});

describe("tasks_complete", () => {
	it("sets STATUS, PERCENT-COMPLETE and COMPLETED with If-Match, and undoes", async () => {
		const etag = s.cal.get(QA.a, "todo", "open1.ics")?.etag;
		s.fake.requests.length = 0;
		const r = await callTool("tasks_complete", { task_id: "todo/open1.ics" });
		expect(calCalls(s.fake, "PUT")[0]?.headers.get("if-match")).toBe(etag);
		const t = stored("todo", "open1.ics");
		expect(propOf(t, "vtodo", "status")?.[3]).toBe("COMPLETED");
		expect(propOf(t, "vtodo", "percent-complete")?.[3]).toBe(100);
		expect(String(propOf(t, "vtodo", "completed")?.[3])).toMatch(/Z$/);
		expect(r.structuredContent).toMatchObject({ task: { completed: true }, undo: { tool: "tasks_complete", arguments: { task_id: "todo/open1.ics", completed: false } } });
		const back = await callTool("tasks_complete", { task_id: "todo/open1.ics", completed: false });
		expect(propOf(stored("todo", "open1.ics"), "vtodo", "completed")).toBeUndefined();
		expect(back.structuredContent.task).toMatchObject({ completed: false });
		s.fake.requests.length = 0;
		const same = await callTool("tasks_complete", { task_id: "todo/open1.ics", completed: false });
		expect(same.content[0]?.text.split("\n")[0]).toBe("The task was already not done; nothing changed.");
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
	});

	it("refuses read-only lists, events and bad ids", async () => {
		expect(errCode(await callTool("tasks_complete", { task_id: "shared_by_qa-t1-92/theirs.ics" }))).toBe("permission_denied");
		expect(errCode(await callTool("tasks_complete", { task_id: "personal/ev.ics" }))).toBe("not_found");
		expect(errCode(await callTool("tasks_complete", { task_id: "todo/../x.ics" }))).toBe("invalid_input");
		expect(errCode(await callTool("tasks_complete", { task_id: "todo/missing.ics" }))).toBe("not_found");
	});
});

describe("tasks_set_due_date", () => {
	it("sets a date, a time, and clears it, each with an undo", async () => {
		const a = await callTool("tasks_set_due_date", { task_id: "todo/open1.ics", due: "2030-11-20T15:30" });
		expect(propOf(stored("todo", "open1.ics"), "vtodo", "due")).toEqual(["due", {}, "date-time", "2030-11-20T15:30:00Z"]);
		expect(a.structuredContent).toMatchObject({ task: { due: "2030-11-20T15:30:00+00:00" }, undo: { tool: "tasks_set_due_date", arguments: { task_id: "todo/open1.ics", due: "2030-11-05" } } });
		const b = await callTool("tasks_set_due_date", { task_id: "todo/open1.ics", due: null });
		expect(propOf(stored("todo", "open1.ics"), "vtodo", "due")).toBeUndefined();
		expect(b.structuredContent).toMatchObject({ task: { due: null }, undo: { arguments: { due: "2030-11-20T15:30:00+00:00" } } });
		const c = await callTool("tasks_set_due_date", { task_id: "todo/open1.ics", due: "2030-12-01" });
		expect(propOf(stored("todo", "open1.ics"), "vtodo", "due")).toEqual(["due", {}, "date", "2030-12-01"]);
		expect(c.structuredContent.undo).toEqual({ tool: "tasks_set_due_date", arguments: { task_id: "todo/open1.ics", due: null } });
	});

	it("refuses a due date before the start", async () => {
		s.cal.put(QA.a, "todo", "started.ics", vtodo("started", [["dtstart", {}, "date", "2030-11-10"]]));
		const r = await callTool("tasks_set_due_date", { task_id: "todo/started.ics", due: "2030-11-09" });
		expect(errCode(r)).toBe("invalid_input");
		expect(r._meta?.["nourax/error"]?.field).toBe("due");
		expect(errCode(await callTool("tasks_set_due_date", { task_id: "todo/started.ics" }))).toBe("invalid_input");
	});
});
