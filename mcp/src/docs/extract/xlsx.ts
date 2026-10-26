/**
 * Excel (.xlsx) to text (DESIGN 12.4): sheet names and order from xl/workbook.xml, shared strings
 * by index, inline strings, numbers and booleans; dates are found from number formats and shown as
 * ISO dates. Each sheet becomes CSV rows under "## Sheet: name", at most 5,000 rows per sheet.
 * `sheet` picks one sheet by name (or by its 1-based number).
 *
 * Every part is streamed. The shared strings are kept compactly (joined blocks, so no string keeps
 * a decoded chunk alive) and are bounded: at most 1,000,000 strings and 16,000,000 characters
 * (DOC_LIMITS); a bigger file is TooBigHere and is read through the connector's conversion.
 */
import { ToolError } from "../../core/errors";
import { TooBigHere } from "../errors";
import { DOC_LIMITS } from "../limits";
import { attr, NS, parsePart, SaxStream } from "../sax";
import type { ZipReader } from "../zip";
import { MAX_SHEET_ROWS, MAX_SHEET_COLUMNS, csvLine, formatNumber, isDateFormat, serialToIso } from "./cells";
import { addCapped, type TextOut } from "./out";
import { readRels, relsPathFor, resolvePart } from "./rels";

interface SheetRef {
	name: string;
	part: string;
	hidden: boolean;
}

/** Built-in number formats that show dates or times. */
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const BUILTIN_TIME_ONLY = new Set([18, 19, 20, 21, 45, 46, 47]);

/** Characters kept of one cell (Excel's own limit) and of one row. */
const CELL_CHARS = 32_767;
const MAX_SHEETS = 10_000;

function readWorkbook(zip: ZipReader): { sheets: SheetRef[]; date1904: boolean } {
	if (!zip.has("xl/workbook.xml")) throw new ToolError("unsupported_type", "This Excel file has no workbook part.");
	const rels = readRels(zip, relsPathFor("xl/workbook.xml"));
	const sheets: SheetRef[] = [];
	let date1904 = false;
	parsePart(zip, "xl/workbook.xml", {
		open(t) {
			if (t.uri !== NS.x) return;
			if (t.local === "workbookPr") {
				const v = (attr(t, null, "date1904") ?? "").toLowerCase();
				date1904 = v === "1" || v === "true";
			} else if (t.local === "sheet" && sheets.length < MAX_SHEETS) {
				const rid = attr(t, NS.r, "id");
				const rel = rid ? rels.get(rid) : undefined;
				if (!rel || rel.external) return;
				const state = attr(t, null, "state") ?? "visible";
				sheets.push({ name: (attr(t, null, "name") ?? `Sheet${sheets.length + 1}`).slice(0, 255), part: resolvePart("xl/workbook.xml", rel.target), hidden: state !== "visible" });
			}
		},
	});
	return { sheets, date1904 };
}

/** For each cellXfs index: "date", "time", "datetime" or null. */
function readDateStyles(zip: ZipReader): ("date" | "datetime" | "time" | null)[] {
	const custom = new Map<number, string>();
	const xfs: ("date" | "datetime" | "time" | null)[] = [];
	let inCellXfs = false;
	const fmts: number[] = [];
	// Streamed; at most DOC_LIMITS.tableEntries formats and cell styles are kept.
	parsePart(zip, "xl/styles.xml", {
		open(t) {
			if (t.uri !== NS.x) return;
			if (t.local === "numFmt" && custom.size < DOC_LIMITS.tableEntries) custom.set(Number(attr(t, null, "numFmtId")), (attr(t, null, "formatCode") ?? "").slice(0, 255));
			else if (t.local === "cellXfs") inCellXfs = true;
			else if (t.local === "xf" && inCellXfs && fmts.length < DOC_LIMITS.tableEntries) fmts.push(Number(attr(t, null, "numFmtId") ?? 0));
		},
		close(t) {
			if (t.uri === NS.x && t.local === "cellXfs") inCellXfs = false;
		},
	});
	for (const id of fmts) {
		const code = custom.get(id);
		if (code !== undefined) xfs.push(isDateFormat(code));
		else if (BUILTIN_DATE.has(id)) xfs.push(BUILTIN_TIME_ONLY.has(id) ? "time" : id === 22 ? "datetime" : "date");
		else xfs.push(null);
	}
	return xfs;
}

