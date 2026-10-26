/**
 * Shared NoBoard (Deck) helpers for the boards tools (DESIGN 11.8). Deck 1.19.1, read on the server:
 * - REST under /index.php/apps/deck/api/v1.0 for boards, stacks and cards. The card routes ignore
 *   the board and stack ids in the URL (only the card id counts), so every tool checks itself that
 *   a card belongs to the board it was named with.
 * - OCS under /ocs/v2.php/apps/deck/api/v1.0 for comments and reorder (the REST reorder ignores a
 *   stackId in the body, so a move always uses the OCS route).
 * - A board or card that doesn't exist answers 403 "Permission denied", the same as one the person
 *   can't see (Deck's ExceptionMiddleware hides which). A write the person may not make is a 403 too.
 * - "Operation not allowed. This board/card is archived." is a 500 (StatusException).
 * - The deck capability (lib/Capabilities.php: version, apiVersions ["1.0", "1.1"]) is read before
 *   the first Deck call of every tool (requireDeck; core caches capabilities for 10 minutes). Without
 *   it, Deck is off for the person and every Deck route would answer 404.
 *
 * Texts from Deck lose their control characters (other than line breaks and tabs) on the way out,
 * as the framed text does, so structuredContent and the text say the same, and answers are measured
 * as JSON with nulls kept, the way structuredContent carries them (fix round 3). They lose invisible
 * Unicode too (tag characters, bidi controls, zero-width marks: src/mail/invisible.ts), because
 * cards, lists and comments are written by other people and structuredContent can't carry the data
 * framing (fix round 4, DESIGN 26.8). Only what is shown is cleaned: a card written back (the REST
 * update replaces every field) always takes Deck's own values.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { numericId, typedId } from "../../core/ids";
import { Person } from "../../core/shapes";
import type { ToolCtx } from "../../core/tool";
import { dropInvisible } from "../../mail/invisible";
import { boardTitleOut, cardDescriptionOut } from "./brand-defaults";

// ---- Deck itself ----

/** The Deck API version every boards tool uses (REST and OCS under /api/v1.0). */
export const DECK_API = "1.0";

/**
 * Checks the deck capability before the first Deck call: Deck must be on for this person and offer
 * API 1.0. An unreadable capabilities answer leaves the decision to the Deck call itself; a dead
 * NoDrive credential still ends the connection.
 */
export async function requireDeck(ctx: ToolCtx): Promise<void> {
	let deck: { version: string | null; apiVersions: string[] } | null;
	try {
		deck = (await ctx.nc.capabilities()).deck;
	} catch (e) {
		if (e instanceof ToolError && (e.deadCredential || e.code === "reconnect_required")) throw e;
		return;
	}
	if (!deck) {
		throw new ToolError("not_available", "NoBoard isn't available for this person right now, so there are no boards to show or change.", {
			hint: "workspace_overview shows which apps are on.",
		});
	}
	if (!deck.apiVersions.includes(DECK_API)) {
		throw new ToolError("not_available", "This version of NoBoard doesn't offer what the boards tools use, so they can't work with it right now.");
	}
}

// ---- Sizes and texts ----

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * A text from Deck as people see it: control characters other than \n and \t removed (like frame()),
 * and invisible Unicode removed.
 */
export function deckText(v: unknown): string {
	return dropInvisible(String(v ?? "")).replace(CONTROL, "");
}

/** Characters an answer takes as structuredContent: JSON with nulls kept. */
export function jsonChars(v: unknown): number {
	return JSON.stringify(v).length;
}

/**
 * The largest prefix of `items` whose rendered answer fits `budget` characters as structuredContent
 * carries it (JSON with nulls kept). Core's ctx.page.fit measured without nulls until section 30.7,
 * so structuredContent could pass the cap (fix round 3); the framed text, which leaves nulls out, is
 * then smaller still.
 */
export function fitJson<T>(items: readonly T[], render: (items: T[]) => unknown, budget: number): { items: T[]; cut: boolean } {
	const fits = (n: number) => jsonChars(render(items.slice(0, n))) <= budget;
	if (fits(items.length)) return { items: items.slice(), cut: false };
	let lo = 0;
	let hi = items.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (fits(mid)) lo = mid;
		else hi = mid - 1;
	}
	return { items: items.slice(0, lo), cut: true };
}

