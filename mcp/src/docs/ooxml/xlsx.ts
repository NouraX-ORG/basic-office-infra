/**
 * The Excel (.xlsx) writer (DESIGN 12.1): inline strings (no shared-strings part), a styles part
 * with a bold header and the date, date-time, currency and percent formats, a frozen header row,
 * an autofilter and column widths estimated from the content (without them dates print as ####).
 *
 * The formula guard lives in the cell model: only a cell of kind "f" writes <f>. Every other value
 * is written as a number, a boolean or an inline string, so text that starts with "=", "+", "-"
 * or "@" can never become a formula.
 */
import { writeZip } from "../zip";
import { appPropsXml, contentTypesXml, corePropsXml, esc, REL, relsXml, rootRels, XML_HEAD } from "./common";

export type NumStyle = "date" | "datetime" | "currency" | "percent";

export type XCell =
	| null
	| { k: "s"; v: string }
	| { k: "n"; v: number; style?: NumStyle }
	| { k: "b"; v: boolean }
	| { k: "f"; v: string };

export interface XSheet {
	name: string;
	/** The header row (bold, frozen, with an autofilter), or null for none. */
	header: string[] | null;
	rows: XCell[][];
	/** Column widths in characters; null entries are estimated. */
	widths?: (number | null)[];
}

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** cellXfs indexes in STYLES. */
const XF = { normal: 0, header: 1, date: 2, datetime: 3, currency: 4, percent: 5 } as const;

const STYLES = `${XML_HEAD}<styleSheet xmlns="${MAIN}"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><color rgb="FF0F172A"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FF0F172A"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDBEAFE"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF2563EB"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;

export function columnName(index: number): string {
	let n = index + 1;
	let s = "";
	while (n > 0) {
		const r = (n - 1) % 26;
		s = String.fromCharCode(65 + r) + s;
		n = Math.floor((n - 1) / 26);
	}
	return s;
}

/**
 * The exact value, in the shortest form that reads back as the same number (as Excel stores them).
 * Cutting to 15 digits would move a date-time serial such as 09:30 a few microseconds early.
 * (ONLYOFFICE's CSV export still shows 09:30 as 09:29 because it truncates; its PDF export and our
 * own reader show 09:30. Seen in the live run, 2026-10-25.)
 */
function numText(v: number): string {
	return String(v).replace("e+", "E+").replace("e-", "E-");
}

/** The width a number needs on screen (15 significant digits, as spreadsheet apps show them). */
function numWidth(v: number): number {
	return String(Number(v.toPrecision(15))).length;
}

function cellXml(c: XCell, ref: string): string {
	if (c === null) return "";
	switch (c.k) {
		case "s":
			return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`;
		case "n":
			return `<c r="${ref}"${c.style ? ` s="${XF[c.style]}"` : ""}><v>${numText(c.v)}</v></c>`;
		case "b":
			return `<c r="${ref}" t="b"><v>${c.v ? 1 : 0}</v></c>`;
		case "f":
			return `<c r="${ref}"><f>${esc(c.v)}</f></c>`;
	}
}

function displayLength(c: XCell): number {
	if (c === null) return 0;
	switch (c.k) {
		case "s": {
			// The longest line, for wrapped text.
			let max = 0;
			for (const line of c.v.split("\n", 50)) max = Math.max(max, line.length);
			return max;
		}
		case "n":
			if (c.style === "date") return 10;
			if (c.style === "datetime") return 16;
			if (c.style === "currency") return numWidth(c.v) + 4;
			if (c.style === "percent") return numWidth(c.v * 100) + 1;
			return numWidth(c.v);
		case "b":
			return 5;
		case "f":
			return 10;
	}
}

function estimateWidths(sheet: XSheet, cols: number): number[] {
	const out: number[] = [];
	const sample = sheet.rows.slice(0, 500);
	for (let c = 0; c < cols; c++) {
		const given = sheet.widths?.[c];
		if (given) {
			out.push(Math.min(255, Math.max(1, given)));
			continue;
		}
		let max = sheet.header?.[c]?.length ?? 0;
		if (sheet.header) max += 2; // room for the filter button
		for (const r of sample) max = Math.max(max, displayLength(r[c] ?? null));
		out.push(Math.min(60, Math.max(8, max + 2)));
	}
	return out;
}

function widestRow(rows: readonly (readonly unknown[])[]): number {
	let n = 1;
	for (const r of rows) if (r.length > n) n = r.length;
	return n;
}

/** 'Sheet name' quoted for a reference, with apostrophes doubled. */
function quotedSheet(name: string): string {
	return `'${name.replace(/'/g, "''")}'`;
}

