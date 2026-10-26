/**
 * The read-only NoBoard tools (DESIGN 11.8): boards_list, boards_get_board and boards_get_card.
 *
 * Every answer fits the 60,000-character result cap as structuredContent carries it (fix rounds 3
 * and 4): lists, a board's cards and a card's comments are fitted with fitJson, which measures JSON
 * with nulls kept, against ctx.budget.chars (the framed text's payload room, a little under 60,000).
 * The framed text leaves nulls out, so it is smaller still. Parts that aren't paged (a board's
 * members, a card's description) are cut too when they alone would pass the cap, each with a note.
 * Every text from Deck goes through deckText (control characters and invisible Unicode removed).
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { numericId } from "../../core/ids";
import { Person, Warnings } from "../../core/shapes";
import { defineTool, type ToolCtx } from "../../core/tool";
import {
	BoardBrief,
	boardIdArg,
	boardOut,
	CardBrief,
	type CardOut,
	cardIdArg,
	cardOut,
	cardsInOrder,
	cutText,
	type DeckBoard,
	type DeckComment,
	type DeckStack,
	deckError,
	deckText,
	fitJson,
	jsonChars,
	loadBoard,
	loadCardOnBoard,
	loadStacks,
	membersOut,
	personOf,
	requireDeck,
	stacksInOrder,
} from "./deck";

/** Card descriptions in a board view are cut to this many characters (DESIGN 11.8). */
export const BOARD_DESCRIPTION_CHARS = 300;
/** A single card's description is returned up to this many characters. */
export const CARD_DESCRIPTION_CHARS = 20_000;
/** boards_get_card returns the newest comments, up to this many. */
export const COMMENTS_SHOWN = 20;

// ---- boards_list ----

/**
 * Open like every other lane E output, and it names warnings: core copies an outcome's warnings into
 * structuredContent, and clients check structuredContent against the published JSON Schema with
 * additionalProperties honoured (a closed z.object publishes additionalProperties false).
 */
const listOutput = z.looseObject({ boards: z.array(BoardBrief), truncated: z.boolean(), warnings: Warnings });

const LIST_CUT = "Not every board fits in one answer.";

export const boardsList = defineTool({
	name: "boards_list",
	title: "List boards",
	description:
		"Lists the NoBoard boards the person can see (their own and shared ones) with title, colour, owner, whether the person may edit them and a link. Archived boards are left out unless include_archived is true. board_id is what the other boards tools take.",
	input: z
		.object({
			include_archived: z.boolean().default(false).describe("true also lists archived boards."),
		})
		.strict(),
	output: listOutput,
	async run(ctx, args) {
		await requireDeck(ctx);
		const raw = await ctx.nc.deck.rest<unknown>("GET", "/boards");
		if (!Array.isArray(raw)) throw new ToolError("upstream_unavailable", "NoBoard's answer about the boards couldn't be read.");
		const boards = (raw as DeckBoard[])
			.filter((b) => b && typeof b.id === "number" && !((b.deletedAt ?? 0) > 0) && b.externalId == null)
			.filter((b) => args.include_archived || b.archived !== true)
			.map((b) => boardOut(ctx, b))
			.sort((a, b) => Number(a.archived) - Number(b.archived) || a.board_id - b.board_id);
		// Measured with the warning in, as core adds it to structuredContent when the list is cut.
		const fit = fitJson(boards, (items) => ({ boards: items, truncated: true, warnings: [LIST_CUT] }), ctx.budget.chars);
		const n = fit.items.length;
		return {
			data: { boards: fit.items, truncated: fit.cut },
			summary: n === 0 ? "This person has no NoBoard boards yet." : `Found ${n} board${n === 1 ? "" : "s"}${fit.cut ? " (cut short to fit)" : ""}.`,
			...(fit.cut ? { warnings: [LIST_CUT] } : {}),
		};
	},
});

// ---- boards_get_board ----

const stackOut = z.looseObject({ stack_id: z.number(), title: z.string(), cards: z.array(CardBrief) });

const getBoardOutput = z.looseObject({
	board: BoardBrief,
	stacks: z.array(stackOut),
	truncated: z.boolean(),
});

type StackView = {
	stack_id: number;
	title: string;
	is_done_list: boolean;
	cards: CardOut[];
};

function mergeArchived(open: DeckStack[], archived: DeckStack[]): DeckStack[] {
	const byId = new Map(open.map((s) => [s.id, { ...s, cards: [...(s.cards ?? [])] }]));
	for (const a of archived) {
		const s = byId.get(a.id);
		if (s) s.cards.push(...(a.cards ?? []));
	}
	return [...byId.values()];
}

