/**
 * Fix round 5 for lane G (DESIGN 25.10; the resumed run's third fix round), against the fake: an
 * imported plan's links with the tool's own defaults, the remedy a refused link points to, `assigned`
 * for tasks assigned through NoGantt's resource_id, the report's delayed counts, and the title of an
 * existing card that gantt_link_board_card links.
 *
 * The fake refuses what NoGantt refuses (FakeGantt.negativeFloat): a one-day task hung start to start
 * on a fixed milestone can't wait for another task. Writes are split between the two QA people: each
 * may make 30 a minute.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEGATIVE_FLOAT, NEGATIVE_FLOAT_HINT } from "../../../src/tools/gantt/api";
import { BOARD_OUTPUTS } from "../../../src/tools/gantt/board";
import { INSIGHT_OUTPUTS } from "../../../src/tools/gantt/insight";
import { buildTree, PROJECT_OUTPUTS, startWaitingTasks } from "../../../src/tools/gantt/projects";
import type { FakeGantt, GProject, GTask } from "../../fake-nc/gantt";
import type { FakeNc } from "../../fake-nc/index";
import { errCode, QA, setup, tool } from "./_helpers";

let fake: FakeNc;
let g: FakeGantt;
beforeEach(() => {
	({ fake, g } = setup());
});
afterEach(() => vi.restoreAllMocks());

const D = (s: string | undefined) => (s ?? "").slice(0, 10);
const importBody = () => JSON.parse(fake.driveCalls().find((c) => c.url.pathname.endsWith("/structure-import"))?.body ?? "{}");
const linkCalls = () => fake.driveCalls().filter((c) => c.method === "POST" && c.url.pathname.endsWith("/dependencies"));
const task = (id: number | undefined) => g.tasks.get(id as number) as GTask;
const preds = (t: GTask) => t.deps.map((d) => `${d.predecessor_id}${d.dependency_type}`);

describe("the fake refuses what NoGantt refuses (DESIGN 25.10 #1)", () => {
	it("a one-day task on a fixed milestone can't wait for a task; replacing its links can", async () => {
		const as = { uid: QA.b };
		const p = g.addProject(QA.b);
		const m = g.addMilestone(p.id, { title: "Project start", milestone_date: "2026-11-02" });
		const day = { start_date: "2026-11-02 00:00:00", end_date: "2026-11-02 00:00:00" };
		const a = g.addTask(p.id, { title: "A", ...day });
		const b = g.addTask(p.id, { title: "B", ...day });
		for (const t of [a, b]) t.deps.push({ id: g.id(), task_id: t.id, predecessor_id: `m-${m.id}`, dependency_type: "AA", lag_days: 0 });
		// What an import with the old request left behind: gantt_link_tasks is refused, with the remedy.
		const link = await tool("gantt_link_tasks", { project_id: p.id, links: [{ task_id: b.id, after_task_id: a.id }] }, as);
		expect(errCode(link)).toBe("invalid_input");
		// The whole remedy reaches the AI client: message and hint fit core's 300 characters for an error.
		expect(link.content[0]?.text).toBe(`${NEGATIVE_FLOAT} ${NEGATIVE_FLOAT_HINT}`);
		expect(`${NEGATIVE_FLOAT} ${NEGATIVE_FLOAT_HINT}`.length).toBeLessThanOrEqual(300);
		expect(preds(b)).toEqual([`m-${m.id}AA`]);
		// The remedy the hint names works: depends_on replaces B's links, its milestone link too.
		const fix = await tool("gantt_update_task", { project_id: p.id, task_id: b.id, depends_on: [{ after_task_id: a.id }] }, as);
		expect(fix.isError, fix.content[0]?.text).toBeFalsy();
		expect(preds(b)).toEqual([`t-${a.id}EA`]);
		expect(D(b.start_date) > D(a.end_date)).toBe(true);
	});
});

describe("gantt_import_plan with its own defaults (DESIGN 25.10 #1)", () => {
	it("makes every link for undated one-day tasks with the start milestone on, and each waiting task starts after its predecessor", async () => {
		const items = ["a", "b", "c"].map((k) => ({ key: k, kind: "task", title: k.toUpperCase() }));
		const r = await tool("gantt_import_plan", { new_project_title: "Defaults", start_date: "2026-11-02", items, links: [{ from: "a", to: "b" }, { from: "b", to: "c" }] });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		const d = PROJECT_OUTPUTS.gantt_import_plan.parse(r.structuredContent);
		expect(d).toMatchObject({ tasks: 3, milestones: 1, links: 2, links_not_added: 0, start_milestone_links: 1 });
		expect(r.structuredContent.warnings ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining("link")]));
		// The defaults go to NoGantt as they are; only the waiting tasks b and c get a date of their own.
		const sent = importBody();
		expect(sent.options).toEqual({ start_date: "2026-11-02", duration: 1, start_milestone: true });
		expect(sent.items).toEqual([
			{ key: "a", type: "task", title: "A" },
			{ key: "b", type: "task", title: "B", start_date: "2026-11-02" },
			{ key: "c", type: "task", title: "C", start_date: "2026-11-02" },
		]);
		const [a, b, c] = [d.task_ids.a, d.task_ids.b, d.task_ids.c].map(task) as [GTask, GTask, GTask];
		const ms = [...g.milestones.values()].find((x) => x.project_id === d.project_id && x.title === "Project start");
		expect(preds(a)).toEqual([`m-${ms?.id}AA`]);
		expect(preds(b)).toEqual([`t-${a.id}EA`]);
		expect(preds(c)).toEqual([`t-${b.id}EA`]);
		expect([D(a.start_date), D(a.end_date)]).toEqual(["2026-11-02", "2026-11-02"]);
		expect(D(b.start_date) > D(a.end_date)).toBe(true);
		expect(D(c.start_date) > D(b.end_date)).toBe(true);
	});
	it("works the same into a project made first with gantt_create_project (the description's own path)", async () => {
		const as = { uid: QA.b };
		const made = await tool("gantt_create_project", { title: "Made first" }, as);
		const pid = made.structuredContent.project.project_id as number;
		const items = ["a", "b", "c"].map((k) => ({ key: k, kind: "task", title: k.toUpperCase() }));
		const r = await tool("gantt_import_plan", { project_id: pid, start_date: "2026-11-02", items, links: [{ from: "a", to: "b" }, { from: "a", to: "c" }] }, as);
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		expect(PROJECT_OUTPUTS.gantt_import_plan.parse(r.structuredContent)).toMatchObject({ created_project: false, links: 2, links_not_added: 0, start_milestone_links: 1 });
		expect(linkCalls()).toHaveLength(1);
		// A second import into it, with the defaults, links too (NoGantt reuses its "Project start").
		const again = await tool("gantt_import_plan", { project_id: pid, start_date: "2026-11-09", items: [{ key: "x", kind: "task", title: "X" }, { key: "y", kind: "task", title: "Y" }], links: [{ from: "x", to: "y" }] }, as);
		expect(PROJECT_OUTPUTS.gantt_import_plan.parse(again.structuredContent)).toMatchObject({ links: 1, links_not_added: 0 });
	});
	it("the request the tool sent before this fix is refused by the fake, as NoGantt refused it live", async () => {
		const as = { uid: QA.b };
		const items = ["a", "b"].map((k) => ({ key: k, kind: "task", title: k.toUpperCase() }));
		// Both undated tasks hung on the milestone (what the tool sent before): the link route refuses.
		const route = fake.routes.find((x) => x.method === "POST" && x.path.source.includes("structure-import"));
		if (!route) throw new Error("no import route in the fake");
		fake.on("POST", route.path, (req, f, m) => {
			const body = JSON.parse(req.body ?? "{}") as { items: Record<string, unknown>[] };
			for (const it of body.items) delete it.start_date;
			return route.handler({ ...req, body: JSON.stringify(body) }, f, m);
		});
		const r = await tool("gantt_import_plan", { new_project_title: "Old shape", start_date: "2026-11-02", items, links: [{ from: "a", to: "b" }] }, as);
		expect(r.isError).toBeFalsy();
		expect(PROJECT_OUTPUTS.gantt_import_plan.parse(r.structuredContent)).toMatchObject({ links: 0, links_not_added: 1, start_milestone_links: 2 });
		const w = (r.structuredContent.warnings as string[]).find((x) => x.includes("couldn't be added")) ?? "";
		// The warning names the remedy that works (depends_on), not gantt_link_tasks.
		expect(w).toContain("gantt_update_task with depends_on on the waiting task replaces its links, the milestone link too.");
		expect(w).not.toContain("gantt_link_tasks");
	});
	it("a waiting task after a dated one gets the plan's start too and moves only later; a task with its own end isn't changed", async () => {
		const as = { uid: QA.b };
		const r = await tool(
			"gantt_import_plan",
			{
				new_project_title: "Mixed",
				start_date: "2026-11-02",
				items: [
					{ key: "early", kind: "task", title: "Early", start_date: "2026-10-01", end_date: "2026-10-01" },
					{ key: "late", kind: "task", title: "Late", start_date: "2026-11-20", end_date: "2026-11-20" },
					{ key: "after_early", kind: "task", title: "After early" },
					{ key: "after_late", kind: "task", title: "After late" },
					{ key: "ends", kind: "task", title: "Ends", end_date: "2026-11-06" },
				],
				links: [
					{ from: "early", to: "after_early" },
					{ from: "late", to: "after_late" },
					{ from: "early", to: "ends" },
				],
			},
			as,
		);
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		const d = PROJECT_OUTPUTS.gantt_import_plan.parse(r.structuredContent);
		expect(d).toMatchObject({ links: 3, links_not_added: 0, start_milestone_links: 0, milestones: 0 });
		const sent = importBody().items as Record<string, unknown>[];
		expect(sent.find((i) => i.key === "after_early")).toMatchObject({ start_date: "2026-11-02" });
		expect(sent.find((i) => i.key === "ends")).toEqual({ key: "ends", type: "task", title: "Ends", end_date: "2026-11-06" });
		// NoGantt's link route moves a task only later: the plan's start stays when the predecessor ends earlier.
		expect(D(task(d.task_ids.after_early).start_date)).toBe("2026-11-02");
		expect(D(task(d.task_ids.after_late).start_date)).toBe("2026-11-21");
	});
	it("sends the items unchanged with add_start_milestone false, and without links", async () => {
		const items = ["a", "b"].map((k) => ({ key: k, kind: "task", title: k.toUpperCase() }));
		await tool("gantt_import_plan", { new_project_title: "No milestone", start_date: "2026-11-02", add_start_milestone: false, items, links: [{ from: "a", to: "b" }] });
		expect(importBody().items).toEqual([
			{ key: "a", type: "task", title: "A" },
			{ key: "b", type: "task", title: "B" },
		]);
		fake.requests.length = 0;
		await tool("gantt_import_plan", { new_project_title: "No links", start_date: "2026-11-02", items });
		expect(importBody().items).toEqual([
			{ key: "a", type: "task", title: "A" },
			{ key: "b", type: "task", title: "B" },
		]);
	});
	it("startWaitingTasks reaches tasks inside phases and leaves dated, unlinked tasks and phases alone", () => {
		const tree = buildTree([
			{ key: "p", kind: "phase", title: "P" },
			{ key: "q", kind: "phase", title: "Q", parent_key: "p" },
			{ key: "deep", kind: "task", title: "Deep", parent_key: "q", duration_days: 3 },
			{ key: "own", kind: "task", title: "Own", parent_key: "p", start_date: "2026-12-01" },
			{ key: "free", kind: "task", title: "Free" },
		]);
		expect(startWaitingTasks(tree, new Set(["deep", "own", "p", "nope"]), "2026-11-02")).toBe(1);
		expect(tree).toEqual([
			{
				key: "p",
				type: "subproject",
				title: "P",
				children: [
					{ key: "q", type: "subproject", title: "Q", children: [{ key: "deep", type: "task", title: "Deep", duration: 3, start_date: "2026-11-02" }] },
					{ key: "own", type: "task", title: "Own", start_date: "2026-12-01" },
				],
			},
			{ key: "free", type: "task", title: "Free" },
		]);
	});
});

describe("assigned counts NoGantt's resource_id (DESIGN 25.10 #2)", () => {
	it("is true for a task with resource_id and resources [], and for task_resources rows; false without either", async () => {
		const p = g.addProject(QA.a);
		const byId = g.addTask(p.id, { title: "By resource_id", resource_id: 3 });
		const byRows = g.addTask(p.id, { title: "By rows", resources: [{ resource_id: 4 }] });
		const none = g.addTask(p.id, { title: "None" });
		const zero = g.addTask(p.id, { title: "Zero", resource_id: 0 });
		const raw = g.taskJson(byId);
		expect([raw.resource_id, raw.resources]).toEqual([3, []]);
		const r = await tool("gantt_get_project", { project_id: p.id });
		const assigned = Object.fromEntries((r.structuredContent.tasks as { task_id: number; assigned: boolean }[]).map((t) => [t.task_id, t.assigned]));
		expect(assigned).toEqual({ [byId.id]: true, [byRows.id]: true, [none.id]: false, [zero.id]: false });
	});
});

describe("gantt_project_report's delayed counts match its delays (DESIGN 25.10 #3)", () => {
	let p: GProject;
	beforeEach(() => {
		p = g.addProject(QA.a, { title: "Plan" });
	});
	it("counts every task that ends later than in the baseline, and apart the ones more than 7 days late", async () => {
		const end = (s: string) => ({ start_date: `${s} 00:00:00`, end_date: `${s} 00:00:00` });
		const week = g.addTask(p.id, { title: "Week late", ...end("2026-11-16") });
		const ten = g.addTask(p.id, { title: "Ten late", ...end("2026-11-19") });
		const onTime = g.addTask(p.id, { title: "On time", ...end("2026-11-09") });
		const early = g.addTask(p.id, { title: "Early", ...end("2026-11-06") });
		g.baselines.set(p.id, {
			created_at: "2026-10-20 09:00:00",
			comment: null,
			ends: new Map([
				[week.id, "2026-11-09"],
				[ten.id, "2026-11-09"],
				[onTime.id, "2026-11-09"],
				[early.id, "2026-11-09"],
				// A task deleted since: no variance, counted in neither.
				[99_999, "2026-11-09"],
			]),
		});
		const d = INSIGHT_OUTPUTS.gantt_project_report.parse((await tool("gantt_project_report", { project_id: p.id })).structuredContent);
		expect(d.baseline).toMatchObject({ tasks_compared: 5, delayed_tasks: 2, delayed_more_than_7_days: 1 });
		expect(d.baseline?.biggest_delays.map((x) => [x.task_id, x.variance_days])).toEqual([
			[ten.id, 10],
			[week.id, 7],
		]);
		// The live case of the finding: one task 7 days late is a delayed task, not 0.
		g.baselines.set(p.id, { created_at: "2026-10-20 09:00:00", comment: null, ends: new Map([[week.id, "2026-11-09"]]) });
		const one = INSIGHT_OUTPUTS.gantt_project_report.parse((await tool("gantt_project_report", { project_id: p.id })).structuredContent);
		expect(one.baseline).toMatchObject({ delayed_tasks: 1, delayed_more_than_7_days: 0 });
		expect(one.baseline?.biggest_delays).toHaveLength(one.baseline?.delayed_tasks ?? -1);
	});
	it("counts all late tasks while listing the biggest 20", async () => {
		const ends = new Map<number, string>();
		for (let i = 1; i <= 25; i++) ends.set(g.addTask(p.id, { title: `T${i}`, end_date: "2026-11-30 00:00:00" }).id, "2026-11-20");
		g.baselines.set(p.id, { created_at: "2026-10-20 09:00:00", comment: null, ends });
		const d = INSIGHT_OUTPUTS.gantt_project_report.parse((await tool("gantt_project_report", { project_id: p.id })).structuredContent);
		expect([d.baseline?.delayed_tasks, d.baseline?.delayed_more_than_7_days, d.baseline?.biggest_delays.length]).toEqual([25, 25, 20]);
	});
});

describe("gantt_link_board_card names an existing card (DESIGN 25.10 #4)", () => {
	let p: GProject;
	let a: GTask;
	const cardReads = () => fake.driveCalls().filter((c) => c.method === "GET" && /\/stacks\/\d+\/cards\/\d+$/.test(c.url.pathname)).length;
	beforeEach(() => {
		p = g.addProject(QA.a, { deck_board_id: 21, deck_sync_level: "write_confirm" });
		a = g.addTask(p.id, { title: "A" });
		g.boards.set(21, { title: "Board", readers: new Set([QA.a]), editors: new Set([QA.a]) });
		// Card 70 lives on another board the person can read (NoGantt names the card's own board).
		g.boards.set(22, { title: "Other", readers: new Set([QA.a]), editors: new Set() });
		g.cards.set(70, { board_id: 22, readers: new Set([QA.a]), title: "Existing card", duedate: "2026-12-24T17:00:00+00:00", owner: QA.a });
	});
	it("with keep, reads the card on its own board after linking and gives its title", async () => {
		fake.requests.length = 0;
		const r = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, card_id: 70 });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		const d = BOARD_OUTPUTS.gantt_link_board_card.parse(r.structuredContent);
		expect(d.link).toEqual({ task_id: a.id, card_id: 70, board_id: 22, card_title: "Existing card", card_url: "https://drive.nourax.org/apps/deck/board/22/card/70" });
		const calls = fake.driveCalls().map((c) => `${c.method} ${c.url.pathname}`);
		const link = calls.findIndex((c) => c.endsWith(`/tasks/${a.id}/deck-links`));
		const read = calls.findIndex((c) => c.startsWith("GET /index.php/apps/deck/api/v1.0/boards/22/stacks/") && c.endsWith("/cards/70"));
		expect(read).toBeGreaterThan(link);
	});
	it("with use_plan, takes the title from the card it reads first, without a second read", async () => {
		g.cards.set(71, { board_id: 21, readers: new Set([QA.a]), title: "Dated card", duedate: "2026-12-24T17:00:00+00:00", owner: QA.a });
		fake.requests.length = 0;
		const r = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, card_id: 71, card_dates: "use_plan" });
		expect(BOARD_OUTPUTS.gantt_link_board_card.parse(r.structuredContent).link.card_title).toBe("Dated card");
		expect(cardReads()).toBe(1);
	});
	it("keeps the link and a null title when the card can't be read after linking; a new card's title comes from NoGantt", async () => {
		fake.on("GET", /^\/index\.php\/apps\/deck\/api\/v1\.0\/boards\/22$/, () => Response.json({ status: 500, message: "boom" }, { status: 500 }));
		const r = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, card_id: 70 });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		expect(BOARD_OUTPUTS.gantt_link_board_card.parse(r.structuredContent).link).toMatchObject({ card_id: 70, card_title: null });
		expect(a.deck_cards).toContain(70);
		const made = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, create_card: true, another_card: true });
		expect(BOARD_OUTPUTS.gantt_link_board_card.parse(made.structuredContent).link.card_title).toBe("A");
	});
	it("shows NoGantt's own name in a card title as NoGantt, framed like every other text", async () => {
		g.cards.set(72, { board_id: 21, readers: new Set([QA.a]), title: "From nc_gantt", owner: QA.a });
		const r = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, card_id: 72 });
		expect(BOARD_OUTPUTS.gantt_link_board_card.parse(r.structuredContent).link.card_title).toBe("From NoGantt");
	});
});
