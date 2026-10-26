/**
 * The OOXML writers (DESIGN 12.1 and 17.4): every part is listed in [Content_Types].xml, every XML
 * part parses, internal relationships resolve, output is read back by our own extractor, the
 * formula guard holds and text is escaped.
 */
import { describe, expect, it } from "vitest";
import { ToolError } from "../../src/core/errors";
import { extractText } from "../../src/docs/extract/index";
import { parseMarkdown } from "../../src/docs/markdown";
import { buildDocx } from "../../src/docs/ooxml/docx";
import { buildPptx, type SlideSpec } from "../../src/docs/ooxml/pptx";
import { buildXlsx, columnName, excelSerial, parseIsoDate } from "../../src/docs/ooxml/xlsx";
import { buildSheets, checkFormula, cleanSheetNames, csvSheet, numberFromText, parseCsv } from "../../src/docs/sheets";
import { checkPackage } from "./helpers";

async function text(bytes: Uint8Array, name: string, extra: { sheet?: string } = {}): Promise<string> {
	const r = await extractText(bytes, { name, mime: null, offset: 0, maxChars: 50_000, ...extra });
	if (!("text" in r)) throw new Error(`no text: ${JSON.stringify(r)}`);
	return r.text;
}

const MD = `# Plan for Q4

Intro with **bold**, *italic*, ~~old~~, \`code\` and a [link](https://nourax.org/a?b=1&c=2).

## Steps

1. First
2. Second
   - detail
3. Third

- bullet <tag> & "quotes"

| Item | Cost |
|------|-----:|
| Tea | 2.50 |

> A quote

\`\`\`
line one
    indented
\`\`\`

---

<!-- pagebreak -->

Last \u0001 line with a control character.`;

describe("docx writer", () => {
	it("makes a sound package and reads back as the same content", async () => {
		const bytes = buildDocx(parseMarkdown(MD), { title: "Plan & <test>", creator: "QA" });
		const parts = checkPackage(bytes);
		const doc = parts.get("word/document.xml") as string;
		expect(doc).toContain('<w:pStyle w:val="Heading1"/>');
		expect(doc).toContain("<w:numPr>");
		expect(doc).toContain('<w:br w:type="page"/>');
		expect(doc).not.toContain("\u0001");
		expect(parts.get("word/_rels/document.xml.rels")).toContain('Target="https://nourax.org/a?b=1&amp;c=2" TargetMode="External"');
		expect(parts.get("docProps/core.xml")).toContain("<dc:title>Plan &amp; &lt;test&gt;</dc:title>");
		const t = await text(bytes, "x.docx");
		expect(t).toContain("# Plan for Q4");
		expect(t).toContain("## Steps");
		expect(t).toContain("1. First\n2. Second\n  - detail\n3. Third");
		expect(t).toContain("- bullet <tag> & \"quotes\"");
		expect(t).toContain("| Item | Cost |\n| --- | --- |\n| Tea | 2.50 |");
		expect(t).toContain("[link](https://nourax.org/a?b=1&c=2)");
		expect(t).toContain("line one\n\n    indented");
	});
	it("numbered lists restart after a break, and Letter paper is used when asked", () => {
		const bytes = buildDocx(parseMarkdown("1. a\n2. b\n\npara\n\n1. c\n"), { pageSize: "Letter" });
		const parts = checkPackage(bytes);
		expect(parts.get("word/document.xml")).toContain('<w:pgSz w:w="12240" w:h="15840"/>');
		const numbering = parts.get("word/numbering.xml") as string;
		expect(numbering.match(/<w:num w:numId=/g)).toHaveLength(3); // bullets + two ordered lists
	});
	it("an empty document is still valid", () => {
		const parts = checkPackage(buildDocx([]));
		expect(parts.get("word/document.xml")).toContain("<w:body><w:p/><w:sectPr>");
	});
});

