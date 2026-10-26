/**
 * Collects extracted text as blocks: list items follow each other on single lines, other blocks
 * are separated by a blank line. Reading stops at MAX_TEXT_CHARS (the rest is reported as cut),
 * so a huge file can't use up the Worker's memory.
 */
import { ToolError } from "../../core/errors";
import { DOC_LIMITS } from "../limits";

export const MAX_TEXT_CHARS = 5_000_000;

/** Thrown to stop reading early once enough text is collected; never shown to anyone. */
export class StopRead extends Error {
	constructor() {
		super("stop");
		this.name = "StopRead";
	}
}

export class TextOut {
	private parts: string[] = [];
	private length = 0;
	private lastWasItem = false;
	/** Reading stopped at the text cap: the end of the file is missing. */
	cut = false;
	/**
	 * A reader limit left some content out (rows past 5,000 in a sheet, cells past column 1,000, a
	 * monstrous paragraph or cell cut short, PDF pages past 300). files_read_text then sets truncated.
	 */
	left = false;

	/** Notes that a reader limit left some content out. */
	leftOut(): void {
		this.left = true;
	}

	constructor(private readonly max = MAX_TEXT_CHARS) {}

	/** Adds one block. List items are joined with a single newline. */
	block(s: string, listItem = false): void {
		if (this.cut) throw new StopRead();
		if (!s.trim()) return;
		const sep = this.parts.length === 0 ? "" : listItem && this.lastWasItem ? "\n" : "\n\n";
		this.parts.push(sep, s);
		this.length += sep.length + s.length;
		this.lastWasItem = listItem;
		if (this.length > this.max) {
			this.cut = true;
			throw new StopRead();
		}
	}

	/** Adds a line directly after the previous one (rows of a sheet). */
	line(s: string): void {
		if (this.cut) throw new StopRead();
		const sep = this.parts.length === 0 ? "" : "\n";
		this.parts.push(sep, s);
		this.length += sep.length + s.length;
		this.lastWasItem = false;
		if (this.length > this.max) {
			this.cut = true;
			throw new StopRead();
		}
	}

	fail(message: string): never {
		throw new ToolError("unsupported_type", message);
	}

	/** Characters that can still be added before the text is cut. */
	room(): number {
		return Math.max(0, this.max - this.length);
	}

	/** Ends reading here: what was collected stays, and the rest is reported as cut. */
	stop(): never {
		this.cut = true;
		throw new StopRead();
	}

	text(): string {
		const s = this.parts.join("");
		return s.length > this.max ? s.slice(0, this.max) : s;
	}

	get size(): number {
		return this.length;
	}
}

/**
 * Trims the end of every line. Done by splitting, never with a regular expression such as
 * /[ \t]+$/gm, which backtracks quadratically on a long run of spaces inside a line.
 */
export function trimLineEnds(s: string): string {
	return s.includes("\n") ? s.split("\n").map((l) => l.trimEnd()).join("\n") : s.trimEnd();
}

/** Joins lines with single spaces (table cells, titles), without a backtracking regex. */
export function joinLines(s: string): string {
	return s
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.join(" ");
}

/**
 * Appends to text being collected for one block (a paragraph, cell or slide line), keeping at most
 * `max` characters: the rest of a monstrous block is dropped rather than held in memory. With `out`,
 * a drop is noted there (TextOut.left), so the read says it is incomplete.
 */
export function addCapped(cur: string, add: string, max: number = DOC_LIMITS.blockChars, out?: TextOut): string {
	if (cur.length + add.length <= max) return cur + add;
	if (add.length > 0) out?.leftOut();
	return cur.length >= max ? cur : cur + add.slice(0, max - cur.length);
}

/** Runs a reader and swallows the early stop. */
export function runReader(fn: () => void): void {
	try {
		fn();
	} catch (e) {
		if (e instanceof StopRead) return;
		throw e;
	}
}