/** How many strings go into one joined block. */
const BLOCK = 4096;

/**
 * The shared strings, kept as joined blocks of 4,096 strings plus an end offset per string. Joining
 * copies the text, so no kept string holds on to a decoded chunk of the part (a substring would).
 */
export class SharedStrings {
	private readonly blocks: string[] = [];
	private pending: string[] = [];
	private ends = new Int32Array(1024);
	private pendingLen = 0;
	private chars = 0;
	count = 0;

	add(s: string): void {
		if (this.count >= DOC_LIMITS.sharedStrings) throw new TooBigHere("This spreadsheet has more distinct text than can be read here.");
		const v = s.length > DOC_LIMITS.sharedStringMax ? s.slice(0, DOC_LIMITS.sharedStringMax) : s;
		this.chars += v.length;
		if (this.chars > DOC_LIMITS.sharedStringChars) throw new TooBigHere("This spreadsheet has more distinct text than can be read here.");
		if (this.count >= this.ends.length) {
			const next = new Int32Array(Math.min(DOC_LIMITS.sharedStrings, this.ends.length * 2));
			next.set(this.ends);
			this.ends = next;
		}
		this.pending.push(v);
		this.pendingLen += v.length;
		this.ends[this.count] = this.pendingLen;
		this.count++;
		if (this.pending.length === BLOCK) this.seal();
	}

	private seal(): void {
		if (this.pending.length === 0) return;
		this.blocks.push(this.pending.join(""));
		this.pending = [];
		this.pendingLen = 0;
	}

	done(): this {
		this.seal();
		return this;
	}

	get(i: number): string {
		if (!Number.isInteger(i) || i < 0 || i >= this.count) return "";
		const block = this.blocks[Math.floor(i / BLOCK)];
		if (block === undefined) return "";
		const start = i % BLOCK === 0 ? 0 : (this.ends[i - 1] as number);
		return block.slice(start, this.ends[i] as number);
	}
}

function readSharedStrings(zip: ZipReader): SharedStrings {
	const out = new SharedStrings();
	let cur: string | null = null;
	let inT = false;
	let rph = 0;
	parsePart(zip, "xl/sharedStrings.xml", {
		open(t) {
			if (t.uri !== NS.x) return;
			if (t.local === "si") cur = "";
			else if (t.local === "rPh") rph++;
			else if (t.local === "t" && rph === 0) inT = true;
		},
		close(t) {
			if (t.uri !== NS.x) return;
			if (t.local === "si") {
				out.add(cur ?? "");
				cur = null;
			} else if (t.local === "rPh") rph--;
			else if (t.local === "t") inT = false;
		},
		text(x) {
			if (inT && cur !== null) cur = addCapped(cur, x, DOC_LIMITS.sharedStringMax);
		},
	});
	return out.done();
}

function colIndex(ref: string): number | null {
	let n = 0;
	let k = 0;
	while (k < ref.length && k < 4) {
		const c = ref.charCodeAt(k);
		if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
		else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
		else break;
		k++;
	}
	return k === 0 ? null : n - 1;
}

export function sheetNames(zip: ZipReader): string[] {
	return readWorkbook(zip).sheets.map((s) => s.name);
}

