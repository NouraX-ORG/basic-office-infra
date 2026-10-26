/** Contract tests for the NoGantt task tools against the fake (DESIGN 17.3 and 25.3). */
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

describe("gantt_my_tasks", () => {
	it("says plainly when no NoGantt person is linked to the account", async () => {
		const r = await tool("gantt_my_tasks", {});
		const d = TASK_OUTPUTS.gantt_my_tasks.parse(r.structuredContent);
		expect(d.linked).toBe(false);
		expect(d.tasks).toEqual([]);
		expect(d.note).toContain("Resources");
	});
	it("lists assigned tasks, filtered, and asks NoGantt for done ones only when wanted", async () => {
		g.myTasks.set(QA.a, [design.id, build.id]);
		build.status = "done";
		fake.requests.length = 0;
		const r = await tool("gantt_my_tasks", {});
		const call = fake.driveCalls().find((c) => c.url.pathname.endsWith("/my-tasks"));
		expect(call?.url.searchParams.get("include_done")).toBeNull();
		expect(call?.url.searchParams.get("limit")).toBe("500");
		const d = TASK_OUTPUTS.gantt_my_tasks.parse(r.structuredContent);
		expect(d.tasks.map((t) => t.title)).toEqual(["Design"]);
		expect(d.tasks[0]).toMatchObject({ project_id: p.id, project_title: "Plan", start: "2026-11-02", end: "2026-11-06", status: "not_started" });
		const all = await tool("gantt_my_tasks", { include_done: true, due_before: "2026-11-10" });
		expect(all.structuredContent.tasks.map((t: { title: string }) => t.title)).toEqual(["Design"]);
		expect(errCode(await tool("gantt_my_tasks", { due_before: "11/10/2026" }))).toBe("invalid_input");
	});
});

describe("gantt_add_task", () => {
	it("posts the task with its links and reports a move caused by them", async () => {
		fake.requests.length = 0;
		const r = await tool("gantt_add_task", {
			project_id: p.id,
			title: "Test",
			start_date: "2026-11-03",
			end_date: "2026-11-04",
			notes: "Check it",
			status: "in_progress",
			progress: 10,
			depends_on: [{ after_task_id: build.id, lag_days: 1 }],
		});
		expect(r.isError).toBeFalsy();
		expect(body("POST", `/projects/${p.id}/tasks`)).toEqual({
			title: "Test",
			start_date: "2026-11-03",
			end_date: "2026-11-04",
			description: "Check it",
			status: "in_progress",
			manual_progress: 10,
			dependencies: [{ predecessor_id: `t-${build.id}`, dependency_type: "EA", lag_days: 1 }],
		});
		const d = TASK_OUTPUTS.gantt_add_task.parse(r.structuredContent);
		expect(d.moved_by_links).toBe(true);
		expect(d.task.start).toBe("2026-11-15");
		// No tool deletes a task (DESIGN 25.6), so adding one has no undo.
		expect(r.structuredContent.undo).toBeNull();
	});
	it("refuses bad input locally and maps NoGantt's refusals", async () => {
		fake.requests.length = 0;
		const bad = [
			{ project_id: p.id, title: "x", start_date: "2026-11-05", end_date: "2026-11-04" },
			{ project_id: p.id, title: "x", start_date: "2026-11-05", end_date: "2026-11-06", depends_on: [{}] },
			{ project_id: p.id, title: "x", start_date: "2026-11-05", end_date: "2026-11-06", depends_on: [{ after_task_id: 1, after_milestone_id: 2 }] },
			{ project_id: p.id, title: "x", start_date: "2026-11-05", end_date: "2026-11-06", progress: 101 },
			{ project_id: p.id, title: "x", start_date: "2026-11-05", end_date: "2026-11-06", status: "finished" },
		];
		for (const b of bad) expect(errCode(await tool("gantt_add_task", b)), JSON.stringify(b)).toBe("invalid_input");
		expect(ganttCalls(fake)).toEqual([]);
		const r = await tool("gantt_add_task", { project_id: p.id, title: "x", start_date: "2026-11-05", end_date: "2026-11-06", depends_on: [{ after_task_id: 999999 }] });
		expect(errCode(r)).toBe("invalid_input");
		expect(r.content[0]?.text).toContain("isn't in this project");
	});
	it("refuses a viewer with permission_denied, and someone who can't see the project with not_found", async () => {
		const other = g.addProject(QA.b);
		g.shares.set(5, { id: 5, project_id: other.id, principal_id: QA.a, principal_type: "user", permission: "viewer" });
		const r = await tool("gantt_add_task", { project_id: other.id, title: "x", start_date: "2026-11-05", end_date: "2026-11-06" });
		expect(errCode(r)).toBe("permission_denied");
		const hidden = g.addProject(QA.b);
		const h = await tool("gantt_add_task", { project_id: hidden.id, title: "x", start_date: "2026-11-05", end_date: "2026-11-06" });
		expect(errCode(h)).toBe("not_found");
		expect(h.content[0]?.text).toContain(`There's no project ${hidden.id} that this person can see.`);
		expect([...g.tasks.values()].some((t) => t.project_id === hidden.id || t.project_id === other.id)).toBe(false);
	});
});

