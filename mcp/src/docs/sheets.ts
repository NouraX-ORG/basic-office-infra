/**
 * Spreadsheet input for docs_create_spreadsheet (DESIGN 11.4 and 12.1): typed columns or plain
 * rows, CSV parsing (RFC 4180, with the delimiter detected), sheet-name cleaning and the formula
 * guard. Only a column typed "formula" makes formulas, and formulas that reach outside the file
 * (web calls, other workbooks, DDE) are refused.
 */
import { ToolError } from "../core/errors";
import { LIMITS } from "../core/limits";
import { type NumStyle, parseIsoDate, type XCell, type XSheet } from "./ooxml/xlsx";

export type ColumnType = "text" | "number" | "date" | "currency" | "percent" | "formula";
export type CellValue = string | number | boolean | null;

export interface SheetInput {
	name?: string;
	columns?: { header: string; type?: ColumnType; width?: number }[];
	rows: CellValue[][];
}

const MAX_COLUMNS = 1_000;
const MAX_CELL_CHARS = 32_767;
const MAX_FORMULA_CHARS = 8_000;

/**
 * Functions that fetch from the web or online services, run programs, reach other files or turn
 * text into a reference (INDIRECT can build a link to another workbook out of CHAR(91) and the
 * like). They are matched as whole names whatever follows, so a function passed as a value
 * (=MAP(A2:A3,WEBSERVICE), Excel 365's eta lambdas) is caught too, with or without the file
 * format's prefixes: any chain of them (fix round 2), because the file format stacks them (Excel
 * stores FILTER as _xlfn._xlws.FILTER and PY as _xlfn._xlws.PY), and any "_xl" prefix at all
 * (_xlfn., _xll., _xlws., _xludf., _xlpm. and newer ones), so a new prefix can't open a gap. The
 * match starts at the first prefix, so the look-behind still sees what comes before the whole name.
 * A name next to "$" or a digit is a cell reference (RTD1, $DDE$2), and one next to ":" that isn't
 * called is a column (DDE:DDE, PY:PY); a call such as A1:WEBSERVICE(B1) is still refused, because
 * Excel runs it.
 */
const FORMULA_DENY =
	/(?<![A-Za-z0-9_.$!])(?:_xl[a-z]+\.)*(?:WEBSERVICE|FILTERXML|IMPORT[A-Z0-9_.]*|IMAGE|HYPERLINK|CALL|REGISTER\.ID|REGISTER|EXEC|RTD|DDE|INFO|CELL|INDIRECT|EVALUATE|TRANSLATE|DETECTLANGUAGE|STOCKHISTORY|STOCKSERIES|PY|COPILOT)(?![A-Za-z0-9_.$])/gi;

/** Whether the formula (text in quotes emptied) names a denied function. */
function deniedName(code: string): boolean {
	for (const m of code.matchAll(FORMULA_DENY)) {
		const at = m.index ?? 0;
		let k = at + m[0].length;
		const after = code[k];
		while (code[k] === " ") k++;
		const called = code[k] === "(";
		if (!called && (code[at - 1] === ":" || after === ":")) continue;
		return true;
	}
	return false;
}

/**
 * The formula with its "text in quotes" emptied (quotes kept), so words inside text don't count.
 * A single-quoted sheet reference ('Sheet name'!A1) is a different kind of token: it is copied
 * verbatim, so a "[" inside it (a link to another workbook) is still seen by the checks, and a '"'
 * inside it (Excel allows quotes in sheet names) can never open a fake text literal that would hide
 * WEBSERVICE/HYPERLINK/DDE placed after it (fix round 3). "" is an escaped quote inside a literal;
 * '' is an escaped apostrophe inside a sheet name.
 */
function withoutStrings(body: string): string {
	let out = "";
	let inQuote = false;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i] as string;
		if (inQuote) {
			if (ch === '"') {
				if (body[i + 1] === '"') i++;
				else {
					inQuote = false;
					out += ch;
				}
			}
			continue;
		}
		if (ch === "'") {
			out += ch; // opening quote of a sheet-name reference
			let j = i + 1;
			while (j < body.length) {
				const c = body[j] as string;
				if (c === "'") {
					if (body[j + 1] === "'") {
						out += "''";
						j += 2;
						continue;
					}
					out += "'";
					break;
				}
				out += c;
				j++;
			}
			i = j; // the for-loop's i++ then moves past the closing quote (or past the end)
			continue;
		}
		if (ch === '"') inQuote = true;
		out += ch;
	}
	// A double quote that never closes hides nothing: the whole formula is checked.
	return inQuote ? body : out;
}

