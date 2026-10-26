/** Contract tests for the boards tools that change things, against the fake Deck (DESIGN 17.3). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeNc } from "../../fake-nc/index";
import type { FakeDeck } from "../../fake-nc/deck";
import { devToken, mcpPost, QA } from "../../helpers/index";
import { callTool, errorCode, expectSchema, setupDeck } from "./helpers";

let fake: FakeNc;
let deck: FakeDeck;
beforeEach(() => {
	({ fake, deck } = setupDeck());
});
afterEach(() => vi.restoreAllMocks());

const writes = () => fake.driveCalls().filter((r) => r.url.pathname.includes("/apps/deck/") && r.method !== "GET");

function board(o: { shareWith?: { uid: string; edit?: boolean }[]; archived?: boolean; owner?: string } = {}) {
	const b = deck.addBoard(o.owner ?? QA.a, "Board", { shareWith: o.shareWith, archived: o.archived });
	const todo = deck.addStack(b.id, "To do", { order: 0 });
	const done = deck.addStack(b.id, "Done", { order: 1, done: true });
	return { b, todo, done };
}

describe("boards_create_card", () => {
	it("posts exactly title, type, order, description and duedate (never owner) to the named list", async () => {
		const { b, todo } = board();
		fake.requests.length = 0;
		const r = await callTool("boards_create_card", { board_id: b.id, stack_id: todo.id, title: "  Write the\nbrief  ", description: "Line one\r\nLine two\u0007", due: "2026-11-03T14:30:00+01:00" });
		expect(r.isError).toBeFalsy();
		expectSchema("boards_create_card", r);
		const post = writes();
		expect(post).toHaveLength(1);
		expect(post[0]?.method).toBe("POST");
		expect(post[0]?.url.pathname).toBe(`/index.php/apps/deck/api/v1.0/boards/${b.id}/stacks/${todo.id}/cards`);
		expect(post[0]?.headers.get("content-type")).toBe("application/json");
		expect(JSON.parse(post[0]?.body ?? "{}")).toEqual({ title: "Write the brief", type: "plain", order: 999, description: "Line one\nLine two", duedate: "2026-11-03T13:30:00.000Z" });
		expect(r.structuredContent.card).toMatchObject({ title: "Write the brief", stack_id: todo.id, board_id: b.id, due: "2026-11-03T13:30:00+00:00", assignees: [] });
		expect(r.content[0]?.text.split("\n")[0]).toMatch(/^Created card \d+ in list \d+ on board \d+\.$/);
	});
	it("a date alone means the end of that day in the person's time zone", async () => {
		// QA.b: the handler caches each person's zone for 10 minutes, and QA.a's is UTC in this file.
		const u = fake.users.get(QA.b);
		if (u) u.timezone = "Europe/Berlin";
		const { b, todo } = board({ owner: QA.b });
		const r = await callTool("boards_create_card", { board_id: b.id, stack_id: todo.id, title: "Due Tuesday", due: "2026-11-03" }, { uid: QA.b });
		expect(JSON.parse(writes()[0]?.body ?? "{}").duedate).toBe("2026-11-03T22:59:00.000Z");
		expect((r.structuredContent.card as { due: string }).due).toBe("2026-11-03T23:59:00+01:00");
	});
	it("assigns the person when asked", async () => {
		const { b, todo } = board();
		const r = await callTool("boards_create_card", { board_id: b.id, stack_id: todo.id, title: "Mine", assign_to_me: true });
		const assign = writes().find((x) => x.url.pathname.endsWith("/assignUser"));
		expect(assign?.method).toBe("PUT");
		expect(JSON.parse(assign?.body ?? "{}")).toEqual({ userId: QA.a, type: 0 });
		expect((r.structuredContent.card as { assignees: { id: string }[] }).assignees).toEqual([{ id: `person:${QA.a}`, display_name: "QA t1 91" }]);
	});
	it("the duplicate guard returns the first card for the same call within 10 minutes; allow_duplicate makes a second", async () => {
		const { b, todo } = board();
		const t = await devToken(QA.a);
		const args = { board_id: b.id, stack_id: todo.id, title: "Once" };
		const call = async (a: unknown) => (await (await import("../../helpers/index")).rpcResult(await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boards_create_card", arguments: a } }))).result as { content: { text: string }[]; structuredContent: { card: { card_id: number } } };
		const first = await call(args);
		const again = await call(args);
		expect(again.content[0]?.text).toMatch(/^This matches a call made 1 minute ago/);
		expect(again.structuredContent.card.card_id).toBe(first.structuredContent.card.card_id);
		expect(writes().filter((x) => x.method === "POST")).toHaveLength(1);
		const second = await call({ ...args, allow_duplicate: true });
		expect(second.structuredContent.card.card_id).not.toBe(first.structuredContent.card.card_id);
		expect(writes().filter((x) => x.method === "POST")).toHaveLength(2);
	});
	it("refuses a list from another board, an archived board and a read-only share, before writing", async () => {
		const one = board();
		const two = board();
		let r = await callTool("boards_create_card", { board_id: one.b.id, stack_id: two.todo.id, title: "x" });
		expect(errorCode(r)).toBe("not_found");
		expect(r.content[0]?.text).toContain(`Board ${one.b.id} has no list ${two.todo.id}.`);
		const arch = board({ archived: true });
		r = await callTool("boards_create_card", { board_id: arch.b.id, stack_id: arch.todo.id, title: "x" });
		expect(errorCode(r)).toBe("invalid_input");
		expect(r.content[0]?.text).toContain("is archived");
		const ro = board({ owner: QA.b, shareWith: [{ uid: QA.a, edit: false }] });
		r = await callTool("boards_create_card", { board_id: ro.b.id, stack_id: ro.todo.id, title: "x" });
		expect(errorCode(r)).toBe("permission_denied");
		expect(writes()).toHaveLength(0);
	});
	it("checks sizes and formats locally", async () => {
		const { b, todo } = board();
		for (const bad of [
			{ title: "" },
			{ title: "t".repeat(256) },
			{ title: "  \n " },
			{ title: "x", description: "d".repeat(10_001) },
			{ title: "x", due: "next Tuesday" },
			{ title: "x", due: "2026-02-30" },
			{ title: "x", owner: QA.b },
		]) {
			const r = await callTool("boards_create_card", { board_id: b.id, stack_id: todo.id, ...bad });
			expect(errorCode(r), JSON.stringify(bad)).toBe("invalid_input");
		}
		expect(writes()).toHaveLength(0);
	});
	it("needs the write scope: a read-only connection gets the step-up challenge", async () => {
		const { b, todo } = board();
		const t = await devToken(QA.a, { scopes: ["workspace.read"] });
		const res = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boards_create_card", arguments: { board_id: b.id, stack_id: todo.id, title: "x" } } });
		expect(res.status).toBe(403);
		expect(res.headers.get("www-authenticate")).toContain("insufficient_scope");
		expect(res.headers.get("www-authenticate")).toContain("workspace.write");
	});
});

describe("boards_move_card", () => {
	it("moves with the OCS reorder route (never the REST one) and reports where it came from", async () => {
		const { b, todo, done } = board();
		const a = deck.addCard(todo.id, "A", { order: 0 });
		deck.addCard(done.id, "X", { order: 0 });
		deck.addCard(done.id, "Y", { order: 1 });
		fake.requests.length = 0;
		const r = await callTool("boards_move_card", { board_id: b.id, card_id: a.id, to_stack_id: done.id });
		expect(r.isError).toBeFalsy();
		expectSchema("boards_move_card", r);
		const w = writes();
		expect(w).toHaveLength(1);
		expect(w[0]?.method).toBe("PUT");
		expect(w[0]?.url.pathname).toBe(`/ocs/v2.php/apps/deck/api/v1.0/cards/${a.id}/reorder`);
		expect(w[0]?.headers.get("ocs-apirequest")).toBe("true");
		expect(JSON.parse(w[0]?.body ?? "{}")).toEqual({ stackId: done.id, order: 2, boardId: b.id });
		expect(r.structuredContent).toMatchObject({
			from_stack_id: todo.id,
			card: { card_id: a.id, stack_id: done.id, done: true, order: 2 },
			undo: { tool: "boards_move_card", arguments: { board_id: b.id, card_id: a.id, to_stack_id: todo.id, position: "top" } },
		});
		expect(deck.cards.get(a.id)?.stackId).toBe(done.id);
	});
	it("top puts it first; moving out of the done list marks it not done", async () => {
		const { b, todo, done } = board();
		deck.addCard(todo.id, "T1", { order: 0 });
		const c = deck.addCard(done.id, "Finished", { done: "2026-10-20T10:00:00+00:00" });
		const r = await callTool("boards_move_card", { board_id: b.id, card_id: c.id, to_stack_id: todo.id, position: "top" });
		expect(JSON.parse(writes()[0]?.body ?? "{}").order).toBe(0);
		expect(r.structuredContent.card).toMatchObject({ stack_id: todo.id, done: false, order: 0 });
	});
	it("archived cards can't be moved, and a list on another board is not found", async () => {
		const { b, todo, done } = board();
		const arch = deck.addCard(todo.id, "Old", { archived: true });
		let r = await callTool("boards_move_card", { board_id: b.id, card_id: arch.id, to_stack_id: done.id });
		expect(errorCode(r)).toBe("invalid_input");
		expect(r.content[0]?.text).toContain("archived");
		const other = board();
		const c = deck.addCard(todo.id, "Live");
		r = await callTool("boards_move_card", { board_id: b.id, card_id: c.id, to_stack_id: other.todo.id });
		expect(errorCode(r)).toBe("not_found");
		r = await callTool("boards_move_card", { board_id: b.id, card_id: 424242, to_stack_id: done.id });
		expect(errorCode(r)).toBe("not_found");
		expect(writes()).toHaveLength(0);
	});
});
