/**
 * Fix round 2 for lane G (DESIGN 25.7), against the fake: the board-card link without the 10-minute
 * guard, depends_on changes the undo couldn't take back, NoGantt's whole card summary, unknown slack,
 * the 500 cap of /my-tasks, texts shown changed, and answers that always fit the result cap.
 *
 * Writes are split between the two QA people: each may make 30 a minute.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadBudget } from "../../../src/core/result";
import { BOARD_OUTPUTS } from "../../../src/tools/gantt/board";
import { INSIGHT_OUTPUTS } from "../../../src/tools/gantt/insight";
import { PROJECT_OUTPUTS } from "../../../src/tools/gantt/projects";
import { TASK_OUTPUTS } from "../../../src/tools/gantt/tasks";
import type { FakeGantt, GDep, GProject, GTask } from "../../fake-nc/gantt";
import type { FakeNc } from "../../fake-nc/index";
import { type CallResult, errCode, ganttCalls, QA, setup, tool } from "./_helpers";

let fake: FakeNc;
let g: FakeGantt;
let p: GProject;
let a: GTask;
let b: GTask;
beforeEach(() => {
	({ fake, g } = setup());
	p = g.addProject(QA.a, { title: "Plan" });
	a = g.addTask(p.id, { title: "A", start_date: "2026-11-02 00:00:00", end_date: "2026-11-06 00:00:00" });
	b = g.addTask(p.id, { title: "B", start_date: "2026-11-09 00:00:00", end_date: "2026-11-13 00:00:00" });
});
afterEach(() => vi.restoreAllMocks());

/** What the core wrapper allows a payload (DESIGN 10.4), as register.ts works it out. */
const BUDGET = payloadBudget("x".repeat(120));
const fits = (r: CallResult) => {
	expect(r.isError).toBeFalsy();
	expect(JSON.stringify(r.structuredContent).length).toBeLessThanOrEqual(BUDGET);
	expect(r.content[0]?.text).not.toContain("Cut short");
};
const puts = () => fake.driveCalls().filter((c) => c.method === "PUT");
const dep = (taskId: number, pred: string, lag = 0): GDep => ({ id: g.id(), task_id: taskId, predecessor_id: pred, dependency_type: "EA", lag_days: lag });

describe("gantt_link_board_card without the 10-minute guard", () => {
	beforeEach(() => {
		g.boards.set(21, { title: "Board", readers: new Set([QA.a]), editors: new Set([QA.a]) });
		g.cards.set(50, { board_id: 21, readers: new Set([QA.a]) });
		p.deck_board_id = 21;
	});
	it("links a card again after the link was removed, for real (no stale answer)", async () => {
		p.deck_sync_level = "read";
		const first = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, card_id: 50 });
		expect(first.isError).toBeFalsy();
		expect(a.deck_cards).toEqual([50]);
		// The person unlinks it in NoGantt; the same call within 10 minutes links it again.
		a.deck_cards = [];
		fake.requests.length = 0;
		const again = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, card_id: 50 });
		expect(again.isError).toBeFalsy();
		expect(again.content[0]?.text).not.toContain("matches a call made");
		expect(ganttCalls(fake)).toContain(`POST /tasks/${a.id}/deck-links`);
		expect(a.deck_cards).toEqual([50]);
		BOARD_OUTPUTS.gantt_link_board_card.parse(again.structuredContent);
	});
	it("makes a card once; a repeat is refused while the task has a card, another_card makes a second", async () => {
		p.deck_sync_level = "write_confirm";
		const made = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, create_card: true });
		expect(made.structuredContent.new_card).toBe(true);
		const card = a.deck_cards[0];
		fake.requests.length = 0;
		const repeat = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, create_card: true });
		expect(errCode(repeat)).toBe("already_exists");
		expect(repeat.content[0]?.text).toContain(`already has NoBoard card ${card} linked, so no new card was made`);
		expect(repeat.content[0]?.text).toContain("another_card");
		expect(ganttCalls(fake).some((c) => c.endsWith("/deck-cards"))).toBe(false);
		const second = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, create_card: true, another_card: true });
		expect(second.isError).toBeFalsy();
		expect(a.deck_cards).toHaveLength(2);
		// Once the task has no card link any more, a new card is made without another_card.
		b.deck_cards = [];
		expect((await tool("gantt_link_board_card", { project_id: p.id, task_id: b.id, create_card: true })).structuredContent.new_card).toBe(true);
		fake.requests.length = 0;
		expect(errCode(await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, card_id: 50, another_card: true }))).toBe("invalid_input");
		expect(ganttCalls(fake)).toEqual([]);
	});
});

