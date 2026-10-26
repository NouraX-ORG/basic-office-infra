/**
 * Fix round 4 for lane G (DESIGN 25.9; the resumed run's second fix round), against the fake: imported
 * links that schedule the plan, NoGantt's task ids as a JSON list, the link counts, board_sync without
 * a board, titles with outer spaces, the undo wording for a change taken back already, lookups that
 * never match inherited keys, the card's own dates before use_plan, and the reworded backlink line of
 * a new card.
 *
 * Writes are split between the two QA people: each may make 30 a minute.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "../../../src/core/errors";
import { boardsSetDueDate } from "../../../src/tools/boards/write";
import { mapGanttError } from "../../../src/tools/gantt/api";
import { BOARD_OUTPUTS } from "../../../src/tools/gantt/board";
import { importedIds, LINK_TIME_BUDGET_MS, linkOrder, PROJECT_OUTPUTS } from "../../../src/tools/gantt/projects";
import { TASK_OUTPUTS } from "../../../src/tools/gantt/tasks";
import type { FakeGantt, GProject, GTask } from "../../fake-nc/gantt";
import type { FakeNc } from "../../fake-nc/index";
import { errCode, ganttCalls, QA, setup, tool } from "./_helpers";

let fake: FakeNc;
let g: FakeGantt;
beforeEach(() => {
	({ fake, g } = setup());
});
afterEach(() => vi.restoreAllMocks());

const D = (s: string | undefined) => (s ?? "").slice(0, 10);
const linkCalls = () => fake.driveCalls().filter((c) => c.method === "POST" && c.url.pathname.endsWith("/dependencies"));
const ocsFail = (status: number, message: string) => new Response(JSON.stringify({ ocs: { meta: { statuscode: status, message }, data: [] } }), { status });
const taskByTitle = (projectId: number, title: string) => [...g.tasks.values()].find((t) => t.project_id === projectId && t.title === title) as GTask;

describe("gantt_import_plan schedules its links (DESIGN 25.9 #1)", () => {
	it("sends the links through the link route, waiting tasks first after their predecessors, and the plan's dates follow them", async () => {
		const r = await tool("gantt_import_plan", {
			new_project_title: "Launch",
			start_date: "2026-11-02",
			items: [
				{ key: "t1", kind: "task", title: "One", start_date: "2026-11-02", end_date: "2026-11-03" },
				{ key: "t2", kind: "task", title: "Two" },
				{ key: "t3", kind: "task", title: "Three" },
			],
			// Given last link first: the tool sends them so each waiting task follows its predecessor.
			links: [
				{ from: "t2", to: "t3" },
				{ from: "t1", to: "t2" },
				{ from: "t1", to: "t2" },
			],
		});
		expect(r.isError).toBeFalsy();
		const d = PROJECT_OUTPUTS.gantt_import_plan.parse(r.structuredContent);
		// t1 has dates of its own, and t2 and t3 wait for a task, so none hangs on the start milestone (DESIGN 25.10).
		expect(d).toMatchObject({ tasks: 3, links: 2, links_not_added: 0, start_milestone_links: 0, milestones: 0 });
		const imp = fake.driveCalls().find((c) => c.url.pathname.endsWith("/structure-import"));
		expect(JSON.parse(imp?.body ?? "{}").dependencies).toEqual([]);
		expect(linkCalls()).toHaveLength(1);
		const sent = JSON.parse(linkCalls()[0]?.body ?? "{}").links as { task_id: number; predecessor_id: string }[];
		expect(sent).toEqual([
			{ task_id: d.task_ids.t2, predecessor_id: `t-${d.task_ids.t1}`, dependency_type: "EA", lag_days: 0 },
			{ task_id: d.task_ids.t3, predecessor_id: `t-${d.task_ids.t2}`, dependency_type: "EA", lag_days: 0 },
		]);
		// Every waiting task starts after the task it waits for ends.
		const [one, two, three] = [d.task_ids.t1, d.task_ids.t2, d.task_ids.t3].map((id) => g.tasks.get(id as number) as GTask);
		expect(D(two?.start_date) > D(one?.end_date)).toBe(true);
		expect(D(three?.start_date) > D(two?.end_date)).toBe(true);
		expect(r.content[0]?.text.split("\n")[0]).toContain("with 2 links (tasks that wait now start after the tasks they wait for)");
	});
	it("refuses links that make a loop before anything is written, and drops repeats", async () => {
		const loop = [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
			{ from: "c", to: "a" },
		];
		expect(() => linkOrder(loop)).toThrow(ToolError);
		expect(linkOrder([{ from: "a", to: "b" }, { from: "a", to: "b" }, { from: "x", to: "a" }])).toEqual([
			{ from: "x", to: "a" },
			{ from: "a", to: "b" },
		]);
		const items = ["a", "b", "c"].map((k) => ({ key: k, kind: "task", title: k.toUpperCase() }));
		const r = await tool("gantt_import_plan", { new_project_title: "Loop", start_date: "2026-11-02", items, links: loop }, { uid: QA.b });
		expect(errCode(r)).toBe("invalid_input");
		expect(r.content[0]?.text).toContain("make a loop");
		expect(ganttCalls(fake)).toEqual([]);
		expect(g.imports).toBe(0);
	});
	it("keeps the imported plan and says so when the link step fails", async () => {
		const items = ["a", "b"].map((k) => ({ key: k, kind: "task", title: k.toUpperCase() }));
		fake.on("POST", /\/projects\/\d+\/dependencies$/, () => ocsFail(500, "internal_error"));
		const r = await tool("gantt_import_plan", { new_project_title: "Half", start_date: "2026-11-02", items, links: [{ from: "a", to: "b" }] });
		expect(r.isError).toBeFalsy();
		const d = PROJECT_OUTPUTS.gantt_import_plan.parse(r.structuredContent);
		expect(d).toMatchObject({ tasks: 2, links: 0, links_not_added: 1 });
		expect(Object.keys(d.task_ids).sort()).toEqual(["a", "b"]);
		expect(r.structuredContent.warnings).toContain(
			"The tasks and phases were imported, but NoGantt didn't confirm 1 link; gantt_get_project shows which are there, and gantt_link_tasks adds the rest (it skips links that exist).",
		);
		// A refusal is named in plain words, without NoGantt's code or the task's title.
		fake.on("POST", /\/projects\/\d+\/dependencies$/, () => ocsFail(400, "negative_float:Secret title"));
		const n = await tool("gantt_import_plan", { new_project_title: "Half 2", start_date: "2026-11-02", items, links: [{ from: "a", to: "b" }] });
		const w = (n.structuredContent.warnings as string[]).find((x) => x.includes("couldn't be added"));
		// The remedy is the one that works for that refusal, not gantt_link_tasks (DESIGN 25.10).
		expect(w).toBe(
			"The tasks and phases were imported, but 1 link couldn't be added: That would make a task in this plan miss a fixed milestone (its slack would drop below zero). A one-day task that starts with a fixed milestone is due that day: gantt_update_task with depends_on on the waiting task replaces its links, the milestone link too. Or move the milestone in NoGantt.",
		);
		expect(w).not.toContain("gantt_link_tasks");
		expect(JSON.stringify(n)).not.toContain("Secret title");
		expect(JSON.stringify(n)).not.toContain("negative_float");
	});
	it("sends 100 links per call, counts the second call as one more write, and stops when NoGantt is slow", async () => {
		const as = { uid: QA.b };
		const items = Array.from({ length: 151 }, (_, i) => ({ key: `k${i}`, kind: "task", title: `T${i}` }));
		// A star: k0 first, the other 150 wait for it.
		const links = items.slice(1).map((it) => ({ from: "k0", to: it.key }));
		const r = await tool("gantt_import_plan", { new_project_title: "Star", start_date: "2026-11-02", items, links }, as);
		expect(r.isError).toBeFalsy();
		expect(linkCalls().map((c) => (JSON.parse(c.body ?? "{}").links as unknown[]).length)).toEqual([100, 50]);
		expect(PROJECT_OUTPUTS.gantt_import_plan.parse(r.structuredContent)).toMatchObject({ links: 150, links_not_added: 0 });
		// The first link call takes longer than the time left: the rest isn't sent, and the answer says so.
		const route = fake.routes.find((x) => x.method === "POST" && x.path.source.includes("dependencies"));
		if (!route) throw new Error("no link route in the fake");
		const realNow = Date.now.bind(Date);
		fake.on("POST", route.path, (req, f, m) => {
			vi.spyOn(Date, "now").mockImplementation(() => realNow() + LINK_TIME_BUDGET_MS + 1_000);
			return route.handler(req, f, m);
		});
		fake.requests.length = 0;
		const slow = await tool("gantt_import_plan", { new_project_title: "Star 2", start_date: "2026-11-02", items, links }, as);
		vi.restoreAllMocks();
		expect(linkCalls()).toHaveLength(1);
		expect(PROJECT_OUTPUTS.gantt_import_plan.parse(slow.structuredContent)).toMatchObject({ links: 100, links_not_added: 50 });
		expect(slow.structuredContent.warnings).toContain("NoGantt is slow right now, so 50 links weren't added; gantt_link_tasks adds them by task id (task_ids).");
	});
});

describe("gantt_import_plan task ids (DESIGN 25.9 #2)", () => {
	it("reads NoGantt's JSON list for the keys 0, 1, 2 and links them", async () => {
		const items = ["0", "1", "2"].map((k) => ({ key: k, kind: "task", title: `Step ${k}` }));
		const r = await tool("gantt_import_plan", { new_project_title: "Numbered", start_date: "2026-11-02", items, links: [{ from: "0", to: "1" }, { from: "1", to: "2" }] });
		const d = PROJECT_OUTPUTS.gantt_import_plan.parse(r.structuredContent);
		expect(Object.keys(d.task_ids)).toEqual(["0", "1", "2"]);
		expect(d.task_ids["0"]).toBe(taskByTitle(d.project_id, "Step 0").id);
		expect(d.task_ids["2"]).toBe(taskByTitle(d.project_id, "Step 2").id);
		expect(d).toMatchObject({ links: 2, links_not_added: 0 });
		expect(D(taskByTitle(d.project_id, "Step 2").start_date) > D(taskByTitle(d.project_id, "Step 1").end_date)).toBe(true);
	});
	it("maps a list, an object and anything else the same way, keeping only task keys that were sent", () => {
		const kinds = new Map<string, "task" | "phase">([
			["0", "task"],
			["1", "task"],
			["p", "phase"],
			["x", "task"],
		]);
		expect(Object.fromEntries(importedIds([100, 101], kinds))).toEqual({ "0": 100, "1": 101 });
		expect(Object.fromEntries(importedIds({ "1": 5, x: 6, p: 7, zz: 8, constructor: 9 }, kinds))).toEqual({ "1": 5, x: 6 });
		expect(importedIds(null, kinds).size).toBe(0);
		expect(importedIds("nope", kinds).size).toBe(0);
		expect(Object.fromEntries(importedIds({ x: "6", "0": -1, "1": 1.5 }, kinds))).toEqual({});
	});
});

describe("gantt_update_project board_sync without a board (DESIGN 25.9 #4)", () => {
	it("refuses a level NoGantt would set back to off, and writes nothing", async () => {
		const as = { uid: QA.b };
		const p = g.addProject(QA.b);
		fake.requests.length = 0;
		const r = await tool("gantt_update_project", { project_id: p.id, board_sync: "write" }, as);
		expect(errCode(r)).toBe("not_available");
		expect(r.content[0]?.text).toContain(`NoGantt project ${p.id} isn't linked to a NoBoard board, so board_sync can't be set; give board_id too.`);
		g.boards.set(21, { title: "Board", readers: new Set([QA.b]), editors: new Set([QA.b]) });
		p.deck_board_id = 21;
		p.deck_sync_level = "read";
		const unlink = await tool("gantt_update_project", { project_id: p.id, board_id: null, board_sync: "write" }, as);
		expect(errCode(unlink)).toBe("invalid_input");
		expect(fake.driveCalls().some((c) => c.method === "PUT")).toBe(false);
		// Unlinking with off, and a level with the board given, still work.
		const off = await tool("gantt_update_project", { project_id: p.id, board_id: null, board_sync: "off" }, as);
		expect(off.isError).toBeFalsy();
		expect(off.structuredContent.project.board).toBeNull();
		const both = await tool("gantt_update_project", { project_id: p.id, board_id: 21, board_sync: "write" }, as);
		expect(both.structuredContent.project.board).toEqual({ board_id: 21, sync: "write" });
	});
});

describe("titles with spaces at either end (DESIGN 25.9 #5)", () => {
	it("aren't changed, because the undo would drop the spaces; other fields still change", async () => {
		const p = g.addProject(QA.a, { title: "Plan " });
		const t = g.addTask(p.id, { title: " Task" });
		fake.requests.length = 0;
		const task = await tool("gantt_update_task", { project_id: p.id, task_id: t.id, title: "Task" });
		expect(errCode(task)).toBe("not_available");
		expect(task.content[0]?.text).toContain("This task's title starts or ends with spaces, which the undo would drop, so changing it here couldn't be undone. Nothing was changed.");
		const proj = await tool("gantt_update_project", { project_id: p.id, title: "Plan" });
		expect(errCode(proj)).toBe("not_available");
		expect(proj.content[0]?.text).toContain("This project's title starts or ends with spaces");
		expect(fake.driveCalls().some((c) => c.method === "PUT")).toBe(false);
		const status = await tool("gantt_update_task", { project_id: p.id, task_id: t.id, status: "in_progress" });
		expect(status.isError).toBeFalsy();
		// Notes aren't trimmed by the input, so spaces there are written back exactly.
		t.description = "Notes  ";
		const notes = await tool("gantt_update_task", { project_id: p.id, task_id: t.id, notes: "New" });
		expect(notes.structuredContent.undo.arguments.notes).toBe("Notes  ");
	});
});

describe("gantt_undo_change taken back already (DESIGN 25.9 #6)", () => {
	it("says the change may have been taken back already, without claiming a task is gone", async () => {
		const as = { uid: QA.b };
		const p = g.addProject(QA.b);
		const a = g.addTask(p.id, { title: "A" });
		const b = g.addTask(p.id, { title: "B", start_date: "2026-11-03 00:00:00", end_date: "2026-11-04 00:00:00" });
		const link = await tool("gantt_link_tasks", { project_id: p.id, links: [{ task_id: b.id, after_task_id: a.id }] }, as);
		const op = link.structuredContent.undo.arguments.op_id as string;
		expect((await tool("gantt_undo_change", { op_id: op }, as)).isError).toBeFalsy();
		const again = await tool("gantt_undo_change", { op_id: op }, as);
		expect(errCode(again)).toBe("conflict");
		expect(again.content[0]?.text.split("\n")[0]).toBe(
			"Something in that change (a task, a link or a phase) no longer exists, or the change was taken back already, so it can't be taken back.",
		);
		expect(g.tasks.has(a.id) && g.tasks.has(b.id)).toBe(true);
	});
});

describe("lookups never match inherited keys (DESIGN 25.9 #7)", () => {
	it("maps codes such as constructor or __proto__ like any unknown code", () => {
		for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
			const e = new ToolError("invalid_input", "x", { upstreamStatus: 400, detail: JSON.stringify({ ocs: { meta: { statuscode: 400, message: code }, data: [] } }) });
			const m = mapGanttError(e, "POST", {});
			expect([m.code, m.message], code).toEqual(["invalid_input", "NoGantt didn't accept that."]);
			const f = mapGanttError(new ToolError("permission_denied", "x", { upstreamStatus: 403, detail: JSON.stringify({ ocs: { meta: { statuscode: 403, message: code }, data: [] } }) }), "PUT", {});
			expect(f.code, code).toBe("permission_denied");
			expect(f.message.length).toBeGreaterThan(10);
		}
	});
	it("an undo's kinds, a card's dates and a share's kind fall back to their plain words", async () => {
		const p = g.addProject(QA.a);
		const a = g.addTask(p.id, { title: "A" });
		fake.on("POST", /\/changes\/[0-9a-f-]{36}\/revert$/, () =>
			Response.json({ ocs: { meta: { statuscode: 200, message: "OK" }, data: { reverted_count: 1, task_ids: [], entity_types: ["constructor", "__proto__"], deck: null } } }),
		);
		const u = await tool("gantt_undo_change", { op_id: "00000000-0000-4000-8000-0000000000aa" });
		expect(TASK_OUTPUTS.gantt_undo_change.parse(u.structuredContent).kinds).toEqual(["other"]);
		g.boards.set(21, { title: "Board", readers: new Set([QA.a]), editors: new Set([QA.a]) });
		g.cards.set(50, { board_id: 21, readers: new Set([QA.a]) });
		p.deck_board_id = 21;
		p.deck_sync_level = "read";
		fake.on("POST", /\/tasks\/\d+\/deck-links$/, () => Response.json({ ocs: { meta: { statuscode: 201, message: "OK" }, data: { id: 1, task_id: a.id, card_id: 50, board_id: 21, dates: "constructor" } } }, { status: 201 }));
		const l = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, card_id: 50 });
		expect(BOARD_OUTPUTS.gantt_link_board_card.parse(l.structuredContent).card_dates).toBe("unknown");
		g.shares.set(7, { id: 7, project_id: p.id, principal_id: "x", principal_type: "constructor", permission: "viewer" });
		const s = await tool("gantt_share_project", { project_id: p.id, action: "list" });
		expect(s.structuredContent.shares[0].with.kind).toBe("person");
	});
});

describe("gantt_link_board_card gives back a card's own dates (DESIGN 25.9 #3)", () => {
	let p: GProject;
	let a: GTask;
	beforeEach(() => {
		p = g.addProject(QA.a, { deck_board_id: 21, deck_sync_level: "write_confirm" });
		a = g.addTask(p.id, { title: "A", description: "Notes for the card" });
		g.boards.set(21, { title: "Board", readers: new Set([QA.a, QA.b]), editors: new Set([QA.a]) });
	});
	it("reads the card first with use_plan, returns its old dates and an undo that boards_set_due_date takes", async () => {
		g.cards.set(50, { board_id: 21, readers: new Set([QA.a]), duedate: "2026-12-24T17:00:00+00:00", startdate: "2026-12-20T09:00:00+00:00", owner: QA.a });
		fake.requests.length = 0;
		const r = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, card_id: 50, card_dates: "use_plan" });
		expect(r.isError).toBeFalsy();
		const calls = fake.driveCalls().map((c) => `${c.method} ${c.url.pathname}`);
		const read = calls.findIndex((c) => c.startsWith("GET /index.php/apps/deck/api/v1.0/boards/21/stacks/") && c.endsWith("/cards/50"));
		const link = calls.findIndex((c) => c.endsWith(`/tasks/${a.id}/deck-links`));
		expect(read).toBeGreaterThanOrEqual(0);
		expect(read).toBeLessThan(link);
		const d = BOARD_OUTPUTS.gantt_link_board_card.parse(r.structuredContent);
		expect(d.card_dates).toBe("plan_written");
		expect(Date.parse(d.previous_card_dates?.due ?? "")).toBe(Date.parse("2026-12-24T17:00:00+00:00"));
		expect(Date.parse(d.previous_card_dates?.start ?? "")).toBe(Date.parse("2026-12-20T09:00:00+00:00"));
		const undo = r.structuredContent.undo as { tool: string; arguments: Record<string, unknown> };
		expect(undo).toEqual({ tool: "boards_set_due_date", arguments: { board_id: 21, card_id: 50, due: d.previous_card_dates?.due } });
		expect(boardsSetDueDate.input.safeParse(undo.arguments).success).toBe(true);
		expect((r.structuredContent.warnings as string[]).some((w) => w.startsWith("The undo puts back only the card's due date; NoBoard itself can set its start date back (it was "))).toBe(true);
		// NoGantt wrote the plan's dates into the card.
		expect(D(g.cards.get(50)?.duedate ?? "")).toBe(D(a.end_date));
	});
	it("with keep, a card without dates gets the plan's on a write level: none before, and the undo clears the due date", async () => {
		g.cards.set(52, { board_id: 21, readers: new Set([QA.a]), owner: QA.a });
		const r = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, card_id: 52 });
		const d = BOARD_OUTPUTS.gantt_link_board_card.parse(r.structuredContent);
		expect([d.card_dates, d.previous_card_dates]).toEqual(["plan_written", { start: null, due: null }]);
		expect(r.structuredContent.undo).toEqual({ tool: "boards_set_due_date", arguments: { board_id: 21, card_id: 52, due: null } });
		// A differing card with keep is only compared: nothing to give back.
		g.cards.set(53, { board_id: 21, readers: new Set([QA.a]), duedate: "2026-12-24T17:00:00+00:00", owner: QA.a });
		const k = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, card_id: 53 });
		expect([k.structuredContent.card_dates, k.structuredContent.previous_card_dates, k.structuredContent.undo]).toEqual(["different", null, null]);
	});
	it("says so when the card's dates couldn't be read first", async () => {
		g.cards.set(50, { board_id: 21, readers: new Set([QA.a]), duedate: "2026-12-24T17:00:00+00:00", owner: QA.a });
		fake.on("GET", /^\/index\.php\/apps\/deck\/api\/v1\.0\/boards\/21$/, () => Response.json({ status: 500, message: "boom" }, { status: 500 }));
		const r = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, card_id: 50, card_dates: "use_plan" });
		expect(r.isError).toBeFalsy();
		expect([r.structuredContent.previous_card_dates, r.structuredContent.undo]).toEqual([null, null]);
		expect(r.structuredContent.warnings).toContain("The card's own dates were replaced by the plan's and couldn't be read first, so this can't be undone here.");
	});
	it("rewords NoGantt's German line in a new card and keeps the rest of the card", async () => {
		const r = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, create_card: true });
		expect(r.isError).toBeFalsy();
		const id = r.structuredContent.link.card_id as number;
		const card = g.cards.get(id);
		expect(card?.description).toBe(`Notes for the card\n\nPlanned in NoGantt: https://drive.nourax.org/apps/nc_gantt/?project=${p.id}&task=${a.id}`);
		expect([D(card?.duedate ?? ""), D(card?.startdate ?? "")]).toEqual([D(a.end_date), D(a.start_date)]);
		expect(g.cardPuts).toBe(1);
		expect(r.structuredContent.warnings ?? []).toEqual([]);
		expect(r.structuredContent.previous_card_dates).toBeNull();
		expect(r.structuredContent.undo).toBeNull();
	});
	it("warns, without naming the upstream app, when the line couldn't be changed", async () => {
		// The person may make cards through NoGantt but the fake board refuses their card update.
		g.boards.set(21, { title: "Board", readers: new Set([QA.a]), editors: new Set() });
		const r = await tool("gantt_link_board_card", { project_id: p.id, task_id: a.id, create_card: true });
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent.warnings).toEqual(["NoGantt ended the new card's description with a link line in German; it can be changed in NoBoard."]);
		expect(JSON.stringify(r)).not.toMatch(/nc_gantt|geplant/i);
	});
});
