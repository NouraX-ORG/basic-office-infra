/**
 * OpenDocument (odt, ods, odp) to text from content.xml (DESIGN 12.4):
 * - text: headings (text:h, or a paragraph whose style is a heading style, as ONLYOFFICE and Word
 *   write them), paragraphs, bullet and numbered lists (from the list styles), tables as Markdown
 *   tables;
 * - spreadsheets: each table as CSV rows under "## Sheet: name" (typed values, repeats expanded
 *   only where cells have content, 5,000 rows per sheet at most);
 * - presentations: each page as "## Slide N: title", its text, then its notes.
 * Paragraph and list styles come from styles.xml and from content.xml's automatic styles.
 */
import { ToolError } from "../../core/errors";
import { DOC_LIMITS } from "../limits";
import { attr, NS, SaxStream, type Tag } from "../sax";
import type { ZipReader } from "../zip";
import { csvLine, formatNumber, MAX_SHEET_COLUMNS, MAX_SHEET_ROWS } from "./cells";
import { addCapped, type TextOut, trimLineEnds } from "./out";
import { noSheet } from "./xlsx";

type Mode = "odt" | "ods" | "odp";

const MAX_REPEAT = 1_000;

/** "2026-10-26T09:30:00" -> "2026-10-26 09:30"; a plain date stays as it is. */
function isoDateTime(v: string): string {
	const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?)?/.exec(v);
	if (!m) return v;
	if (!m[2] || (m[2] === "00:00" && (m[3] ?? "00") === "00")) return m[1] as string;
	return `${m[1]} ${m[2]}${m[3] && m[3] !== "00" ? `:${m[3]}` : ""}`;
}

/**
 * office:boolean-value is an xsd:boolean, so "1" and "0" are as valid as "true" and "false", and
 * ONLYOFFICE writes "1" (fix round 2: every TRUE it saved read as FALSE). Anything else is no value,
 * and the cell's own text is shown instead.
 */
export function odfBoolean(v: string | undefined): string | null {
	const b = (v ?? "").trim().toLowerCase();
	if (b === "true" || b === "1") return "TRUE";
	if (b === "false" || b === "0") return "FALSE";
	return null;
}

/**
 * How many sheets an OpenDocument spreadsheet has: the tables right under office:spreadsheet in
 * content.xml, streamed with the zip reader's counters (docs_convert says when a PDF or CSV copy
 * keeps only the first one).
 */
export function odsSheetCount(zip: ZipReader): number {
	let count = 0;
	let inSheet = 0; // the depth of office:spreadsheet, 0 outside it
	const stream = new SaxStream({
		open(t, depth) {
			if (t.uri === NS.office && t.local === "spreadsheet") inSheet = depth;
			else if (inSheet && depth === inSheet + 1 && t.uri === NS.table && t.local === "table") count++;
		},
		close(t) {
			if (t.uri === NS.office && t.local === "spreadsheet") inSheet = 0;
		},
	});
	zip.streamText("content.xml", (c) => stream.write(c));
	stream.close();
	return count;
}