describe("gantt_update_task with depends_on the undo couldn't take back", () => {
	it("refuses replacing more than 20 old links, an unknown link or a lag out of range, writing nothing", async () => {
		const many = Array.from({ length: 21 }, () => g.addTask(p.id, { title: "Pre" }));
		const t = g.addTask(p.id, { title: "Waits", deps: [] });
		t.deps = many.map((m) => dep(t.id, `t-${m.id}`));
		fake.requests.length = 0;
		const tooMany = await tool("gantt_update_task", { project_id: p.id, task_id: t.id, depends_on: [] });
		expect(errCode(tooMany)).toBe("too_large");
		expect(tooMany._meta?.["nourax/error"]?.field).toBe("depends_on");
		expect(tooMany.content[0]?.text).toContain("waits for 21 tasks and milestones, more than the 20 that depends_on takes");
		expect(tooMany.content[0]?.text).toContain(`task=${t.id}`);
		const lag = g.addTask(p.id, { title: "Lagged" });
		lag.deps = [dep(lag.id, `t-${a.id}`, 300)];
		const odd = g.addTask(p.id, { title: "Odd" });
		odd.deps = [dep(odd.id, "x-5")];
		for (const id of [lag.id, odd.id]) {
			const r = await tool("gantt_update_task", { project_id: p.id, task_id: id, depends_on: [{ after_task_id: b.id }] });
			expect(errCode(r), String(id)).toBe("not_available");
			expect(r.content[0]?.text).toContain("can't be written back through depends_on");
		}
		expect(puts()).toEqual([]);
		expect(t.deps).toHaveLength(21);
		// Other fields of the same task still change.
		const title = await tool("gantt_update_task", { project_id: p.id, task_id: t.id, title: "Waits 2" });
		expect(title.isError).toBeFalsy();
		expect(title.structuredContent.task.depends_on).toHaveLength(21);
	});
	it("replaces up to 20 old links, and the undo puts all of them back", async () => {
		const pre = Array.from({ length: 20 }, () => g.addTask(p.id, { title: "Pre", start_date: "2026-10-01 00:00:00", end_date: "2026-10-02 00:00:00" }));
		const t = g.addTask(p.id, { title: "Waits", start_date: "2026-11-20 00:00:00", end_date: "2026-11-21 00:00:00" });
		t.deps = pre.map((m, i) => dep(t.id, `t-${m.id}`, i % 3));
		const r = await tool("gantt_update_task", { project_id: p.id, task_id: t.id, depends_on: [] });
		expect(r.isError).toBeFalsy();
		expect(t.deps).toEqual([]);
		expect(r.structuredContent.previous.depends_on).toHaveLength(20);
		expect(r.structuredContent.undo.tool).toBe("gantt_update_task");
		const back = await tool("gantt_update_task", r.structuredContent.undo.arguments);
		expect(back.isError).toBeFalsy();
		expect(t.deps.map((d) => [d.predecessor_id, d.lag_days])).toEqual(pre.map((m, i) => [`t-${m.id}`, i % 3]));
	});
	it("says how to take back the rest when a change has an op_id for its moved dates", async () => {
		const r = await tool("gantt_update_task", { project_id: p.id, task_id: a.id, start_date: "2026-11-03", title: "A2" });
		expect(r.structuredContent.undo.tool).toBe("gantt_undo_change");
		expect(r.structuredContent.warnings).toContain("gantt_undo_change takes back only the date moves; gantt_update_task with the old values in previous takes back the rest.");
		expect(r.structuredContent.previous).toEqual({ title: "A", start_date: "2026-11-02" });
	});
});

