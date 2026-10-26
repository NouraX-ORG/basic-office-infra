/**
 * Text extraction (DESIGN 12.4 and 17.4): files made by real producers (python-docx, openpyxl,
 * xlsxwriter, python-pptx), hand-built OpenDocument files and PDFs, text decoding, paging and the
 * zip guards (bombs, entry counts, passwords, damage).
 */
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ToolError } from "../../src/core/errors";
import { classify, decodeText, looksLikeText } from "../../src/docs/extract/classify";
import { type ExtractResult, extractText, pageOf } from "../../src/docs/extract/index";
import { isDateFormat, serialToIso } from "../../src/docs/extract/cells";
import { parseMarkdown } from "../../src/docs/markdown";
import { buildDocx } from "../../src/docs/ooxml/docx";
import { ZipReader } from "../../src/docs/zip";
import { fixture, textPdf, zipOf } from "./helpers";

async function run(bytes: Uint8Array, name: string, extra: { sheet?: string; pages?: string } = {}): Promise<ExtractResult> {
	return extractText(bytes, { name, mime: null, offset: 0, maxChars: 50_000, ...extra });
}

async function textOf(bytes: Uint8Array, name: string, extra: { sheet?: string; pages?: string } = {}): Promise<string> {
	const r = await run(bytes, name, extra);
	if (!("text" in r)) throw new Error(`no text: ${JSON.stringify(r)}`);
	return r.text;
}

describe("Word", () => {
	it("python-docx: headings, split runs, lists with numbers, tables, escaped text", async () => {
		const t = await textOf(fixture("word-python-docx.docx"), "a.docx");
		expect(t).toContain("# Quarterly report");
		expect(t).toContain("Dear {{client}}, thank you & welcome <back>.");
		expect(t).toContain("## Highlights");
		expect(t).toContain("- First point\n- Second point");
		expect(t).toContain("1. Step one\n2. Step two");
		expect(t).toContain("| Name | Amount |\n| --- | --- |\n| Apples \\| pears | 12 |\n| {{item}} | {{ amount }} |");
	});
	it("keeps tracked insertions, drops deletions, reads a text box once and ignores tab stops", async () => {
		const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
		const doc = `<?xml version="1.0"?><w:document ${W}><w:body>
<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Kept</w:t></w:r><w:ins><w:r><w:t xml:space="preserve"> added</w:t></w:r></w:ins><w:del><w:r><w:delText> removed</w:delText></w:r></w:del><w:r><w:tab/><w:t>after tab</w:t></w:r></w:p>
<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent><w:p><w:r><w:t>Box text</w:t></w:r></w:p></w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>Box text</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r><w:r><w:t>Outer</w:t></w:r></w:p>
</w:body></w:document>`;
		const t = await textOf(zipOf({ "[Content_Types].xml": "<Types/>", "word/document.xml": doc }), "b.docx");
		expect(t).toBe("Kept added\tafter tab\n\nOuter\n\nBox text");
	});
	it("refuses a DOCTYPE (no entity tricks)", async () => {
		const doc = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&a;</w:t></w:r></w:p></w:body></w:document>';
		await expect(run(zipOf({ "word/document.xml": doc }), "c.docx")).rejects.toMatchObject({ code: "unsupported_type" });
	});
	it("a .docx that isn't a zip: an old binary file goes to the server route, text is read as text, the rest is refused", async () => {
		const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
		expect(await run(ole, "d.docx")).toEqual({ needsServer: true, target: "txt" });
		expect(await run(ole, "d.xlsx")).toEqual({ needsServer: true, target: "csv" });
		expect(await run(new TextEncoder().encode("{\\rtf1 old}"), "d.docx")).toEqual({
			text: "{\\rtf1 old}",
			format: "text",
			totalChars: 11,
			note: "This file is named .docx but holds plain text, so it was read as text.",
			cut: false,
		});
		expect(await run(new Uint8Array([0x50, 0x4b, 0x01, 0, 0, 7, 0, 9]), "d.pptx")).toEqual({ unsupported: true, reason: "This file's contents couldn't be read; it may be damaged or not really an Office file." });
	});
});

