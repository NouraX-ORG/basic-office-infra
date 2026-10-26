/**
 * Keeping lane B's answers inside one result (DESIGN 10.4: 60,000 characters), measured the way
 * structuredContent carries them (fix round 3). Many clients hand structuredContent to the model
 * as it is, so the framed text block being short is not enough:
 * - it is JSON with nulls kept, where a quote or a backslash takes two characters (core's
 *   ctx.page.fit left nulls out when it measured, until section 30.7);
 * - text people wrote elsewhere (a share note, a contact's name made in another app) has no length
 *   limit on the server, so every such field is shown cut to a field limit, and one item can never
 *   outgrow a page.
 *
 * Shown text is display text: control characters are dropped (the framed text block drops them
 * too, so both say the same), tabs and line separators become spaces (line breaks are kept only
 * where `multiline`), and a broken surrogate pair becomes U+FFFD. It is never fed back into a
 * tool's input or an undo: those use the server's own values.
 */
import { LIMITS } from "../../core/limits";
import { payloadBudget } from "../../core/result";
import type { ToolCtx } from "../../core/tool";

// C0 and C1 controls except \t and \n (handled below), DEL and the byte-order mark. Built from
// escapes in a string, so no control or separator character is in the source.
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\ufeff]", "g");
// Tabs and the Unicode line and paragraph separators.
const SPACING = new RegExp("[\\t\\u2028\\u2029]", "g");
/** "..." as one character (U+2026), at the end of a text shown cut short. */
const ELLIPSIS = String.fromCharCode(0x2026);

export interface Shown {
	text: string;
	/** true when the text was longer than `max` and is shown cut short (ending in "..."). */
	cut: boolean;
}

/** Display text, at most `max` characters; a cut text ends in "...". */
export function shown(s: string, max: number, multiline = false): Shown {
	let t = s.replace(/\r\n?/g, "\n").replace(SPACING, (c) => (c === "\t" || !multiline ? " " : "\n"));
	if (!multiline) t = t.replace(/\n/g, " ");
	t = t.replace(CONTROL, "").toWellFormed();
	if (t.length <= max) return { text: t, cut: false };
	let end = Math.max(0, max - 1);
	// Never split a surrogate pair.
	const code = t.charCodeAt(end - 1);
	if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
	return { text: `${t.slice(0, end)}${ELLIPSIS}`, cut: true };
}

/** Display text or null: null and empty text (once cleaned) are null. */
export function shownOrNull(s: unknown, max: number, multiline = false): string | null {
	if (typeof s !== "string" || s.length === 0) return null;
	const t = shown(s, max, multiline).text;
	return t.length ? t : null;
}

/** How many characters a value takes as JSON, nulls kept (what structuredContent carries). */
export function jsonLength(v: unknown): number {
	return JSON.stringify(v)?.length ?? 0;
}

/**
 * The characters one answer's structuredContent may take: the result budget with room for the
 * longest summary line core allows (300 characters; ctx.budget assumes 120), so the framed text,
 * which is the same JSON without its nulls, is never cut short either.
 */
export function answerRoom(ctx: Pick<ToolCtx, "budget">): number {
	return Math.min(ctx.budget.chars, payloadBudget("x".repeat(300)), LIMITS.resultChars);
}

/** The largest prefix of `items` whose rendered answer, as JSON with nulls kept, is at most `room` characters. */
export function fitJson<T>(items: readonly T[], render: (items: T[]) => unknown, room: number): T[] {
	const fits = (n: number) => jsonLength(render(items.slice(0, n))) <= room;
	if (fits(items.length)) return items.slice();
	let lo = 0;
	let hi = items.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (fits(mid)) lo = mid;
		else hi = mid - 1;
	}
	return items.slice(0, lo);
}

/**
 * One page of a sorted list: up to `limit` items from `offset` that fit `room`. A page always
 * moves on: should the first item not fit on its own (the field limits make that impossible
 * today), it is skipped and counted, so a cursor can never repeat the same empty page.
 */
export function pageWindow<T>(all: readonly T[], offset: number, limit: number, render: (items: T[]) => unknown, room: number): { items: T[]; next: number; skipped: number } {
	const window = all.slice(offset, offset + limit);
	const items = fitJson(window, render, room);
	if (items.length === 0 && window.length > 0) return { items, next: offset + 1, skipped: 1 };
	return { items, next: offset + items.length, skipped: 0 };
}