describe("NoGantt's whole card summary", () => {
	const as = { uid: QA.b };
	let q: GProject;
	let c: GTask;
	beforeEach(() => {
		q = g.addProject(QA.b, { deck_board_id: 21, deck_sync_level: "write_silent" });
		c = g.addTask(q.id, { title: "C", deck_cards: [77] });
		g.addTask(q.id, { title: "D" });
	});
	it("gantt_update_task counts cards that kept their own dates, are gone, failed or wait", async () => {
		g.deckNext = { updated: [{ card_id: 1 }], failed: [{ card_id: 2 }], deviations: [{ card_id: 3 }, { card_id: 4 }], pending: [{ card_id: 5 }], gone: [{ card_id: 6 }], unconfirmed: 0 };
		const r = await tool("gantt_update_task", { project_id: q.id, task_id: c.id, end_date: "2026-11-09" }, as);
		const d = TASK_OUTPUTS.gantt_update_task.parse(r.structuredContent);
		expect(d.board).toEqual({ cards_updated: 1, cards_failed: 2, cards_kept_their_dates: 2, cards_gone: 1, waiting_for_confirmation: 0 });
		const w = (r.structuredContent.warnings as string[]).join(" ");
		expect(w).toContain("2 linked NoBoard cards kept their own dates");
		expect(w).toContain("1 linked NoBoard card no longer exists in NoBoard.");
		expect(w).toContain("2 linked NoBoard cards couldn't be given the new dates.");
		expect(w).not.toContain("old dates");
	});
	it("gantt_link_tasks shows a card that kept its own dates, which used to make board null", async () => {
		const [x, y] = [...g.tasks.values()].filter((t) => t.project_id === q.id);
		g.deckNext = { updated: [], failed: [], deviations: [{ card_id: 77 }], pending: [], gone: [], unconfirmed: 0 };
		const r = await tool("gantt_link_tasks", { project_id: q.id, links: [{ task_id: (y as GTask).id, after_task_id: (x as GTask).id }] }, as);
		const d = TASK_OUTPUTS.gantt_link_tasks.parse(r.structuredContent);
		expect(d.board).toEqual({ cards_updated: 0, cards_failed: 0, cards_kept_their_dates: 1, cards_gone: 0, waiting_for_confirmation: 0 });
		expect(r.structuredContent.warnings).toContain("1 linked NoBoard card kept its own dates, because it was changed in NoBoard since NoGantt last wrote it.");
	});
	it("gantt_undo_change doesn't claim old dates went into cards that kept their own", async () => {
		const m = await tool("gantt_update_task", { project_id: q.id, task_id: c.id, end_date: "2026-11-10" }, as);
		g.deckNext = { updated: [], failed: [], deviations: [{ card_id: 77 }], pending: [], gone: [], unconfirmed: 0 };
		const u = await tool("gantt_undo_change", m.structuredContent.undo.arguments, as);
		const d = TASK_OUTPUTS.gantt_undo_change.parse(u.structuredContent);
		expect(d.board).toEqual({ cards_updated: 0, cards_failed: 0, cards_kept_their_dates: 1, cards_gone: 0, waiting_for_confirmation: 0 });
		const w = (u.structuredContent.warnings as string[]).join(" ");
		expect(w).not.toContain("wrote the old dates back");
		expect(w).toContain("kept its own dates");
	});
});

