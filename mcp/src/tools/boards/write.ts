/**
 * The NoBoard tools that change things (DESIGN 11.8): boards_create_card, boards_move_card,
 * boards_set_due_date, boards_assign_card and boards_add_comment. Nothing here deletes a board or a
 * card; every change is one card per call.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import { allowDuplicateArg, Warnings } from "../../core/shapes";
import { defineTool, type ToolCtx } from "../../core/tool";
import {
	assigneeUids,
	boardIdArg,
	CardBrief,
	type CardOut,
	cardIdArg,
	cardOut,
	type DeckBoard,
	type DeckCard,
	deckOcs,
	deckRest,
	dueArg,
	findStack,
	fullCardBody,
	loadBoard,
	loadCardOnBoard,
	loadStacks,
	memberUids,
	parseDue,
	requireEdit,
	stackIdArg,
	UndoBrief,
} from "./deck";
import { CARD_DESCRIPTION_CHARS } from "./read";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL_LINE = /[\u0000-\u001f\u007f-\u009f]+/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** One line: control characters and line breaks become spaces, then trimmed. */
function cleanTitle(raw: string): string {
	const t = raw.replace(CONTROL_LINE, " ").replace(/\s+/g, " ").trim();
	if (!t) throw new ToolError("invalid_input", "title can't be empty.", { field: "title" });
	return t;
}

/** Multi-line text: line breaks and tabs stay, other control characters go. */
function cleanText(raw: string): string {
	return raw.replace(/\r\n?/g, "\n").replace(CONTROL_TEXT, "");
}

async function freshCard(ctx: ToolCtx, board: DeckBoard, cardId: number, stackId: number): Promise<DeckCard> {
	return deckRest<DeckCard>(ctx, "GET", `/boards/${board.id}/stacks/${stackId}/cards/${cardId}`, { kind: "card", boardId: board.id, cardId }, undefined, true);
}

function fullOut(ctx: ToolCtx, boardId: number, c: DeckCard): CardOut {
	return cardOut(ctx, boardId, c, { descriptionMax: CARD_DESCRIPTION_CHARS, full: true });
}

// ---- boards_create_card ----

export const boardsCreateCard = defineTool({
	name: "boards_create_card",
	title: "Create a card",
	description:
		"Adds a card at the bottom of a list (stack) on a NoBoard board: a title, and optionally a Markdown description, a due date and the person as assignee. A date alone (2026-11-03) means the end of that day in the person's time zone. Stack ids come from boards_get_board.",
	input: z
		.object({
			board_id: boardIdArg(),
			stack_id: stackIdArg("List (stack) for the card, from boards_get_board."),
			title: z.string().min(1).max(LIMITS.titleChars).describe("Title, one line."),
			description: z.string().max(LIMITS.descriptionInChars).optional().describe("Description in Markdown."),
			due: dueArg("Due date or date-time, ISO 8601 (2026-11-03 or 2026-11-03T17:00).").optional(),
			assign_to_me: z.boolean().default(false).describe("true assigns the card to the person."),
			allow_duplicate: allowDuplicateArg(),
		})
		.strict(),
	output: z.looseObject({ card: CardBrief, warnings: Warnings }),
	async run(ctx, args) {
		const title = cleanTitle(args.title);
		const description = args.description === undefined ? "" : cleanText(args.description);
		const dueMs = args.due === undefined ? null : parseDue(ctx, args.due);
		const board = await loadBoard(ctx, args.board_id);
		requireEdit(board);
		const stack = findStack(board, args.stack_id);
		const t = { kind: "stack" as const, boardId: board.id, stackId: stack.id };
		const created = await deckRest<DeckCard>(
			ctx,
			"POST",
			`/boards/${board.id}/stacks/${stack.id}/cards`,
			t,
			{ title, type: "plain", order: 999, description, duedate: dueMs === null ? null : new Date(dueMs).toISOString() },
			true,
		);
		if (!created || typeof created.id !== "number") throw new ToolError("upstream_unavailable", "NoBoard's answer about the new card couldn't be read.");
		const warnings: string[] = [];
		let card = created;
		if (args.assign_to_me) {
			try {
				await deckRest(ctx, "PUT", `/boards/${board.id}/stacks/${stack.id}/cards/${created.id}/assignUser`, { kind: "card", boardId: board.id, cardId: created.id }, { userId: ctx.uid, type: 0 }, true);
				card = await freshCard(ctx, board, created.id, stack.id);
			} catch (e) {
				if (e instanceof ToolError && e.code === "reconnect_required") throw e;
				warnings.push("The card was made, but assigning it to the person didn't work. boards_assign_card can try again.");
			}
		}
		return {
			data: { card: fullOut(ctx, board.id, card), ...(warnings.length ? { warnings } : {}) },
			summary: `Created card ${card.id} in list ${stack.id} on board ${board.id}.`,
		};
	},
});

