/**
 * Lane E live cases (DESIGN 17.6): every boards tool and workspace_overview for real, through
 * wrangler dev on :8840 with dev-only auth, as qa-t1-27 against drive.nourax.org. With privacy
 * between organisations on, a board can only be shared within an organisation or team, and the local
 * QA accounts are in none (Task 6's OrgShareMiddleware refuses the share), so qa-t1-24 serves as
 * the person who is not a member. Setup makes one QA board straight through the Deck API; nothing else
 * of the account is changed. At the end the QA board is archived (not deleted: rule 3); it goes on
 * the owner's deletion list. Deck's first-run board of qa-t1-27 is only read (the brand mapping).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deck, devToken, rpc, RUN, tool } from "./client-e";

const UID = "qa-t1-27";
const OTHER = "qa-t1-24";

interface DeckBoardJ {
	id: number;
	title: string;
	color: string;
}
interface DeckStackJ {
	id: number;
	title: string;
}
interface DeckCardJ {
	id: number;
	stackId: number;
	description: string;
	done: string | null;
	duedate: string | null;
	startdate: string | null;
	assignedUsers: { participant: { uid: string } }[];
}

let token = "";
let board: DeckBoardJ;
let todo: DeckStackJ;
let doing: DeckStackJ;
let done: DeckStackJ;
let keeper: DeckCardJ;

beforeAll(async () => {
	token = (await devToken(UID, { scopes: ["workspace.read", "workspace.write"] })).access_token;
	board = await deck<DeckBoardJ>(UID, "POST", "/boards", { title: `MCP-QA-${RUN} lane E`, color: "2563eb" });
	todo = await deck<DeckStackJ>(UID, "POST", `/boards/${board.id}/stacks`, { title: "To do", order: 0 });
	doing = await deck<DeckStackJ>(UID, "POST", `/boards/${board.id}/stacks`, { title: "Doing", order: 1 });
	done = await deck<DeckStackJ>(UID, "POST", `/boards/${board.id}/stacks`, { title: "Done", order: 2 });
	await deck(UID, "PUT", `/ocs/v2.php/apps/deck/api/v1.0/stacks/${done.id}/done`, { boardId: board.id, isDone: true });
	keeper = await deck<DeckCardJ>(UID, "POST", `/boards/${board.id}/stacks/${doing.id}/cards`, {
		title: "Keep my other fields",
		type: "plain",
		order: 0,
		description: "Line one\n\nLine two, written by the setup.",
		startdate: "2026-11-02T08:00:00+00:00",
	});
});

afterAll(async () => {
	// Archive, never delete (brief rule 3): the owner removes QA data later.
	if (board?.id) await deck(UID, "PUT", `/boards/${board.id}`, { title: board.title, color: board.color, archived: true }).catch(() => undefined);
});

describe("live: boards (qa-t1-27)", () => {
	it("boards_list and boards_get_board show Deck's first-run board in Nourax words only", async () => {
		const list = await tool(token, "boards_list", {});
		expect(list.isError).toBeFalsy();
		const boards = list.structuredContent.boards as { board_id: number; title: string }[];
		expect(boards.some((b) => b.board_id === board.id)).toBe(true);
		const welcome = boards.find((b) => b.title === "Welcome to NoBoard!");
		expect(welcome).toBeTruthy();
		const view = await tool(token, "boards_get_board", { board_id: welcome?.board_id });
		const cards = (view.structuredContent.stacks as { cards: { card_id: number; description: string | null }[] }[]).flatMap((s) => s.cards);
		expect(cards.length).toBeGreaterThanOrEqual(5);
		const first = cards.find((c) => c.description?.startsWith("## Welcome to NoBoard!"));
		expect(first).toBeTruthy();
		const full = await tool(token, "boards_get_card", { board_id: welcome?.board_id, card_id: first?.card_id });
		expect((full.structuredContent.card as { description: string }).description).toContain("NoBoard is the kanban board of Nourax Workspace.");
	});

	it("boards_get_board shows the QA board's lists in order, its done list and its one member", async () => {
		const r = await tool(token, "boards_get_board", { board_id: board.id });
		const stacks = r.structuredContent.stacks as { stack_id: number; title: string; is_done_list: boolean }[];
		expect(stacks.map((s) => s.title)).toEqual(["To do", "Doing", "Done"]);
		expect(stacks[2]?.is_done_list).toBe(true);
		expect((r.structuredContent.members as { id: string }[]).map((m) => m.id)).toEqual([`person:${UID}`]);
	});

	it("boards_create_card: a date alone is due at the end of that day in the person's zone; assign_to_me works", async () => {
		const who = await tool(token, "workspace_whoami", {});
		const zone = String(who.structuredContent.time_zone);
		const r = await tool(token, "boards_create_card", { board_id: board.id, stack_id: todo.id, title: `Live card ${RUN}`, description: "From the live test.", due: "2026-11-20", assign_to_me: true });
		expect(r.isError).toBeFalsy();
		const card = r.structuredContent.card as { card_id: number; due: string; assignees: { id: string }[] };
		expect(card.assignees.map((a) => a.id)).toEqual([`person:${UID}`]);
		expect(card.due.startsWith("2026-11-20T23:59:00")).toBe(true);
		const stored = await deck<DeckCardJ>(UID, "GET", `/boards/${board.id}/stacks/${todo.id}/cards/${card.card_id}`);
		expect(Date.parse(stored.duedate ?? "")).toBe(Date.parse(card.due));
		expect(stored.assignedUsers.map((a) => a.participant.uid)).toEqual([UID]);
		expect(zone.length).toBeGreaterThan(0);
	});

	it("boards_move_card into the done list marks it done; boards_set_due_date then keeps done, start date and description", async () => {
		const moved = await tool(token, "boards_move_card", { board_id: board.id, card_id: keeper.id, to_stack_id: done.id, position: "top" });
		expect(moved.isError).toBeFalsy();
		expect(moved.structuredContent).toMatchObject({ from_stack_id: doing.id, card: { stack_id: done.id, done: true } });
		const before = await deck<DeckCardJ>(UID, "GET", `/boards/${board.id}/stacks/${done.id}/cards/${keeper.id}`);
		expect(before.done).toBeTruthy();
		const set = await tool(token, "boards_set_due_date", { board_id: board.id, card_id: keeper.id, due: "2026-12-01T09:30:00Z" });
		expect(set.isError).toBeFalsy();
		expect(set.structuredContent.warnings).toBeUndefined();
		const after = await deck<DeckCardJ>(UID, "GET", `/boards/${board.id}/stacks/${done.id}/cards/${keeper.id}`);
		expect(Date.parse(after.duedate ?? "")).toBe(Date.parse("2026-12-01T09:30:00Z"));
		expect(Date.parse(after.done ?? "")).toBe(Date.parse(before.done ?? ""));
		expect(Date.parse(after.startdate ?? "")).toBe(Date.parse("2026-11-02T08:00:00+00:00"));
		expect(after.description).toBe("Line one\n\nLine two, written by the setup.");
		expect(after.stackId).toBe(done.id);
		const cleared = await tool(token, "boards_set_due_date", { board_id: board.id, card_id: keeper.id, due: null });
		expect((cleared.structuredContent.card as { due: string | null }).due).toBeNull();
		const back = await tool(token, "boards_move_card", moved.structuredContent.undo ? (moved.structuredContent.undo as { arguments: unknown }).arguments : {});
		expect(back.structuredContent).toMatchObject({ card: { stack_id: doing.id, done: false } });
	});

	it("boards_assign_card: me, idempotent repeats, refusal of someone who isn't a member, unassign", async () => {
		const me = await tool(token, "boards_assign_card", { board_id: board.id, card_id: keeper.id, user_id: "me" });
		expect(me.structuredContent).toMatchObject({ changed: true, undo: { tool: "boards_assign_card", arguments: { user_id: "me", unassign: true } } });
		const again = await tool(token, "boards_assign_card", { board_id: board.id, card_id: keeper.id, user_id: `person:${UID}` });
		expect(again.structuredContent.changed).toBe(false);
		const outsider = await tool(token, "boards_assign_card", { board_id: board.id, card_id: keeper.id, user_id: `person:${OTHER}` });
		expect(outsider._meta?.["nourax/error"]?.code).toBe("invalid_input");
		expect(outsider.content[0]?.text).toContain("isn't a member of board");
		let stored = await deck<DeckCardJ>(UID, "GET", `/boards/${board.id}/stacks/${doing.id}/cards/${keeper.id}`);
		expect(stored.assignedUsers.map((a) => a.participant.uid)).toEqual([UID]);
		const off = await tool(token, "boards_assign_card", { board_id: board.id, card_id: keeper.id, user_id: "me", unassign: true });
		expect(off.structuredContent.changed).toBe(true);
		stored = await deck<DeckCardJ>(UID, "GET", `/boards/${board.id}/stacks/${doing.id}/cards/${keeper.id}`);
		expect(stored.assignedUsers).toEqual([]);
	});

	it("boards_add_comment, then boards_get_card shows it (in the ONLYOFFICE request shape)", async () => {
		const c = await tool(token, "boards_add_comment", { board_id: board.id, card_id: keeper.id, message: `Live comment ${RUN}` });
		expect(c.isError).toBeFalsy();
		const id = (c.structuredContent.comment as { comment_id: number }).comment_id;
		const r = await rpc(token, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "boards_get_card", arguments: { board_id: board.id, card_id: keeper.id } } }, { accept: "" });
		expect(r.status).toBe(200);
		const res = r.json.result as { structuredContent: { comments: { comment_id: number; message: string; author: { id: string } }[] } };
		expect(res.structuredContent.comments[0]).toMatchObject({ comment_id: id, message: `Live comment ${RUN}`, author: { id: `person:${UID}` } });
	});

	it("errors are plain: a board of someone else, a card from another board, an unknown list", async () => {
		const theirs = await tool(token, "boards_get_board", { board_id: 1 });
		expect(theirs._meta?.["nourax/error"]?.code).toBe("not_found");
		const wrong = await tool(token, "boards_get_card", { board_id: board.id, card_id: 45 });
		expect(wrong._meta?.["nourax/error"]?.code).toBe("not_found");
		const list = await tool(token, "boards_create_card", { board_id: board.id, stack_id: 999999, title: "x" });
		expect(list._meta?.["nourax/error"]?.code).toBe("not_found");
		expect(list.content[0]?.text).toContain(`Board ${board.id} has no list 999999.`);
	});

	it("workspace_overview reports the apps of this account and no mail (no NoMail sign-in in dev)", async () => {
		const r = await tool(token, "workspace_overview", {});
		expect(r.isError).toBeFalsy();
		const apps = r.structuredContent.apps as Record<string, Record<string, unknown>>;
		expect(apps.files).toMatchObject({ available: true, trash: true, versions: true });
		expect(apps.boards).toMatchObject({ available: true, in_this_connection: true, tools: 8 });
		expect(apps.content_search).toEqual({ available: true });
		expect(apps.tasks).toMatchObject({ available: true });
		expect(apps.gantt).toMatchObject({ available: true });
		expect(apps.mail).toMatchObject({ status: "not_set_up" });
		const list = await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		expect((list.json.result as { tools: { name: string }[] }).tools.some((t) => t.name.startsWith("mail_"))).toBe(false);
	});

	it("(fix round 2) every result matches its published outputSchema the way SDK clients check it", async () => {
		// The SDK client's own validator, additionalProperties honoured, no stripping of unknown keys.
		const { CfWorkerJsonSchemaValidator } = await import("@modelcontextprotocol/client/validators/cf-worker");
		const validator = new CfWorkerJsonSchemaValidator();
		const listed = await rpc(token, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
		const schemas = new Map((listed.json.result as { tools: { name: string; outputSchema?: Record<string, unknown> }[] }).tools.map((t) => [t.name, t.outputSchema]));
		expect(schemas.get("boards_list")?.additionalProperties).not.toBe(false);
		const calls: [string, Record<string, unknown>][] = [
			["boards_list", {}],
			["boards_list", { include_archived: true }],
			["boards_get_board", { board_id: board.id, include_archived_cards: true }],
			["boards_get_card", { board_id: board.id, card_id: keeper.id }],
			["workspace_overview", {}],
		];
		for (const [name, args] of calls) {
			const schema = schemas.get(name);
			expect(schema, name).toBeTruthy();
			const r = await tool(token, name, args);
			expect(r.isError, name).toBeFalsy();
			const checked = validator.getValidator(schema as never)(r.structuredContent);
			expect(checked.valid, `${name}: ${checked.valid ? "" : checked.errorMessage}`).toBe(true);
		}
	});
});
