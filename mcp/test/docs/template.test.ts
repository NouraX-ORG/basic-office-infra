/**
 * Template fields and filling (DESIGN 12.3 and 17.4): placeholders split across runs (Word and
 * Excel rich strings from real producers), PowerPoint newlines, the missing policies, unused
 * values, escaping, and .dotx to .docx.
 */
import { describe, expect, it } from "vitest";
import { extractText } from "../../src/docs/extract/index";
import { fillTemplate, findPlaceholders, listFields, validKey } from "../../src/docs/template";
import { checkPackage, fixture, unzipText, zipOf } from "./helpers";

async function text(bytes: Uint8Array, name: string): Promise<string> {
	const r = await extractText(bytes, { name, mime: null, offset: 0, maxChars: 50_000 });
	if (!("text" in r)) throw new Error("no text");
	return r.text;
}

describe("placeholders", () => {
	it("finds {{key}} without overlaps and refuses bad keys", () => {
		expect(findPlaceholders("{{a}} {{ b c }} {{{d}}} {{e.f-g_h}} {{}} {{x\ny}} {{" + "z".repeat(70) + "}}").map((m) => m.key)).toEqual(["a", "b c", "d", "e.f-g_h"]);
		expect(validKey(" client ")).toBe(true);
		expect(validKey("a/b")).toBe(false);
		expect(validKey("x".repeat(65))).toBe(false);
	});
	it("scans hostile text in linear time", () => {
		expect(findPlaceholders("{{".repeat(200_000))).toEqual([]);
		expect(findPlaceholders("{{a".repeat(100_000))).toEqual([]);
	});
});