export const boardsGetBoard = defineTool({
	name: "boards_get_board",
	title: "Board lists and cards",
	description:
		"Shows one NoBoard board: its lists (stacks) in order, each with its cards (title, due date, labels, assignees, done), plus the board's members and labels. Descriptions are cut to 300 characters; boards_get_card shows a card in full. Archived cards only with include_archived_cards.",
	input: z
		.object({
			board_id: boardIdArg(),
			include_archived_cards: z.boolean().default(false).describe("true also shows archived cards."),
		})
		.strict(),
	output: getBoardOutput,
	async run(ctx, args) {
		const board = await loadBoard(ctx, args.board_id);
		const [open, archived] = await Promise.all([
			loadStacks(ctx, board.id),
			args.include_archived_cards ? loadStacks(ctx, board.id, true) : Promise.resolve([] as DeckStack[]),
		]);
		const stacks = stacksInOrder(args.include_archived_cards ? mergeArchived(open, archived) : open);
		let views: StackView[] = stacks.map((s) => ({
			stack_id: s.id,
			title: deckText(s.title),
			is_done_list: s.isDoneColumn === true,
			cards: cardsInOrder(s.cards ?? []).map((c) => cardOut(ctx, board.id, c, { descriptionMax: BOARD_DESCRIPTION_CHARS })),
		}));
		const allMembers = membersOut(board);
		const base = {
			board: boardOut(ctx, board),
			members: allMembers,
			labels: (board.labels ?? []).map((l) => ({ label_id: l.id, title: deckText(l.title), color: l.color ? `#${l.color}` : null })),
		};
		const budget = ctx.budget.chars;
		const notes: string[] = [];
		const render = (v: StackView[], truncated: boolean, extra: string[] = []) => {
			const all = [...notes, ...extra];
			return { ...base, stacks: v, truncated, note: all.length ? all.join(" ") : null };
		};
		let truncated = false;
		const total = views.reduce((n, s) => n + s.cards.length, 0);
		// Room for the longest note this answer may carry, so adding it never pushes the answer over.
		const NOTE_ROOM = ["x".repeat(400)];
		if (jsonChars(render(views, false)) > budget) {
			truncated = true;
			// A board shared with very many people: its members alone could pass the cap (no cards fit).
			const emptyStacks = views.map((s) => ({ ...s, cards: [] }));
			if (jsonChars(render(emptyStacks, true, NOTE_ROOM)) > budget) {
				const fitM = fitJson(allMembers, (items) => ({ ...base, members: items, stacks: emptyStacks, truncated: true, note: NOTE_ROOM[0] }), budget);
				base.members = fitM.items;
				notes.push(`Only ${fitM.items.length} of the board's ${allMembers.length} members fit in one answer.`);
			}
			// First drop the descriptions, then cards from the end of the board.
			views = views.map((s) => ({ ...s, cards: s.cards.map((c) => ({ ...c, description: null, description_cut: c.description ? true : undefined })) }));
			notes.push("Card descriptions were left out to fit; boards_get_card shows each card in full.");
			const flat = views.flatMap((s) => s.cards.map((c) => ({ stack: s.stack_id, c })));
			const regroup = (items: { stack: number; c: StackView["cards"][number] }[]): StackView[] =>
				views.map((s) => ({ ...s, cards: items.filter((x) => x.stack === s.stack_id).map((x) => x.c) }));
			const fit = fitJson(flat, (items) => render(regroup(items), true, NOTE_ROOM), budget);
			if (fit.cut) {
				notes.push(`Only the first ${fit.items.length} of ${total} cards fit in one answer; boards_get_card shows the others one by one.`);
				views = regroup(fit.items);
			}
		}
		const shown = views.reduce((n, s) => n + s.cards.length, 0);
		const data = render(views, truncated);
		if (jsonChars(data) > budget) {
			// Only lists and labels alone (hundreds of long titles) get here; NoBoard itself shows the board.
			throw new ToolError("too_large", `Board ${board.id} has too many lists or labels to show in one answer.`, { hint: `It can be opened in NoBoard: ${base.board.web_url}` });
		}
		return {
			data,
			summary: `Board ${board.id} has ${views.length} list${views.length === 1 ? "" : "s"} and ${total} card${total === 1 ? "" : "s"}${shown < total ? ` (${shown} shown)` : ""}.`,
		};
	},
});

// ---- boards_get_card ----

type CommentOut = {
	comment_id: number;
	author: Person;
	created_at: string | null;
	message: string;
	reply_to: number | null;
};

