/**
 * Fix round 3 for lane G (DESIGN 25.8), against the fake: one answer from gantt_undo_change for an
 * unknown undo id and for one the person may not take back; a made-up example id; the undo summary
 * in tasks, not NoGantt's field entries; and the board level when gantt_update_project links a board.
 * The share role rules are in fix3-share.test.ts (the share bucket allows 10 calls a minute).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tools as ganttTools } from "../../../src/tools/gantt/index";
import { EXAMPLE_OP_ID, TASK_OUTPUTS, undoSummary } from "../../../src/tools/gantt/tasks";
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
	p = g.addProject(QA.a, { title: "Plan" });
	a = g.addTask(p.id, { title: "A", start_date: "2026-11-02 00:00:00", end_date: "2026-11-06 00:00:00" });
	b = g.addTask(p.id, { title: "B", start_date: "2026-11-09 00:00:00", end_date: "2026-11-13 00:00:00" });
});
afterEach(() => vi.restoreAllMocks());

const SENTENCE = "There's no change with that undo id that this person may take back (taking one back needs the editor role on its project).";
const HINT = "Undo ids come from gantt_update_task, gantt_link_tasks and gantt_update_project.";

/** A link that moves B (it waits four days after A ends; the fake counts calendar days), as QA.a; returns its op_id. */
async function linkOp(): Promise<string> {
	const r = await tool("gantt_link_tasks", { project_id: p.id, links: [{ task_id: b.id, after_task_id: a.id, lag_days: 4 }] });
	expect(r.isError).toBeFalsy();
	expect(r.structuredContent.moved_total).toBe(1);
	return r.structuredContent.undo.arguments.op_id as string;
}

describe("gantt_undo_change: unknown and not allowed get one answer (DESIGN 25.1 and 25.8)", () => {
	it("someone outside the project, a viewer and an unknown id all get the same not_found, and nothing changes", async () => {
		const op = await linkOp();
		const outsider = await tool("gantt_undo_change", { op_id: op }, { uid: QA.b });
		const unknown = await tool("gantt_undo_change", { op_id: "00000000-0000-4000-8000-0000000000ef" }, { uid: QA.b });
		g.shares.set(901, { id: 901, project_id: p.id, principal_id: QA.b, principal_type: "user", permission: "viewer" });
		const viewer = await tool("gantt_undo_change", { op_id: op }, { uid: QA.b });
		for (const r of [outsider, unknown, viewer]) {
			expect(errCode(r)).toBe("not_found");
			expect(r._meta?.["nourax/error"]?.field).toBe("op_id");
			expect(r.content[0]?.text.split("\n")[0]).toBe(`${SENTENCE} ${HINT}`);
			expect(r.content[0]?.text).not.toContain("isn't allowed");
		}
		// Byte for byte the same, hint included: nothing tells "exists" from "doesn't".
		expect(outsider.content[0]?.text).toBe(unknown.content[0]?.text);
		expect(viewer.content[0]?.text).toBe(unknown.content[0]?.text);
		expect(outsider._meta).toEqual(unknown._meta);
		// The change is still there for the owner to take back.
		expect(g.tasks.get(b.id)?.start_date).not.toBe("2026-11-09 00:00:00");
		const back = await tool("gantt_undo_change", { op_id: op });
		expect(back.isError).toBeFalsy();
		expect(g.tasks.get(b.id)?.start_date).toBe("2026-11-09 00:00:00");
		// Several dev tokens and calls: fine alone (under 2 s), slow under the full parallel run (fix round 3).
	}, 90_000);
	it("a plain 404 without NoGantt's code gets the same sentence; a conflict and NoGantt off keep their own", async () => {
		fake.on("POST", /\/changes\/[0-9a-f-]{36}\/revert$/, () => new Response(JSON.stringify({ ocs: { meta: { statuscode: 404, message: "" }, data: [] } }), { status: 404 }));
		const plain = await tool("gantt_undo_change", { op_id: "00000000-0000-4000-8000-000000000001" });
		expect([errCode(plain), plain.content[0]?.text.split("\n")[0]]).toEqual(["not_found", `${SENTENCE} ${HINT}`]);
		fake.on("POST", /\/changes\/[0-9a-f-]{36}\/revert$/, () => new Response(JSON.stringify({ ocs: { meta: { statuscode: 998, message: "" }, data: [] } }), { status: 404 }));
		expect(errCode(await tool("gantt_undo_change", { op_id: "00000000-0000-4000-8000-000000000002" }))).toBe("not_available");
		fake.on("POST", /\/changes\/[0-9a-f-]{36}\/revert$/, () => new Response(JSON.stringify({ ocs: { meta: { statuscode: 409, message: "conflict" }, data: [] } }), { status: 409 }));
		expect(errCode(await tool("gantt_undo_change", { op_id: "00000000-0000-4000-8000-000000000003" }))).toBe("conflict");
	});
	it("refuses a malformed id with a made-up example, which is no real change", async () => {
		fake.requests.length = 0;
		const r = await tool("gantt_undo_change", { op_id: "5fe72ff2-not-a-real-id" });
		expect(errCode(r)).toBe("invalid_input");
		expect(r.content[0]?.text).toContain(EXAMPLE_OP_ID);
		expect(EXAMPLE_OP_ID).toBe("00000000-0000-4000-8000-000000000000");
		expect(ganttCalls(fake)).toEqual([]);
		// Copying the example finds nothing.
		const copied = await tool("gantt_undo_change", { op_id: EXAMPLE_OP_ID });
		expect(errCode(copied)).toBe("not_found");
	});
});