// ---- Deck's JSON (only the fields we read) ----

export interface DeckUser {
	primaryKey?: string;
	uid?: string;
	displayname?: string;
	type?: number;
}

export interface DeckLabel {
	id: number;
	title: string;
	color?: string;
}

export interface DeckAcl {
	participant?: DeckUser | string;
	type?: number;
	permissionEdit?: boolean;
}

export interface DeckStack {
	id: number;
	title: string;
	boardId?: number;
	order?: number;
	deletedAt?: number;
	isDoneColumn?: boolean;
	cards?: DeckCard[];
}

export interface DeckAssignment {
	id?: number;
	participant?: DeckUser | string;
	type?: number;
}

export interface DeckCard {
	id: number;
	title: string;
	description?: string | null;
	stackId: number;
	type?: string;
	order?: number;
	owner?: DeckUser | string;
	archived?: boolean;
	done?: string | null;
	duedate?: string | null;
	startdate?: string | null;
	deletedAt?: number;
	labels?: DeckLabel[];
	assignedUsers?: DeckAssignment[];
	commentsCount?: number;
	createdAt?: number;
	lastModified?: number;
}

export interface DeckBoard {
	id: number;
	title: string;
	color?: string;
	owner?: DeckUser | string;
	archived?: boolean;
	deletedAt?: number;
	permissions?: Record<string, boolean>;
	users?: DeckUser[];
	acl?: DeckAcl[];
	labels?: DeckLabel[];
	stacks?: DeckStack[];
	externalId?: unknown;
}

export interface DeckComment {
	id: number;
	message?: string;
	actorId?: string;
	actorType?: string;
	actorDisplayName?: string;
	creationDateTime?: string;
	replyTo?: { id?: number };
}

// ---- Output shapes ----

export const BoardOut = z.object({
	board_id: z.number(),
	title: z.string(),
	color: z.string().nullable(),
	owner: Person,
	can_edit: z.boolean(),
	archived: z.boolean(),
	web_url: z.string(),
});
export type BoardOut = z.infer<typeof BoardOut>;

export const LabelOut = z.object({ label_id: z.number(), title: z.string(), color: z.string().nullable() });

export const CardOut = z.object({
	card_id: z.number(),
	board_id: z.number(),
	stack_id: z.number(),
	title: z.string(),
	description: z.string().nullable(),
	description_cut: z.boolean().optional(),
	due: z.string().nullable(),
	start: z.string().nullable().optional(),
	done: z.boolean(),
	done_at: z.string().nullable().optional(),
	archived: z.boolean(),
	labels: z.array(z.string()),
	assignees: z.array(Person),
	owner: Person.nullable().optional(),
	order: z.number(),
	comments_count: z.number(),
	created_at: z.string().nullable().optional(),
	modified_at: z.string().nullable().optional(),
	web_url: z.string(),
});
export type CardOut = z.infer<typeof CardOut>;

/**
 * What tools/list publishes as output schemas: the key fields only, open to the rest. The whole
 * card (CardOut) is still returned; this keeps lane E's share of tools/list small (DESIGN 10.8).
 */
export const CardBrief = z.looseObject({ card_id: z.number(), title: z.string(), due: z.string().nullable(), done: z.boolean() });
export const BoardBrief = z.looseObject({ board_id: z.number(), title: z.string(), can_edit: z.boolean(), web_url: z.string() });
export const UndoBrief = z.looseObject({ tool: z.string(), arguments: z.record(z.string(), z.unknown()) }).nullable();

// ---- Input pieces ----

export const boardIdArg = () => z.number().int().min(1).max(2_147_483_647).describe("Board id, from boards_list.");
export const cardIdArg = () => z.number().int().min(1).max(2_147_483_647).describe("Card id, from boards_get_board.");
export const stackIdArg = (what = "List (stack) id, from boards_get_board.") => z.number().int().min(1).max(2_147_483_647).describe(what);

/** "2026-11-03", "2026-11-03T14:30", "2026-11-03T14:30:00+01:00" or "...Z". */
export const dueArg = (description: string) => z.string().min(10).max(40).describe(description);