export function checkFormula(f: string, where: string): string {
	const body = f.startsWith("=") ? f.slice(1) : f;
	if (!body.trim()) throw new ToolError("invalid_input", `${where}: the formula is empty.`, { field: "sheets" });
	if (body.length > MAX_FORMULA_CHARS) throw new ToolError("invalid_input", `${where}: the formula is too long (8,000 characters at most).`, { field: "sheets" });
	// Sheet names in single quotes stay in: '[Book.xlsx]Sheet1'!A1 links to another workbook.
	const code = withoutStrings(body);
	if (deniedName(code) || code.includes("|") || code.includes("[")) {
		throw new ToolError("invalid_input", `${where}: that formula reaches outside the spreadsheet (web, links, other files or programs), which isn't allowed here.`, { field: "sheets" });
	}
	return body;
}

const RESERVED = new Set(["history"]);

/**
 * Cleans sheet names of []:*?/\ and " (fix round 3: Excel allows a double quote in a sheet name,
 * and a formula that references such a sheet could smuggle a function reference past the formula
 * guard), cuts them to 31 characters and makes them unique.
 */
export function cleanSheetNames(raw: (string | undefined)[]): string[] {
	const used = new Set<string>();
	return raw.map((r, i) => {
		let base = (r ?? "")
			.replace(/[[\]:*?/\\"]/g, " ")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
			.replace(/[\u0000-\u001f\u007f]/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.replace(/^'+|'+$/g, "")
			.trim();
		if (!base) base = `Sheet${i + 1}`;
		base = base.slice(0, 31).trim();
		let name = base;
		for (let n = 2; used.has(name.toLowerCase()) || RESERVED.has(name.toLowerCase()); n++) {
			const suffix = ` (${n})`;
			name = `${base.slice(0, 31 - suffix.length).trim()}${suffix}`;
		}
		used.add(name.toLowerCase());
		return name;
	});
}

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d{1,3})?$/;

/** A plain number written as text, without a leading zero that would be lost ("007"). */
export function numberFromText(s: string): number | null {
	const t = s.trim();
	if (t.length === 0 || t.length > 40 || !NUMBER_RE.test(t)) return null;
	if (/^[+-]?0\d/.test(t)) return null;
	const n = Number(t);
	return Number.isFinite(n) ? n : null;
}

function textCell(v: string, where: () => string): XCell {
	if (v.length > MAX_CELL_CHARS) throw new ToolError("invalid_input", `${where()}: a cell can hold at most 32,767 characters.`, { field: "sheets" });
	return { k: "s", v };
}

function plainCell(v: CellValue, where: () => string): XCell {
	if (v === null) return null;
	if (typeof v === "number") return Number.isFinite(v) ? { k: "n", v } : null;
	if (typeof v === "boolean") return { k: "b", v };
	return textCell(v, where);
}

function typedCell(v: CellValue, type: ColumnType, where: () => string, warn: (type: ColumnType) => void): XCell {
	if (v === null || v === "") return null;
	if (typeof v === "boolean") return type === "text" ? { k: "s", v: v ? "TRUE" : "FALSE" } : { k: "b", v };
	switch (type) {
		case "text":
			return textCell(typeof v === "number" ? String(v) : v, where);
		case "number":
		case "currency": {
			const n = typeof v === "number" ? v : numberFromText(v);
			if (n === null) {
				warn(type);
				return textCell(String(v), where);
			}
			return type === "currency" ? { k: "n", v: n, style: "currency" } : { k: "n", v: n };
		}
		case "percent": {
			if (typeof v === "number") return { k: "n", v, style: "percent" };
			const t = v.trim();
			const n = t.endsWith("%") ? numberFromText(t.slice(0, -1)) : numberFromText(t);
			if (n === null) {
				warn(type);
				return textCell(v, where);
			}
			return { k: "n", v: t.endsWith("%") ? n / 100 : n, style: "percent" };
		}
		case "date": {
			if (typeof v === "number") {
				warn(type);
				return { k: "n", v };
			}
			const d = parseIsoDate(v);
			if (!d) {
				warn(type);
				return textCell(v, where);
			}
			return { k: "n", v: d.serial, style: (d.time ? "datetime" : "date") as NumStyle };
		}
		case "formula": {
			if (typeof v === "number") return { k: "n", v };
			if (!v.trim().startsWith("=")) return textCell(v, where);
			return { k: "f", v: checkFormula(v.trim(), where()) };
		}
	}
}

export interface BuiltSheets {
	sheets: XSheet[];
	summary: { name: string; rows: number; columns: number }[];
	warnings: string[];
}

export const TOO_MANY_CELLS = "A spreadsheet can have at most 50,000 cells here; given as sheets, each row and column setting counts too. Split it into several files, or give one sheet as csv.";

/**
 * How many input elements the MCP SDK counts in a tool's arguments: the same walk as
 * toolInputElementCount in @modelcontextprotocol/server 2.3.1, one per array item and one per object
 * key, at any depth. Core caps that at 50,000 (maxToolInputElements, src/mcp/factory.ts). The SDK
 * counts the arguments as they were sent, before the schema and before the tool runs, and refuses a
 * request past the cap in its own words (putting that in plain words is core's job).
 * docs_create_spreadsheet counts the arguments it got the same way (fix round 2: its old count of
 * cells, rows and column settings was a few elements under the SDK's, so the limit its description
 * states didn't quite hold). The schemas are strict, so nothing the SDK counted is dropped, and the
 * defaults they fill in (if_exists, a column's type) only add: this count is never below the SDK's,
 * and a request that the defaults take past 50,000 is refused here in plain words. Stops counting
 * once past `max`.
 */
export function inputElements(value: unknown, max: number): number {
	let count = 0;
	const stack: unknown[] = [value];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === null || typeof node !== "object") continue;
		if (Array.isArray(node)) {
			for (const child of node) {
				if (++count > max) return count;
				if (child !== null && typeof child === "object") stack.push(child);
			}
		} else {
			for (const key in node) {
				if (!Object.hasOwn(node, key)) continue;
				if (++count > max) return count;
				const child = (node as Record<string, unknown>)[key];
				if (child !== null && typeof child === "object") stack.push(child);
			}
		}
	}
	return count;
}