describe("gantt_critical_path with an unknown slack", () => {
	it("gives null, never 0, when NoGantt has no slack (its empty answer sends float_map as [])", async () => {
		g.criticalOverride = { critical_ids: [], float_map: [], project_duration: 0 };
		const r = await tool("gantt_critical_path", { project_id: p.id });
		const d = INSIGHT_OUTPUTS.gantt_critical_path.parse(r.structuredContent);
		expect(d.critical).toEqual([]);
		expect(d.others.map((t) => t.slack_days)).toEqual([null, null]);
		expect(d.note).toContain("loop");
		expect(d.note).toContain("unknown (null)");
	});
	it("lists known slack first and says how many are unknown", async () => {
		const c = g.addTask(p.id, { title: "C" });
		const e = g.addTask(p.id, { title: "E" });
		g.criticalOverride = { critical_ids: [a.id], float_map: { [`t-${a.id}`]: 0, [`t-${b.id}`]: 3, [`t-${e.id}`]: 1 }, project_duration: 9 };
		const d = INSIGHT_OUTPUTS.gantt_critical_path.parse((await tool("gantt_critical_path", { project_id: p.id })).structuredContent);
		expect(d.others.map((t) => [t.task_id, t.slack_days])).toEqual([[e.id, 1], [b.id, 3], [c.id, null]]);
		expect(d.note).toBe("NoGantt gave no slack for 1 task; its slack_days is null.");
	});
});

describe("gantt_my_tasks and NoGantt's 500", () => {
	it("warns that tasks may be missing when NoGantt sends its maximum, and not otherwise", async () => {
		const ids = Array.from({ length: 501 }, (_, i) => g.addTask(p.id, { title: `T${i}`, end_date: `2026-${String(1 + (i % 12)).padStart(2, "0")}-10 00:00:00` }).id);
		g.myTasks.set(QA.a, ids);
		const r = await tool("gantt_my_tasks", { project_id: p.id, limit: 10 });
		expect(r.isError).toBeFalsy();
		expect(r.content[0]?.text.split("\n")[0]).toContain("among NoGantt's first 500");
		expect(r.structuredContent.warnings[0]).toContain("at most 500 assigned tasks");
		g.myTasks.set(QA.a, ids.slice(0, 499));
		const few = await tool("gantt_my_tasks", { limit: 10 });
		expect(few.structuredContent.warnings).toBeUndefined();
	});
});

describe("texts the connector shows changed aren't changed", () => {
	const as = { uid: QA.b };
	it("refuses a title holding NoGantt's own name and a description with a C1 control; other fields change", async () => {
		const q = g.addProject(QA.b, { title: "From nc_gantt", description: "Line\u0085two" });
		const t = g.addTask(q.id, { title: "Moved from NC-Gantt" });
		fake.requests.length = 0;
		const tt = await tool("gantt_update_task", { project_id: q.id, task_id: t.id, title: "New" }, as);
		expect(errCode(tt)).toBe("not_available");
		expect(tt.content[0]?.text).toContain("This task's title holds characters this connector doesn't show exactly");
		expect(errCode(await tool("gantt_update_project", { project_id: q.id, title: "New" }, as))).toBe("not_available");
		expect(errCode(await tool("gantt_update_project", { project_id: q.id, description: "New" }, as))).toBe("not_available");
		expect(puts()).toEqual([]);
		expect((await tool("gantt_update_task", { project_id: q.id, task_id: t.id, status: "done" }, as)).isError).toBeFalsy();
		expect((await tool("gantt_update_project", { project_id: q.id, color: "#123456" }, as)).isError).toBeFalsy();
		expect([q.title, q.description, t.title]).toEqual(["From nc_gantt", "Line\u0085two", "Moved from NC-Gantt"]);
	});
});