describe("Excel", () => {
	it("openpyxl: shared strings, dates, percent, booleans, cached formulas, hidden and empty sheets", async () => {
		const r = await run(fixture("excel-openpyxl.xlsx"), "a.xlsx");
		if (!("text" in r)) throw new Error("no text");
		expect(r.sheets).toEqual(["Sales", "Hidden notes", "Empty"]);
		expect(r.text).toContain("## Sheet: Sales\nRegion,Date,Amount,Ratio,Done,Note\nNorth,2026-10-25,1234.5,0.25,TRUE,=not a formula\nSouth,2026-01-02 14:30,0.3,0.5,FALSE,{{name}} owes");
		expect(r.text).toContain("## Sheet: Hidden notes (hidden)\nsecret-ish");
		expect(r.text).toContain("## Sheet: Empty\n(empty)");
	});
	it("picks one sheet by name or number; a missing one gets a count, never the file's own names", async () => {
		const b = fixture("excel-openpyxl.xlsx");
		expect(await textOf(b, "a.xlsx", { sheet: "empty" })).toBe("## Sheet: Empty\n(empty)");
		expect(await textOf(b, "a.xlsx", { sheet: "2" })).toContain("secret-ish");
		const err = await run(b, "a.xlsx", { sheet: "Nope" }).catch((e: Error) => e);
		expect((err as Error).message).toBe('There\'s no sheet called "Nope". This file has 3 sheets; read it without sheet to see their names, or give a number from 1 to 3.');
		expect((err as Error).message).not.toContain("Sales");
	});
	it("xlsxwriter: rich strings and dd/mm/yyyy dates", async () => {
		const t = await textOf(fixture("excel-xlsxwriter.xlsx"), "b.xlsx");
		expect(t).toContain("Item,When,Qty\nHello {{first}} and {{second}},2025-12-31,7\nplain {{first}}");
	});
	it("number formats and serials", () => {
		expect(isDateFormat("yyyy-mm-dd")).toBe("date");
		expect(isDateFormat('0.00 "days"')).toBeNull();
		expect(isDateFormat("[Red]0.00")).toBeNull();
		expect(isDateFormat("h:mm AM/PM")).toBe("time");
		expect(isDateFormat("dd/mm/yyyy hh:mm")).toBe("datetime");
		expect(isDateFormat("[$-409]mmmm d, yyyy")).toBe("date");
		expect(isDateFormat("#,##0.00")).toBeNull();
		expect(serialToIso(46320, "date")).toBe("2026-10-25");
		expect(serialToIso(46320.75, "datetime")).toBe("2026-10-25 18:00");
		expect(serialToIso(0.5, "time")).toBe("12:00");
		expect(serialToIso(44858, "date", true)).toBe("2026-10-25");
	});
});

describe("PowerPoint", () => {
	it("python-pptx: slides in sldIdLst order (not file order), titles, levels and notes", async () => {
		const r = await run(fixture("pptx-python-pptx.pptx"), "a.pptx");
		if (!("text" in r)) throw new Error("no text");
		expect(r.slides).toBe(3);
		expect(r.text).toBe("## Slide 1: Moved to the front\n\n## Slide 2: {{title}}\n\nPrepared for {{client}}\n\n## Slide 3: Agenda\n\nWelcome\n  Details\n\nNotes: Say hello {{client}}");
	});
});