// ---- Mapping ----

function uidOf(u: DeckUser | string | undefined | null): string | null {
	if (!u) return null;
	if (typeof u === "string") return u || null;
	return u.uid ?? u.primaryKey ?? null;
}

export function personOf(u: DeckUser | string | undefined | null): Person | null {
	const uid = uidOf(u);
	if (!uid) return null;
	const name = typeof u === "object" && u?.displayname ? deckText(u.displayname) : null;
	return { id: typedId("person", uid), display_name: name || null };
}

export function boardUrl(ctx: ToolCtx, boardId: number): string {
	return `${ctx.cfg.driveOrigin}/apps/deck/board/${boardId}`;
}

export function cardUrl(ctx: ToolCtx, boardId: number, cardId: number): string {
	return `${ctx.cfg.driveOrigin}/apps/deck/board/${boardId}/card/${cardId}`;
}

/** A Deck date (ISO 8601 with offset) in the person's zone, or null. */
export function dateOut(ctx: ToolCtx, raw: string | null | undefined): string | null {
	if (!raw) return null;
	const ms = Date.parse(raw);
	return Number.isFinite(ms) ? ctx.time.format(ms) : null;
}

function epochOut(ctx: ToolCtx, sec: number | undefined): string | null {
	return typeof sec === "number" && sec > 0 ? ctx.time.format(sec * 1000) : null;
}

export function boardOut(ctx: ToolCtx, b: DeckBoard): BoardOut {
	return {
		board_id: b.id,
		title: deckText(boardTitleOut(String(b.title ?? ""), b.color)),
		color: b.color ? `#${b.color.replace(/^#/, "")}` : null,
		owner: personOf(b.owner) ?? { id: "person:unknown", display_name: null },
		can_edit: b.permissions?.PERMISSION_EDIT === true,
		archived: b.archived === true,
		web_url: boardUrl(ctx, b.id),
	};
}

export function cutText(s: string, max: number): { text: string; cut: boolean } {
	if (s.length <= max) return { text: s, cut: false };
	return { text: `${s.slice(0, Math.max(0, max - 1))}…`, cut: true };
}

export function cardOut(ctx: ToolCtx, boardId: number, c: DeckCard, opts: { descriptionMax: number; full?: boolean }): CardOut {
	const desc = deckText(cardDescriptionOut(String(c.description ?? "")));
	const cut = cutText(desc, opts.descriptionMax);
	const out: CardOut = {
		card_id: c.id,
		board_id: boardId,
		stack_id: c.stackId,
		title: deckText(c.title),
		description: desc ? cut.text : null,
		...(cut.cut ? { description_cut: true } : {}),
		due: dateOut(ctx, c.duedate),
		done: Boolean(c.done),
		archived: c.archived === true,
		labels: (c.labels ?? []).map((l) => deckText(l.title)).filter(Boolean),
		assignees: (c.assignedUsers ?? [])
			.filter((a) => (a.type ?? 0) === 0)
			.map((a) => personOf(a.participant))
			.filter((p): p is Person => p !== null),
		order: typeof c.order === "number" ? c.order : 0,
		comments_count: typeof c.commentsCount === "number" ? c.commentsCount : 0,
		web_url: cardUrl(ctx, boardId, c.id),
	};
	if (opts.full) {
		out.start = dateOut(ctx, c.startdate);
		out.done_at = dateOut(ctx, c.done);
		out.owner = personOf(c.owner);
		out.created_at = epochOut(ctx, c.createdAt);
		out.modified_at = epochOut(ctx, c.lastModified);
	}
	return out;
}

/** Uids of the people who can use the board (owner, shared people and members of shared groups). */
export function memberUids(b: DeckBoard): Set<string> {
	const s = new Set<string>();
	const owner = uidOf(b.owner);
	if (owner) s.add(owner);
	for (const u of b.users ?? []) {
		const uid = uidOf(u);
		if (uid) s.add(uid);
	}
	for (const a of b.acl ?? []) {
		if ((a.type ?? 0) === 0) {
			const uid = uidOf(a.participant);
			if (uid) s.add(uid);
		}
	}
	return s;
}