describe("xlsx writer", () => {
	it("types columns, guards formulas and reads back", async () => {
		const built = buildSheets([
			{
				name: "Q4: plan/[draft]",
				columns: [
					{ header: "Name", type: "text" },
					{ header: "When", type: "date" },
					{ header: "Cost", type: "currency" },
					{ header: "Share", type: "percent" },
					{ header: "Total", type: "formula" },
				],
				rows: [
					["=HYPERLINK(\"x\")", "2026-10-25", 12.5, "25%", "=C2*2"],
					["+1-2", "2026-10-25T14:30", "1,000", 0.5, "plain"],
					[null, "not a date", 3, null, 4],
				],
			},
			{ name: "Q4: plan/[draft]", rows: [["A", "B"], [1, true], ["x", null]] },
		]);
		expect(built.summary.map((s) => s.name)).toEqual(["Q4  plan  draft", "Q4  plan  draft (2)"].map((s) => s.replace(/\s+/g, " ")));
		expect(built.warnings.join(" ")).toMatch(/column "Cost".*currency/);
		expect(built.warnings.join(" ")).toMatch(/column "When".*date/);
		const bytes = buildXlsx(built.sheets);
		const parts = checkPackage(bytes);
		const s1 = parts.get("xl/worksheets/sheet1.xml") as string;
		// Text that looks like a formula stays an inline string; only the formula column has <f>.
		expect(s1).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;x&quot;)</t></is></c>');
		expect(s1).toContain("<f>C2*2</f>");
		expect(s1.match(/<f>/g)).toHaveLength(1);
		expect(s1).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
		expect(s1).toContain('<autoFilter ref="A1:E4"/>');
		expect(s1).toContain(`<c r="B2" s="2"><v>${excelSerial(2026, 10, 25)}</v></c>`);
		expect(parts.get("xl/workbook.xml")).toContain("_xlnm._FilterDatabase");
		const t = await text(bytes, "x.xlsx");
		expect(t).toContain("## Sheet: Q4 plan draft");
		expect(t).toContain("Name,When,Cost,Share,Total");
		expect(t).toContain('"=HYPERLINK(""x"")",2026-10-25,12.5,0.25');
		expect(t).toContain("+1-2,2026-10-25 14:30,\"1,000\",0.5,plain");
		expect(t).toContain("## Sheet: Q4 plan draft (2)\nA,B\n1,TRUE\nx");
	});
	it("refuses formulas that reach outside the file", () => {
		for (const f of ["=WEBSERVICE(\"https://x\")", "=cmd|' /C calc'!A0", "=[book.xlsx]Sheet1!A1", "=hyperlink(\"https://x\",\"y\")", "=IMPORTXML(A1,B1)"]) {
			expect(() => checkFormula(f, "cell"), f).toThrow(ToolError);
		}
		expect(checkFormula("=SUM(A1:A3)*2", "cell")).toBe("SUM(A1:A3)*2");
	});
	it("enforces the cell and sheet caps", () => {
		expect(() => buildSheets([{ rows: Array.from({ length: 50_001 }, () => [1]) }])).toThrow(/50,000 cells/);
		expect(() => buildSheets(Array.from({ length: 21 }, () => ({ rows: [] })))).toThrow(/20 sheets/);
	});
	it("cleans and de-duplicates sheet names", () => {
		expect(cleanSheetNames(["a/b", "A B", "", "History", "'quoted'", "x".repeat(40), "x".repeat(40)])).toEqual([
			"a b",
			"A B (2)",
			"Sheet3",
			"History (2)",
			"quoted",
			"x".repeat(31),
			`${"x".repeat(27)} (2)`,
		]);
	});
	it("parses CSV with quotes, CRLF and a detected delimiter, and infers column types", () => {
		expect(parseCsv('a,"b ""q""",c\r\n1,"x,y",3\n\n')).toEqual([
			["a", 'b "q"', "c"],
			["1", "x,y", "3"],
		]);
		expect(parseCsv("a;b\n1;2")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
		const s = csvSheet(parseCsv("id,zip,when,mixed\n1,007,2026-01-02,1\n2,010,2026-01-03,x"));
		expect(s.columns?.map((c) => c.type)).toEqual(["number", "text", "date", "text"]);
		expect(() => parseCsv('a,"b')).toThrow(/never closed/);
		expect(numberFromText("007")).toBeNull();
		expect(numberFromText("-1.5e3")).toBe(-1500);
	});
	it("writes numbers exactly (as Excel does), so a date-time such as 09:30 is not a few microseconds early", () => {
		const built = buildSheets([{ columns: [{ header: "t", type: "date" }, { header: "n", type: "number" }], rows: [["2026-10-26T09:30", 0.1 + 0.2]] }]);
		const s1 = checkPackage(buildXlsx(built.sheets)).get("xl/worksheets/sheet1.xml") as string;
		const v = /<c r="A2" s="3"><v>([^<]+)<\/v>/.exec(s1)?.[1] as string;
		expect(Number(v)).toBe(excelSerial(2026, 10, 26, 9, 30));
		// A reader that truncates to whole seconds still lands on 09:30:00.
		expect(Math.floor(((Number(v) % 1) * 86400 + 1e-6) / 60)).toBe(9 * 60 + 30);
		expect(Math.floor((Number(v) % 1) * 86400) % 60).toBe(0);
		expect(s1).toContain(`<v>${String(0.1 + 0.2)}</v>`);
	});
	it("dates and columns", () => {
		expect(columnName(0)).toBe("A");
		expect(columnName(25)).toBe("Z");
		expect(columnName(26)).toBe("AA");
		expect(columnName(16383)).toBe("XFD");
		expect(parseIsoDate("2026-02-30")).toBeNull();
		expect(parseIsoDate("1900-01-15")).toBeNull();
		expect(parseIsoDate("2026-10-25T25:00")).toBeNull();
		expect(parseIsoDate("2026-10-25")).toEqual({ serial: 46320, time: false });
	});
	it("a 10,000-row sheet builds and reads back with the 5,000-row cap", async () => {
		const rows = Array.from({ length: 10_000 }, (_, i) => [`row ${i}`, i, i % 2 === 0]);
		const built = buildSheets([{ name: "Big", columns: [{ header: "Name" }, { header: "N", type: "number" }, { header: "Even" }], rows }]);
		const bytes = buildXlsx(built.sheets);
		const t = await text(bytes, "big.xlsx");
		expect(t).toContain("row 4998,4998,TRUE");
		expect(t).not.toContain("row 5000,");
		expect(t).toContain("[This sheet has 5,001 more rows; only the first 5,000 are shown.]");
	});
});