/** Refuses in plain words arguments that the MCP SDK would count past its 50,000-element cap. */
export function checkInputElements(args: unknown): void {
	if (inputElements(args, LIMITS.cells) > LIMITS.cells) throw new ToolError("invalid_input", TOO_MANY_CELLS, { field: "sheets" });
}

/**
 * Builds the sheets: at most 20, and at most 50,000 cells with the header rows. When the sheets
 * came as JSON, the tool has already counted the request's elements as the SDK does
 * (checkInputElements), which covers rows and column settings too.
 */
export function buildSheets(inputs: readonly SheetInput[]): BuiltSheets {
	if (inputs.length === 0) throw new ToolError("invalid_input", "Give at least one sheet.", { field: "sheets" });
	if (inputs.length > LIMITS.sheets) throw new ToolError("invalid_input", "A spreadsheet can have at most 20 sheets here.", { field: "sheets" });
	const names = cleanSheetNames(inputs.map((s) => s.name));
	let cells = 0;
	const warnings: string[] = [];
	const sheets: XSheet[] = [];
	const summary: BuiltSheets["summary"] = [];
	inputs.forEach((input, si) => {
		const name = names[si] as string;
		const types: ColumnType[] = input.columns?.map((c) => c.type ?? "text") ?? [];
		let header: string[] | null;
		let dataRows: CellValue[][];
		if (input.columns && input.columns.length > 0) {
			header = input.columns.map((c) => c.header);
			dataRows = input.rows;
		} else {
			const first = input.rows[0];
			header = first ? first.map((v) => (v === null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v))) : null;
			dataRows = input.rows.slice(1);
		}
		const warned = new Set<string>();
		const rows: XCell[][] = dataRows.map((r, ri) => {
			if (r.length > MAX_COLUMNS) throw new ToolError("invalid_input", `Sheet "${name}" row ${ri + 1} has more than 1,000 cells.`, { field: "sheets" });
			cells += r.length;
			if (cells > LIMITS.cells) throw new ToolError("invalid_input", TOO_MANY_CELLS, { field: "sheets" });
			return r.map((v, ci) => {
				const where = () => `Sheet "${name}" row ${ri + 2}, column ${ci + 1}`;
				const type = types[ci];
				if (!type) return plainCell(v, where);
				return typedCell(v, type, where, (t) => {
					const key = `${ci}`;
					if (warned.has(key)) return;
					warned.add(key);
					warnings.push(`Sheet "${name}", column "${header?.[ci] ?? ci + 1}": some values aren't valid for type ${t} and were kept as text.`);
				});
			});
		});
		cells += header?.length ?? 0;
		if (cells > LIMITS.cells) throw new ToolError("invalid_input", TOO_MANY_CELLS, { field: "sheets" });
		const widths = input.columns?.map((c) => c.width ?? null);
		let columns = header?.length ?? 0;
		for (const r of rows) columns = Math.max(columns, r.length);
		sheets.push({ name, header: header && header.length ? header : null, rows, ...(widths ? { widths } : {}) });
		summary.push({ name, rows: rows.length, columns });
	});
	return { sheets, summary, warnings };
}