export function membersOut(b: DeckBoard): Person[] {
	const byUid = new Map<string, Person>();
	const add = (u: DeckUser | string | undefined | null) => {
		const p = personOf(u);
		if (p && !byUid.has(p.id)) byUid.set(p.id, p);
		else if (p && p.display_name && !byUid.get(p.id)?.display_name) byUid.set(p.id, p);
	};
	add(b.owner);
	for (const u of b.users ?? []) add(u);
	for (const a of b.acl ?? []) if ((a.type ?? 0) === 0) add(a.participant);
	return [...byUid.values()];
}

export function stacksInOrder<T extends DeckStack>(stacks: readonly T[]): T[] {
	return stacks
		.filter((s) => !s.deletedAt)
		.slice()
		.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id);
}

export function cardsInOrder(cards: readonly DeckCard[]): DeckCard[] {
	return cards
		.filter((c) => !c.deletedAt)
		.slice()
		.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id);
}

// ---- Calls, with board-specific plain messages ----

export type Target = { kind: "board"; boardId: number } | { kind: "card"; boardId: number; cardId: number } | { kind: "stack"; boardId: number; stackId: number };

function notFoundMessage(t: Target): ToolError {
	if (t.kind === "board") {
		return new ToolError("not_found", `There's no board ${t.boardId}, or this person can't see it.`, { hint: "boards_list shows the boards." });
	}
	if (t.kind === "stack") {
		return new ToolError("not_found", `Board ${t.boardId} has no list ${t.stackId}.`, { hint: "boards_get_board shows its lists and their ids." });
	}
	return new ToolError("not_found", `There's no card ${t.cardId} on board ${t.boardId}, or this person can't see it.`, {
		hint: "boards_get_board shows the board's cards.",
	});
}

/** Maps a failed Deck call to a board-specific message. `loaded` means the item was read just before. */
export function deckError(e: unknown, t: Target, loaded = false): unknown {
	if (!(e instanceof ToolError)) return e;
	// Keep the server's text for matching by the caller (never shown, never logged).
	const keep = { detail: e.detail, upstreamStatus: e.upstreamStatus };
	const detail = (e.detail ?? "").toLowerCase();
	if (detail.includes("archived")) {
		const what = detail.includes("board is archived") ? `Board ${t.boardId} is archived` : "This card is archived";
		return new ToolError("invalid_input", `${what}, so it can't be changed.`, { ...keep, hint: "Archived items can be restored in NoBoard first." });
	}
	if (e.code === "permission_denied" || e.code === "not_found") {
		if (loaded) return new ToolError("permission_denied", `The person can see board ${t.boardId} but isn't allowed to change it.`, keep);
		const nf = notFoundMessage(t);
		return new ToolError(nf.code, nf.message, { ...keep, hint: nf.hint });
	}
	if (e.code === "invalid_input" && e.upstreamStatus === 400) {
		return new ToolError("invalid_input", "NoBoard refused that request as invalid.", keep);
	}
	return e;
}

export async function deckRest<T>(ctx: ToolCtx, method: "GET" | "POST" | "PUT", path: string, t: Target, body?: Record<string, unknown>, loaded = false): Promise<T> {
	try {
		return await ctx.nc.deck.rest<T>(method, path, body);
	} catch (e) {
		throw deckError(e, t, loaded);
	}
}

export async function deckOcs<T>(ctx: ToolCtx, method: "GET" | "POST" | "PUT", path: string, t: Target, body?: Record<string, unknown>, loaded = false): Promise<T> {
	try {
		return await ctx.nc.deck.ocs<T>(method, path, body);
	} catch (e) {
		throw deckError(e, t, loaded);
	}
}

function asObject<T>(v: unknown, what: string): T {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new ToolError("upstream_unavailable", `NoBoard's answer about the ${what} couldn't be read.`);
	return v as T;
}

/** GET /boards/{b}: the board with its stacks (no cards), members, labels and permissions. */
export async function loadBoard(ctx: ToolCtx, boardId: number): Promise<DeckBoard> {
	const id = numericId(boardId, "board_id");
	await requireDeck(ctx);
	const b = asObject<DeckBoard>(await deckRest<unknown>(ctx, "GET", `/boards/${id}`, { kind: "board", boardId: id }), "board");
	if (typeof b.id !== "number" || b.id !== id || (b.deletedAt ?? 0) > 0) throw notFoundMessage({ kind: "board", boardId: id });
	return b;
}