function tableMarkdown(rows: string[][]): string {
	let cols = 1;
	for (const r of rows) cols = Math.max(cols, r.length);
	const pad = (r: string[]) => `| ${Array.from({ length: cols }, (_, i) => (r[i] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
	return [pad(rows[0] as string[]), `|${" --- |".repeat(cols)}`, ...rows.slice(1).map(pad)].join("\n");
}

/**
 * An OpenDocument formula in the spreadsheet apps' usual form, for formulas with no saved result:
 * "of:=SUM([.B2:.B3])" becomes "=SUM(B2:B3)", "[$Sheet2.A1]" becomes "Sheet2!A1", and ";" between
 * arguments becomes ",". Text in quotes is left as it is. Linear; at most 8,192 characters come in.
 */
export function odfFormula(f: string): string {
	const src = f.replace(/^[a-z]+:(?==)/, "");
	let out = "";
	let inQuote = false;
	let inRef = false;
	// Inside [...]: each side of a ":" is [$][sheet].cell; "start" is before any of it.
	let seg: "start" | "sheet" | "cell" = "start";
	for (let i = 0; i < src.length; i++) {
		const ch = src[i] as string;
		if (inQuote) {
			out += ch;
			if (ch === '"') inQuote = false;
			continue;
		}
		if (inRef) {
			if (ch === "]") inRef = false;
			else if (ch === ":") {
				out += ":";
				seg = "start";
			} else if (ch === ".") {
				// ".B2" (this sheet) loses its dot; "Sheet2.B2" becomes "Sheet2!B2".
				if (seg === "sheet") out += "!";
				else if (seg === "cell") out += ".";
				seg = "cell";
			} else if (ch === "$" && seg === "start") {
				// "$Sheet2": an absolute sheet name; the marker has no A1 form.
				seg = "sheet";
			} else {
				if (seg === "start") seg = "sheet";
				out += ch;
			}
			continue;
		}
		if (ch === '"') inQuote = true;
		else if (ch === "[") {
			inRef = true;
			seg = "start";
			continue;
		}
		out += ch === ";" ? "," : ch;
	}
	return out;
}

interface ParaStyle {
	parent?: string;
	display?: string;
	outline?: number;
}

/** Paragraph and list styles, filled from styles.xml and the automatic styles in content.xml. */
class Styles {
	readonly para = new Map<string, ParaStyle>();
	/** list style name -> level (1-based) -> numbered? */
	readonly lists = new Map<string, Map<number, boolean>>();
	private listName: string | null = null;

	/** Feeds one open tag; returns true when it was a style element. */
	open(t: Tag): boolean {
		if (t.uri === NS.style && t.local === "style" && attr(t, NS.style, "family") === "paragraph") {
			const name = attr(t, NS.style, "name");
			if (name && this.para.size < DOC_LIMITS.tableEntries) {
				const outline = Number(attr(t, NS.style, "default-outline-level") ?? "");
				this.para.set(name, {
					parent: attr(t, NS.style, "parent-style-name"),
					display: attr(t, NS.style, "display-name"),
					...(Number.isInteger(outline) && outline > 0 ? { outline } : {}),
				});
			}
			return true;
		}
		if (t.uri === NS.text && t.local === "list-style") {
			this.listName = attr(t, NS.style, "name") ?? null;
			if (this.listName && this.lists.size < DOC_LIMITS.tableEntries) this.lists.set(this.listName, new Map());
			return true;
		}
		if (t.uri === NS.text && (t.local === "list-level-style-number" || t.local === "list-level-style-bullet") && this.listName) {
			const level = Math.min(10, Number(attr(t, NS.text, "level") ?? 1) || 1);
			const numbered = t.local === "list-level-style-number" && (attr(t, NS.style, "num-format") ?? "1") !== "";
			this.lists.get(this.listName)?.set(level, numbered);
			return true;
		}
		return false;
	}

	close(t: Tag): void {
		if (t.uri === NS.text && t.local === "list-style") this.listName = null;
	}

	/** The heading level of a paragraph style (through its parents), or 0. */
	headingLevel(name: string | undefined): number {
		let cur = name;
		for (let k = 0; cur && k < 8; k++) {
			const s = this.para.get(cur);
			const label = (s?.display ?? cur).toLowerCase().replace(/_20_/g, " ");
			const m = /^heading ?([1-9])$/.exec(label);
			if (s?.outline) return Math.min(6, s.outline);
			if (m) return Math.min(6, Number(m[1]));
			if (label === "title") return 1;
			cur = s?.parent;
		}
		return 0;
	}

	numbered(list: string | null, level: number): boolean {
		if (!list) return false;
		return this.lists.get(list)?.get(level) ?? false;
	}
}

function readStyles(zip: ZipReader, styles: Styles): void {
	if (!zip.has("styles.xml")) return;
	const s = new SaxStream({ open: (t) => void styles.open(t), close: (t) => styles.close(t) });
	zip.streamText("styles.xml", (c) => s.write(c));
	s.close();
}

interface Para {
	text: string;
	heading: number;
	style?: string;
	/** List depth (1-based) and list style when the paragraph is a list item. */
	list: number;
	listStyle: string | null;
}

export function odfText(zip: ZipReader, out: TextOut, mode: Mode, opts: { sheet?: string } = {}): { sheets?: string[]; slides?: number } {
	if (!zip.has("content.xml")) throw new ToolError("unsupported_type", "This OpenDocument file has no content part.");
	const styles = new Styles();
	if (mode === "odt") readStyles(zip, styles);
	const sheets: string[] = [];
	let slides = 0;

	// Paragraph collection shared by all three modes.
	const paras: Para[] = [];
	const lists: (string | null)[] = []; // the list style of each open text:list
	const counters = new Map<string, number[]>();
	let skip = 0; // annotations, notes inside text, change-tracking deletions
	const links: { start: number; href: string | null }[] = [];
	// Tables (text documents) and sheets (spreadsheets).
	let table: { name: string; rows: string[][] } | null = null;
	let row: string[] | null = null;
	let rowRepeat = 1;
	// Characters held in the open row, table and slide: bounded so a hostile file can't pile them up.
	let rowChars = 0;
	let tableChars = 0;
	let pageChars = 0;
	let sheetCount = 0;
	let cell: { parts: string[]; chars: number; value: string | null; formula: string | null; repeat: number } | null = null;
	let chosenSheet = true;
	let sheetRows = 0;
	let sheetMore = 0;
	// Presentations.
	let page: { title: string; lines: string[]; notes: string[] } | null = null;
	let frameClass: string | null = null;
	let inNotes = 0;

	const listMarker = (p: Para): string => {
		if (!styles.numbered(p.listStyle, p.list) || !p.listStyle) return "-";
		const c = counters.get(p.listStyle) ?? [];
		c[p.list] = (c[p.list] ?? 0) + 1;
		for (let k = p.list + 1; k < c.length; k++) c[k] = 0;
		counters.set(p.listStyle, c);
		return `${c[p.list]}.`;
	};

	const emitPara = (p: Para) => {
		const text = trimLineEnds(p.text);
		if (cell) {
			const t = text.trim();
			if (t && cell.chars + t.length <= DOC_LIMITS.blockChars) {
				cell.parts.push(t);
				cell.chars += t.length + 1;
			} else if (t) out.leftOut();
			return;
		}
		if (page) {
			if (!text.trim()) return;
			pageChars += text.length + 1;
			if (pageChars > out.room() + 1) pageOverflow();
			if (inNotes > 0) page.notes.push(text.trim());
			else if (frameClass === "title") page.title = page.title ? `${page.title} ${text.trim()}` : text.trim();
			else page.lines.push(`${"  ".repeat(Math.min(8, Math.max(0, p.list - 1)))}${text.trim()}`);
			return;
		}
		if (mode === "ods") return; // text outside cells (headers, footers) isn't part of a sheet
		const heading = p.heading || styles.headingLevel(p.style);
		if (heading > 0 && text.trim()) out.block(`${"#".repeat(Math.min(6, heading))} ${text.trim()}`);
		else if (p.list > 0 && text.trim()) out.block(`${"  ".repeat(Math.min(8, p.list - 1))}${listMarker(p)} ${text.trim()}`, true);
		else out.block(text);
	};

	/** A slide or table that would pass the text cap: write what there is and stop reading. */
	const writePage = (pg: { title: string; lines: string[]; notes: string[] }) => {
		out.block(`## Slide ${slides}${pg.title ? `: ${pg.title}` : ""}`);
		if (pg.lines.length) out.block(pg.lines.join("\n"));
		if (pg.notes.length) out.block(`Notes: ${pg.notes.join("\n")}`);
	};
	const pageOverflow = (): never => {
		const pg = page;
		page = null;
		if (pg) writePage(pg);
		return out.stop();
	};
	const tableOverflow = (rows: string[][]): never => {
		if (rows.length) out.block(tableMarkdown(rows));
		return out.stop();
	};

	const flushSheetRow = (cells: string[], repeat: number) => {
		let end = cells.length;
		while (end > 0 && (cells[end - 1] ?? "") === "") end--;
		if (end === 0) return;
		if (repeat > MAX_REPEAT) out.leftOut();
		for (let k = 0; k < Math.min(repeat, MAX_REPEAT); k++) {
			if (sheetRows >= MAX_SHEET_ROWS) {
				sheetMore++;
				out.leftOut();
				continue;
			}
			sheetRows++;
			out.line(csvLine(cells.slice(0, end)));
		}
	};

	const stream = new SaxStream({
		open(t) {
			if (skip > 0) {
				skip++;
				return;
			}
			if (styles.open(t)) return;
			if ((t.uri === NS.office && t.local === "annotation") || (t.uri === NS.text && (t.local === "note" || t.local === "tracked-changes"))) {
				skip = 1;
				return;
			}
			if (t.uri === NS.draw && t.local === "page") {
				slides++;
				page = { title: "", lines: [], notes: [] };
				return;
			}
			if (t.uri === NS.presentation && t.local === "notes") {
				inNotes++;
				return;
			}
			if (t.uri === NS.draw && t.local === "frame" && page) {
				frameClass = attr(t, NS.presentation, "class") ?? null;
				return;
			}
			if (t.uri === NS.table) {
				if (t.local === "table") {
					const name = (attr(t, NS.table, "name") ?? `Sheet${sheetCount + 1}`).slice(0, 255);
					table = { name, rows: [] };
					tableChars = 0;
					if (mode === "ods") {
						sheetCount++;
						if (sheets.length < 10_000) sheets.push(name);
						chosenSheet = opts.sheet === undefined || opts.sheet.trim().toLowerCase() === name.toLowerCase() || opts.sheet.trim() === String(sheetCount);
						sheetRows = 0;
						sheetMore = 0;
						if (chosenSheet) out.block(`## Sheet: ${name}`);
					}
				} else if (t.local === "table-row") {
					row = [];
					rowChars = 0;
					rowRepeat = Math.max(1, Number(attr(t, NS.table, "number-rows-repeated") ?? 1) || 1);
				} else if (t.local === "table-cell" || t.local === "covered-table-cell") {
					const type = attr(t, NS.office, "value-type");
					let value: string | null = null;
					if (type === "float" || type === "percentage" || type === "currency") {
						const n = Number(attr(t, NS.office, "value"));
						value = Number.isFinite(n) ? formatNumber(n) : null;
					} else if (type === "date") value = isoDateTime(attr(t, NS.office, "date-value") ?? "") || null;
					else if (type === "time") value = attr(t, NS.office, "time-value") ?? null;
					else if (type === "boolean") value = odfBoolean(attr(t, NS.office, "boolean-value"));
					// A formula with no saved result (never calculated): shown as the formula, without the "of:" prefix.
					const f = attr(t, NS.table, "formula");
					const formula = f ? odfFormula(f.slice(0, 8192)) : null;
					cell = { parts: [], chars: 0, value, formula, repeat: Math.max(1, Number(attr(t, NS.table, "number-columns-repeated") ?? 1) || 1) };
				}
				return;
			}
			if (t.uri === NS.text) {
				switch (t.local) {
					case "list":
						// A nested list without its own style keeps the outer list's style.
						lists.push(attr(t, NS.text, "style-name") ?? lists[lists.length - 1] ?? null);
						break;
					case "h":
						paras.push({ text: "", heading: Number(attr(t, NS.text, "outline-level") ?? 1) || 1, list: 0, listStyle: null });
						break;
					case "p": {
						const style = attr(t, NS.text, "style-name");
						paras.push({ text: "", heading: 0, list: lists.length, listStyle: lists[lists.length - 1] ?? null, ...(style ? { style } : {}) });
						break;
					}
					case "a": {
						const p = paras[paras.length - 1];
						const href = attr(t, "http://www.w3.org/1999/xlink", "href") ?? "";
						links.push({ start: p?.text.length ?? 0, href: /^(https?:|mailto:)/i.test(href) ? href : null });
						break;
					}
					case "s": {
						const p = paras[paras.length - 1];
						if (p) p.text = addCapped(p.text, " ".repeat(Math.min(100, Math.max(1, Number(attr(t, NS.text, "c") ?? 1) || 1))), DOC_LIMITS.blockChars, out);
						break;
					}
					case "tab": {
						const p = paras[paras.length - 1];
						if (p) p.text = addCapped(p.text, "\t", DOC_LIMITS.blockChars, out);
						break;
					}
					case "line-break": {
						const p = paras[paras.length - 1];
						if (p) p.text = addCapped(p.text, "\n", DOC_LIMITS.blockChars, out);
						break;
					}
				}
			}
		},
		close(t) {
			if (skip > 0) {
				skip--;
				return;
			}
			styles.close(t);
			if (t.uri === NS.draw && t.local === "page" && page) {
				const pg = page;
				page = null;
				pageChars = 0;
				writePage(pg);
				return;
			}
			if (t.uri === NS.presentation && t.local === "notes") {
				inNotes--;
				return;
			}
			if (t.uri === NS.draw && t.local === "frame") {
				frameClass = null;
				return;
			}
			if (t.uri === NS.text) {
				if (t.local === "a") {
					const l = links.pop();
					const p = paras[paras.length - 1];
					if (l?.href && p) {
						const label = p.text.slice(l.start);
						if (label.trim() && label.trim() !== l.href) p.text = `${p.text.slice(0, l.start)}[${label}](${l.href})`;
					}
				} else if (t.local === "list") lists.pop();
				else if (t.local === "p" || t.local === "h") {
					const p = paras.pop();
					if (p) {
						const parent = paras[paras.length - 1];
						// A paragraph inside a paragraph (a frame in text): its text joins the outer one.
						if (parent && !cell) parent.text = addCapped(parent.text, (parent.text ? " " : "") + p.text, DOC_LIMITS.blockChars, out);
						else emitPara(p);
					}
				}
				return;
			}
			if (t.uri !== NS.table) return;
			if ((t.local === "table-cell" || t.local === "covered-table-cell") && cell && row) {
				const text = cell.value ?? (cell.parts.join(" ") || cell.formula || "");
				const repeat = text ? Math.min(cell.repeat, MAX_REPEAT) : cell.repeat;
				if (text && (cell.repeat > MAX_REPEAT || row.length + repeat > MAX_SHEET_COLUMNS)) out.leftOut();
				for (let k = 0; k < repeat && row.length < MAX_SHEET_COLUMNS; k++) {
					// A row keeps at most DOC_LIMITS.blockChars characters; the rest of its cells stay empty.
					const keep = text && rowChars + text.length <= DOC_LIMITS.blockChars ? text : "";
					if (text && !keep) out.leftOut();
					rowChars += keep.length;
					row.push(keep);
				}
				cell = null;
			} else if (t.local === "table-row" && row && table) {
				if (mode === "ods") {
					if (chosenSheet) flushSheetRow(row, rowRepeat);
				} else if (row.some((c) => c)) {
					if (rowRepeat > MAX_REPEAT) out.leftOut();
					for (let k = 0; k < Math.min(rowRepeat, MAX_REPEAT); k++) {
						tableChars += rowChars + row.length * 3;
						if (tableChars > out.room() + 1) {
							if (page) pageOverflow();
							tableOverflow(table.rows);
						}
						table.rows.push(row);
					}
				}
				row = null;
			} else if (t.local === "table" && table) {
				const tb = table;
				table = null;
				if (mode === "ods") {
					if (chosenSheet) {
						if (sheetMore > 0) out.line(`[This sheet has ${sheetMore.toLocaleString("en-GB")} more rows; only the first ${MAX_SHEET_ROWS.toLocaleString("en-GB")} are shown.]`);
						else if (sheetRows === 0) out.line("(empty)");
					}
				} else if (tb.rows.length) {
					const md = tableMarkdown(tb.rows);
					if (page) {
						pageChars += md.length;
						(page as { lines: string[] }).lines.push(md);
					} else out.block(md);
				}
			}
		},
		text(x) {
			if (skip > 0) return;
			const p = paras[paras.length - 1];
			if (p) p.text = addCapped(p.text, x, DOC_LIMITS.blockChars, out);
		},
	});
	zip.streamText("content.xml", (c) => stream.write(c));
	stream.close();
	if (mode === "ods" && opts.sheet !== undefined) {
		const want = opts.sheet.trim().toLowerCase();
		if (!sheets.some((s, i) => s.toLowerCase() === want || String(i + 1) === want)) throw noSheet(opts.sheet, sheetCount);
	}
	return mode === "ods" ? { sheets } : mode === "odp" ? { slides } : {};
}
