/**
 * Contract tests for boards_set_due_date, boards_assign_card and boards_add_comment (DESIGN 17.3).
 * A separate file acting as the second QA account: the vault allows 30 writes a minute per person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeNc } from "../../fake-nc/index";
import type { FakeDeck } from "../../fake-nc/deck";
import { QA } from "../../helpers/index";
import { callTool, errorCode, expectSchema, setupDeck, WRITE_SCOPES } from "./helpers";

const ME = QA.b;
const OTHER = QA.a;
const act = (name: string, args: unknown, o: { scopes?: string[] } = {}) => callTool(name, args, { uid: ME, ...o });

let fake: FakeNc;
let deck: FakeDeck;
beforeEach(() => {
	({ fake, deck } = setupDeck());
});
afterEach(() => vi.restoreAllMocks());

const writes = () => fake.driveCalls().filter((r) => r.url.pathname.includes("/apps/deck/") && r.method !== "GET");

function board(o: { shareWith?: { uid: string; edit?: boolean }[]; archived?: boolean; owner?: string } = {}) {
	const b = deck.addBoard(o.owner ?? ME, "Board", { shareWith: o.shareWith, archived: o.archived });
	const todo = deck.addStack(b.id, "To do", { order: 0 });
	const done = deck.addStack(b.id, "Done", { order: 1, done: true });
	return { b, todo, done };
}

describe("boards_set_due_date", () => {
	it("writes the whole card back, so nothing else is lost (done and start date included)", async () => {
		const { b, done } = board();
		const c = deck.addCard(done.id, "Keep me", { description: "Notes", done: "2026-10-20T10:00:00+00:00", startdate: "2026-10-01T08:00:00+00:00", duedate: "2026-10-30T17:00:00+00:00", type: "text", order: 3 });
		fake.requests.length = 0;
		const r = await act("boards_set_due_date", { board_id: b.id, card_id: c.id, due: "2026-12-01T09:00:00Z" });
		expect(r.isError).toBeFalsy();
		expectSchema("boards_set_due_date", r);
		const put = writes();
		expect(put).toHaveLength(1);
		expect(put[0]?.url.pathname).toBe(`/index.php/apps/deck/api/v1.0/boards/${b.id}/stacks/${done.id}/cards/${c.id}`);
		expect(JSON.parse(put[0]?.body ?? "{}")).toEqual({
			title: "Keep me",
			type: "text",
			owner: ME,
			description: "Notes",
			order: 3,
			duedate: "2026-12-01T09:00:00.000Z",
			startdate: "2026-10-01T08:00:00+00:00",
			done: "2026-10-20T10:00:00+00:00",
		});
		const after = deck.cards.get(c.id);
		expect(after).toMatchObject({ done: "2026-10-20T10:00:00+00:00", startdate: "2026-10-01T08:00:00+00:00", description: "Notes", stackId: done.id });
		expect(r.structuredContent).toMatchObject({
			card: { due: "2026-12-01T09:00:00+00:00", done: true },
			previous_due: "2026-10-30T17:00:00+00:00",
			undo: { tool: "boards_set_due_date", arguments: { board_id: b.id, card_id: c.id, due: "2026-10-30T17:00:00+00:00" } },
		});
		expect(r.structuredContent.warnings).toBeUndefined();
	});
	it("null clears the due date; the field is required", async () => {
		const { b, todo } = board();
		const c = deck.addCard(todo.id, "Due", { duedate: "2026-10-30T17:00:00+00:00" });
		let r = await act("boards_set_due_date", { board_id: b.id, card_id: c.id, due: null });
		expect(JSON.parse(writes()[0]?.body ?? "{}").duedate).toBeNull();
		expect(r.structuredContent.card).toMatchObject({ due: null });
		expect(r.content[0]?.text.split("\n")[0]).toBe(`Card ${c.id} has no due date now.`);
		r = await act("boards_set_due_date", { board_id: b.id, card_id: c.id });
		expect(errorCode(r)).toBe("invalid_input");
		expect(r.content[0]?.text).toContain("due");
	});
	it("refuses archived cards and boards the person can only read", async () => {
		const { b, todo } = board();
		const arch = deck.addCard(todo.id, "Old", { archived: true });
		let r = await act("boards_set_due_date", { board_id: b.id, card_id: arch.id, due: "2026-12-01" });
		expect(errorCode(r)).toBe("invalid_input");
		const ro = board({ owner: OTHER, shareWith: [{ uid: ME, edit: false }] });
		const c = deck.addCard(ro.todo.id, "Theirs");
		r = await act("boards_set_due_date", { board_id: ro.b.id, card_id: c.id, due: "2026-12-01" });
		expect(errorCode(r)).toBe("permission_denied");
		expect(writes()).toHaveLength(0);
	});
});

describe("boards_assign_card", () => {
	it('assigns "me" and a member by id, and undo removes it again', async () => {
		const { b, todo } = board({ shareWith: [{ uid: OTHER }] });
		const c = deck.addCard(todo.id, "Task");
		let r = await act("boards_assign_card", { board_id: b.id, card_id: c.id, user_id: "me" }, { scopes: WRITE_SCOPES });
		expect(r.isError).toBeFalsy();
		expectSchema("boards_assign_card", r);
		let w = writes();
		expect(w[0]?.url.pathname).toBe(`/index.php/apps/deck/api/v1.0/boards/${b.id}/stacks/${todo.id}/cards/${c.id}/assignUser`);
		expect(JSON.parse(w[0]?.body ?? "{}")).toEqual({ userId: ME, type: 0 });
		expect(r.structuredContent).toMatchObject({ changed: true, undo: { tool: "boards_assign_card", arguments: { user_id: "me", unassign: true } } });
		r = await act("boards_assign_card", { board_id: b.id, card_id: c.id, user_id: `person:${OTHER}` });
		w = writes();
		expect(JSON.parse(w[1]?.body ?? "{}")).toEqual({ userId: OTHER, type: 0 });
		expect((r.structuredContent.card as { assignees: { id: string }[] }).assignees.map((x) => x.id)).toEqual([`person:${ME}`, `person:${OTHER}`]);
		r = await act("boards_assign_card", { board_id: b.id, card_id: c.id, user_id: `person:${OTHER}`, unassign: true });
		expect(writes()[2]?.url.pathname.endsWith("/unassignUser")).toBe(true);
		expect(deck.cards.get(c.id)?.assigned).toEqual([ME]);
	});
	it("someone who isn't on the board is refused before any call; assigning twice changes nothing", async () => {
		const { b, todo } = board();
		const c = deck.addCard(todo.id, "Task", { assigned: [ME] });
		let r = await act("boards_assign_card", { board_id: b.id, card_id: c.id, user_id: `person:${OTHER}` });
		expect(errorCode(r)).toBe("invalid_input");
		expect(r.content[0]?.text).toContain("isn't a member of board");
		r = await act("boards_assign_card", { board_id: b.id, card_id: c.id, user_id: "me" });
		expect(r.structuredContent).toMatchObject({ changed: false, undo: null });
		r = await act("boards_assign_card", { board_id: b.id, card_id: c.id, user_id: `person:${OTHER}`, unassign: true });
		expect(r.structuredContent).toMatchObject({ changed: false });
		expect(writes()).toHaveLength(0);
	});
	it("refuses ids with slashes, control characters or nothing usable", async () => {
		const { b, todo } = board();
		const c = deck.addCard(todo.id, "Task");
		for (const user_id of ["person:", "../x", "a/b", "x\u0000y", "group:admins"]) {
			const r = await act("boards_assign_card", { board_id: b.id, card_id: c.id, user_id });
			expect(errorCode(r), user_id).toBe("invalid_input");
		}
		expect(writes()).toHaveLength(0);
	});
});

describe("boards_add_comment", () => {
	it("posts the comment to the OCS route and returns its id", async () => {
		const { b, todo } = board();
		const c = deck.addCard(todo.id, "Task");
		const r = await act("boards_add_comment", { board_id: b.id, card_id: c.id, message: "Looks good @qa-t1-91" });
		expect(r.isError).toBeFalsy();
		expectSchema("boards_add_comment", r);
		const w = writes();
		expect(w).toHaveLength(1);
		expect(w[0]?.method).toBe("POST");
		expect(w[0]?.url.pathname).toBe(`/ocs/v2.php/apps/deck/api/v1.0/cards/${c.id}/comments`);
		expect(w[0]?.headers.get("ocs-apirequest")).toBe("true");
		expect(JSON.parse(w[0]?.body ?? "{}")).toEqual({ message: "Looks good @qa-t1-91" });
		expect(r.structuredContent).toMatchObject({ comment: { comment_id: deck.comments[0]?.id, created_at: "2026-10-25T10:00:00+00:00" }, card_id: c.id });
	});
	it("checks the length locally and refuses an empty message", async () => {
		const { b, todo } = board();
		const c = deck.addCard(todo.id, "Task");
		for (const message of ["", "   ", "m".repeat(1001)]) {
			const r = await act("boards_add_comment", { board_id: b.id, card_id: c.id, message });
			expect(errorCode(r)).toBe("invalid_input");
		}
		expect(writes()).toHaveLength(0);
	});
	it("a card on a board the person can't see is not found", async () => {
		const theirs = board({ owner: OTHER });
		const c = deck.addCard(theirs.todo.id, "Theirs");
		const r = await act("boards_add_comment", { board_id: theirs.b.id, card_id: c.id, message: "hi" });
		expect(errorCode(r)).toBe("not_found");
		expect(writes()).toHaveLength(0);
	});
});