function sheetXml(sheet: XSheet, first: boolean): string {
	const rows: XCell[][] = sheet.header ? [sheet.header.map((h) => ({ k: "s", v: h }) as XCell), ...sheet.rows] : sheet.rows;
	const cols = widestRow(rows);
	const lastRef = `${columnName(cols - 1)}${Math.max(1, rows.length)}`;
	const widths = estimateWidths(sheet, cols);
	const colsXml = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w.toFixed(2)}" customWidth="1"/>`).join("")}</cols>`;
	const pane = sheet.header
		? `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>`
		: "";
	const views = `<sheetViews><sheetView workbookViewId="0"${first ? ' tabSelected="1"' : ""}>${pane}</sheetView></sheetViews>`;
	const data: string[] = [];
	rows.forEach((r, ri) => {
		const n = ri + 1;
		let cells = "";
		r.forEach((c, ci) => {
			if (sheet.header && ri === 0) {
				cells += `<c r="${columnName(ci)}1" t="inlineStr" s="${XF.header}"><is><t xml:space="preserve">${esc((c as { v: string }).v)}</t></is></c>`;
			} else cells += cellXml(c, `${columnName(ci)}${n}`);
		});
		data.push(`<row r="${n}">${cells}</row>`);
	});
	const filter = sheet.header && rows.length > 1 ? `<autoFilter ref="A1:${lastRef}"/>` : "";
	return `${XML_HEAD}<worksheet xmlns="${MAIN}" xmlns:r="${R_NS}"><dimension ref="A1:${lastRef}"/>${views}<sheetFormatPr defaultRowHeight="15"/>${colsXml}<sheetData>${data.join("")}</sheetData>${filter}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
}

export function buildXlsx(sheets: readonly XSheet[], opts: { title?: string | null; creator?: string | null } = {}): Uint8Array {
	const names = sheets.map((s) => s.name);
	const sheetEls = names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
	const defined = sheets
		.map((s, i) => {
			if (!s.header || s.rows.length === 0) return "";
			const cols = Math.max(s.header.length, widestRow(s.rows));
			return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(`${quotedSheet(s.name)}!$A$1:$${columnName(cols - 1)}$${s.rows.length + 1}`)}</definedName>`;
		})
		.join("");
	const workbook = `${XML_HEAD}<workbook xmlns="${MAIN}" xmlns:r="${R_NS}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheetEls}</sheets>${defined ? `<definedNames>${defined}</definedNames>` : ""}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
	const wbRels = relsXml([
		...sheets.map((_, i) => ({ id: `rId${i + 1}`, type: REL.worksheet, target: `worksheets/sheet${i + 1}.xml` })),
		{ id: `rId${sheets.length + 1}`, type: REL.styles, target: "styles.xml" },
	]);
	const S = "application/vnd.openxmlformats-officedocument.spreadsheetml";
	const parts: [string, string][] = [
		[
			"[Content_Types].xml",
			contentTypesXml([
				["/xl/workbook.xml", `${S}.sheet.main+xml`],
				["/xl/styles.xml", `${S}.styles+xml`],
				...sheets.map((_, i) => [`/xl/worksheets/sheet${i + 1}.xml`, `${S}.worksheet+xml`] as [string, string]),
				["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"],
				["/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"],
			]),
		],
		["_rels/.rels", rootRels("xl/workbook.xml")],
		["docProps/core.xml", corePropsXml({ title: opts.title, creator: opts.creator })],
		["docProps/app.xml", appPropsXml()],
		["xl/workbook.xml", workbook],
		["xl/_rels/workbook.xml.rels", wbRels],
		["xl/styles.xml", STYLES],
		...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s, i === 0)] as [string, string]),
	];
	return writeZip(parts);
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Excel's serial day number for a wall-clock date and time (1900 date system). */
export function excelSerial(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
	const ms = Date.UTC(y, mo - 1, d, h, mi, s) - Date.UTC(1899, 11, 30);
	return ms / 86_400_000;
}

/**
 * Parses an ISO date ("2026-10-25") or date-time ("2026-10-25T14:30", seconds and an offset are
 * allowed; the wall-clock time is kept, since spreadsheets have no time zones).
 */
export function parseIsoDate(s: string): { serial: number; time: boolean } | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s.trim());
	if (!m) return null;
	const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((x) => (x === undefined ? undefined : Number(x)));
	if (y === undefined || mo === undefined || d === undefined) return null;
	if (y < 1900 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
	const check = new Date(Date.UTC(y, mo - 1, d));
	if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
	if (h !== undefined && (h > 23 || (mi ?? 0) > 59 || (sec ?? 0) > 59)) return null;
	const serial = excelSerial(y, mo, d, h ?? 0, mi ?? 0, sec ?? 0);
	// Excel's serials skip the made-up 1900-02-29, so dates before March 1900 would be off by one.
	if (serial < 61) return null;
	return { serial, time: h !== undefined };
}
