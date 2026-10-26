/**
 * gantt_link_board_card (DESIGN 25.3): links an existing NoBoard card to a NoGantt task, or makes a
 * new card for it on the project's board. NoGantt does the NoBoard side as the person, through
 * NoBoard's own permission checks (a card must be readable to be linked; a new card needs edit
 * rights on the board and a write level on the project's board link).
 *
 * No 10-minute duplicate guard (DESIGN 25.7): its cached answer would claim a link or card that the
 * person removed in the meantime. Linking has a natural key instead: NoGantt keeps one link per card
 * (the same task and card again returns that link; a card of another task is refused as
 * deck_card_taken). Making a card has none in NoGantt (each call makes one), so this tool checks the
 * task's current card link and makes a second card only with another_card.
 *
 * When NoGantt writes the plan's dates into an existing card (use_plan, or a card without dates on
 * a write level; DeckLinkService::settleDates), the card's own dates are gone in NoBoard. So the tool
 * reads them first and gives them back with an undo for the due date (DESIGN 25.9). A new card gets
 * NoGantt's fixed German backlink line, which the tool rewords (DESIGN 25.9).
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { defineTool, type ToolCtx } from "../../core/tool";
import { type DeckCard, dateOut, fullCardBody } from "../boards/deck";
import { findTask, gantt, getProject, own, text } from "./api";
import { idArg, projectIdArg, taskIdArg } from "./shapes";

const DATES: Record<string, "plan_written" | "card_has_no_dates" | "same" | "different" | "not_written" | "unknown"> = {
	written: "plan_written",
	none: "card_has_no_dates",
	match: "same",
	deviation: "different",
	failed: "not_written",
	unknown: "unknown",
};

interface CardDates {
	start: string | null;
	due: string | null;
}

/** NoBoard reads a card by its id alone and checks the person's right on the card's own board. */
async function readCard(ctx: ToolCtx, boardId: number, cardId: number): Promise<DeckCard | null> {
	const b = await ctx.nc.deck.rest<{ id?: number; stacks?: { id?: unknown }[] }>("GET", `/boards/${boardId}`);
	const stack = (Array.isArray(b?.stacks) ? b.stacks : []).map((s) => s?.id).find((x): x is number => typeof x === "number" && Number.isInteger(x) && x > 0);
	if (stack === undefined) return null;
	const c = await ctx.nc.deck.rest<DeckCard>("GET", `/boards/${boardId}/stacks/${stack}/cards/${cardId}`);
	return c && c.id === cardId && !((c.deletedAt ?? 0) > 0) ? c : null;
}

/**
 * The card before use_plan replaces its dates: its own dates and its title, or null when it can't be
 * read (the card is read through the project's board; NoGantt itself refuses a card the person can't
 * read).
 */
async function cardBefore(ctx: ToolCtx, projectId: number, cardId: number): Promise<{ dates: CardDates; title: unknown } | null> {
	try {
		const boardId = Number((await getProject(ctx, projectId)).deck_board_id ?? 0);
		if (!Number.isInteger(boardId) || boardId <= 0) return null;
		const c = await readCard(ctx, boardId, cardId);
		return c ? { dates: { start: dateOut(ctx, c.startdate), due: dateOut(ctx, c.duedate) }, title: c.title } : null;
	} catch (e) {
		if (e instanceof ToolError && (e.code === "reconnect_required" || e.code === "rate_limited" || e.code === "timeout")) throw e;
		return null;
	}
}

/**
 * The title of an existing card just linked. NoGantt's link answer has none (DeckLinkController::create
 * sends the link and the date result only), so the card is read on the board NoGantt names, which is
 * the card's own (DeckLinkService::readableBoardOfCard). The link is made by then: this never throws,
 * and a card that can't be read leaves the title null (DESIGN 25.10).
 */
async function titleAfter(ctx: ToolCtx, boardId: number | null, cardId: number): Promise<unknown> {
	if (!boardId) return null;
	try {
		return (await readCard(ctx, boardId, cardId))?.title ?? null;
	} catch {
		return null;
	}
}

/** NoGantt's fixed last line of a card it makes (DeckLinkService::cardDescription): German, with its upstream name. */
const BACKLINK = /(^|\n\n)Geplant in nc_Gantt: (\S+)$/;

/**
 * Rewords that line in a card the tool just made to "Planned in NoGantt: <link>", keeping the rest of
 * the description (the task's notes) and every other field. True when done, null when there was no
 * such line, false when it couldn't be changed. The card is made by then, so this never throws.
 */
async function rewordBacklink(ctx: ToolCtx, boardId: number | null, cardId: number): Promise<boolean | null> {
	if (!boardId) return false;
	try {
		const c = await readCard(ctx, boardId, cardId);
		if (!c) return false;
		const desc = String(c.description ?? "");
		const m = BACKLINK.exec(desc);
		if (!m) return null;
		const next = `${desc.slice(0, m.index)}${m[1]}Planned in NoGantt: ${m[2]}`;
		const u = await ctx.nc.deck.rest<DeckCard>("PUT", `/boards/${boardId}/stacks/${c.stackId}/cards/${cardId}`, { ...fullCardBody(c, {}), description: next });
		return String(u?.description ?? "") === next;
	} catch {
		return false;
	}
}

