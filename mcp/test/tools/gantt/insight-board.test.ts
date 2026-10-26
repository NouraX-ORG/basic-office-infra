/** Contract tests for gantt_critical_path, gantt_project_report and gantt_link_board_card (DESIGN 25.3). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_OUTPUTS } from "../../../src/tools/gantt/board";
import { INSIGHT_OUTPUTS } from "../../../src/tools/gantt/insight";
import type { FakeGantt, GProject, GTask } from "../../fake-nc/gantt";
import type { FakeNc } from "../../fake-nc/index";
import { errCode, ganttCalls, QA, setup, tool } from "./_helpers";

let fake: FakeNc;
let g: FakeGantt;
let p: GProject;
let a: GTask;
let b: GTask;
beforeEach(() => {
	({ fake, g } = setup());
	p = g.addProject(QA.a, { title: "Plan", plan_start: "2026-11-02", plan_end: "2026-12-31" });
	a = g.addTask(p.id, { title: "A", start_date: "2026-11-02 00:00:00", end_date: "2026-11-06 00:00:00" });
	b = g.addTask(p.id, { title: "B", start_date: "2026-11-09 00:00:00", end_date: "2026-11-13 00:00:00" });
});
afterEach(() => vi.restoreAllMocks());

describe("gantt_critical_path", () => {
	it("joins NoGantt's critical ids and slack with the task titles and dates", async () => {
		const c = g.addTask(p.id, { title: "C", start_date: "2026-11-03 00:00:00", end_date: "2026-11-04 00:00:00" });
		g.criticalOverride = { critical_ids: [a.id, b.id], float_map: { [`t-${a.id}`]: 0, [`t-${b.id}`]: 0, [`t-${c.id}`]: 7 }, project_duration: 10 };
		const r = await tool("gantt_critical_path", { project_id: p.id });
		const d = INSIGHT_OUTPUTS.gantt_critical_path.parse(r.structuredContent);
		expect(d.duration_working_days).toBe(10);
		expect(d.critical.map((t) => t.title)).toEqual(["A", "B"]);
		expect(d.others).toEqual([{ task_id: c.id, title: "C", start: "2026-11-03", end: "2026-11-04", slack_days: 7 }]);
		expect([d.critical_total, d.others_total]).toEqual([2, 1]);
		expect(d.note).toBeNull();
		expect(r.structuredContent.warnings).toBeUndefined();
		expect(ganttCalls(fake).sort()).toEqual([`GET /projects/${p.id}/critical-path`, `GET /projects/${p.id}/tasks`].sort());
	});
	it("lists 200 critical tasks at most, within the result, with the full counts", async () => {
		const many = Array.from({ length: 260 }, (_, i) => g.addTask(p.id, { title: `Critical ${i} ${"c".repeat(150)}` }));
		const others = Array.from({ length: 240 }, (_, i) => g.addTask(p.id, { title: `Other ${i}` }));
		g.criticalOverride = {
			critical_ids: many.map((t) => t.id),
			float_map: Object.fromEntries([...many.map((t) => [`t-${t.id}`, 0]), ...others.map((t, i) => [`t-${t.id}`, i % 9])]),
			project_duration: 300,
		};
		const r = await tool("gantt_critical_path", { project_id: p.id });
		const d = INSIGHT_OUTPUTS.gantt_critical_path.parse(r.structuredContent);
		expect(d.critical_total).toBe(260);
		expect(d.others_total).toBe(242);
		expect(d.critical.length).toBeLessThanOrEqual(200);
		expect(d.others.length).toBeLessThanOrEqual(200);
		expect(d.others[0]?.slack_days).toBe(0);
		expect(JSON.stringify(r.structuredContent).length).toBeLessThan(60_000);
		expect(r.structuredContent.warnings[0]).toContain("fit in one answer");
		expect(r.content[0]?.text).not.toContain("Cut short");
	});
	it("explains an empty project and a plan with a loop", async () => {
		const empty = g.addProject(QA.a);
		expect((await tool("gantt_critical_path", { project_id: empty.id })).structuredContent.note).toContain("no tasks");
		g.criticalOverride = { critical_ids: [], float_map: {}, project_duration: 0 };
		expect((await tool("gantt_critical_path", { project_id: p.id })).structuredContent.note).toContain("loop");
	});
});

describe("gantt_project_report", () => {
	it("reports progress, schedule, counts, milestones, budget and no baseline", async () => {
		a.status = "done";
		a.manual_progress = 100;
		b.status = "blocked";
		g.addTask(p.id, { title: "Late", start_date: "2026-01-05 00:00:00", end_date: "2026-01-09 00:00:00", status: "in_progress" });
		g.addMilestone(p.id, { title: "Past", milestone_date: "2026-01-01" });
		const m = g.addMilestone(p.id, { title: "Launch", milestone_date: "2099-12-01" });
		const r = await tool("gantt_project_report", { project_id: p.id });
		const d = INSIGHT_OUTPUTS.gantt_project_report.parse(r.structuredContent);
		expect(d.tasks).toEqual({ total: 3, not_started: 0, in_progress: 1, blocked: 1, done: 1, overdue: 1 });
		expect(d.schedule).toEqual({ status: "at_risk", worst_delay_working_days: 6 });
		expect(d.next_milestones).toEqual([{ milestone_id: m.id, title: "Launch", date: "2099-12-01" }]);
		expect(d.budget).toEqual({ planned: 1200.5, unit: "mixed", earned_value: { pv: 100, ev: 80, ac: null, spi: 0.8, cpi: null } });
		expect(d.baseline).toBeNull();
		expect(d.dates).toEqual({ first_start: "2026-01-05", last_end: "2026-11-13" });
		expect(r.content[0]?.text).not.toContain("gemischt");
	});
	it("shows the biggest delays against a saved baseline", async () => {
		g.baselines.set(p.id, { created_at: "2026-10-20 09:00:00", comment: "Signed off", ends: new Map([[a.id, "2026-11-06"], [b.id, "2026-11-03"]]) });
		const d = INSIGHT_OUTPUTS.gantt_project_report.parse((await tool("gantt_project_report", { project_id: p.id })).structuredContent);
		expect(d.baseline).toMatchObject({ saved_at: "2026-10-20", comment: "Signed off", tasks_compared: 2, delayed_tasks: 1, total_schedule_variance_days: 10 });
		expect(d.baseline?.biggest_delays).toEqual([{ task_id: b.id, title: "B", baseline_end: "2026-11-03", current_end: "2026-11-13", variance_days: 10 }]);
	});
	it("doesn't hide real failures of the baseline report", async () => {
		fake.on("GET", /\/report\/delta$/, () => new Response(JSON.stringify({ ocs: { meta: { statuscode: 500, message: "internal_error" }, data: [] } }), { status: 500 }));
		expect(errCode(await tool("gantt_project_report", { project_id: p.id }))).toBe("upstream_unavailable");
	});
});

describe("gantt_link_board_card", () => {
	beforeEach(() => {
		g.boards.set(21, { title: "Board", readers: new Set([QA.a]), editors: new Set([QA.a]) });
		// Card 50 has its own due date, which differs from the plan's (the fake follows settleDates).
		g.cards.set(50, { board_id: 21, readers: new Set([QA.a]), duedate: "2026-12-24T17:00:00+00:00" });
		g.cards.set(51, { board_id: 21, readers: new Set([QA.b]) });
	});
	it("needs a linked board first, in plain words", async () => {
		const r = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, card_id: 50 });
		expect(errCode(r)).toBe("not_available");
		expect(r.content[0]?.text).toContain("isn't linked to a NoBoard board");
		expect(r.content[0]?.text).not.toContain("deck_sync_off");
	});
	it("links a readable card, refuses one the person can't read, and writes the plan's dates when asked", async () => {
		p.deck_board_id = 21;
		p.deck_sync_level = "read";
		const r = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, card_id: 50 });
		expect(JSON.parse(fake.driveCalls().filter((c) => c.url.pathname.endsWith(`/tasks/${a.id}/deck-links`)).pop()?.body ?? "{}")).toEqual({ card_id: 50, date_action: "keep" });
		const d = BOARD_OUTPUTS.gantt_link_board_card.parse(r.structuredContent);
		expect(d).toMatchObject({ link: { task_id: a.id, card_id: 50, board_id: 21, card_url: "https://drive.nourax.org/apps/deck/board/21/card/50" }, card_dates: "different", new_card: false });
		expect(r.structuredContent.warnings[0]).toContain("use_plan");
		expect(errCode(await tool("gantt_link_board_card", { project_id: p.id, task_id: b.id, card_id: 51 }))).toBe("not_found");
		const use = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, card_id: 50, card_dates: "use_plan" });
		expect(errCode(use)).toBe("not_available");
		expect(use.content[0]?.text).toContain("only reads");
	});
	it("makes a new card when the link writes, and refuses unclear input", async () => {
		p.deck_board_id = 21;
		p.deck_sync_level = "write_confirm";
		const r = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, create_card: true });
		const d = BOARD_OUTPUTS.gantt_link_board_card.parse(r.structuredContent);
		expect(d).toMatchObject({ new_card: true, card_dates: "plan_written", assigned_people: 1, link: { card_title: "A", board_id: 21 } });
		fake.requests.length = 0;
		for (const bad of [{ project_id: p.id, task_id: a.id }, { project_id: p.id, task_id: a.id, card_id: 50, create_card: true }, { project_id: p.id, task_id: a.id, create_card: true, card_dates: "use_plan" }]) {
			expect(errCode(await tool("gantt_link_board_card", bad, { uid: QA.b })), JSON.stringify(bad)).toBe("invalid_input");
		}
		expect(ganttCalls(fake)).toEqual([]);
	});
	it("checks the task belongs to the project", async () => {
		const other = g.addTask(g.addProject(QA.a).id);
		expect(errCode(await tool("gantt_link_board_card", { project_id: p.id, task_id: other.id, card_id: 50 }))).toBe("not_found");
	});
});