describe("pptx writer", () => {
	const slides: SlideSpec[] = [
		{ title: "Welcome & <hello>", layout: "title", bullets: [], body: "Prepared for QA", notes: "" },
		{ title: "Agenda", layout: "content", bullets: [{ text: "One", level: 0 }, { text: "Sub", level: 1 }], body: "", notes: "Speak slowly\nthen fast" },
		{ title: "Part two", layout: "section", bullets: [], body: "", notes: "" },
		{ title: "", layout: "content", bullets: [], body: "Just text", notes: "" },
	];
	it("makes a sound package with notes only where given, and reads back in order", async () => {
		const bytes = buildPptx(slides, { title: "Deck" });
		const parts = checkPackage(bytes);
		expect([...parts.keys()].filter((k) => k.startsWith("ppt/notesSlides/notesSlide"))).toEqual(["ppt/notesSlides/notesSlide2.xml"]);
		expect(parts.get("ppt/presentation.xml")).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
		expect(parts.get("ppt/theme/theme1.xml")).toContain('<a:accent1><a:srgbClr val="2563EB"/></a:accent1>');
		const t = await text(bytes, "deck.pptx");
		expect(t).toContain("## Slide 1: Welcome & <hello>\n\nPrepared for QA");
		expect(t).toContain("## Slide 2: Agenda\n\nOne\n  Sub\n\nNotes: Speak slowly\nthen fast");
		expect(t).toContain("## Slide 3: Part two");
		expect(t).toContain("## Slide 4\n\nJust text");
	});
});