describe("OpenDocument", () => {
	const O = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"';
	it("odt: headings, lists, spaces, tables; notes and annotations skipped", async () => {
		const content = `<?xml version="1.0"?><office:document-content ${O}><office:body><office:text>
<text:h text:outline-level="2">Title<text:note><text:note-body><text:p>footnote</text:p></text:note-body></text:note></text:h>
<text:p>A<text:s text:c="3"/>B<text:tab/>C<office:annotation><text:p>comment</text:p></office:annotation></text:p>
<text:list><text:list-item><text:p>one</text:p><text:list><text:list-item><text:p>two</text:p></text:list-item></text:list></text:list-item></text:list>
<table:table table:name="T"><table:table-row><table:table-cell><text:p>h1</text:p></table:table-cell><table:table-cell><text:p>h2</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>x|y</text:p></table:table-cell><table:table-cell/></table:table-row></table:table>
</office:text></office:body></office:document-content>`;
		const t = await textOf(zipOf({ mimetype: "application/vnd.oasis.opendocument.text", "content.xml": content }), "a.odt");
		expect(t).toBe("## Title\n\nA   B\tC\n\n- one\n  - two\n\n| h1 | h2 |\n| --- | --- |\n| x\\|y |  |");
	});
	it("ods: typed values, repeated cells and rows, huge empty repeats ignored", async () => {
		const content = `<?xml version="1.0"?><office:document-content ${O}><office:body><office:spreadsheet>
<table:table table:name="S1">
<table:table-row><table:table-cell office:value-type="string"><text:p>name</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="0.1"><text:p>0.1</text:p></table:table-cell><table:table-cell office:value-type="date" office:date-value="2026-10-25"><text:p>25/10</text:p></table:table-cell><table:table-cell office:value-type="boolean" office:boolean-value="true"/></table:table-row>
<table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2" office:value-type="float" office:value="7"/></table:table-row>
<table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>
</table:table>
<table:table table:name="S2"><table:table-row><table:table-cell><text:p>other</text:p></table:table-cell></table:table-row></table:table>
</office:spreadsheet></office:body></office:document-content>`;
		const b = zipOf({ mimetype: "application/vnd.oasis.opendocument.spreadsheet", "content.xml": content });
		const r = await run(b, "a.ods");
		if (!("text" in r)) throw new Error("no text");
		expect(r.sheets).toEqual(["S1", "S2"]);
		expect(r.text).toBe("## Sheet: S1\nname,0.1,2026-10-25,TRUE\n7,7\n7,7\n\n## Sheet: S2\nother");
		expect(await textOf(b, "a.ods", { sheet: "S2" })).toBe("## Sheet: S2\nother");
	});
	it("odp: pages with titles, text and notes", async () => {
		const content = `<?xml version="1.0"?><office:document-content ${O}><office:body><office:presentation>
<draw:page draw:name="p1"><draw:frame presentation:class="title"><draw:text-box><text:p>Hello</text:p></draw:text-box></draw:frame><draw:frame presentation:class="outline"><draw:text-box><text:list><text:list-item><text:p>point</text:p></text:list-item></text:list></draw:text-box></draw:frame><presentation:notes><draw:frame><draw:text-box><text:p>a note</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>
<draw:page draw:name="p2"><draw:frame><draw:text-box><text:p>no title</text:p></draw:text-box></draw:frame></draw:page>
</office:presentation></office:body></office:document-content>`;
		const t = await textOf(zipOf({ mimetype: "application/vnd.oasis.opendocument.presentation", "content.xml": content }), "a.odp");
		expect(t).toBe("## Slide 1: Hello\n\npoint\n\nNotes: a note\n\n## Slide 2\n\nno title");
	});
});

describe("PDF", () => {
	it("reads pages, picks a range, and says when the start is past the end", async () => {
		const pdf = textPdf(["Hello page one (a)", "Second page here", "Third"]);
		const r = await run(pdf, "a.pdf");
		if (!("text" in r)) throw new Error(`no text ${JSON.stringify(r)}`);
		expect(r.pages).toEqual({ from: 1, to: 3, total: 3 });
		expect(r.text).toBe("## Page 1\n\nHello page one (a)\n\n## Page 2\n\nSecond page here\n\n## Page 3\n\nThird");
		const two = await run(pdf, "a.pdf", { pages: "2-9" });
		expect("text" in two && two.text).toBe("## Page 2\n\nSecond page here\n\n## Page 3\n\nThird");
		await expect(run(pdf, "a.pdf", { pages: "4" })).rejects.toMatchObject({ code: "invalid_input" });
		await expect(run(pdf, "a.pdf", { pages: "x-y" })).rejects.toMatchObject({ code: "invalid_input" });
	});
	it("sends encrypted PDFs to the server route (their streams can't be counted), reports scanned ones and non-PDFs", async () => {
		expect(await run(textPdf(["secret"], { encrypted: true }), "e.pdf")).toEqual({ needsServer: true, target: "txt" });
		await expect(run(textPdf(["", ""]), "s.pdf")).rejects.toThrow(/seems to be scanned/);
		expect(await run(new TextEncoder().encode("not a pdf at all"), "n.pdf")).toEqual({ unsupported: true, reason: "This file isn't a readable PDF." });
	});
});

