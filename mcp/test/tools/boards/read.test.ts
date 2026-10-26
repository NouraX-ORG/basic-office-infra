/** Contract tests for boards_list, boards_get_board and boards_get_card against the fake Deck (DESIGN 17.3). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeNc } from "../../fake-nc/index";
import type { FakeDeck } from "../../fake-nc/deck";
import { QA } from "../../helpers/index";
import { upstreamDefaultsForTests } from "../../../src/tools/boards/brand-defaults";
import { brandFree, callTool, errorCode, expectSchema, payloadOf, publishedOutputSchema, setupDeck } from "./helpers";

let fake: FakeNc;
let deck: FakeDeck;
beforeEach(() => {
	({ fake, deck } = setupDeck());
});
afterEach(() => vi.restoreAllMocks());

const deckCalls = () => fake.driveCalls().filter((r) => r.url.pathname.includes("/apps/deck/"));

describe("boards_list", () => {
	it("sends one GET with Basic auth and the OCS header, and lists own and shared boards", async () => {
		const mine = deck.addBoard(QA.a, "Team plan", { color: "2563eb" });
		const shared = deck.addBoard(QA.b, "Shared roadmap", { shareWith: [{ uid: QA.a, edit: false }] });
		deck.addBoard(QA.b, "Not shared");
		fake.requests.length = 0;
		const r = await callTool("boards_list", {});
		expect(r.isError).toBeFalsy();
		const calls = deckCalls();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url.pathname).toBe("/index.php/apps/deck/api/v1.0/boards");
		expect(calls[0]?.auth).toBe(QA.a);
		expect(calls[0]?.headers.get("ocs-apirequest")).toBe("true");
		expect(calls[0]?.headers.get("accept")).toBe("application/json");
		expect(calls[0]?.headers.get("cookie")).toBeNull();
		expectSchema("boards_list", r);
		const boards = r.structuredContent.boards as { board_id: number; title: string; can_edit: boolean; color: string; owner: { id: string }; web_url: string }[];
		expect(boards.map((b) => b.board_id)).toEqual([mine.id, shared.id]);
		expect(boards[0]).toMatchObject({ title: "Team plan", can_edit: true, color: "#2563eb", owner: { id: `person:${QA.a}` }, web_url: `https://drive.nourax.org/apps/deck/board/${mine.id}` });
		expect(boards[1]).toMatchObject({ can_edit: false, owner: { id: `person:${QA.b}` } });
		expect(r.content[0]?.text.split("\n")[0]).toBe("Found 2 boards.");
		expect(payloadOf(r).boards).toHaveLength(2);
	});
	it("leaves out archived boards unless asked, and boards in the trash always", async () => {
		deck.addBoard(QA.a, "Live");
		const old = deck.addBoard(QA.a, "Old", { archived: true });
		deck.addBoard(QA.a, "Binned", { deletedAt: 1792926000 });
		let r = await callTool("boards_list", {});
		expect((r.structuredContent.boards as unknown[]).length).toBe(1);
		r = await callTool("boards_list", { include_archived: true });
		const boards = r.structuredContent.boards as { board_id: number; archived: boolean }[];
		expect(boards).toHaveLength(2);
		expect(boards[1]).toMatchObject({ board_id: old.id, archived: true });
	});
	it("shows Deck's first-run board in Nourax words", async () => {
		const d = upstreamDefaultsForTests();
		deck.addBoard(QA.a, d.title, { color: d.color });
		const r = await callTool("boards_list", {});
		expect((r.structuredContent.boards as { title: string }[])[0]?.title).toBe("Welcome to NoBoard!");
		expect(brandFree(JSON.stringify(r))).toBe(true);
	});
	it("a list cut short to fit still matches the published output schema, also in the SDK client (fix round 2)", async () => {
		// About 300 boards with long titles don't fit in one answer: the result is cut, and core copies
		// the warning into structuredContent, which spec-following clients check against the published
		// JSON Schema without stripping unknown keys.
		for (let i = 0; i < 300; i++) deck.addBoard(QA.a, `Board ${String(i).padStart(3, "0")} ${"long title ".repeat(14)}`);
		const r = await callTool("boards_list", {});
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent.truncated).toBe(true);
		expect(r.structuredContent.warnings).toEqual(["Not every board fits in one answer."]);
		expectSchema("boards_list", r);
		expect(publishedOutputSchema("boards_list")).toMatchObject({ type: "object", properties: { warnings: { type: "array" } } });
		expect(publishedOutputSchema("boards_list").additionalProperties).not.toBe(false);
		const { devToken, sdkClient } = await import("../../helpers/index");
		const client = await sdkClient((await devToken(QA.a)).access_token);
		await client.listTools();
		// The SDK client throws when structuredContent breaks the tool's published outputSchema.
		const viaClient = (await client.callTool({ name: "boards_list", arguments: {} })) as { structuredContent?: { truncated?: boolean; boards?: unknown[] } };
		expect(viaClient.structuredContent?.truncated).toBe(true);
		expect(viaClient.structuredContent?.boards?.length).toBeGreaterThan(50);
		await client.close();
	});
	it("says so when there are no boards", async () => {
		const r = await callTool("boards_list", {});
		expect(r.structuredContent.boards).toEqual([]);
		expect(r.content[0]?.text.split("\n")[0]).toBe("This person has no NoBoard boards yet.");
	});
	it("refuses unknown input and maps a server error without its text", async () => {
		let r = await callTool("boards_list", { archived: true });
		expect(errorCode(r)).toBe("invalid_input");
		fake.on("GET", /^\/index\.php\/apps\/deck\/api\/v1\.0\/boards$/, () => new Response("OCA\\Deck\\StatusException trace /var/www/html", { status: 500 }));
		r = await callTool("boards_list", {});
		expect(errorCode(r)).toBe("upstream_unavailable");
		expect(r.content[0]?.text).not.toMatch(/OCA|trace|var\/www/i);
	});
	it("a dead NoDrive credential ends the connection with HTTP 401", async () => {
		fake.on("GET", /^\/index\.php\/apps\/deck\/api\/v1\.0\/boards$/, () => new Response("", { status: 401 }));
		fake.on("GET", /^\/ocs\/v2\.php\/cloud\/user$/, () => new Response("", { status: 401 }));
		const { devToken, mcpPost } = await import("../../helpers/index");
		const t = await devToken(QA.a);
		const res = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boards_list", arguments: {} } });
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain("invalid_token");
	});
});

describe("boards_get_board", () => {
	function seed() {
		const b = deck.addBoard(QA.a, "Launch", { shareWith: [{ uid: QA.b }] });
		const todo = deck.addStack(b.id, "To do", { order: 0 });
		const done = deck.addStack(b.id, "Done", { order: 2, done: true });
		const doing = deck.addStack(b.id, "Doing", { order: 1 });
		const c2 = deck.addCard(todo.id, "Second", { order: 1 });
		const c1 = deck.addCard(todo.id, "First", { order: 0, description: "d".repeat(500), duedate: "2026-11-03T16:00:00+00:00", labels: [b.labels[1]?.id as number], assigned: [QA.b] });
		const arch = deck.addCard(doing.id, "Archived one", { archived: true });
		const fin = deck.addCard(done.id, "Shipped", { done: "2026-10-20T10:00:00+00:00" });
		return { b, todo, done, doing, c1, c2, arch, fin };
	}
	it("returns lists in order with their cards, members and labels; descriptions cut to 300", async () => {
		const s = seed();
		fake.requests.length = 0;
		const r = await callTool("boards_get_board", { board_id: s.b.id });
		expect(r.isError).toBeFalsy();
		expectSchema("boards_get_board", r);
		expect(deckCalls().map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
			`GET /index.php/apps/deck/api/v1.0/boards/${s.b.id}`,
			`GET /index.php/apps/deck/api/v1.0/boards/${s.b.id}/stacks`,
		]);
		const data = r.structuredContent as {
			stacks: { stack_id: number; title: string; is_done_list: boolean; cards: { card_id: number; description: string | null; description_cut?: boolean; due: string | null; labels: string[]; assignees: { id: string }[]; done: boolean }[] }[];
			members: { id: string }[];
			labels: { title: string; color: string }[];
			truncated: boolean;
		};
		expect(data.stacks.map((x) => x.title)).toEqual(["To do", "Doing", "Done"]);
		expect(data.stacks[0]?.cards.map((c) => c.card_id)).toEqual([s.c1.id, s.c2.id]);
		const first = data.stacks[0]?.cards[0];
		expect(first?.description?.length).toBe(300);
		expect(first?.description_cut).toBe(true);
		expect(first?.due).toBe("2026-11-03T16:00:00+00:00");
		expect(first?.labels).toEqual(["Action needed"]);
		expect(first?.assignees).toEqual([{ id: `person:${QA.b}`, display_name: "QA t1 92" }]);
		expect(data.stacks[1]?.cards).toEqual([]);
		expect(data.stacks[2]?.is_done_list).toBe(true);
		expect(data.stacks[2]?.cards[0]?.done).toBe(true);
		expect(data.members.map((m) => m.id).sort()).toEqual([`person:${QA.a}`, `person:${QA.b}`].sort());
		expect(data.labels.map((l) => l.title)).toEqual(["Finished", "Action needed"]);
		expect(data.truncated).toBe(false);
		expect(r.content[0]?.text.split("\n")[0]).toBe(`Board ${s.b.id} has 3 lists and 3 cards.`);
	});
	it("adds archived cards when asked", async () => {
		const s = seed();
		const r = await callTool("boards_get_board", { board_id: s.b.id, include_archived_cards: true });
		const doing = (r.structuredContent.stacks as { stack_id: number; cards: { card_id: number; archived: boolean }[] }[]).find((x) => x.stack_id === s.doing.id);
		expect(doing?.cards).toEqual([expect.objectContaining({ card_id: s.arch.id, archived: true })]);
		expect(fake.driveCalls().some((c) => c.url.pathname.endsWith("/stacks/archived"))).toBe(true);
	});
	it("a board that doesn't exist or can't be seen is not_found with a pointer to boards_list", async () => {
		const other = deck.addBoard(QA.b, "Private");
		for (const id of [other.id, 999_999]) {
			const r = await callTool("boards_get_board", { board_id: id });
			expect(errorCode(r)).toBe("not_found");
			expect(r.content[0]?.text).toBe(`There's no board ${id}, or this person can't see it. boards_list shows the boards.`);
		}
	});
	it("refuses ids that aren't positive whole numbers", async () => {
		for (const board_id of [0, -1, 1.5, "12", null]) {
			const r = await callTool("boards_get_board", { board_id });
			expect(errorCode(r)).toBe("invalid_input");
		}
		expect(deckCalls()).toHaveLength(0);
	});
	it("maps Deck's default card texts and keeps a person's own text as it is", async () => {
		const d = upstreamDefaultsForTests();
		const b = deck.addBoard(QA.a, d.title, { color: d.color });
		const st = deck.addStack(b.id, "Custom lists - click to rename!");
		for (const desc of d.descriptions) deck.addCard(st.id, "Default", { description: desc });
		const mine = deck.addCard(st.id, "Mine", { description: "Our own words, unchanged." });
		const r = await callTool("boards_get_board", { board_id: b.id });
		expect(brandFree(JSON.stringify(r))).toBe(true);
		const cards = (r.structuredContent.stacks as { cards: { card_id: number; description: string }[] }[])[0]?.cards ?? [];
		expect(cards.find((c) => c.card_id === mine.id)?.description).toBe("Our own words, unchanged.");
		expect(cards[0]?.description.startsWith("## Welcome to NoBoard!")).toBe(true);
	});
	it("a board too big for one answer drops descriptions, then cards, and says so", async () => {
		const b = deck.addBoard(QA.a, "Huge");
		const st = deck.addStack(b.id, "All");
		for (let i = 0; i < 400; i++) deck.addCard(st.id, `Card ${i} ${"t".repeat(200)}`, { description: "x".repeat(300), order: i });
		const r = await callTool("boards_get_board", { board_id: b.id });
		expect(r.isError).toBeFalsy();
		expect(r.content[0]?.text.length).toBeLessThanOrEqual(60_000);
		const data = r.structuredContent as { truncated: boolean; note: string; stacks: { cards: unknown[] }[] };
		expect(data.truncated).toBe(true);
		// Both steps are named, in the order they were taken (fix round 3): descriptions first, then cards.
		expect(data.note).toMatch(/^Card descriptions were left out to fit; boards_get_card shows each card in full\. Only the first \d+ of 400 cards fit in one answer; /);
		expect(data.stacks[0]?.cards.length).toBeLessThan(400);
		// structuredContent itself fits, measured as JSON with nulls kept.
		expect(JSON.stringify(r.structuredContent).length).toBeLessThanOrEqual(60_000);
	});
});

describe("boards_get_card", () => {
	it("returns the card in full with its newest 20 comments, from the OCS comments route", async () => {
		const b = deck.addBoard(QA.a, "B");
		const st = deck.addStack(b.id, "S");
		const c = deck.addCard(st.id, "Card", { description: "Full text ".repeat(100), startdate: "2026-11-01T09:00:00+00:00", duedate: "2026-11-05T17:00:00+00:00" });
		for (let i = 0; i < 25; i++) deck.comments.push({ id: 5000 + i, cardId: c.id, actorId: QA.b, message: `Comment ${i}`, creationDateTime: "2026-10-24T08:00:00+00:00" });
		fake.requests.length = 0;
		const r = await callTool("boards_get_card", { board_id: b.id, card_id: c.id });
		expect(r.isError).toBeFalsy();
		expectSchema("boards_get_card", r);
		const commentsCall = fake.driveCalls().find((x) => x.url.pathname === `/ocs/v2.php/apps/deck/api/v1.0/cards/${c.id}/comments`);
		expect(commentsCall?.method).toBe("GET");
		expect(commentsCall?.url.searchParams.get("limit")).toBe("20");
		expect(commentsCall?.url.searchParams.get("format")).toBe("json");
		expect(commentsCall?.headers.get("ocs-apirequest")).toBe("true");
		const data = r.structuredContent as { card: Record<string, unknown>; comments: { comment_id: number; author: { id: string }; message: string; created_at: string }[]; list: { stack_id: number }; comments_shown: number };
		expect(data.card).toMatchObject({ card_id: c.id, start: "2026-11-01T09:00:00+00:00", due: "2026-11-05T17:00:00+00:00", owner: { id: `person:${QA.a}` } });
		expect((data.card.description as string).length).toBe(1000);
		expect(data.comments).toHaveLength(20);
		expect(data.comments[0]).toMatchObject({ comment_id: 5024, author: { id: `person:${QA.b}` }, message: "Comment 24", created_at: "2026-10-24T08:00:00+00:00" });
		expect(data.list.stack_id).toBe(st.id);
		expect(data.comments_shown).toBe(20);
	});
	it("a card on another board is not found, even though Deck's card route would answer", async () => {
		const b1 = deck.addBoard(QA.a, "One");
		const b2 = deck.addBoard(QA.a, "Two");
		deck.addStack(b1.id, "S1");
		const s2 = deck.addStack(b2.id, "S2");
		const c = deck.addCard(s2.id, "On two");
		const r = await callTool("boards_get_card", { board_id: b1.id, card_id: c.id });
		expect(errorCode(r)).toBe("not_found");
		expect(r.content[0]?.text).toContain(`There's no card ${c.id} on board ${b1.id}`);
		expect(fake.driveCalls().some((x) => x.url.pathname.includes("/comments"))).toBe(false);
	});
	it("a card the person can't see is not found", async () => {
		const b = deck.addBoard(QA.b, "Theirs");
		const st = deck.addStack(b.id, "S");
		const c = deck.addCard(st.id, "Secret");
		const r = await callTool("boards_get_card", { board_id: b.id, card_id: c.id });
		expect(errorCode(r)).toBe("not_found");
		expect(r.content[0]?.text).not.toContain("Secret");
	});
});

describe("boards tools in tools/list", () => {
	it("carry all four hints as the catalogue says, and need the Boards app", async () => {
		const { devToken, mcpPost, rpcResult } = await import("../../helpers/index");
		const t = await devToken(QA.a, { scopes: ["workspace.read", "workspace.write"] });
		const body = await rpcResult(await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
		const tools = (body.result as { tools: { name: string; annotations: Record<string, boolean>; outputSchema?: unknown }[] }).tools.filter((x) => x.name.startsWith("boards_"));
		expect(tools.map((x) => x.name)).toEqual(["boards_list", "boards_get_board", "boards_get_card", "boards_create_card", "boards_move_card", "boards_set_due_date", "boards_assign_card", "boards_add_comment"]);
		const a = Object.fromEntries(tools.map((x) => [x.name, x.annotations]));
		expect(a.boards_list).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
		expect(a.boards_create_card).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
		expect(a.boards_move_card).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
		expect(a.boards_set_due_date).toMatchObject({ destructiveHint: true, idempotentHint: true });
		expect(a.boards_assign_card).toMatchObject({ destructiveHint: true, idempotentHint: true });
		expect(a.boards_add_comment).toMatchObject({ destructiveHint: false, readOnlyHint: false });
		for (const x of tools) expect(x.outputSchema, x.name).toBeTruthy();
		const noBoards = await devToken(QA.a, { apps: ["files"] });
		const b2 = await rpcResult(await mcpPost(noBoards.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
		expect((b2.result as { tools: { name: string }[] }).tools.some((x) => x.name.startsWith("boards_"))).toBe(false);
		const r = await callTool("boards_list", {}, { apps: ["files"] });
		expect(errorCode(r)).toBe("not_available");
	});
});