/** GET /boards/{b}/stacks: the stacks with their open (not archived) cards. */
export async function loadStacks(ctx: ToolCtx, boardId: number, archived = false): Promise<DeckStack[]> {
	const r = await deckRest<unknown>(ctx, "GET", `/boards/${boardId}/stacks${archived ? "/archived" : ""}`, { kind: "board", boardId });
	if (!Array.isArray(r)) throw new ToolError("upstream_unavailable", "NoBoard's answer about the lists couldn't be read.");
	return r as DeckStack[];
}

/**
 * Loads a board and one of its cards, and checks that the card is on that board (Deck's card
 * routes would otherwise accept any card id the person can see, whatever board was named).
 */
export async function loadCardOnBoard(ctx: ToolCtx, boardId: number, cardId: number): Promise<{ board: DeckBoard; card: DeckCard; stack: DeckStack }> {
	const board = await loadBoard(ctx, boardId);
	const cid = numericId(cardId, "card_id");
	const stacks = stacksInOrder(board.stacks ?? []);
	const t: Target = { kind: "card", boardId: board.id, cardId: cid };
	const first = stacks[0];
	if (!first) throw notFoundMessage(t);
	const card = asObject<DeckCard>(await deckRest<unknown>(ctx, "GET", `/boards/${board.id}/stacks/${first.id}/cards/${cid}`, t), "card");
	const stack = stacks.find((s) => s.id === card.stackId);
	if (card.id !== cid || !stack || (card.deletedAt ?? 0) > 0) throw notFoundMessage(t);
	return { board, card, stack };
}

export function findStack(board: DeckBoard, stackId: number): DeckStack {
	const sid = numericId(stackId, "stack_id");
	const s = stacksInOrder(board.stacks ?? []).find((x) => x.id === sid);
	if (!s) throw notFoundMessage({ kind: "stack", boardId: board.id, stackId: sid });
	return s;
}

export function requireEdit(board: DeckBoard): void {
	if (board.archived === true) {
		throw new ToolError("invalid_input", `Board ${board.id} is archived, so it can't be changed.`, { hint: "Archived boards can be restored in NoBoard first." });
	}
	if (board.permissions?.PERMISSION_EDIT !== true) {
		throw new ToolError("permission_denied", `The person can see board ${board.id} but isn't allowed to change it.`);
	}
}

/**
 * Parses a due date: a date alone means the end of that day (23:59) in the person's zone; a
 * date-time without an offset is read in the person's zone. Returns UTC milliseconds.
 */
export function parseDue(ctx: ToolCtx, raw: string, field = "due"): number {
	const p = ctx.time.parse(raw, field);
	if (p.kind === "instant") return p.utcMs;
	const iso = `${String(p.y).padStart(4, "0")}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}T23:59:00`;
	const q = ctx.time.parse(iso, field);
	if (q.kind !== "instant") throw new ToolError("invalid_input", `${field} isn't a real date.`, { field });
	return q.utcMs;
}

/**
 * The full card body for Deck's REST card update, which replaces every field: anything not sent
 * is cleared (done and startdate included). Archived and colour are left out on purpose: Deck keeps
 * them when they are absent.
 */
export function fullCardBody(card: DeckCard, changes: { duedate?: string | null }): Record<string, unknown> {
	const owner = uidOf(card.owner);
	if (!owner) throw new ToolError("upstream_unavailable", "NoBoard's answer about the card couldn't be read.");
	return {
		title: card.title,
		type: card.type ?? "plain",
		owner,
		description: card.description ?? "",
		order: typeof card.order === "number" ? card.order : 0,
		duedate: "duedate" in changes ? changes.duedate : (card.duedate ?? null),
		startdate: card.startdate ?? null,
		done: card.done ?? null,
	};
}

export function assigneeUids(card: DeckCard): string[] {
	return (card.assignedUsers ?? [])
		.filter((a) => (a.type ?? 0) === 0)
		.map((a) => uidOf(a.participant))
		.filter((u): u is string => typeof u === "string");
}