export function xlsxText(zip: ZipReader, out: TextOut, opts: { sheet?: string } = {}): { sheets: string[] } {
	const wb = readWorkbook(zip);
	const names = wb.sheets.map((s) => s.name);
	let chosen = wb.sheets;
	if (opts.sheet !== undefined) {
		const want = opts.sheet.trim().toLowerCase();
		const byName = wb.sheets.filter((s) => s.name.toLowerCase() === want);
		const asNum = /^\d+$/.test(want) ? wb.sheets[Number(want) - 1] : undefined;
		chosen = byName.length ? byName : asNum ? [asNum] : [];
		if (chosen.length === 0) throw noSheet(opts.sheet, names.length);
	}
	const dateStyles = readDateStyles(zip);
	const shared = readSharedStrings(zip);
	for (const sh of chosen) {
		out.block(`## Sheet: ${sh.name}${sh.hidden ? " (hidden)" : ""}`);
		let rows = 0;
		let more = 0;
		let row: string[] = [];
		let rowChars = 0;
		let col = 0;
		let cell: { t: string; s: number; ref: number | null } | null = null;
		let v = "";
		let isText = "";
		let inV = false;
		let inIsT = false;
		let inIs = false;
		let inF = false;
		let f = "";
		const flushRow = () => {
			let end = row.length;
			while (end > 0 && (row[end - 1] ?? "") === "") end--;
			if (end === 0) return;
			if (rows >= MAX_SHEET_ROWS) {
				more++;
				out.leftOut();
				return;
			}
			rows++;
			out.line(csvLine(row.slice(0, end)));
		};
		const stream = new SaxStream({
			open(t) {
				if (t.uri !== NS.x) return;
				switch (t.local) {
					case "row":
						row = [];
						rowChars = 0;
						col = 0;
						break;
					case "c": {
						const r = attr(t, null, "r");
						cell = { t: attr(t, null, "t") ?? "n", s: Number(attr(t, null, "s") ?? 0) || 0, ref: r ? colIndex(r) : null };
						v = "";
						isText = "";
						f = "";
						break;
					}
					case "v":
						inV = true;
						break;
					case "f":
						inF = true;
						break;
					case "is":
						inIs = true;
						break;
					case "t":
						if (inIs) inIsT = true;
						break;
				}
			},
			close(t) {
				if (t.uri !== NS.x) return;
				switch (t.local) {
					case "v":
						inV = false;
						break;
					case "f":
						inF = false;
						break;
					case "t":
						inIsT = false;
						break;
					case "is":
						inIs = false;
						break;
					case "c": {
						if (!cell) break;
						const c = cell;
						const at = c.ref ?? col;
						col = at + 1;
						cell = null;
						if (at >= MAX_SHEET_COLUMNS) {
							if (v !== "" || isText !== "" || f !== "") out.leftOut();
							break;
						}
						let text = "";
						if (c.t === "s") text = shared.get(Number(v));
						else if (c.t === "inlineStr") text = isText;
						else if (c.t === "str" || c.t === "e") text = v;
						else if (c.t === "b") text = v === "1" ? "TRUE" : v === "0" ? "FALSE" : v;
						else if (c.t === "d") text = v;
						else if (v !== "") {
							const n = Number(v);
							const ds = dateStyles[c.s];
							if (Number.isFinite(n) && ds) text = serialToIso(n, ds, wb.date1904);
							else text = Number.isFinite(n) ? formatNumber(n) : v;
						}
						// A formula with no saved result (written by a library, never opened): show the formula.
						if (text === "" && v === "" && f.trim()) text = `=${f.trim()}`;
						// A row keeps at most DOC_LIMITS.blockChars characters; the rest of its cells stay empty.
						if (rowChars + text.length > DOC_LIMITS.blockChars) {
							if (text) out.leftOut();
							text = "";
						}
						rowChars += text.length;
						while (row.length < at) row.push("");
						row[at] = text;
						break;
					}
					case "row":
						flushRow();
						break;
				}
			},
			text(x) {
				if (inV) v = addCapped(v, x, CELL_CHARS, out);
				else if (inIsT) isText = addCapped(isText, x, CELL_CHARS, out);
				else if (inF) f = addCapped(f, x, 8192);
			},
		});
		if (!zip.streamText(sh.part, (c) => stream.write(c))) continue;
		stream.close();
		if (more > 0) out.line(`[This sheet has ${more.toLocaleString("en-GB")} more rows; only the first ${MAX_SHEET_ROWS.toLocaleString("en-GB")} are shown.]`);
		if (rows === 0 && more === 0) out.line("(empty)");
	}
	return { sheets: names };
}

/** The sheet asked for isn't there. The file's own sheet names never go into an error (they are unframed). */
export function noSheet(asked: string, count: number): ToolError {
	return new ToolError(
		"invalid_input",
		`There's no sheet called "${asked.slice(0, 100)}". This file has ${count} sheet${count === 1 ? "" : "s"}; read it without sheet to see their names, or give a number from 1 to ${Math.max(1, count)}.`,
		{ field: "sheet" },
	);
}