describe("fix round 2: cut says when content was left out (files_read_text sets truncated from it)", () => {
	const X = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
	const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
	const xlsx = (rows: number) =>
		zipOf({
			"xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="${X}" xmlns:r="${R}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
			"xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
			"xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="${X}"><sheetData>${Array.from({ length: rows }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join("")}</sheetData></worksheet>`,
		});
	it("a PDF of more than 300 pages read without pages: the page cap sets cut, with a note that says how to go on", async () => {
		const pdf = textPdf(Array.from({ length: 302 }, (_, i) => `p${i + 1}`));
		const r = await run(pdf, "long.pdf");
		if (!("text" in r)) throw new Error(JSON.stringify(r));
		expect(r.pages).toEqual({ from: 1, to: 300, total: 302 });
		expect(r.cut).toBe(true);
		expect(r.note).toBe('Only pages 1 to 300 were read (300 at most per call); pages "301-302" continues.');
		expect(r.text.endsWith("## Page 300\n\np300")).toBe(true);
		// The rest is reached with pages; that read is whole.
		const rest = await run(pdf, "long.pdf", { pages: "301-302" });
		expect(rest).toMatchObject({ cut: false, pages: { from: 301, to: 302, total: 302 } });
		// 300 pages exactly is whole too.
		expect(await run(pdf, "long.pdf", { pages: "1-300" })).toMatchObject({ cut: false });
	}, 60_000);
	it("a sheet of more than 5,000 rows sets cut; 5,000 rows don't", async () => {
		const over = await run(xlsx(5_001), "big.xlsx");
		if (!("text" in over)) throw new Error(JSON.stringify(over));
		expect(over.cut).toBe(true);
		expect(over.text.endsWith("4999\n[This sheet has 1 more rows; only the first 5,000 are shown.]")).toBe(true);
		expect(over.note).toContain("rows past 5,000");
		const exact = await run(xlsx(5_000), "ok.xlsx");
		expect(exact).toMatchObject({ cut: false });
		expect("note" in exact).toBe(false);
	});
	it("whole files read whole: cut is false", async () => {
		for (const [name, bytes] of [
			["a.docx", fixture("word-python-docx.docx")],
			["a.xlsx", fixture("excel-openpyxl.xlsx")],
			["a.pdf", textPdf(["one", "two"])],
			["a.txt", new TextEncoder().encode("plain")],
		] as const) {
			expect(await run(bytes, name), name).toMatchObject({ cut: false });
		}
	});
	it("ods: booleans written as 1 and 0 (as ONLYOFFICE saves them) read as TRUE and FALSE", async () => {
		const O = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"';
		const cell = (v: string) => `<table:table-cell office:value-type="boolean" office:boolean-value="${v}"><text:p>shown</text:p></table:table-cell>`;
		const content = `<?xml version="1.0"?><office:document-content ${O}><office:body><office:spreadsheet><table:table table:name="B"><table:table-row>${["1", "0", "true", "false", "TRUE", "yes"].map(cell).join("")}</table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`;
		expect(await textOf(zipOf({ mimetype: "application/vnd.oasis.opendocument.spreadsheet", "content.xml": content }), "b.ods")).toBe("## Sheet: B\nTRUE,FALSE,TRUE,FALSE,TRUE,shown");
	});
});