describe("answers always fit the result cap (DESIGN 25.7)", () => {
	it("refuses changing notes whose copy for the undo would outgrow the answer", async () => {
		a.description = "\u0001".repeat(10_000);
		fake.requests.length = 0;
		const r = await tool("gantt_update_task", { project_id: p.id, task_id: a.id, notes: "x" });
		expect(errCode(r)).toBe("too_large");
		expect(r.content[0]?.text).toContain("too much of one answer");
		expect(r._meta?.["nourax/error"]?.field).toBe("notes");
		expect(puts()).toEqual([]);
		// Changing something else of that task is fine, and fits.
		fits(await tool("gantt_update_task", { project_id: p.id, task_id: a.id, status: "blocked" }));
	});
	it("fits with quote-heavy old notes given twice (previous and undo)", async () => {
		a.description = '"'.repeat(10_000);
		const r = await tool("gantt_update_task", { project_id: p.id, task_id: a.id, notes: "x", title: "A2" });
		fits(r);
		expect(r.structuredContent.undo.arguments.notes).toBe('"'.repeat(10_000));
		expect(r.structuredContent.previous.notes).toBe('"'.repeat(10_000));
	});
	it("fits when the same change also moves 230 dependent tasks with long titles", async () => {
		a.description = '"'.repeat(10_000);
		let prev = a;
		for (let i = 0; i < 230; i++) {
			const t = g.addTask(p.id, { title: `${"\u0001".repeat(200)} ${i}`, start_date: "2026-11-09 00:00:00", end_date: "2026-11-10 00:00:00" });
			t.deps = [dep(t.id, `t-${prev.id}`)];
			prev = t;
		}
		const r = await tool("gantt_update_task", { project_id: p.id, task_id: a.id, notes: "x", start_date: "2026-11-03", end_date: "2026-11-09" });
		fits(r);
		const d = TASK_OUTPUTS.gantt_update_task.parse(r.structuredContent);
		expect(d.moved_total).toBeGreaterThanOrEqual(230);
		expect(d.moved.length).toBeLessThan(d.moved_total);
		expect((r.structuredContent.warnings as string[]).some((w) => w.includes("more moved tasks aren't listed"))).toBe(true);
	});
	it("lists 100 of a task's 300 links, with the count, in gantt_update_task and gantt_get_project", async () => {
		const pre = Array.from({ length: 300 }, () => g.addTask(p.id, { title: "\u0001".repeat(255), start_date: "2026-08-01 00:00:00", end_date: "2026-08-02 00:00:00" }));
		// It starts first, so the plan's first page lists it (the plan is read before anything moves it).
		const t = g.addTask(p.id, { title: "Many", start_date: "2026-07-01 00:00:00", end_date: "2026-07-02 00:00:00" });
		t.deps = pre.map((m) => dep(t.id, `t-${m.id}`));
		const plan = await tool("gantt_get_project", { project_id: p.id, limit: 300 });
		fits(plan);
		const many = (plan.structuredContent.tasks as { task_id: number; depends_on: unknown[]; depends_on_total?: number }[])[0];
		expect([many?.task_id, many?.depends_on.length, many?.depends_on_total]).toEqual([t.id, 100, 300]);
		expect(plan.structuredContent.has_more).toBe(true);
		expect(plan.structuredContent.warnings).toContain("1 task has more than 100 links; only the first 100 of each are listed, and depends_on_total has the count.");
		const r = await tool("gantt_update_task", { project_id: p.id, task_id: t.id, title: "Many 2" });
		fits(r);
		expect(r.structuredContent.task.depends_on).toHaveLength(100);
		expect(r.structuredContent.task.depends_on_total).toBe(300);
		expect(r.structuredContent.warnings).toContain(`Task ${t.id} has 300 links; only the first 100 are listed here (NoGantt shows them all).`);
	});
	// Core's ctx.page.fit measures without nulls; lane G's pageOf measures as structuredContent
	// carries the answer, and keeps room for the totals, cursor and warnings (ANSWER_REST).
	const C1 = (n: number) => "\u0001".repeat(n);
	it("gantt_list_projects pages 200 worst-case projects within the cap, and the next page goes on", async () => {
		for (let i = 0; i < 200; i++) g.addProject(QA.a, { title: `${C1(250)}${i}`, description: C1(400) });
		const r = await tool("gantt_list_projects", { limit: 200 });
		fits(r);
		const d = PROJECT_OUTPUTS.gantt_list_projects.parse(r.structuredContent);
		expect(d.total).toBe(201);
		expect(d.projects.length).toBeLessThan(201);
		expect(d.has_more).toBe(true);
		const next = await tool("gantt_list_projects", { limit: 200, cursor: d.next_cursor });
		fits(next);
		const seen = new Set([...d.projects, ...PROJECT_OUTPUTS.gantt_list_projects.parse(next.structuredContent).projects].map((x) => x.project_id));
		expect(seen.size).toBe(d.projects.length + next.structuredContent.projects.length);
	});
	it("gantt_my_tasks pages 200 worst-case tasks within the cap", async () => {
		const q = g.addProject(QA.a, { title: C1(255) });
		const ids = Array.from({ length: 200 }, () => g.addTask(q.id, { title: C1(255), end_date: "2026-12-01 00:00:00" }).id);
		g.myTasks.set(QA.a, ids);
		const r = await tool("gantt_my_tasks", { limit: 200 });
		fits(r);
		const d = TASK_OUTPUTS.gantt_my_tasks.parse(r.structuredContent);
		expect(d.tasks.length).toBeLessThan(200);
		expect(d.has_more).toBe(true);
	});
	it("gantt_critical_path fits 400 worst-case tasks with its counts and warning", async () => {
		const ts = Array.from({ length: 400 }, () => g.addTask(p.id, { title: C1(255) }));
		g.criticalOverride = { critical_ids: ts.slice(0, 250).map((t) => t.id), float_map: Object.fromEntries(ts.map((t, i) => [`t-${t.id}`, i < 250 ? 0 : i])), project_duration: 40 };
		const r = await tool("gantt_critical_path", { project_id: p.id });
		fits(r);
		const d = INSIGHT_OUTPUTS.gantt_critical_path.parse(r.structuredContent);
		expect([d.critical_total, d.others_total]).toEqual([250, 152]);
		expect(d.critical.length + d.others.length).toBeLessThan(402);
		expect((r.structuredContent.warnings as string[])[0]).toContain("fit in one answer");
	});
	it("gantt_project_report fits at its worst: 5 milestones, 20 delays and a comment, all control characters", async () => {
		const q = g.addProject(QA.a, { title: C1(255), plan_start: "2026-01-01 00:00:00", plan_end: "2027-12-31 00:00:00" });
		const ts = Array.from({ length: 40 }, (_, i) => g.addTask(q.id, { title: C1(255), start_date: "2027-01-04 00:00:00", end_date: `2027-02-${String(1 + (i % 27)).padStart(2, "0")} 00:00:00` }));
		for (let i = 0; i < 9; i++) g.addMilestone(q.id, { title: C1(255), milestone_date: `2027-03-0${1 + i} 00:00:00` });
		g.baselines.set(q.id, { created_at: "2026-10-01 10:00:00", comment: C1(1000), ends: new Map(ts.map((t) => [t.id, "2026-11-02"])) });
		const r = await tool("gantt_project_report", { project_id: q.id });
		fits(r);
		const d = INSIGHT_OUTPUTS.gantt_project_report.parse(r.structuredContent);
		expect([d.next_milestones.length, d.baseline?.biggest_delays.length]).toEqual([5, 20]);
	});
	it("gantt_share_project list fits 250 worst-case shares, with the total", async () => {
		for (let i = 0; i < 250; i++) {
			const id = g.id();
			g.shares.set(id, { id, project_id: p.id, principal_id: `${C1(60)}${i}`, principal_type: "group", permission: "editor" });
		}
		const r = await tool("gantt_share_project", { project_id: p.id, action: "list" });
		fits(r);
		expect(r.structuredContent.total).toBe(250);
		expect(r.structuredContent.shares.length).toBeLessThan(250);
		expect(r.structuredContent.warnings[0]).toContain("of 250 shares fit in one answer");
	});
	it("gantt_update_project refuses a description too costly to copy, and fits otherwise", async () => {
		const as = { uid: QA.b };
		const big = g.addProject(QA.b, { description: "\u0001".repeat(10_000) });
		fake.requests.length = 0;
		const r = await tool("gantt_update_project", { project_id: big.id, description: "x" }, as);
		expect(errCode(r)).toBe("too_large");
		expect(r._meta?.["nourax/error"]?.field).toBe("description");
		expect(puts()).toEqual([]);
		const quotes = g.addProject(QA.b, { title: "\u0001".repeat(255), description: '"'.repeat(10_000) });
		const ok = await tool("gantt_update_project", { project_id: quotes.id, description: "x", color: "#123456" }, as);
		fits(ok);
		PROJECT_OUTPUTS.gantt_update_project.parse(ok.structuredContent);
		expect(ok.structuredContent.undo.arguments.description).toBe('"'.repeat(10_000));
	});
});
