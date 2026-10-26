/**
 * Contract tests for the fix round 1 and 2 guards, through the whole Worker against the fake
 * NoDrive: bounded results (template fields, missing lists, sheet names), the conversion route used
 * only for pairs our tools send, docs_convert's checks before it spends a conversion (a taken name,
 * a missing folder), Markdown made into .docx in the Worker (never sent to the converter), the
 * first-sheet warning for workbooks, the document tools' own hint for a taken name, files that
 * aren't what their names say, and text that isn't UTF-8.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeNc } from "../../fake-nc/index";
import { installOffice, type OfficeFake } from "../../fake-nc/office";
import { fakeWithQa, framedPayload, QA } from "../../helpers/index";
import { checkPackage, fixture, zipOf } from "../../docs/helpers";
import { callTool, calls, failed, freshDay, ok } from "./helpers";

let fake: FakeNc;
let office: OfficeFake;
beforeEach(() => {
	freshDay();
	fake = fakeWithQa();
	office = installOffice(fake);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const X = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
/** The start of an old binary Office file (a compound file is at least one 512-byte sector). */
const OLE = new Uint8Array(1024);
OLE.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function manyFields(n: number): Uint8Array {
	const body = Array.from({ length: n }, (_, i) => `<w:p><w:r><w:t>{{field number ${i}}}</w:t></w:r></w:p>`).join("");
	return zipOf({ "[Content_Types].xml": CT, "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>` });
}

describe("bounded results", () => {
	it("docs_list_template_fields lists at most 500 fields, says how many there are, and fits one result", async () => {
		office.addFile(QA.a, "/T/many.docx", manyFields(30_000));
		const r = await callTool("docs_list_template_fields", { path: "/T/many.docx" });
		const data = ok("docs_list_template_fields", r);
		expect((data.fields as unknown[]).length).toBeLessThanOrEqual(500);
		expect(data).toMatchObject({ total_fields: 10_000, truncated: true });
		expect(JSON.stringify(r.structuredContent).length).toBeLessThan(60_000);
		const text = r.content[0]?.text ?? "";
		expect(text.length).toBeLessThanOrEqual(60_000);
		expect(text).not.toContain("[Cut short");
		expect(text.split("\n")[0]).toBe(`/T/many.docx has more than 10,000 fields. The first ${(data.fields as unknown[]).length} are listed.`);
		JSON.parse(framedPayload(text));
	});
	it("docs_fill_template's missing list is cut to 200, with missing_total and truncated", async () => {
		office.addFile(QA.a, "/T/many.docx", manyFields(3_000));
		const r = await callTool("docs_fill_template", { template_path: "/T/many.docx", output_path: "/T/out.docx", values: { "field number 7": "seven" }, missing: "keep" });
		const data = ok("docs_fill_template", r);
		expect(data).toMatchObject({ filled: ["field number 7"], missing_total: 2_999, truncated: true });
		expect((data.missing as unknown[]).length).toBe(200);
		expect(JSON.stringify(r.structuredContent).length).toBeLessThan(60_000);
		expect((data.warnings as string[])[0]).toMatch(/^2,999 fields had no value and were left as they were: field number 0, field number 1, .*, and more\.$/);
	});
	it("files_read_text lists at most 50 sheet names, each cleaned and at most 100 characters", async () => {
		const sheets = Array.from({ length: 60 }, (_, i) => `<sheet name="${i === 0 ? `Evilname${"x".repeat(200)}` : `S${i}`}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
		const rels = Array.from({ length: 60 }, (_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("");
		const files: Record<string, string> = {
			"[Content_Types].xml": CT,
			"xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="${X}" xmlns:r="${R}"><sheets>${sheets}</sheets></workbook>`,
			"xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
		};
		for (let i = 1; i <= 60; i++) files[`xl/worksheets/sheet${i}.xml`] = `<?xml version="1.0"?><worksheet xmlns="${X}"><sheetData><row r="1"><c r="A1"><v>${i}</v></c></row></sheetData></worksheet>`;
		office.addFile(QA.a, "/wide.xlsx", zipOf(files));
		const data = ok("files_read_text", await callTool("files_read_text", { path: "/wide.xlsx" }));
		const names = data.sheets as string[];
		expect(names).toHaveLength(50);
		expect(names[0]).toBe(`Evilname${"x".repeat(92)}`);
		expect(data.note).toContain("This file has 60 sheets; sheets lists the first 50.");
	});
});

describe("the conversion route only for pairs our tools send", () => {
	it("djvu, flat OpenDocument, Google shortcuts and the like are refused plainly, without a download or a conversion", async () => {
		for (const name of ["/x.djvu", "/y.fodp", "/z.gsheet", "/w.gslides", "/v.oform", "/u.epub"]) {
			office.addFile(QA.a, name, new Uint8Array([1, 2, 3]));
			expect(failed(await callTool("files_read_text", { path: name }), "unsupported_type"), name).toBe("This kind of file can't be turned into text here. The NoDrive app or ONLYOFFICE can open it.");
		}
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(0);
		expect(calls(fake, "GET", /\/remote\.php\//)).toHaveLength(0);
	});
	it("docs_convert refuses HTML, MHT, XML and EPUB sources", async () => {
		for (const [name, ext] of [
			["/p.html", "html"],
			["/p.mht", "mht"],
			["/p.xml", "xml"],
			["/p.epub", "epub"],
		]) {
			office.addFile(QA.a, name as string, "<html><img src='http://169.254.169.254/'></html>");
			expect(failed(await callTool("docs_convert", { path: name }), "unsupported_type")).toBe(`.${ext} files can't be converted here.`);
		}
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(0);
	});
});

describe("docs_convert checks before it spends a conversion", () => {
	it('if_exists "fail" with a taken name fails before converting', async () => {
		office.addFile(QA.a, "/Docs/Plan.docx", fixture("word-python-docx.docx"));
		office.addFile(QA.a, "/Docs/Plan.pdf", "%PDF-1.4 old");
		const t = failed(await callTool("docs_convert", { path: "/Docs/Plan.docx", if_exists: "fail" }), "already_exists");
		expect(t).toBe('/Docs/Plan.pdf already exists. Use if_exists "rename", or another output_path.');
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(0);
		expect(calls(fake, "PUT", /./)).toHaveLength(0);
		// A free name goes ahead (one PROPFIND finds nothing, then the conversion).
		ok("docs_convert", await callTool("docs_convert", { path: "/Docs/Plan.docx", if_exists: "fail", output_path: "/Docs/New.pdf" }));
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(1);
	});
	it("a damaged or fake Office file is refused without converting; an old binary file under a new name converts", async () => {
		office.addFile(QA.a, "/broken.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...Array.from({ length: 46 }, (_, i) => i)]));
		office.addFile(QA.a, "/fake.xlsx", "just some text, not a spreadsheet");
		expect(failed(await callTool("docs_convert", { path: "/broken.docx" }), "unsupported_type")).toBe("/broken.docx couldn't be converted: it may be damaged, or not really a .docx file.");
		failed(await callTool("docs_convert", { path: "/fake.xlsx" }), "unsupported_type");
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(0);
		// A package small enough to read here is read once in the Worker (fix round 3: that one read
		// serves the soundness check and the external-reference check).
		const reads = calls(fake, "GET", /\/broken\.docx$/);
		expect(reads).toHaveLength(1);
		expect(reads[0]?.headers.get("range")).toBe("bytes=0-10485759");
		office.addFile(QA.a, "/old.docx", OLE);
		ok("docs_convert", await callTool("docs_convert", { path: "/old.docx" }));
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(1);
	});
	it("a sound zip (our own fixture) is read once in the Worker for the content checks", async () => {
		office.addFile(QA.a, "/s.docx", fixture("word-python-docx.docx"));
		ok("docs_convert", await callTool("docs_convert", { path: "/s.docx" }));
		const reads = calls(fake, "GET", /\/s\.docx$/);
		expect(reads).toHaveLength(1);
		expect(reads[0]?.headers.get("range")).toBe("bytes=0-10485759");
	});
	it("a workbook made into a PDF is read once (its sheets counted, its zip and links checked from the same read)", async () => {
		const bytes = fixture("excel-openpyxl.xlsx");
		office.addFile(QA.a, "/s.xlsx", bytes);
		ok("docs_convert", await callTool("docs_convert", { path: "/s.xlsx" }));
		const reads = calls(fake, "GET", /\/s\.xlsx$/);
		expect(reads).toHaveLength(1);
		expect(reads[0]?.headers.get("range")).toBe("bytes=0-10485759");
		// To another workbook format the source is still read whole, for the external-reference check.
		ok("docs_convert", await callTool("docs_convert", { path: "/s.xlsx", to: "ods" }));
		expect(calls(fake, "GET", /\/s\.xlsx$/)[1]?.headers.get("range")).toBe("bytes=0-10485759");
	});
});

describe("fix round 2: docs_convert", () => {
	it("Markdown is never sent to the converter: a .md file becomes a .docx made in the Worker", async () => {
		office.addFile(QA.a, "/Notes/plan.md", "# Plan\n\n![x](http://169.254.169.254/latest)\n\n- one\n- [link](javascript:alert(1))\n\n1. first");
		const r = await callTool("docs_convert", { path: "/Notes/plan.md", to: "docx" });
		expect(ok("docs_convert", r)).toMatchObject({ from: "/Notes/plan.md", renamed: false, file: { path: "/Notes/plan.docx" } });
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(0);
		const parts = checkPackage(office.file(QA.a, "/Notes/plan.docx")?.bytes as Uint8Array);
		const doc = parts.get("word/document.xml") ?? "";
		expect(doc).toContain("Plan");
		// No images and no links other than https: and mailto:, so nothing in it can be fetched.
		expect([...parts.keys()].some((k) => k.startsWith("word/media/"))).toBe(false);
		expect(parts.get("word/_rels/document.xml.rels") ?? "").not.toMatch(/169\.254|javascript:/);
		// Its text reads back.
		const t = framedPayload((await callTool("files_read_text", { path: "/Notes/plan.docx" })).content[0]?.text ?? "");
		expect(t).toContain("# Plan");
		expect(t).toContain("- one");
	});
	it("Markdown to any other format says to make the .docx first, without a download or a conversion", async () => {
		office.addFile(QA.a, "/Notes/plan.md", "# Plan");
		for (const to of ["pdf", "odt", "txt"]) {
			expect(failed(await callTool("docs_convert", { path: "/Notes/plan.md", to }), "unsupported_type", "to")).toBe(`A .md file can become a .docx here (to "docx"), and that .docx can then be converted to .${to}.`);
		}
		// The default target is pdf.
		failed(await callTool("docs_convert", { path: "/Notes/plan.md" }), "unsupported_type");
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(0);
		expect(calls(fake, "GET", /plan\.md$/)).toHaveLength(0);
	});
	it("Markdown over 400,000 characters is refused plainly", async () => {
		office.addFile(QA.a, "/big.md", "x".repeat(400_001));
		expect(failed(await callTool("docs_convert", { path: "/big.md", to: "docx" }), "too_large")).toBe("/big.md has 400,001 characters. Markdown files up to 400,000 characters can be made into a .docx here.");
		expect(calls(fake, "PUT", /./)).toHaveLength(0);
	});
	it("output_path in a missing folder fails before the conversion is spent, naming the folder", async () => {
		office.addFile(QA.a, "/Docs/Plan.docx", fixture("word-python-docx.docx"));
		const t = failed(await callTool("docs_convert", { path: "/Docs/Plan.docx", output_path: "/Nowhere/Sub/Plan.pdf" }), "parent_missing", "output_path");
		expect(t).toBe("The folder /Nowhere/Sub doesn't exist. files_create_folder can make it.");
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(0);
		expect(calls(fake, "PUT", /./)).toHaveLength(0);
		// A file where the folder should be.
		office.addFile(QA.a, "/Docs/notafolder", "x");
		expect(failed(await callTool("docs_convert", { path: "/Docs/Plan.docx", output_path: "/Docs/notafolder/Plan.pdf" }), "parent_missing")).toBe("/Docs/notafolder is a file, not a folder, so nothing can be saved in it.");
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(0);
	});
	it("a workbook of several sheets made into a PDF or CSV says that only the first sheet is in it", async () => {
		// excel-openpyxl.xlsx has three sheets: Sales, Hidden notes and Empty.
		office.addFile(QA.a, "/Book.xlsx", fixture("excel-openpyxl.xlsx"));
		const pdf = await callTool("docs_convert", { path: "/Book.xlsx" });
		const warning = "Only the first sheet was converted: this workbook has 3 sheets, so 2 aren't in the PDF file. The ONLYOFFICE editor can export every sheet.";
		expect(ok("docs_convert", pdf).warnings).toEqual([warning]);
		expect(pdf.content[0]?.text).toContain(warning);
		const csv = ok("docs_convert", await callTool("docs_convert", { path: "/Book.xlsx", to: "csv" }));
		expect(csv.warnings).toEqual(["Only the first sheet was converted: this workbook has 3 sheets, so 2 aren't in the CSV file. The ONLYOFFICE editor can export every sheet."]);
		// Other formats keep every sheet: no warning.
		expect(ok("docs_convert", await callTool("docs_convert", { path: "/Book.xlsx", to: "ods" })).warnings).toBeUndefined();
		// One sheet: no warning. A workbook that can't be counted here (xls) gets the general one.
		office.addFile(QA.a, "/One.xlsx", fixture("excel-xlsxwriter.xlsx"));
		expect(ok("docs_convert", await callTool("docs_convert", { path: "/One.xlsx" })).warnings).toBeUndefined();
		office.addFile(QA.a, "/Old.xls", OLE);
		const old = ok("docs_convert", await callTool("docs_convert", { path: "/Old.xls" }));
		expect(old.warnings).toEqual(["When a workbook becomes a PDF file here, only its first sheet is converted; any other sheets aren't in the copy. The ONLYOFFICE editor can export every sheet."]);
	});
	it("the description says so: Markdown becomes .docx, and a workbook keeps only its first sheet", async () => {
		const { toolDef } = await import("../../../src/tools/registry");
		const d = toolDef("docs_convert")?.description ?? "";
		expect(d).toContain("Markdown becomes .docx");
		expect(d).toContain("A workbook made into PDF or CSV keeps only its first sheet.");
	});
});

describe("fix round 3: the converter is given only safe content", () => {
	const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
	const docxWithRel = (rels: string) =>
		zipOf({
			"[Content_Types].xml": CT,
			"word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>`,
			"word/_rels/document.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
		});
	it("docs_convert refuses a package that links an image by URL, without converting", async () => {
		office.addFile(QA.a, "/linked.docx", docxWithRel(`<Relationship Id="r1" Type="${REL}/image" Target="http://169.254.169.254/x.png" TargetMode="External"/>`));
		expect(failed(await callTool("docs_convert", { path: "/linked.docx" }), "invalid_input", "path")).toContain("links to an image or file on the internet");
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(0);
		// A package with only a web hyperlink (not fetched by the converter) converts normally.
		office.addFile(QA.a, "/plain.docx", docxWithRel(`<Relationship Id="r1" Type="${REL}/hyperlink" Target="https://nourax.org" TargetMode="External"/>`));
		ok("docs_convert", await callTool("docs_convert", { path: "/plain.docx" }));
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(1);
	});
	it("docs_convert refuses a text-based source whose bytes are really HTML, without converting", async () => {
		office.addFile(QA.a, "/sneaky.txt", "<html><body><img src='http://169.254.169.254/'></body></html>");
		expect(failed(await callTool("docs_convert", { path: "/sneaky.txt" }), "unsupported_type")).toContain("looks like a web page (HTML)");
		office.addFile(QA.a, "/sneaky.csv", "<!DOCTYPE html><html></html>");
		failed(await callTool("docs_convert", { path: "/sneaky.csv" }), "unsupported_type");
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(0);
		// A real CSV converts.
		office.addFile(QA.a, "/real.csv", "a,b\n1,2\n");
		ok("docs_convert", await callTool("docs_convert", { path: "/real.csv", to: "xlsx" }));
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(1);
	});
	it("files_read_text refuses a legacy source whose bytes are really HTML, without converting", async () => {
		office.addFile(QA.a, "/sneaky.doc", "<html><body>hi</body></html>");
		expect(failed(await callTool("files_read_text", { path: "/sneaky.doc" }), "unsupported_type")).toContain("looks like a web page (HTML)");
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(0);
	});
});

describe("fix round 2: a taken name gets the document tools' own hint", () => {
	it("never points to files_overwrite_file (which writes text and can't replace an Office file)", async () => {
		office.addFile(QA.a, "/Plan.docx", fixture("word-python-docx.docx"));
		const d = failed(await callTool("docs_create_document", { path: "/Plan.docx", markdown: "x" }), "already_exists", "path");
		expect(d).toBe('/Plan.docx already exists. Use if_exists "rename", or another path.');
		ok("docs_create_spreadsheet", await callTool("docs_create_spreadsheet", { path: "/Plan.xlsx", csv: "a\n1" }));
		const s = failed(await callTool("docs_create_spreadsheet", { path: "/Plan.xlsx", csv: "a\n1" }), "already_exists", "path");
		expect(s).toBe('/Plan.xlsx already exists. Use if_exists "rename", or another path.');
		office.addFile(QA.a, "/Out.docx", fixture("word-python-docx.docx"));
		const values = { client: "A", item: "B", amount: "C", "due date": "D", company: "E" };
		const f = failed(await callTool("docs_fill_template", { template_path: "/Plan.docx", output_path: "/Out.docx", values }), "already_exists", "output_path");
		expect(f).toBe('/Out.docx already exists. Use if_exists "rename", or another output_path.');
		for (const t of [d, s, f]) expect(t).not.toContain("files_overwrite_file");
	});
});

describe("files that aren't what their names say, and text that isn't UTF-8", () => {
	it("plain text named .docx is read as text, with a note, without a conversion", async () => {
		office.addFile(QA.a, "/fake.docx", "This is really just text.");
		const r = await callTool("files_read_text", { path: "/fake.docx" });
		const data = ok("files_read_text", r);
		expect(data).toMatchObject({ format: "text", note: "This file is named .docx but holds plain text, so it was read as text." });
		expect(framedPayload(r.content[0]?.text ?? "")).toBe("This is really just text.");
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(0);
	});
	it("a Windows-1252 CSV reads with its accents and a note", async () => {
		office.addFile(QA.a, "/latin1.csv", new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x31]));
		const r = await callTool("files_read_text", { path: "/latin1.csv" });
		expect(ok("files_read_text", r).note).toBe("The file isn't UTF-8, so it was read as Windows-1252 (Western European); a few characters may be wrong.");
		expect(framedPayload(r.content[0]?.text ?? "")).toBe("café,1");
	});
	it("an RTF file read through the conversion carries the accents note", async () => {
		office.addFile(QA.a, "/legacy.rtf", "{\\rtf1 caf\\'e9}");
		const data = ok("files_read_text", await callTool("files_read_text", { path: "/legacy.rtf" }));
		expect(data.note).toBe("Read through a conversion to plain text; some spacing may be lost. Accented letters in RTF files may be lost in this conversion.");
	});
});
