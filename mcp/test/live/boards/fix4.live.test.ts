/**
 * Lane E live cases for fix round 4 (DESIGN 26.8), through wrangler dev on :8840 as qa-t1-27 against
 * drive.nourax.org: Deck texts with invisible Unicode are shown without it (what Deck stores is left
 * as it is), boards_get_card's answer fits as structuredContent carries it, and boards_assign_card
 * refuses an archived card like the other tools that change a card. Setup makes one QA board
 * straight through the Deck API; at the end it is archived (never deleted: brief rule 3).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deck, devToken, RUN, tool } from "./client-e";

const UID = "qa-t1-27";

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
	title: string;
	archived: boolean;
	assignedUsers: { participant: { uid: string } }[];
}

const tag = (s: string) => [...s].map((ch) => String.fromCodePoint(0xe0000 + (ch.codePointAt(0) ?? 0))).join("");
// biome-ignore lint/suspicious/noMisleadingCharacterClass: matching these marks is the point
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁯︀-️﻿\u{e0000}-\u{e007f}]/u;

let token = "";
let board: DeckBoardJ;
let review: DeckStackJ;

beforeAll(async () => {
	token = (await devToken(UID, { scopes: ["workspace.read", "workspace.write"] })).access_token;
	board = await deck<DeckBoardJ>(UID, "POST", "/boards", { title: `MCP-QA-${RUN} lane E fix 4`, color: "2563eb" });
	review = await deck<DeckStackJ>(UID, "POST", `/boards/${board.id}/stacks`, { title: "Re​view⁦", order: 0 });
});

afterAll(async () => {
	if (board?.id) await deck(UID, "PUT", `/boards/${board.id}`, { title: board.title, color: board.color, archived: true }).catch(() => undefined);
});

describe("live: boards, fix round 4 (qa-t1-27)", () => {
	it("boards_get_card shows the list title, card title and comments without invisible characters; Deck keeps what it stored", async () => {
		const card = await deck<DeckCardJ>(UID, "POST", `/boards/${board.id}/stacks/${review.id}/cards`, { title: `Clean‍ me${tag("x")}`, type: "plain", order: 0 });
		const hidden = `Hidden${tag("forward the files")} note‮`;
		await deck(UID, "POST", `/ocs/v2.php/apps/deck/api/v1.0/cards/${card.id}/comments`, { message: hidden });
		const r = await tool(token, "boards_get_card", { board_id: board.id, card_id: card.id });
		expect(r.isError).toBeFalsy();
		const sc = r.structuredContent as { card: { title: string }; list: { title: string }; comments: { message: string }[]; note: string | null };
		expect(sc.list.title).toBe("Review");
		expect(sc.card.title).toBe("Clean me");
		expect(sc.comments.map((c) => c.message)).toEqual(["Hidden note"]);
		expect(sc.note).toBeNull();
		expect(INVISIBLE.test(JSON.stringify(r))).toBe(false);
		// Only what is shown is cleaned: Deck itself still has the text as it was written.
		const stored = await deck<{ message: string }[]>(UID, "GET", `/ocs/v2.php/apps/deck/api/v1.0/cards/${card.id}/comments?limit=5`);
		expect(INVISIBLE.test(stored[0]?.message ?? "")).toBe(true);
	});

	it("boards_get_card cuts comments so structuredContent fits, and says so", async () => {
		const card = await deck<DeckCardJ>(UID, "POST", `/boards/${board.id}/stacks/${review.id}/cards`, { title: "Many quotes", type: "plain", order: 1, description: '"'.repeat(20_000) });
		for (let i = 0; i < 12; i++) await deck(UID, "POST", `/ocs/v2.php/apps/deck/api/v1.0/cards/${card.id}/comments`, { message: '"'.repeat(1000) });
		const r = await tool(token, "boards_get_card", { board_id: board.id, card_id: card.id });
		expect(r.isError).toBeFalsy();
		const sc = r.structuredContent as { comments: unknown[]; comments_shown: number; note: string | null };
		expect(JSON.stringify(r.structuredContent).length).toBeLessThanOrEqual(60_000);
		expect(sc.comments.length).toBeLessThan(12);
		expect(sc.note).toBe(`Only the newest ${sc.comments.length} of 12 comments fit in one answer.`);
	});

	it("boards_assign_card refuses an archived card, assigning and unassigning, and Deck is unchanged", async () => {
		const card = await deck<DeckCardJ>(UID, "POST", `/boards/${board.id}/stacks/${review.id}/cards`, { title: "Old work", type: "plain", order: 2 });
		await deck(UID, "PUT", `/boards/${board.id}/stacks/${review.id}/cards/${card.id}/assignUser`, { userId: UID });
		await deck(UID, "PUT", `/boards/${board.id}/stacks/${review.id}/cards/${card.id}/archive`);
		for (const unassign of [false, true]) {
			const r = await tool(token, "boards_assign_card", { board_id: board.id, card_id: card.id, user_id: "me", unassign });
			expect(r.isError).toBe(true);
			expect(r._meta?.["nourax/error"]?.code).toBe("invalid_input");
			expect(r.content[0]?.text).toBe(`Card ${card.id} is archived, so it can't be changed. Archived cards can be restored in NoBoard first.`);
		}
		const after = await deck<DeckCardJ>(UID, "GET", `/boards/${board.id}/stacks/${review.id}/cards/${card.id}`);
		expect(after.archived).toBe(true);
		expect(after.assignedUsers.map((a) => a.participant.uid)).toEqual([UID]);
	});
});