describe("Word templates", () => {
	const tpl = fixture("word-python-docx.docx");
	it("lists fields across split runs, tables and the header, with counts", () => {
		const r = listFields(tpl, "docx");
		const map = Object.fromEntries(r.fields.map((f) => [f.name, f.count]));
		expect(map).toEqual({ client: 1, item: 1, amount: 2, "due date": 1, company: 1 });
	});
	it("fills split runs keeping the first run's formatting, escapes values and makes line breaks", async () => {
		const r = fillTemplate(tpl, "docx", { client: "Bob & <Co>", item: "Tea", amount: "£5", "due date": "Friday\nnoon", company: "Acme", extra: "x" }, "fail", false);
		expect(r.filled).toEqual(["amount", "client", "company", "due date", "item"]);
		expect(r.missing).toEqual([]);
		expect(r.unused).toEqual(["extra"]);
		const parts = checkPackage(r.bytes);
		const doc = parts.get("word/document.xml") as string;
		// The value sits in the first (bold) run; the second run of the split is emptied.
		expect(doc).toMatch(/<w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">Bob &amp; &lt;Co&gt;<\/w:t><\/w:r><w:r><w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve"><\/w:t><\/w:r>/);
		expect(doc).toContain('Friday</w:t><w:br/><w:t xml:space="preserve">noon');
		expect(parts.get("word/header1.xml")).toContain("Header for Acme");
		const t = await text(r.bytes, "out.docx");
		expect(t).toContain("Dear Bob & <Co>, thank you");
		expect(t).toContain("| Tea | £5 |");
		expect(t).toContain("Total due: £5 by Friday\nnoon.");
	});
	it("missing: fail stops with a count (never the template's own names), keep leaves them, blank empties them", async () => {
		expect(() => fillTemplate(tpl, "docx", { client: "x" }, "fail", false)).toThrow(/^The template has 4 fields with no value\.$/);
		const keep = fillTemplate(tpl, "docx", { client: "x" }, "keep", false);
		expect(keep.missing).toEqual(["amount", "company", "due date", "item"]);
		expect(await text(keep.bytes, "k.docx")).toContain("| {{item}} | {{ amount }} |");
		const blank = fillTemplate(tpl, "docx", { client: "x" }, "blank", false);
		expect(await text(blank.bytes, "b.docx")).toContain("Total due:  by .");
	});
	it("a .dotx template becomes a .docx document", () => {
		const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
		const dotx = zipOf({
			"[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml"/></Types>',
			"word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>Hi {{name}}</w:t></w:r></w:p></w:body></w:document>`,
		});
		const r = fillTemplate(dotx, "docx", { name: "Ann" }, "fail", true);
		const parts = unzipText(r.bytes);
		expect(parts.get("[Content_Types].xml")).toContain("wordprocessingml.document.main+xml");
		expect(parts.get("word/document.xml")).toContain("Hi Ann");
	});
	it("refuses a file that isn't the kind its name says, and a DOCTYPE", () => {
		expect(() => fillTemplate(fixture("excel-openpyxl.xlsx"), "docx", {}, "keep", false)).toThrow(/isn't a valid document/);
		const evil = zipOf({ "word/document.xml": '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x "y">]><d/>' });
		expect(() => listFields(evil, "docx")).toThrow();
	});
});

describe("Excel templates", () => {
	it("openpyxl: shared strings", async () => {
		const b = fixture("excel-openpyxl.xlsx");
		expect(listFields(b, "xlsx").fields).toEqual([{ name: "name", count: 1 }]);
		const r = fillTemplate(b, "xlsx", { name: "  Zoë  " }, "fail", false);
		checkPackage(r.bytes);
		expect(await text(r.bytes, "o.xlsx")).toContain('South,2026-01-02 14:30,0.3,0.5,FALSE,"  Zoë   owes"');
	});
	it("xlsxwriter: placeholders split across rich-text runs", async () => {
		const b = fixture("excel-xlsxwriter.xlsx");
		expect(listFields(b, "xlsx").fields).toEqual([
			{ name: "first", count: 2 },
			{ name: "second", count: 1 },
		]);
		const r = fillTemplate(b, "xlsx", { first: "A", second: "B\nC" }, "fail", false);
		checkPackage(r.bytes);
		expect(await text(r.bytes, "x.xlsx")).toContain('"Hello A and B\nC",2025-12-31,7\nplain A');
	});
});

describe("PowerPoint templates", () => {
	it("python-pptx: fills titles, bodies and notes; a newline splits the run with an a:br", async () => {
		const b = fixture("pptx-python-pptx.pptx");
		expect(Object.fromEntries(listFields(b, "pptx").fields.map((f) => [f.name, f.count]))).toEqual({ title: 1, client: 2 });
		const r = fillTemplate(b, "pptx", { title: "Q4 & beyond", client: "Line 1\nLine 2" }, "fail", false);
		const parts = checkPackage(r.bytes);
		const slide = [...parts.entries()].find(([k, v]) => k.startsWith("ppt/slides/slide") && v.includes("Prepared for"))?.[1] ?? "";
		expect(slide).toMatch(/Prepared for Line 1<\/a:t><\/a:r><a:br>(<a:rPr[^>]*\/>)?<\/a:br><a:r>(<a:rPr[^>]*\/>)?<a:t>Line 2<\/a:t><\/a:r>|Prepared for Line 1<\/a:t><\/a:r><a:br\/><a:r><a:t>Line 2/);
		const t = await text(r.bytes, "p.pptx");
		expect(t).toContain("## Slide 2: Q4 & beyond\n\nPrepared for Line 1\nLine 2");
		expect(t).toContain("Notes: Say hello Line 1\nLine 2");
	});
	it("leaves field text (slide numbers) alone", () => {
		const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
		const slide = `<?xml version="1.0"?><p:sld ${A}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:fld id="{1}" type="slidenum"><a:t>{{n}}</a:t></a:fld><a:r><a:t>{{x}}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
		const b = zipOf({ "ppt/presentation.xml": `<p:presentation ${A}/>`, "ppt/slides/slide1.xml": slide });
		expect(listFields(b, "pptx").fields).toEqual([{ name: "x", count: 1 }]);
	});
});