describe("gantt_update_task and gantt_undo_change", () => {
	it("moves a task, lists the tasks it pushed, and undoes the whole move", async () => {
		build.deps.push({ id: 1, task_id: build.id, predecessor_id: `t-${design.id}`, dependency_type: "EA", lag_days: 0 });
		const r = await tool("gantt_update_task", { project_id: p.id, task_id: design.id, start_date: "2026-11-09", end_date: "2026-11-13" });
		expect(r.isError).toBeFalsy();
		expect(body("PUT", `/tasks/${design.id}`)).toEqual({ start_date: "2026-11-09", end_date: "2026-11-13" });
		const d = TASK_OUTPUTS.gantt_update_task.parse(r.structuredContent);
		expect(d.task).toMatchObject({ start: "2026-11-09", end: "2026-11-13" });
		expect(d.moved).toEqual([{ task_id: build.id, title: "Build", start: "2026-11-14", end: "2026-11-18" }]);
		expect(d.previous).toEqual({ start_date: "2026-11-02", end_date: "2026-11-06" });
		const undo = r.structuredContent.undo as { tool: string; arguments: { op_id: string } };
		expect(undo.tool).toBe("gantt_undo_change");
		const u = await tool("gantt_undo_change", undo.arguments);
		const ud = TASK_OUTPUTS.gantt_undo_change.parse(u.structuredContent);
		expect(ud.reverted_entries).toBe(4);
		expect(ud.kinds).toEqual(["task dates"]);
		expect(g.tasks.get(design.id)?.start_date).toBe("2026-11-02 00:00:00");
		expect(g.tasks.get(build.id)?.start_date).toBe("2026-11-09 00:00:00");
		// NoGantt keeps the change: taking it back again is a conflict, in words that say why (DESIGN 25.9).
		const again = await tool("gantt_undo_change", undo.arguments);
		expect(errCode(again)).toBe("conflict");
		expect(again.content[0]?.text).toContain("or the change was taken back already");
	});
	it("gives the old values as undo when nothing moved, and clears notes with null", async () => {
		design.description = "Old notes";
		const r = await tool("gantt_update_task", { project_id: p.id, task_id: design.id, title: "Design 2", notes: null, status: "blocked", progress: 40 });
		expect(body("PUT", `/tasks/${design.id}`)).toEqual({ title: "Design 2", description: "", status: "blocked", manual_progress: 40 });
		expect(r.structuredContent.undo).toEqual({ tool: "gantt_update_task", arguments: { project_id: p.id, task_id: design.id, title: "Design", notes: "Old notes", status: "not_started", progress: 0 } });
		expect(r.structuredContent.task).toMatchObject({ title: "Design 2", notes: null, status: "blocked", progress: 40 });
	});
	it("replaces links with depends_on, refuses loops and a task waiting for itself", async () => {
		const r = await tool("gantt_update_task", { project_id: p.id, task_id: build.id, depends_on: [{ after_task_id: design.id, type: "start_to_start" }] });
		expect(body("PUT", `/tasks/${build.id}`).dependencies).toEqual([{ predecessor_id: `t-${design.id}`, dependency_type: "AA", lag_days: 0 }]);
		expect(r.structuredContent.previous).toEqual({ depends_on: [] });
		const loop = await tool("gantt_update_task", { project_id: p.id, task_id: design.id, depends_on: [{ after_task_id: build.id }] });
		expect(errCode(loop)).toBe("invalid_input");
		expect(loop.content[0]?.text).toContain("loop");
		expect(errCode(await tool("gantt_update_task", { project_id: p.id, task_id: design.id, depends_on: [{ after_task_id: design.id }] }))).toBe("invalid_input");
	});
	it("checks the task belongs to the project, and refuses empty changes and end before start", async () => {
		const other = g.addProject(QA.a);
		const t = g.addTask(other.id);
		fake.requests.length = 0;
		expect(errCode(await tool("gantt_update_task", { project_id: p.id, task_id: t.id, title: "x" }))).toBe("not_found");
		expect(errCode(await tool("gantt_update_task", { project_id: p.id, task_id: design.id }))).toBe("invalid_input");
		expect(errCode(await tool("gantt_update_task", { project_id: p.id, task_id: design.id, end_date: "2026-11-01" }))).toBe("invalid_input");
		expect(fake.driveCalls().some((c) => c.method === "PUT")).toBe(false);
	});
	it("says when linked cards wait for confirmation, and confirms them with update_board_cards", async () => {
		p.deck_board_id = 21;
		p.deck_sync_level = "write_confirm";
		design.deck_cards.push(77);
		const r = await tool("gantt_update_task", { project_id: p.id, task_id: design.id, end_date: "2026-11-07" });
		expect(r.structuredContent.board).toEqual({ cards_updated: 0, cards_failed: 0, cards_kept_their_dates: 0, cards_gone: 0, waiting_for_confirmation: 1 });
		expect(r.structuredContent.warnings[0]).toContain("update_board_cards");
		const c = await tool("gantt_update_task", { project_id: p.id, task_id: design.id, end_date: "2026-11-08", update_board_cards: true });
		expect(body("PUT", `/tasks/${design.id}`)).toMatchObject({ deck_confirmed: true });
		expect(c.structuredContent.board).toEqual({ cards_updated: 1, cards_failed: 0, cards_kept_their_dates: 0, cards_gone: 0, waiting_for_confirmation: 0 });
	});
	it("doesn't change notes or a title it couldn't put back, and leaves unreadable old dates out of the undo", async () => {
		design.description = `Long ${"x".repeat(10_000)}`;
		fake.requests.length = 0;
		const long = await tool("gantt_update_task", { project_id: p.id, task_id: design.id, notes: "Short" });
		expect(errCode(long)).toBe("too_large");
		expect(long.content[0]?.text).toContain("couldn't be undone");
		expect(long._meta?.["nourax/error"]?.field).toBe("notes");
		expect(fake.driveCalls().some((c) => c.method === "PUT")).toBe(false);
		// Other fields of the same task still change; the long notes aren't copied into the result.
		const status = await tool("gantt_update_task", { project_id: p.id, task_id: design.id, status: "blocked" });
		expect(status.isError).toBeFalsy();
		expect(status.structuredContent.previous).toEqual({ status: "not_started" });
		expect(status.structuredContent.task.notes.length).toBeLessThanOrEqual(300);
		// Notes up to 10,000 characters come back whole as the undo, exactly as NoGantt holds them.
		build.description = `Made in NoGantt ${"y".repeat(9_000)}`;
		const ok = await tool("gantt_update_task", { project_id: p.id, task_id: build.id, notes: null });
		expect(ok.structuredContent.undo.arguments.notes).toBe(`Made in NoGantt ${"y".repeat(9_000)}`);
		expect(ok.structuredContent.previous.notes).toBe(ok.structuredContent.undo.arguments.notes);
		// Notes that would be shown changed (NoGantt's own name in them) aren't changed here (DESIGN 25.7).
		build.description = "Made in nc_gantt";
		const mapped = await tool("gantt_update_task", { project_id: p.id, task_id: build.id, notes: "New" });
		expect(errCode(mapped)).toBe("not_available");
		expect(mapped.content[0]?.text).toContain("couldn't be undone");
		expect(build.description).toBe("Made in nc_gantt");
		// A date NoGantt sent in an odd form reads as null; the undo leaves it out and says so.
		build.start_date = "09.11.2026";
		fake.on("PUT", /\/nc_gantt\/api\/v1\/tasks\/\d+$/, () => Response.json({ ocs: { meta: { status: "ok", statuscode: 200, message: "OK" }, data: { task: g.taskJson(build), propagated: [], op_id: null, deck: {} } } }));
		const odd = await tool("gantt_update_task", { project_id: p.id, task_id: build.id, start_date: "2026-11-10", status: "in_progress" });
		expect(odd.isError).toBeFalsy();
		expect(odd.structuredContent.undo).toEqual({ tool: "gantt_update_task", arguments: { project_id: p.id, task_id: build.id, status: "not_started" } });
		expect(odd.structuredContent.warnings.join(" ")).toContain("start_date couldn't be read back");
	});
	it("says that an undo also wrote the old dates back into linked NoBoard cards", async () => {
		p.deck_board_id = 21;
		p.deck_sync_level = "write_silent";
		design.deck_cards.push(77);
		const r = await tool("gantt_update_task", { project_id: p.id, task_id: design.id, end_date: "2026-11-07", update_board_cards: true });
		const u = await tool("gantt_undo_change", r.structuredContent.undo.arguments);
		const d = TASK_OUTPUTS.gantt_undo_change.parse(u.structuredContent);
		expect(d.board).toEqual({ cards_updated: 1, cards_failed: 0, cards_kept_their_dates: 0, cards_gone: 0, waiting_for_confirmation: 0 });
		expect(u.structuredContent.warnings[0]).toContain("1 linked NoBoard card");
		expect(d.task_ids_total).toBe(1);
	});
	it("refuses a malformed undo id locally and maps a conflict", async () => {
		fake.requests.length = 0;
		expect(errCode(await tool("gantt_undo_change", { op_id: "../../projects/1" }))).toBe("invalid_input");
		expect(ganttCalls(fake)).toEqual([]);
		fake.on("POST", /\/changes\/[0-9a-f-]{36}\/revert$/, () => new Response(JSON.stringify({ ocs: { meta: { statuscode: 409, message: "conflict" }, data: [] } }), { status: 409 }));
		const r = await tool("gantt_undo_change", { op_id: "00000000-0000-4000-8000-0000000000cd" });
		expect(errCode(r)).toBe("conflict");
		expect(r.content[0]?.text).toContain("changed again");
	});
});