// ---- boards_move_card ----

export const boardsMoveCard = defineTool({
	name: "boards_move_card",
	title: "Move a card",
	description:
		"Moves a NoBoard card to the top or bottom of a list (stack) on the same board, its own list included. Moving into the board's done list marks it done; moving out marks it not done. Archived cards can't be moved.",
	input: z
		.object({
			board_id: boardIdArg(),
			card_id: cardIdArg(),
			to_stack_id: stackIdArg("List (stack) to move it to, from boards_get_board."),
			position: z.enum(["top", "bottom"]).default("bottom").describe('Where in the list: "top" or "bottom" (default).'),
		})
		.strict(),
	output: z.looseObject({ card: CardBrief, from_stack_id: z.number(), undo: UndoBrief }),
	async run(ctx, args) {
		const board = await loadBoard(ctx, args.board_id);
		requireEdit(board);
		const target = findStack(board, args.to_stack_id);
		const stacks = await loadStacks(ctx, board.id);
		const from = stacks.find((s) => (s.cards ?? []).some((c) => c.id === args.card_id));
		if (!from) {
			// Not among the open cards: either archived on this board, or not on it at all.
			const { card } = await loadCardOnBoard(ctx, board.id, args.card_id);
			if (card.archived) throw new ToolError("invalid_input", `Card ${card.id} is archived, so it can't be moved.`, { hint: "Archived cards can be restored in NoBoard first." });
			throw new ToolError("not_found", `There's no card ${args.card_id} on board ${board.id}, or this person can't see it.`, { hint: "boards_get_board shows the board's cards." });
		}
		const fromCards = (from.cards ?? []).filter((c) => !c.deletedAt).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id);
		const wasTop = fromCards[0]?.id === args.card_id;
		const targetCards = (stacks.find((s) => s.id === target.id)?.cards ?? []).filter((c) => c.id !== args.card_id && !c.deletedAt);
		const order = args.position === "top" ? 0 : targetCards.length;
		await deckOcs(ctx, "PUT", `/cards/${args.card_id}/reorder`, { kind: "card", boardId: board.id, cardId: args.card_id }, { stackId: target.id, order, boardId: board.id }, true);
		const card = await freshCard(ctx, board, args.card_id, target.id);
		return {
			data: {
				card: fullOut(ctx, board.id, card),
				from_stack_id: from.id,
				undo: { tool: "boards_move_card", arguments: { board_id: board.id, card_id: card.id, to_stack_id: from.id, position: wasTop ? "top" : "bottom" } },
			},
			summary: from.id === target.id ? `Moved card ${card.id} to the ${args.position} of its list.` : `Moved card ${card.id} from list ${from.id} to list ${target.id}.`,
		};
	},
});

// ---- boards_set_due_date ----