describe("gantt_undo_change: the summary counts tasks, not NoGantt's field entries (DESIGN 25.8)", () => {
	it("a link that moved one task reads as one task's dates and the links", async () => {
		const op = await linkOp();
		const r = await tool("gantt_undo_change", { op_id: op });
		const d = TASK_OUTPUTS.gantt_undo_change.parse(r.structuredContent);
		// The fake, like NoGantt, logs B's start and end apart, plus the new link: 3 entries.
		expect(d.reverted_entries).toBe(3);
		expect([d.task_ids, d.task_ids_total, d.kinds]).toEqual([[b.id], 1, ["task dates", "links"]]);
		expect(r.content[0]?.text.split("\n")[0]).toBe("Took back the NoGantt change: the dates of 1 task and the links it added or changed.");
		expect(r.structuredContent).not.toHaveProperty("reverted_changes");
	});
	it("a planning-period change reads as the project's planning period", async () => {
		const u = await tool("gantt_update_project", { project_id: p.id, plan_start: "2026-11-02", plan_end: "2026-12-18" });
		const r = await tool("gantt_undo_change", u.structuredContent.undo.arguments);
		expect(r.isError).toBeFalsy();
		expect(r.content[0]?.text.split("\n")[0]).toBe("Took back the NoGantt change: the project's planning period.");
	});
	it("words every kind NoGantt names", () => {
		expect(undoSummary(0, [])).toBe("Took back the NoGantt change.");
		expect(undoSummary(3, ["task dates"])).toBe("Took back the NoGantt change: the dates of 3 tasks.");
		expect(undoSummary(0, ["task dates"])).toBe("Took back the NoGantt change: task dates.");
		expect(undoSummary(0, ["links"])).toBe("Took back the NoGantt change: the links it added or changed.");
		expect(undoSummary(2, ["task dates", "links", "phase planning period", "other"])).toBe(
			"Took back the NoGantt change: the dates of 2 tasks, the links it added or changed, a phase's planning period and other plan details.",
		);
	});
});

describe("gantt_update_project: the board level when a board is linked (DESIGN 25.3 and 25.8)", () => {
	beforeEach(() => {
		g.boards.set(21, { title: "Team board", readers: new Set([QA.a]), editors: new Set([QA.a]) });
		g.boards.set(23, { title: "Other board", readers: new Set([QA.a]), editors: new Set([QA.a]) });
		p.deck_board_id = 21;
		p.deck_sync_level = "write_silent";
	});
	const put = () => JSON.parse(fake.driveCalls().find((c) => c.method === "PUT")?.body ?? "{}");
	it("linking another board without board_sync sets read, though the old board wrote; the undo puts both back", async () => {
		fake.requests.length = 0;
		const r = await tool("gantt_update_project", { project_id: p.id, board_id: 23 });
		expect(r.isError).toBeFalsy();
		expect(put()).toEqual({ deck_board_id: 23, deck_sync_level: "read" });
		expect(r.structuredContent.project.board).toEqual({ board_id: 23, sync: "read" });
		expect(r.structuredContent.undo).toEqual({ tool: "gantt_update_project", arguments: { project_id: p.id, board_id: 21, board_sync: "write" } });
		expect(r.structuredContent.warnings ?? []).not.toContain("NoGantt now writes plan dates into the linked NoBoard cards when tasks move.");
	});
	it("giving the board already linked keeps its level; board_sync given always wins", async () => {
		fake.requests.length = 0;
		const same = await tool("gantt_update_project", { project_id: p.id, board_id: 21 });
		expect(put()).toEqual({ deck_board_id: 21 });
		expect(same.structuredContent.project.board).toEqual({ board_id: 21, sync: "write" });
		fake.requests.length = 0;
		const given = await tool("gantt_update_project", { project_id: p.id, board_id: 23, board_sync: "write_with_confirmation" });
		expect(put()).toEqual({ deck_board_id: 23, deck_sync_level: "write_confirm" });
		expect(given.structuredContent.project.board).toEqual({ board_id: 23, sync: "write_with_confirmation" });
	});
	it("says so in its description, without the old claim", () => {
		const d = ganttTools.find((t) => t.name === "gantt_update_project")?.description ?? "";
		expect(d).toContain("Linking another board without board_sync sets read; the board already linked keeps its level.");
		expect(d).not.toContain("turns it to read");
	});
});
