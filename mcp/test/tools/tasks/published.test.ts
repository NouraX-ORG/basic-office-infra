/**
 * Fix round 4: a task list published by link shows its tasks to anyone with the link (NC 35.0.2
 * PublicCalendar hides only CLASS:PRIVATE objects), so writing a task there is sharing it. Without
 * workspace.share tasks_create, tasks_set_due_date and tasks_complete refuse it (nothing is written)
 * and tasks_create passes such a list over as the default; with it they go ahead and say so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JComp } from "../../../src/pim/jcal";
import { calCalls, callTool, errCode, propOf, QA, resetTokens, type Setup, setup, vtodo } from "../calendar/_helpers";

const NO_SHARE = ["workspace.read", "workspace.write", "workspace.remove"];
const LINK = "https://drive.nourax.org/remote.php/dav/public-calendars/ABCDEFGH12345678";
let s: Setup;
beforeEach(async () => {
	s = setup();
	await resetTokens();
	s.cal.home(QA.a);
	// The person's first own list that takes tasks is published; "quiet" isn't.
	s.cal.home(QA.a).delete("personal");
	s.cal.addCalendar(QA.a, { uri: "open", displayname: "Open list", comps: ["VEVENT", "VTODO"], order: 0, publishUrl: LINK });
	s.cal.addCalendar(QA.a, { uri: "quiet", displayname: "Quiet list", comps: ["VTODO"], order: 1 });
	s.cal.put(QA.a, "open", "fresh.ics", vtodo("fresh", [["status", {}, "text", "NEEDS-ACTION"]]));
});
afterEach(() => vi.restoreAllMocks());

const stored = (obj: string) => s.cal.get(QA.a, "open", obj)?.jcal as JComp;

describe("a task list published by link", () => {
	it("tasks_create with list_id of a published list is refused without workspace.share, and nothing is written", async () => {
		s.fake.requests.length = 0;
		const r = await callTool("tasks_create", { title: "Salary review", notes: "private", list_id: "open" }, { scopes: NO_SHARE });
		expect(errCode(r)).toBe("not_available");
		expect(r.content[0]?.text).toBe(
			"That task list is published by link, and this connection can't share, so nothing was written there. Choose another list (tasks_list shows them), or reconnect with sharing allowed.",
		);
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
	});

	it("tasks_create without list_id passes the published list over for the next own one", async () => {
		const r = await callTool("tasks_create", { title: "Salary review" }, { scopes: NO_SHARE });
		expect(r.isError).toBeFalsy();
		expect((r.structuredContent?.task as { task_id: string }).task_id.startsWith("quiet/")).toBe(true);
		expect(r.structuredContent?.warnings).toBeUndefined();
	});

	it("tasks_create without list_id is refused when every own list is published, and makes no list", async () => {
		s.cal.home(QA.a).delete("quiet");
		s.fake.requests.length = 0;
		const r = await callTool("tasks_create", { title: "Salary review" }, { scopes: NO_SHARE });
		expect(errCode(r)).toBe("not_available");
		expect(r.content[0]?.text).toContain("This person's own task lists are published by link");
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
		expect(calCalls(s.fake, "MKCOL")).toHaveLength(0);
	});

	it("with workspace.share the first own list is used as before, with a warning that anyone with the link sees it", async () => {
		const r = await callTool("tasks_create", { title: "Open day" });
		expect(r.isError).toBeFalsy();
		expect((r.structuredContent?.task as { task_id: string }).task_id.startsWith("open/")).toBe(true);
		expect(r.structuredContent?.warnings).toEqual(["That task list is published by link, so anyone with the link can see this task."]);
		const chosen = await callTool("tasks_create", { title: "Open day 2", list_id: "open" });
		expect(chosen.structuredContent?.warnings).toEqual(["That task list is published by link, so anyone with the link can see this task."]);
	});

	it("tasks_set_due_date and tasks_complete there are refused without workspace.share; nothing is written", async () => {
		s.fake.requests.length = 0;
		const due = await callTool("tasks_set_due_date", { task_id: "open/fresh.ics", due: "2030-11-04" }, { scopes: NO_SHARE });
		expect(errCode(due)).toBe("not_available");
		const done = await callTool("tasks_complete", { task_id: "open/fresh.ics" }, { scopes: NO_SHARE });
		expect(errCode(done)).toBe("not_available");
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
		expect(propOf(stored("fresh.ics"), "vtodo", "status")?.[3]).toBe("NEEDS-ACTION");
		// A call that changes nothing (already not done) is no write, so it isn't refused.
		const same = await callTool("tasks_complete", { task_id: "open/fresh.ics", completed: false }, { scopes: NO_SHARE });
		expect(same.isError).toBeFalsy();
	});

	it("with workspace.share they change the task and warn", async () => {
		const done = await callTool("tasks_complete", { task_id: "open/fresh.ics" });
		expect(done.isError).toBeFalsy();
		expect(done.structuredContent?.warnings).toEqual(["That task list is published by link, so anyone with the link can see this task."]);
		const due = await callTool("tasks_set_due_date", { task_id: "open/fresh.ics", due: "2030-11-04" });
		expect(due.isError).toBeFalsy();
		expect(due.structuredContent?.warnings).toEqual(["That task list is published by link, so anyone with the link can see this task."]);
	});
});
