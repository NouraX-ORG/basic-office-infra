/** Contract tests for gantt_link_tasks and gantt_add_milestone against the fake, and writes on projects the person can't see (DESIGN 17.3, 25.1 and 25.3). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_OUTPUTS } from "../../../src/tools/gantt/tasks";
import type { FakeGantt, GProject, GTask } from "../../fake-nc/gantt";
import type { FakeNc } from "../../fake-nc/index";
import { errCode, ganttCalls, QA, setup, token, tool } from "./_helpers";

let fake: FakeNc;
let g: FakeGantt;
let p: GProject;
let design: GTask;
let build: GTask;
beforeEach(() => {
	({ fake, g } = setup());
	p = g.addProject(QA.a, { title: "Plan" });
	design = g.addTask(p.id, { title: "Design", start_date: "2026-11-02 00:00:00", end_date: "2026-11-06 00:00:00" });
	build = g.addTask(p.id, { title: "Build", start_date: "2026-11-09 00:00:00", end_date: "2026-11-13 00:00:00" });
});
afterEach(() => vi.restoreAllMocks());

const body = (method: string, end: string) => JSON.parse(fake.driveCalls().filter((c) => c.method === method && c.url.pathname.endsWith(end)).pop()?.body ?? "null");

describe("gantt_link_tasks", () => {
	it("adds links in one call, lists moved tasks, skips existing ones and gives the undo", async () => {
		const test = g.addTask(p.id, { title: "Test", start_date: "2026-11-03 00:00:00", end_date: "2026-11-04 00:00:00" });
		const ms = g.addMilestone(p.id, { title: "Gate" });
		const r = await tool("gantt_link_tasks", {
			project_id: p.id,
			links: [
				{ task_id: build.id, after_task_id: design.id },
				{ task_id: test.id, after_task_id: build.id, lag_days: 2 },
				{ task_id: test.id, after_milestone_id: ms.id, type: "finish_to_finish" },
			],
		});
		expect(r.isError).toBeFalsy();
		expect(body("POST", `/projects/${p.id}/dependencies`)).toEqual({
			links: [
				{ task_id: build.id, predecessor_id: `t-${design.id}`, dependency_type: "EA", lag_days: 0 },
				{ task_id: test.id, predecessor_id: `t-${build.id}`, dependency_type: "EA", lag_days: 2 },
				{ task_id: test.id, predecessor_id: `m-${ms.id}`, dependency_type: "EE", lag_days: 0 },
			],
			deck_confirmed: false,
		});
		const d = TASK_OUTPUTS.gantt_link_tasks.parse(r.structuredContent);
		expect(d.added).toBe(3);
		expect(d.moved).toEqual([{ task_id: test.id, title: "Test", start: "2026-11-16", end: "2026-11-17" }]);
		expect(r.structuredContent.undo).toEqual({ tool: "gantt_undo_change", arguments: { op_id: d.op_id } });
		const again = await tool("gantt_link_tasks", { project_id: p.id, links: [{ task_id: build.id, after_task_id: design.id }] });
		expect(again.structuredContent).toMatchObject({ added: 0, skipped: 1, op_id: null });
		expect(again.structuredContent.undo).toBeNull();
	});
	it("refuses tasks of other projects and self-links before calling NoGantt", async () => {
		const other = g.addTask(g.addProject(QA.a).id);
		fake.requests.length = 0;
		expect(errCode(await tool("gantt_link_tasks", { project_id: p.id, links: [{ task_id: other.id, after_task_id: design.id }] }))).toBe("invalid_input");
		expect(errCode(await tool("gantt_link_tasks", { project_id: p.id, links: [{ task_id: design.id, after_task_id: design.id }] }))).toBe("invalid_input");
		expect(errCode(await tool("gantt_link_tasks", { project_id: p.id, links: [] }))).toBe("invalid_input");
		expect(fake.driveCalls().some((c) => c.method === "POST")).toBe(false);
	});
	it("maps negative slack to a plain sentence without the task title", async () => {
		fake.on("POST", /\/projects\/\d+\/dependencies$/, () => new Response(JSON.stringify({ ocs: { meta: { statuscode: 400, message: "negative_float:Secret title" }, data: [] } }), { status: 400 }));
		const r = await tool("gantt_link_tasks", { project_id: p.id, links: [{ task_id: build.id, after_task_id: design.id }] });
		expect(errCode(r)).toBe("invalid_input");
		expect(r.content[0]?.text).toContain("miss a fixed milestone");
		expect(r.content[0]?.text).not.toContain("Secret title");
	});
});

describe("gantt_add_milestone", () => {
	it("adds a fixed milestone or one that follows a task's end", async () => {
		const fixed = await tool("gantt_add_milestone", { project_id: p.id, title: "Launch", date: "2026-12-18" });
		expect(body("POST", `/projects/${p.id}/milestones`)).toEqual({ title: "Launch", milestone_date: "2026-12-18" });
		expect(TASK_OUTPUTS.gantt_add_milestone.parse(fixed.structuredContent).milestone).toMatchObject({ title: "Launch", date: "2026-12-18", follows: null });
		fake.requests.length = 0;
		const follow = await tool("gantt_add_milestone", { project_id: p.id, title: "Design done", follows: { kind: "task", id: design.id } });
		expect(body("POST", `/projects/${p.id}/milestones`)).toMatchObject({ title: "Design done", task_id: design.id, dependency_type: "EA" });
		expect(follow.structuredContent.milestone).toMatchObject({ date: "2026-11-06", follows: { kind: "task", id: design.id, at: "end" } });
	});
	it("refuses unclear input", async () => {
		const bad = [
			{ project_id: p.id, title: "x" },
			{ project_id: p.id, title: "x", date: "2026-12-18", follows: { kind: "project" } },
			{ project_id: p.id, title: "x", follows: { kind: "task" } },
			{ project_id: p.id, title: "x", follows: { kind: "project", id: 3 } },
			{ project_id: p.id, title: "x", date: "18.12.2026" },
		];
		// Refused before anything reaches NoGantt, so the second person can try them (keeps the first one's per-minute count low).
		for (const b of bad) expect(errCode(await tool("gantt_add_milestone", b, { uid: QA.b })), JSON.stringify(b)).toBe("invalid_input");
	});
});

describe("writes on a project the person can't see", () => {
	it("answer the same not_found as a read and as a missing project, so project ids don't show which exist", async () => {
		const hidden = g.addProject(QA.b, { title: "Not shared" });
		const read = await tool("gantt_get_project", { project_id: hidden.id });
		const missing = await tool("gantt_add_milestone", { project_id: 999999, title: "M", date: "2026-12-01" });
		fake.requests.length = 0;
		const write = await tool("gantt_add_milestone", { project_id: hidden.id, title: "M", date: "2026-12-01" });
		expect([errCode(read), errCode(missing), errCode(write)]).toEqual(["not_found", "not_found", "not_found"]);
		const same = (r: { content: { text: string }[] }, id: number) => r.content[0]?.text.replace(String(id), "X");
		expect(same(write, hidden.id)).toBe(same(read, hidden.id));
		expect(same(write, hidden.id)).toBe(same(missing, 999999));
		// One write refused with 403, then one read of the project to tell "can't see" from "viewer".
		expect(ganttCalls(fake)).toEqual([`POST /projects/${hidden.id}/milestones`, `GET /projects/${hidden.id}`]);
		const imp = await tool("gantt_import_plan", { project_id: hidden.id, start_date: "2026-11-02", items: [{ key: "a", kind: "task", title: "A" }] });
		expect(errCode(imp)).toBe("not_found");
		expect(same(imp, hidden.id)).toBe(same(read, hidden.id));
	});
	it("still tell a viewer they need the editor role", async () => {
		const other = g.addProject(QA.b);
		g.shares.set(8, { id: 8, project_id: other.id, principal_id: QA.a, principal_type: "user", permission: "viewer" });
		const r = await tool("gantt_add_milestone", { project_id: other.id, title: "M", date: "2026-12-01" });
		expect(errCode(r)).toBe("permission_denied");
		expect(r.content[0]?.text).toContain("editor role");
	});
});

describe("moved tasks in a big plan", () => {
	it("are listed 200 at most, with the full count and a note", async () => {
		for (let i = 0; i < 230; i++) {
			const t = g.addTask(p.id, { title: `Step ${i}`, start_date: "2026-11-09 00:00:00", end_date: "2026-11-10 00:00:00" });
			t.deps.push({ id: g.id(), task_id: t.id, predecessor_id: `t-${design.id}`, dependency_type: "EA", lag_days: 0 });
		}
		const r = await tool("gantt_update_task", { project_id: p.id, task_id: design.id, end_date: "2026-11-12" });
		const d = TASK_OUTPUTS.gantt_update_task.parse(r.structuredContent);
		expect(d.moved_total).toBe(230);
		expect(d.moved).toHaveLength(200);
		expect(r.structuredContent.warnings.join(" ")).toContain("30 more moved tasks aren't listed");
		expect(r.content[0]?.text.split("\n")[0]).toContain("230 dependent tasks moved");
	});
});