describe("text and classification", () => {
	it("decodes UTF-8 with or without a BOM, UTF-16, and bad bytes", () => {
		expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0d, 0x0a]))).toBe("hi\n");
		expect(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBe("hi");
		expect(decodeText(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]))).toBe("hi");
		expect(decodeText(new Uint8Array([0x61, 0xff, 0x62]))).toBe("a�b");
		expect(looksLikeText(new Uint8Array([0x61, 0x00, 0x62]))).toBe(false);
		expect(looksLikeText(new TextEncoder().encode("plain é text"))).toBe(true);
	});
	it("classifies by extension first, then mime", () => {
		expect(classify("a.DOCX", null)).toMatchObject({ kind: "docx", heavy: true });
		expect(classify("a.doc", null)).toMatchObject({ kind: "server", serverTarget: "txt" });
		expect(classify("a.xls", null)).toMatchObject({ kind: "server", serverTarget: "csv" });
		expect(classify("a.md", null)).toMatchObject({ kind: "text", format: "markdown", heavy: false });
		expect(classify("photo.jpg", null).kind).toBe("image");
		expect(classify("x.svg", "image/svg+xml").kind).toBe("text");
		expect(classify("noext", "text/plain").kind).toBe("text");
		expect(classify("noext", "application/pdf").kind).toBe("pdf");
		expect(classify("a.zip", null).kind).toBe("binary");
		expect(classify(".env", null).kind).toBe("text");
		expect(classify("a.rtf", null)).toMatchObject({ kind: "server", serverTarget: "txt" });
		expect(classify("a.xlsb", null)).toMatchObject({ kind: "server", serverTarget: "csv" });
		expect(classify("a.ppt", null)).toMatchObject({ kind: "server", serverTarget: "txt" });
	});
	it("never offers the server route for pairs outside what our tools send to the connector", () => {
		// The connector knows these, but formats.ts has no txt/csv pair for them (or keeps them out of TOOL_SOURCES).
		for (const ext of ["djvu", "oform", "dps", "dpt", "fodp", "gdoc", "gsheet", "gslides", "epub", "fb2", "mht", "pages", "hwp", "vsdx", "xps", "numbers", "key", "odg"]) {
			const c = classify(`x.${ext}`, null);
			expect(c.kind, ext).toBe("noconvert");
			expect(c.serverTarget, ext).toBeUndefined();
			expect(c.heavy, ext).toBe(false);
		}
		// A PDF known only by its mime type has no extension for the connector to convert by.
		expect(classify("noext", "application/pdf").serverTarget).toBeUndefined();
		expect(classify("a.pdf", null).serverTarget).toBe("txt");
	});
	it("noconvert files answer plainly", async () => {
		expect(await run(new Uint8Array([1, 2, 3]), "x.djvu")).toEqual({ unsupported: true, reason: "This kind of file can't be turned into text here." });
	});
	it("pages text without splitting a surrogate pair", () => {
		const s = `ab${"😀".repeat(3)}cd`;
		expect(pageOf(s, 0, 3)).toEqual({ text: "ab", next: 2 });
		expect(pageOf(s, 2, 2)).toEqual({ text: "😀", next: 4 });
		expect(pageOf(s, 3, 2)).toEqual({ text: "😀", next: 4 });
		expect(pageOf(s, s.length, 5)).toEqual({ text: "", next: null });
		expect(() => pageOf(s, s.length + 1, 5)).toThrow(ToolError);
	});
	it("images, archives and binary noise say plainly that they have no text", async () => {
		expect(await run(new Uint8Array([1, 2, 3]), "a.png")).toMatchObject({ unsupported: true, reason: "Images have no text to read." });
		expect(await run(new Uint8Array([1, 2, 3]), "a.zip")).toMatchObject({ unsupported: true });
		expect(await run(new Uint8Array([0, 1, 2, 0]), "blob.bin2")).toMatchObject({ unsupported: true });
		expect(await run(new TextEncoder().encode("key = value"), "x.weird")).toMatchObject({ text: "key = value", format: "text" });
	});
});

