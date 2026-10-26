/**
 * Hostile files within the byte caps (fix round 1, from the security review): memory-based limits,
 * not only byte limits. Zip parts that unpack to hundreds of MB, text past the 5,000,000-character
 * cap in deflated parts (which once came back as "damaged"), and templates built to use up memory
 * or CPU. Peak memory itself is measured outside workerd (see src/docs/README.md); here the limits
 * that bound it are pinned.
 */
import { Deflate, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ToolError } from "../../src/core/errors";
import { extractText } from "../../src/docs/extract/index";
import { MAX_TEXT_CHARS } from "../../src/docs/extract/out";
import { fillTemplate, listFields } from "../../src/docs/template";
import { ZipReader } from "../../src/docs/zip";
import { checkPackage, fixture, zipOf } from "./helpers";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const X = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
const CUT_NOTE = "The file has more text than can be read here (5,000,000 characters); the end is missing.";

/** Letters and spaces from a fixed pseudo-random sequence: packs like real text (a few times), not like a bomb. */
function noise(n: number, seed = 1): string {
	let x = seed;
	const out: string[] = [];
	for (let i = 0; i < n; i++) {
		// xorshift32 (exact in 32-bit integers).
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		const r = (x >>> 0) % 28;
		out.push(r >= 26 ? " " : String.fromCharCode(97 + r));
	}
	return out.join("");
}

/** Raw deflate of `mb` MB of one byte value (with `head` at the start), streamed so it is never held. */
function deflatedFill(mb: number, fill: number, head = ""): { packed: Uint8Array; size: number } {
	const out: Uint8Array[] = [];
	const d = new Deflate({ level: 1 }, (c) => out.push(c));
	const block = new Uint8Array(1024 * 1024).fill(fill);
	const first = block.slice();
	first.set(new TextEncoder().encode(head), 0);
	for (let i = 0; i < mb; i++) d.push(i === 0 ? first : block, i === mb - 1);
	let n = 0;
	for (const c of out) n += c.length;
	const packed = new Uint8Array(n);
	let o = 0;
	for (const c of out) {
		packed.set(c, o);
		o += c.length;
	}
	return { packed, size: mb * 1024 * 1024 };
}