const getCardOutput = z.looseObject({
	card: CardBrief,
	comments: z.array(z.looseObject({ comment_id: z.number(), message: z.string() })),
});

export async function loadComments(ctx: ToolCtx, boardId: number, cardId: number): Promise<CommentOut[]> {
	let raw: unknown;
	try {
		raw = await ctx.nc.ocs.get<unknown>(`/ocs/v2.php/apps/deck/api/v1.0/cards/${numericId(cardId, "card_id")}/comments`, { limit: COMMENTS_SHOWN });
	} catch (e) {
		throw deckError(e, { kind: "card", boardId, cardId }, true);
	}
	if (!Array.isArray(raw)) return [];
	return (raw as DeckComment[])
		.filter((c) => c && typeof c.id === "number")
		.slice(0, COMMENTS_SHOWN)
		.map((c) => {
			const ms = c.creationDateTime ? Date.parse(c.creationDateTime) : Number.NaN;
			const author = c.actorType === "users" || c.actorType === undefined ? personOf({ uid: c.actorId, displayname: c.actorDisplayName }) : null;
			return {
				comment_id: c.id,
				author: author ?? { id: "person:unknown", display_name: deckText(c.actorDisplayName) || null },
				created_at: Number.isFinite(ms) ? ctx.time.format(ms) : null,
				message: deckText(c.message),
				reply_to: typeof c.replyTo?.id === "number" ? c.replyTo.id : null,
			};
		});
}

export const boardsGetCard = defineTool({
	name: "boards_get_card",
	title: "Card details",
	description:
		"Shows one NoBoard card in full: title, description, due and start dates, labels, assignees, owner, done or archived, its list, and its 20 newest comments. Card ids come from boards_get_board.",
	input: z
		.object({
			board_id: boardIdArg(),
			card_id: cardIdArg(),
		})
		.strict(),
	output: getCardOutput,
	async run(ctx, args) {
		const { board, card: deckCard, stack } = await loadCardOnBoard(ctx, args.board_id, args.card_id);
		const comments = await loadComments(ctx, board.id, deckCard.id);
		const b = boardOut(ctx, board);
		const budget = ctx.budget.chars;
		let card = cardOut(ctx, board.id, deckCard, { descriptionMax: CARD_DESCRIPTION_CHARS, full: true });
		const head = {
			list: { stack_id: stack.id, title: deckText(stack.title), is_done_list: stack.isDoneColumn === true },
			board: { board_id: b.board_id, title: b.title, can_edit: b.can_edit },
		};
		const notes: string[] = [];
		// Measured as structuredContent carries it (JSON, nulls kept), with room for the longest note.
		const render = (items: CommentOut[], note: string | null = notes.length ? notes.join(" ") : null) => ({
			card,
			...head,
			comments: items,
			comments_shown: items.length,
			note,
		});
		const NOTE_ROOM = "x".repeat(300);
		if (jsonChars(render([], NOTE_ROOM)) > budget && card.description) {
			// Last step: a card too big as JSON without any comment (each quote takes two characters
			// there) has its description cut, leaving the comments up to a third of the answer.
			const full = card.description;
			const withLength = (n: number) => ({ ...card, description: n > 0 ? cutText(full, n).text : null, description_cut: true });
			const cardFits = (n: number, room: number) => jsonChars({ ...render([], NOTE_ROOM), card: withLength(n) }) + room <= budget;
			let room = Math.min(jsonChars(comments), Math.floor(budget / 3));
			if (!cardFits(0, room)) room = 0;
			let lo = 0;
			let hi = full.length - 1;
			while (lo < hi) {
				const mid = Math.ceil((lo + hi) / 2);
				if (cardFits(mid, room)) lo = mid;
				else hi = mid - 1;
			}
			card = withLength(lo);
			notes.push("The card's description was cut to fit in one answer; NoBoard shows it in full.");
		}
		if (jsonChars(render([], NOTE_ROOM)) > budget) {
			throw new ToolError("too_large", `Card ${deckCard.id} has too much in it to show in one answer.`, { hint: `It can be opened in NoBoard: ${card.web_url}` });
		}
		const fit = fitJson(comments, (items) => render(items, NOTE_ROOM), budget);
		if (fit.cut) {
			notes.push(
				fit.items.length
					? `Only the newest ${fit.items.length} of ${comments.length} comments fit in one answer.`
					: `None of the card's ${comments.length} newest comments fit in one answer; NoBoard shows them.`,
			);
		}
		const data = render(fit.items);
		return {
			data,
			summary: `Card ${deckCard.id} on board ${board.id}, with ${data.comments_shown} comment${data.comments_shown === 1 ? "" : "s"}.`,
		};
	},
});