describe("zip guards", () => {
	it("refuses a zip bomb by counting output, whatever the zip claims", () => {
		// 31 MB of zeros packs to a few kilobytes.
		const bomb = zipSync({ "word/document.xml": new Uint8Array(31 * 1024 * 1024) }, { level: 9 });
		expect(bomb.length).toBeLessThan(100_000);
		const z = ZipReader.open(bomb);
		expect(() => z.read("word/document.xml")).toThrow(/unpacks to far more than its size/);
	});
	it("fix round 3: reads a highly compressible part under the 16 MB floor, refuses a bomb past it", () => {
		// The floor was 1 MB, which refused our own highly repetitive writer output (a table of
		// identical rows packs 100x+ but is tiny unpacked). It is now 16 MB: a part under it is read
		// whatever its ratio, and the 30 MB per-part / 60 MB total caps bound memory.
		const small = ZipReader.open(zipSync({ "a.xml": new Uint8Array(2 * 1024 * 1024) }, { level: 9 }));
		expect(small.read("a.xml")?.length).toBe(2 * 1024 * 1024);
		const tiny = ZipReader.open(zipSync({ "a.xml": new Uint8Array(200_000) }, { level: 9 }));
		expect(tiny.read("a.xml")?.length).toBe(200_000);
		// A part that is both large (past 16 MB) and wildly disproportionate is still a bomb.
		const bomb = ZipReader.open(zipSync({ "a.xml": new Uint8Array(20 * 1024 * 1024) }, { level: 9 }));
		expect(() => bomb.read("a.xml")).toThrow(/unpacks to far more than its size/);
	});
	it("fix round 3: highly repetitive writer output is read back, not refused as a bomb", () => {
		// DESIGN 17.4: our own writer output is read back by our extractor. A docx of a repeated table
		// compresses far below its unpacked size, but it is small in absolute terms, so it reads back.
		const md = `| Item | Qty | Note |\n|---|---|---|\n${"| Widget | 1 | ok |\n".repeat(3_000)}`;
		const docx = buildDocx(parseMarkdown(md), { title: null, creator: "QA", pageSize: "A4" });
		const z = ZipReader.open(docx);
		const xml = z.read("word/document.xml");
		if (!xml) throw new Error("no document.xml");
		// It unpacks to well over 100x the whole package, which the old 1 MB floor refused.
		expect(xml.length / docx.length).toBeGreaterThan(100);
	});
	it("fix round 3: a repetitive docx reads back through extractText", async () => {
		const md = `| Item | Qty | Note |\n|---|---|---|\n${"| Widget | 1 | ok |\n".repeat(3_000)}`;
		const r = await run(buildDocx(parseMarkdown(md), { title: null, creator: "QA", pageSize: "A4" }), "repeat.docx");
		if (!("text" in r)) throw new Error(`refused: ${JSON.stringify(r)}`);
		expect(r.text).toContain("| Widget | 1 | ok |");
		// A docx of 25,000 short paragraphs reads back too (another case the old floor refused).
		const paras = await run(buildDocx(parseMarkdown("a\n\n".repeat(25_000)), { title: null, creator: "QA", pageSize: "A4" }), "paras.docx");
		expect("text" in paras).toBe(true);
	});
	it("counts the total over all parts", () => {
		const parts: Record<string, Uint8Array> = {};
		const chunk = new Uint8Array(1024 * 1024);
		crypto.getRandomValues(chunk.subarray(0, 65536));
		for (let i = 0; i < 70; i++) {
			const c = new Uint8Array(1024 * 1024);
			for (let k = 0; k < c.length; k += 65536) c.set(chunk.subarray(0, 65536), k);
			c[0] = i;
			parts[`p${i}.xml`] = c;
		}
		const z = ZipReader.open(zipSync(parts, { level: 1 }), { partBytes: 30 * 1024 * 1024, totalBytes: 60 * 1024 * 1024, entries: 2000, ratio: 1e9, ratioFloor: 1 });
		expect(() => {
			for (let i = 0; i < 70; i++) z.read(`p${i}.xml`);
		}).toThrow(/60 MB in all/);
	});
	it("refuses too many entries, passwords, duplicates and damage", () => {
		const many: Record<string, Uint8Array> = {};
		for (let i = 0; i < 2001; i++) many[`f${i}`] = new Uint8Array(0);
		expect(() => ZipReader.open(zipSync(many))).toThrow(/more than 2,000 parts/);
		const one = zipSync({ "a.xml": new TextEncoder().encode("<a/>") }, { level: 0 });
		// Set the "encrypted" flag in the central directory entry.
		const enc = one.slice();
		const cen = findSig(enc, 0x02014b50);
		enc[cen + 8] = (enc[cen + 8] as number) | 1;
		expect(() => ZipReader.open(enc).read("a.xml")).toThrow(/protected with a password/);
		expect(() => ZipReader.open(one.slice(0, one.length - 30))).toThrow(ToolError);
		expect(() => ZipReader.open(new TextEncoder().encode("PK not really"))).toThrow(ToolError);
		const z = ZipReader.open(one);
		expect(z.has("A.XML")).toBe(true);
		expect(z.read("missing.xml")).toBeNull();
	});
});