/** A zip with already-packed entries (method 8) and the sizes it claims. */
function rawZip(entries: { name: string; packed: Uint8Array; claimed: number }[]): Uint8Array {
	const enc = new TextEncoder();
	const parts: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = enc.encode(e.name);
		const h = new Uint8Array(30 + name.length);
		const v = new DataView(h.buffer);
		v.setUint32(0, 0x04034b50, true);
		v.setUint16(4, 20, true);
		v.setUint16(8, 8, true);
		v.setUint32(18, e.packed.length, true);
		v.setUint32(22, e.claimed, true);
		v.setUint16(26, name.length, true);
		h.set(name, 30);
		const c = new Uint8Array(46 + name.length);
		const cv = new DataView(c.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(10, 8, true);
		cv.setUint32(20, e.packed.length, true);
		cv.setUint32(24, e.claimed, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		c.set(name, 46);
		parts.push(h, e.packed);
		central.push(c);
		offset += h.length + e.packed.length;
	}
	let cdSize = 0;
	for (const c of central) cdSize += c.length;
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, offset, true);
	const all = [...parts, ...central, end];
	let n = 0;
	for (const p of all) n += p.length;
	const out = new Uint8Array(n);
	let o = 0;
	for (const p of all) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

describe("zip bombs: the counters run before memory piles up", () => {
	// A 200 MB part of spaces packs to about 1 MB; the review's 64 KB pushes made 64 MB chunks.
	const big = deflatedFill(200, 32, `<?xml version="1.0"?><w:document ${W}><w:body>`);
	const ct = new TextEncoder().encode(CT);
	const docx = rawZip([
		{ name: "[Content_Types].xml", packed: deflatedSmall(ct), claimed: ct.length },
		{ name: "word/document.xml", packed: big.packed, claimed: 1000 },
	]);

	it("a 200 MB part is refused, and no single unpacked piece is bigger than about 4 MB", () => {
		expect(big.packed.length).toBeLessThan(2 * 1024 * 1024);
		const z = ZipReader.open(docx);
		let largest = 0;
		let seen = 0;
		const err = (() => {
			try {
				z.stream("word/document.xml", (c) => {
					largest = Math.max(largest, c.length);
					seen += c.length;
				});
			} catch (e) {
				return e;
			}
			return null;
		})();
		expect(err).toBeInstanceOf(ToolError);
		expect((err as ToolError).code).toBe("too_large");
		// 4 KB of packed input at a time: deflate expands at most about 1,032 times.
		expect(largest).toBeLessThanOrEqual(4_300_000);
		// It stopped soon after the 100x ratio was passed (the part packs to about 1 MB).
		expect(seen).toBeLessThan(big.packed.length * 100 + 5_000_000);
	});
	it("files_read_text and the template tools refuse it plainly", async () => {
		await expect(extractText(docx, { name: "b.docx", mime: null, offset: 0, maxChars: 1000 })).rejects.toMatchObject({ code: "too_large" });
		expect(() => listFields(docx, "docx")).toThrow(ToolError);
		expect(() => fillTemplate(docx, "docx", {}, "blank", false)).toThrow(ToolError);
	});
});

function deflatedSmall(b: Uint8Array): Uint8Array {
	const out: Uint8Array[] = [];
	const d = new Deflate({ level: 6 }, (c) => out.push(c));
	d.push(b, true);
	let n = 0;
	for (const c of out) n += c.length;
	const r = new Uint8Array(n);
	let o = 0;
	for (const c of out) {
		r.set(c, o);
		o += c.length;
	}
	return r;
}

describe("text past the 5,000,000-character cap in deflated parts is cut, not 'damaged'", () => {
	const text = noise(1_000_000);
	const para = (i: number) => `<w:p><w:r><w:t>${text.slice((i * 1000) % 999_000, ((i * 1000) % 999_000) + 1000)}</w:t></w:r></w:p>`;
	it("Word", async () => {
		const doc = `<?xml version="1.0"?><w:document ${W}><w:body>${Array.from({ length: 6_000 }, (_, i) => para(i)).join("")}</w:body></w:document>`;
		const r = await extractText(zipOf({ "[Content_Types].xml": CT, "word/document.xml": doc }), { name: "big.docx", mime: null, offset: 0, maxChars: 1000 });
		if (!("text" in r)) throw new Error(JSON.stringify(r));
		expect(r.totalChars).toBeLessThanOrEqual(MAX_TEXT_CHARS);
		expect(r.totalChars).toBeGreaterThan(MAX_TEXT_CHARS - 2_000);
		expect(r.note).toBe(CUT_NOTE);
	});
	it("Excel", async () => {
		const cell = (i: number) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${text.slice((i * 97) % 990_000, ((i * 97) % 990_000) + 1_100)}</t></is></c></row>`;
		const rows = Array.from({ length: 5_000 }, (_, i) => cell(i)).join("");
		const r = await extractText(
			zipOf({
				"[Content_Types].xml": CT,
				"xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="${X}" xmlns:r="${R}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
				"xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
				"xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="${X}"><sheetData>${rows}</sheetData></worksheet>`,
			}),
			{ name: "big.xlsx", mime: null, offset: 0, maxChars: 1000 },
		);
		if (!("text" in r)) throw new Error(JSON.stringify(r));
		expect(r.totalChars).toBeLessThanOrEqual(MAX_TEXT_CHARS);
		expect(r.note).toBe(CUT_NOTE);
	});
	it("PowerPoint", async () => {
		const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
		const files: Record<string, string> = { "[Content_Types].xml": CT };
		const ids: string[] = [];
		const rels: string[] = [];
		for (let i = 1; i <= 60; i++) {
			ids.push(`<p:sldId id="${255 + i}" r:id="rId${i}"/>`);
			rels.push(`<Relationship Id="rId${i}" Type="${R}/slide" Target="slides/slide${i}.xml"/>`);
			files[`ppt/slides/slide${i}.xml`] = `<?xml version="1.0"?><p:sld ${A}><p:cSld><p:spTree><p:sp><p:txBody>${Array.from({ length: 10 }, (_, k) => `<a:p><a:r><a:t>${text.slice(k * 10_000 + i * 1_000, k * 10_000 + i * 1_000 + 10_000)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
		}
		files["ppt/presentation.xml"] = `<?xml version="1.0"?><p:presentation ${A} xmlns:r="${R}"><p:sldIdLst>${ids.join("")}</p:sldIdLst></p:presentation>`;
		files["ppt/_rels/presentation.xml.rels"] = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
		const r = await extractText(zipOf(files), { name: "big.pptx", mime: null, offset: 0, maxChars: 1000 });
		if (!("text" in r)) throw new Error(JSON.stringify(r));
		expect(r.totalChars).toBeLessThanOrEqual(MAX_TEXT_CHARS);
		expect(r.note).toBe(CUT_NOTE);
	});
	it("OpenDocument", async () => {
		const T = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';
		const body = Array.from({ length: 6_000 }, (_, i) => `<text:p>${text.slice((i * 1000) % 999_000, ((i * 1000) % 999_000) + 1000)}</text:p>`).join("");
		const r = await extractText(zipOf({ mimetype: "application/vnd.oasis.opendocument.text", "content.xml": `<?xml version="1.0"?><office:document-content ${T}><office:body><office:text>${body}</office:text></office:body></office:document-content>` }), {
			name: "big.odt",
			mime: null,
			offset: 0,
			maxChars: 1000,
		});
		if (!("text" in r)) throw new Error(JSON.stringify(r));
		expect(r.totalChars).toBeLessThanOrEqual(MAX_TEXT_CHARS);
		expect(r.note).toBe(CUT_NOTE);
	});
});