/** Parses CSV text (RFC 4180). The delimiter is the most common of , ; and tab on the first line. */
export function parseCsv(text: string): string[][] {
	const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const firstLineEnd = src.search(/\r?\n/);
	const first = firstLineEnd < 0 ? src : src.slice(0, firstLineEnd);
	let delim = ",";
	let best = -1;
	for (const d of [",", ";", "\t"]) {
		let n = 0;
		let q = false;
		for (const ch of first) {
			if (ch === '"') q = !q;
			else if (!q && ch === d) n++;
		}
		if (n > best) {
			best = n;
			delim = d;
		}
	}
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	let cells = 0;
	const endField = () => {
		row.push(field);
		field = "";
		cells++;
		if (cells > LIMITS.cells) throw new ToolError("invalid_input", "The CSV has more than 50,000 cells. Split it into several files.", { field: "csv" });
		if (row.length > MAX_COLUMNS) throw new ToolError("invalid_input", "A CSV row has more than 1,000 columns.", { field: "csv" });
	};
	for (let i = 0; i < src.length; i++) {
		const ch = src[i] as string;
		if (quoted) {
			if (ch === '"') {
				if (src[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += ch;
			continue;
		}
		if (ch === '"' && field === "") quoted = true;
		else if (ch === delim) endField();
		else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && src[i + 1] === "\n") i++;
			endField();
			rows.push(row);
			row = [];
		} else field += ch;
	}
	if (quoted) throw new ToolError("invalid_input", "The CSV has a quote that is never closed.", { field: "csv" });
	if (field !== "" || row.length > 0) {
		endField();
		rows.push(row);
	}
	// Blank lines are dropped.
	return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/**
 * Turns parsed CSV rows into one sheet. The first line is the header. A column whose values are all
 * plain numbers becomes a number column, and one whose values are all ISO dates a date column;
 * everything else stays text (so "007" keeps its zeros and "=1+1" stays text).
 */
export function csvSheet(rows: string[][]): SheetInput {
	const [head, ...data] = rows;
	if (!head) throw new ToolError("invalid_input", "The CSV is empty.", { field: "csv" });
	let width = head.length;
	for (const r of data) width = Math.max(width, r.length);
	const columns = Array.from({ length: width }, (_, c) => {
		let kind: ColumnType | null = null;
		let seen = 0;
		for (const r of data) {
			const v = (r[c] ?? "").trim();
			if (!v) continue;
			seen++;
			const k: ColumnType = numberFromText(v) !== null ? "number" : parseIsoDate(v) ? "date" : "text";
			if (kind === null) kind = k;
			else if (kind !== k) {
				kind = "text";
				break;
			}
			if (kind === "text") break;
		}
		return { header: head[c] ?? "", type: seen > 0 && kind ? kind : ("text" as ColumnType) };
	});
	return { columns, rows: data };
}