function findSig(b: Uint8Array, sig: number): number {
	for (let i = b.length - 4; i >= 0; i--) {
		if (((b[i] as number) | ((b[i + 1] as number) << 8) | ((b[i + 2] as number) << 16) | ((b[i + 3] as number) << 24)) >>> 0 === sig) return i;
	}
	throw new Error("signature not found");
}

describe("files made by ONLYOFFICE (saved from the live run)", () => {
	it("odt: styled headings, numbered and bullet lists, a table and a link", async () => {
		expect(await textOf(fixture("onlyoffice-plan.odt"), "plan.odt")).toBe(
			"# Quarterly plan\n\nWritten for {{client}} on {{date}}. See [Nourax](https://nourax.org).\n\n## Goals\n\n1. Grow revenue\n2. Hire two people\n  - one engineer\n\n| Item | Cost |\n| --- | --- |\n| Tea | 2.50 |\n| Cake | 4.00 |\n\nKeep it simple.\n\n## Next steps\n\n- Write the report\n- Share it",
		);
	});
	it("ods: two sheets, date-times, uncalculated formulas, repeated empty columns", async () => {
		const r = await run(fixture("onlyoffice-budget.ods"), "budget.ods");
		if (!("text" in r)) throw new Error("no text");
		expect(r.sheets).toEqual(["Costs", "Notes"]);
		// Uncalculated OpenDocument formulas are shown in the usual A1 form ("of:=[.C2]*2" in the file).
		expect(r.text).toBe("## Sheet: Costs\nItem,When,Cost,Share,Double\nTea,2026-10-25,2.5,0.25,=C2*2\n=not a formula,2026-10-26 09:30,4,0.5,=C3*2\n\n## Sheet: Notes\nNote\nsecond sheet text");
	});
	it("odp: titles, nested bullets and notes", async () => {
		expect(await textOf(fixture("onlyoffice-deck.odp"), "deck.odp")).toBe("## Slide 1: Quarterly plan\n\nOctober 2026\n\n## Slide 2: Goals\n\nGrow\n  Revenue\nHire\n\nNotes: Mention the budget\n\n## Slide 3: Thanks");
	});
	it("pdf: a real converter PDF with embedded fonts", async () => {
		const r = await run(fixture("onlyoffice-budget.pdf"), "budget.pdf");
		if (!("text" in r)) throw new Error("no text");
		expect(r.pages).toEqual({ from: 1, to: 1, total: 1 });
		expect(r.text).toBe("## Page 1\n\nItem When Cost Share Double\nTea 2026-10-25 2.50 25% 5\n=not a formula 2026-10-26 09:30 4.00 50% 8");
	});
});