export const boardsSetDueDate = defineTool({
	name: "boards_set_due_date",
	title: "Change a card's due date",
	description:
		"Sets, changes or clears (null) the due date of a NoBoard card. A date alone means the end of that day in the person's time zone; a date-time without an offset is read in that zone. Nothing else on the card changes.",
	input: z
		.object({
			board_id: boardIdArg(),
			card_id: cardIdArg(),
			due: z.string().min(10).max(40).nullable().describe("New due date or date-time, ISO 8601 (2026-11-03 or 2026-11-03T17:00), or null to remove it."),
		})
		.strict(),
	output: z.looseObject({ card: CardBrief, previous_due: z.string().nullable(), undo: UndoBrief }),
	async run(ctx, args) {
		const dueMs = args.due === null ? null : parseDue(ctx, args.due);
		const { board, card } = await loadCardOnBoard(ctx, args.board_id, args.card_id);
		requireEdit(board);
		if (card.archived) throw new ToolError("invalid_input", `Card ${card.id} is archived, so it can't be changed.`, { hint: "Archived cards can be restored in NoBoard first." });
		const before = cardOut(ctx, board.id, card, { descriptionMax: 1 });
		const body = fullCardBody(card, { duedate: dueMs === null ? null : new Date(dueMs).toISOString() });
		const updated = await deckRest<DeckCard>(ctx, "PUT", `/boards/${board.id}/stacks/${card.stackId}/cards/${card.id}`, { kind: "card", boardId: board.id, cardId: card.id }, body, true);
		const after = updated && typeof updated.id === "number" ? updated : await freshCard(ctx, board, card.id, card.stackId);
		const warnings: string[] = [];
		if (Boolean(after.done) !== Boolean(card.done) || (after.description ?? "") !== (card.description ?? "") || after.stackId !== card.stackId) {
			warnings.push("NoBoard changed more than the due date on this card; boards_get_card shows it as it is now.");
		}
		const out = fullOut(ctx, board.id, after);
		return {
			data: {
				card: out,
				previous_due: before.due,
				undo: { tool: "boards_set_due_date", arguments: { board_id: board.id, card_id: card.id, due: before.due } },
				...(warnings.length ? { warnings } : {}),
			},
			summary: out.due ? `Card ${card.id} is now due ${out.due}.` : `Card ${card.id} has no due date now.`,
		};
	},
});

// ---- boards_assign_card ----

/** "me", "person:<uid>" or a bare uid from boards_get_board's members. */
function resolveUser(ctx: ToolCtx, raw: string): string {
	const s = raw.trim();
	if (s === "me") return ctx.uid;
	const uid = s.startsWith("person:") ? s.slice("person:".length) : s;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
	if (!/^[^\u0000-\u001f\u007f/\\:][^\u0000-\u001f\u007f/\\]{0,63}$/.test(uid)) {
		throw new ToolError("invalid_input", 'user_id must be "me" or a member id from boards_get_board, for example "person:…".', { field: "user_id" });
	}
	return uid;
}