export const linkBoardCard = defineTool({
	name: "gantt_link_board_card",
	title: "Link a NoBoard card",
	description:
		"Links a NoGantt task to a NoBoard card: an existing one (card_id, from boards_get_board) or a new one on the project's board (create_card; refused when the task has a card already, unless another_card). The project needs a linked board (gantt_update_project); new cards need a write level. card_dates use_plan replaces a card's own dates with the plan's; the result gives the old ones, and its undo puts the due date back.",
	input: z
		.object({
			project_id: projectIdArg(),
			task_id: taskIdArg(),
			card_id: idArg("Existing NoBoard card to link.").optional(),
			create_card: z.boolean().optional().describe("Or make a new card on the project's board."),
			another_card: z.boolean().default(false).describe("With create_card: make one even if the task has a linked card already."),
			card_dates: z.enum(["keep", "use_plan"]).default("keep").describe("If the card's dates differ."),
		})
		.strict(),
	async run(ctx, args) {
		const create = args.create_card === true;
		if (create === (args.card_id !== undefined)) throw new ToolError("invalid_input", "Give either card_id or create_card true.");
		if (create && args.card_dates === "use_plan") throw new ToolError("invalid_input", "card_dates is for existing cards; a new card always gets the task's dates.", { field: "card_dates" });
		if (!create && args.another_card) throw new ToolError("invalid_input", "another_card goes with create_card true.", { field: "another_card" });
		const { task } = await findTask(ctx, args.project_id, args.task_id);
		const first = Number(task.deck_card_id ?? 0);
		const linked = Number.isInteger(first) && first > 0 ? first : null;
		if (create && linked !== null && !args.another_card) {
			// Read fresh, so a card removed or unlinked since doesn't count (unlike a cached answer).
			throw new ToolError("already_exists", `Task ${args.task_id} already has NoBoard card ${linked} linked, so no new card was made.`, {
				hint: "another_card true makes a second card for it.",
				field: "create_card",
			});
		}
		const usePlan = !create && args.card_dates === "use_plan";
		const read = usePlan ? await cardBefore(ctx, args.project_id, args.card_id as number) : null;
		const before = read?.dates ?? null;
		const opts = { notFound: `Project ${args.project_id} has no task ${args.task_id}.`, forbidden: "This person isn't allowed to change this project's plan, or the board (they need the editor role on both)." };
		const r = create
			? await gantt<Record<string, unknown>>(ctx, "POST", `/tasks/${args.task_id}/deck-cards`, opts)
			: await gantt<Record<string, unknown>>(ctx, "POST", `/tasks/${args.task_id}/deck-links`, {
					...opts,
					body: { card_id: args.card_id, date_action: usePlan ? "enforce" : "keep" },
				});
		const cardId = Number(r.card_id);
		const boardId = typeof r.board_id === "number" ? r.board_id : null;
		const assignment = r.assignment && typeof r.assignment === "object" ? (r.assignment as { assigned?: unknown[] }) : null;
		const dates = own(DATES, String(r.dates)) ?? "unknown";
		// An existing card whose own dates NoGantt replaced: with keep it does that only to a card
		// without dates (DeckLinkService::settleDates), so there were none.
		const replaced = !create && dates === "plan_written";
		const previous: CardDates | null = replaced ? (usePlan ? before : { start: null, due: null }) : null;
		// A new card's title comes in NoGantt's answer; an existing card's from the card itself.
		const rawTitle = create ? r.title : (read?.title ?? (await titleAfter(ctx, boardId, cardId)));
		const data = {
			link: {
				task_id: args.task_id,
				card_id: cardId,
				board_id: boardId,
				card_title: text(typeof rawTitle === "string" ? rawTitle : null, 255),
				card_url: boardId ? `${ctx.cfg.driveOrigin}/apps/deck/board/${boardId}/card/${cardId}` : null,
			},
			card_dates: dates,
			new_card: create,
			assigned_people: assignment && Array.isArray(assignment.assigned) ? assignment.assigned.length : null,
			previous_card_dates: previous,
		};
		const warnings: string[] = [];
		if (data.card_dates === "different") warnings.push("The card's dates differ from the plan; card_dates use_plan writes the plan's dates into it.");
		if (data.card_dates === "not_written") warnings.push("The plan's dates couldn't be written into the card.");
		const undo = replaced && previous && boardId ? { tool: "boards_set_due_date", arguments: { board_id: boardId, card_id: cardId, due: previous.due } } : null;
		if (replaced && !previous) warnings.push("The card's own dates were replaced by the plan's and couldn't be read first, so this can't be undone here.");
		if (replaced && previous) {
			warnings.push(
				`The undo puts back only the card's due date; NoBoard itself can set its start date back (${previous.start ? `it was ${previous.start}` : "it had none"}). The link stays.`,
			);
		}
		if (create && (await rewordBacklink(ctx, boardId, cardId)) === false) {
			warnings.push("NoGantt ended the new card's description with a link line in German; it can be changed in NoBoard.");
		}
		return {
			data,
			summary: create ? `Made NoBoard card ${cardId} for task ${args.task_id} and linked it.` : `Linked NoBoard card ${cardId} to task ${args.task_id}.`,
			undo,
			...(warnings.length ? { warnings } : {}),
		};
	},
});

export const boardTools = [linkBoardCard];

/** Result shapes, checked by the contract tests (not published in tools/list; see shapes.ts). */
export const BOARD_OUTPUTS = {
	gantt_link_board_card: z.object({
		link: z.object({ task_id: z.number(), card_id: z.number(), board_id: z.number().nullable(), card_title: z.string().nullable(), card_url: z.string().nullable() }),
		card_dates: z.enum(["plan_written", "card_has_no_dates", "same", "different", "not_written", "unknown"]),
		new_card: z.boolean(),
		assigned_people: z.number().nullable(),
		/** The card's own dates before NoGantt wrote the plan's into it (null when it didn't, or they couldn't be read). */
		previous_card_dates: z.object({ start: z.string().nullable(), due: z.string().nullable() }).nullable(),
	}),
};