describe("templates: memory and CPU stay bounded", () => {
	const docx = (body: string) => zipOf({ "[Content_Types].xml": CT, "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>` });

	it("30,000 distinct fields: at most 10,000 names are kept, and the rest is said", () => {
		const body = Array.from({ length: 30_000 }, (_, i) => `<w:p><w:r><w:t>{{f${i}}}</w:t></w:r></w:p>`).join("");
		const t = docx(body);
		expect(t.length).toBeLessThan(400_000);
		const r = listFields(t, "docx");
		expect(r.fields).toHaveLength(10_000);
		expect(r.more).toBe(true);
		expect(r.fields[0]).toEqual({ name: "f0", count: 1 });
		const f = fillTemplate(t, "docx", { f1: "one" }, "keep", false);
		expect(f.filled).toEqual(["f1"]);
		expect(f.missing).toHaveLength(10_000);
		expect(f.missingMore).toBe(true);
		checkPackage(f.bytes);
	});
	it("a paragraph of more than 10,000 text pieces, or of more than 1,000,000 characters, is refused", () => {
		expect(() => listFields(docx(`<w:p>${"<w:r><w:t>a</w:t></w:r>".repeat(10_001)}</w:p>`), "docx")).toThrow(/10,000 at most/);
		const long = noise(1_100_000, 7);
		expect(() => listFields(docx(`<w:p>${[0, 1, 2].map((k) => `<w:r><w:t>${long.slice(k * 400_000, (k + 1) * 400_000)}</w:t></w:r>`).join("")}</w:p>`), "docx")).toThrow(/1,000,000 characters at most/);
	});
	it("more than 20,000 replacements is refused; listing them is fine", () => {
		const t = docx("<w:p><w:r><w:t>{{a}}</w:t></w:r></w:p>".repeat(20_001));
		expect(listFields(t, "docx").fields).toEqual([{ name: "a", count: 20_001 }]);
		expect(() => fillTemplate(t, "docx", { a: "x" }, "fail", false)).toThrow(/20,000 at most/);
	});
	it("one paragraph with many pieces and many fields fills in linear time", () => {
		// 9,000 runs, each holding a field split across two runs: once quadratic in pieces times fields.
		const runs = Array.from({ length: 4_500 }, (_, i) => `<w:r><w:t>{{k</w:t></w:r><w:r><w:t>${i % 50}}} </w:t></w:r>`).join("");
		const t = docx(`<w:p>${runs}</w:p>`);
		const values = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, `v${i}`]));
		const started = Date.now();
		const r = fillTemplate(t, "docx", values, "fail", false);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(r.filled).toHaveLength(50);
		const doc = new TextDecoder().decode(unzipSync(r.bytes)["word/document.xml"]);
		// The value goes into the run where the field starts; the second run keeps only its trailing space.
		expect(doc).toContain('<w:t xml:space="preserve">v7</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t>');
		expect(doc).not.toContain("{{");
	});
	it("a part over 4 MB that could hold a field is refused; one that can't is copied as it is", () => {
		const filler = noise(4_600_000, 3);
		const bigBody = Array.from({ length: 11 }, (_, k) => `<w:p><w:r><w:t>${filler.slice(k * 400_000, (k + 1) * 400_000)}</w:t></w:r></w:p>`).join("");
		expect(() => listFields(docx(`${bigBody}<w:p><w:r><w:t>{</w:t></w:r></w:p>`), "docx")).toThrow(/more than 4 MB/);
		// An Excel template with a big data sheet (numbers only) and its field in the shared strings.
		const rows = Array.from({ length: 120_000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join("");
		const sheet = `<?xml version="1.0"?><worksheet xmlns="${X}"><sheetData>${rows}</sheetData></worksheet>`;
		expect(sheet.length).toBeGreaterThan(4 * 1024 * 1024);
		const xlsx = zipOf({
			"[Content_Types].xml": CT,
			"xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="${X}" xmlns:r="${R}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
			"xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
			"xl/sharedStrings.xml": `<?xml version="1.0"?><sst xmlns="${X}"><si><t>Hello {{name}}</t></si></sst>`,
			"xl/worksheets/sheet1.xml": sheet,
		});
		expect(listFields(xlsx, "xlsx").fields).toEqual([{ name: "name", count: 1 }]);
		const r = fillTemplate(xlsx, "xlsx", { name: "Ann" }, "fail", false);
		const before = ZipReader.open(xlsx);
		const after = ZipReader.open(r.bytes);
		const e1 = before.entry("xl/worksheets/sheet1.xml");
		const e2 = after.entry("xl/worksheets/sheet1.xml");
		if (!e1 || !e2) throw new Error("no sheet part");
		// Copied still packed: the same bytes, never unpacked and packed again.
		expect(after.packed(e2)).toEqual(before.packed(e1));
		expect(after.text("xl/sharedStrings.xml")).toContain("Hello Ann");
	});
	it("a filled file keeps every part, and parts without fields are copied still packed", () => {
		const tpl = fixture("word-python-docx.docx");
		const r = fillTemplate(tpl, "docx", { client: "A", item: "B", amount: "C", "due date": "D", company: "E" }, "fail", false);
		const before = ZipReader.open(tpl);
		const after = ZipReader.open(r.bytes);
		expect(after.names().sort()).toEqual(before.names().sort());
		for (const name of ["word/styles.xml", "[Content_Types].xml", "word/_rels/document.xml.rels"]) {
			const a = before.entry(name);
			const b = after.entry(name);
			if (!a || !b) throw new Error(`no ${name}`);
			expect(after.packed(b), name).toEqual(before.packed(a));
		}
		checkPackage(r.bytes);
	});
});

describe("fix round 2: a fill is sized before anything is built", () => {
	// The security review's inputs: once these ran a 128 MB isolate out of memory (or used +194 MB),
	// because the 12,000,000-character check came after every replacement had been built. Measured
	// again in Node 24 under a 64 MB and a 128 MB heap: refused with +20 MB and +4 MB (README).
	const docx = (body: string) => zipOf({ "[Content_Types].xml": CT, "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>` });
	const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
	// Stored, not deflated: a run format of 50,000 repeats would pack more than 100 times and be
	// refused by the zip guard first.
	const pptx = (txBody: string) =>
		zipSync(
			{
				"[Content_Types].xml": strToU8(CT),
				"ppt/presentation.xml": strToU8(`<?xml version="1.0"?><p:presentation ${A}/>`),
				"ppt/slides/slide1.xml": strToU8(`<?xml version="1.0"?><p:sld ${A}><p:cSld><p:spTree><p:sp><p:txBody>${txBody}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
			},
			{ level: 0 },
		);
	const tooBig = (f: () => unknown, re: RegExp) => {
		const started = Date.now();
		let err: unknown;
		try {
			f();
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ToolError);
		expect((err as ToolError).code).toBe("too_large");
		expect((err as ToolError).message).toMatch(re);
		return Date.now() - started;
	};

	it("20,000 paragraphs of {{a}} and a value of 10,000 '&' (50,000 characters escaped) stop at the part's 12,000,000", () => {
		const t = docx("<w:p><w:r><w:t>{{a}}</w:t></w:r></w:p>".repeat(20_000));
		expect(t.length).toBeLessThan(10_000);
		const ms = tooBig(() => fillTemplate(t, "docx", { a: "&".repeat(10_000) }, "fail", false), /over 12,000,000 characters/);
		expect(ms).toBeLessThan(10_000);
	});
	it("one paragraph of 20,000 {{a}} and a 10,000-character value stops at the paragraph's 2,000,000", () => {
		const t = docx(`<w:p><w:r><w:t>${"{{a}}".repeat(20_000)}</w:t></w:r></w:p>`);
		tooBig(() => fillTemplate(t, "docx", { a: "x".repeat(10_000) }, "fail", false), /2,000,000 characters at most/);
	});
	it("a PowerPoint run split (the run repeated for every line) is sized before it is built", () => {
		// A 1.2 MB run format and a value of 10,000 newlines would build about 12 GB of XML.
		const rPr = `<a:rPr lang="en-US">${'<a:latin typeface="x"/>'.repeat(50_000)}</a:rPr>`;
		const t = pptx(`<a:p><a:r>${rPr}<a:t>{{a}}</a:t></a:r></a:p>`);
		tooBig(() => fillTemplate(t, "pptx", { a: "\n".repeat(10_000) }, "fail", false), /2,000,000 characters at most/);
		// The same run with a two-line value is split as before, keeping its format on both lines.
		const ok = fillTemplate(pptx(`<a:p><a:r><a:rPr lang="en-US" b="1"/><a:t>{{a}}</a:t></a:r></a:p>`), "pptx", { a: "one\ntwo" }, "fail", false);
		const slide = new TextDecoder().decode(unzipSync(ok.bytes)["ppt/slides/slide1.xml"]);
		expect(slide).toContain('<a:r><a:rPr lang="en-US" b="1"/><a:t>one</a:t></a:r><a:br><a:rPr lang="en-US" b="1"/></a:br><a:r><a:rPr lang="en-US" b="1"/><a:t>two</a:t></a:r>');
	});
	it("within the limits a big fill still works: 1,000 paragraphs with a 10,000-character value", () => {
		const r = fillTemplate(docx("<w:p><w:r><w:t>{{a}}</w:t></w:r></w:p>".repeat(1_000)), "docx", { a: "y".repeat(10_000) }, "fail", false);
		expect(r.filled).toEqual(["a"]);
		const doc = checkPackage(r.bytes).get("word/document.xml") ?? "";
		expect(doc.length).toBeGreaterThan(10_000_000);
		expect(doc).not.toContain("{{a}}");
	});
	it("missing values count nothing toward the limits; keep leaves the placeholders as they are", () => {
		const t = docx("<w:p><w:r><w:t>{{a}} and {{b}}</w:t></w:r></w:p>".repeat(5_000));
		const r = fillTemplate(t, "docx", { a: "&" }, "keep", false);
		const doc = checkPackage(r.bytes).get("word/document.xml") ?? "";
		expect(doc.split("&amp; and {{b}}").length - 1).toBe(5_000);
		expect(r.missing).toEqual(["b"]);
	});
});