export const boardsAssignCard = defineTool({
	name: "boards_assign_card",
	title: "Assign a card",
	description:
		"Assigns a NoBoard card to the person (\"me\") or to a board member (an id from boards_get_board), or removes it with unassign true. Only board members can be assigned; NoBoard notifies others. Assigning twice changes nothing. Archived cards can't be changed.",
	input: z
		.object({
			board_id: boardIdArg(),
			card_id: cardIdArg(),
			user_id: z.string().min(2).max(140).describe('"me", or a member id from boards_get_board, for example "person:…".'),
			unassign: z.boolean().default(false).describe("true removes the assignment instead."),
		})
		.strict(),
	output: z.looseObject({ card: CardBrief, changed: z.boolean(), undo: UndoBrief }),
	async run(ctx, args) {
		const uid = resolveUser(ctx, args.user_id);
		const { board, card } = await loadCardOnBoard(ctx, args.board_id, args.card_id);
		requireEdit(board);
		// Deck 1.19.1 lets an archived card's people change, but every other boards tool that changes a
		// card refuses archived ones; the same rule here keeps them alike (fix round 4, DESIGN 26.8).
		if (card.archived) throw new ToolError("invalid_input", `Card ${card.id} is archived, so it can't be changed.`, { hint: "Archived cards can be restored in NoBoard first." });
		const assigned = assigneeUids(card).includes(uid);
		const who = uid === ctx.uid ? "the person" : `person:${uid}`;
		if (!args.unassign && !memberUids(board).has(uid)) {
			throw new ToolError("invalid_input", `${who === "the person" ? "The person" : who} isn't a member of board ${board.id}, so they can't be assigned.`, {
				field: "user_id",
				hint: "boards_get_board lists the members.",
			});
		}
		const undoArgs = { board_id: board.id, card_id: card.id, user_id: uid === ctx.uid ? "me" : `person:${uid}` };
		if (args.unassign ? !assigned : assigned) {
			return {
				data: { card: fullOut(ctx, board.id, card), changed: false, undo: null },
				summary: args.unassign ? `Card ${card.id} wasn't assigned to ${who}; nothing changed.` : `Card ${card.id} was already assigned to ${who}; nothing changed.`,
			};
		}
		const t = { kind: "card" as const, boardId: board.id, cardId: card.id };
		try {
			await deckRest(ctx, "PUT", `/boards/${board.id}/stacks/${card.stackId}/cards/${card.id}/${args.unassign ? "unassignUser" : "assignUser"}`, t, { userId: uid, type: 0 }, true);
		} catch (e) {
			const d = e instanceof ToolError ? (e.detail ?? "").toLowerCase() : "";
			// Someone else changed it in between: the end state is what was asked for.
			if (!(d.includes("already assigned") || (args.unassign && d.includes("no assignment")))) {
				if (d.includes("not part of the board")) {
					throw new ToolError("invalid_input", `${who === "the person" ? "The person" : who} isn't a member of board ${board.id}, so they can't be assigned.`, { field: "user_id", hint: "boards_get_board lists the members." });
				}
				throw e;
			}
		}
		const fresh = await freshCard(ctx, board, card.id, card.stackId);
		return {
			data: { card: fullOut(ctx, board.id, fresh), changed: true, undo: { tool: "boards_assign_card", arguments: { ...undoArgs, unassign: !args.unassign } } },
			summary: args.unassign ? `Removed ${who} from card ${card.id}.` : `Assigned card ${card.id} to ${who}.`,
		};
	},
});

// ---- boards_add_comment ----

export const boardsAddComment = defineTool({
	name: "boards_add_comment",
	title: "Comment on a card",
	description:
		"Adds a comment of up to 1,000 characters to a NoBoard card, as the person. @ followed by a user id mentions and notifies someone. Comments can't be edited or removed with these tools.",
	input: z
		.object({
			board_id: boardIdArg(),
			card_id: cardIdArg(),
			message: z.string().min(1).max(LIMITS.commentChars).describe("The comment text, 1 to 1,000 characters."),
			allow_duplicate: allowDuplicateArg(),
		})
		.strict(),
	output: z.looseObject({ comment: z.looseObject({ comment_id: z.number() }), card_id: z.number() }),
	async run(ctx, args) {
		const message = cleanText(args.message).trim();
		if (!message) throw new ToolError("invalid_input", "message can't be empty.", { field: "message" });
		const { board, card } = await loadCardOnBoard(ctx, args.board_id, args.card_id);
		const r = await deckOcs<{ id?: number; creationDateTime?: string }>(ctx, "POST", `/cards/${card.id}/comments`, { kind: "card", boardId: board.id, cardId: card.id }, { message }, true);
		if (!r || typeof r.id !== "number") throw new ToolError("upstream_unavailable", "NoBoard's answer about the comment couldn't be read.");
		const ms = r.creationDateTime ? Date.parse(r.creationDateTime) : Number.NaN;
		return {
			data: { comment: { comment_id: r.id, created_at: Number.isFinite(ms) ? ctx.time.format(ms) : null }, card_id: card.id, board_id: board.id },
			summary: `Added comment ${r.id} to card ${card.id}.`,
		};
	},
});
