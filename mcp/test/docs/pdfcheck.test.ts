/**
 * The PDF check before PDF.js runs in the Worker (fix round 1, security review: a 154 KB PDF whose
 * content stream inflated to 150 MB took PDF.js to +341 MB). Bombs are refused, big or uncountable
 * files go to the connector's conversion, ordinary PDFs stay in the Worker, and PDF.js's text comes
 * in batches so a page of tiny text pieces can't pile up.
 */
import { Deflate, zlibSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ToolError } from "../../src/core/errors";
import { extractText } from "../../src/docs/extract/index";
import { TextOut } from "../../src/docs/extract/out";
import { pdfText } from "../../src/docs/extract/pdf";
import { inflateCount, MAX_PDF_STREAMS, pdfPrecheck } from "../../src/docs/extract/pdfcheck";
import { fixture, textPdf } from "./helpers";

const enc = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

/** A one-page PDF whose content is `streams` (dictionary text and raw data each); text is Helvetica. */
function pdfWith(streams: { dict: string; data: Uint8Array }[], trailerExtra = ""): Uint8Array {
	const objs: (string | { dict: string; data: Uint8Array })[] = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents [${streams.map((_, i) => `${5 + i} 0 R`).join(" ")}] >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		...streams,
	];
	const parts: Uint8Array[] = [enc.encode("%PDF-1.4\n")];
	let off = parts[0]?.length ?? 0;
	const offsets: number[] = [];
	objs.forEach((o, i) => {
		offsets.push(off);
		const chunk =
			typeof o === "string"
				? enc.encode(`${i + 1} 0 obj\n${o}\nendobj\n`)
				: concat([enc.encode(`${i + 1} 0 obj\n<< ${o.dict} /Length ${o.data.length} >>\nstream\n`), o.data, enc.encode("\nendstream\nendobj\n")]);
		parts.push(chunk);
		off += chunk.length;
	});
	const xref = off;
	parts.push(enc.encode(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((x) => `${String(x).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`));
	return concat(parts);
}

/** zlib data of `mb` MB, streamed (never held unpacked): spaces after a text operator, or a repeated random block. */
function zlibOf(mb: number, kind: "spaces" | "block"): Uint8Array {
	const out: Uint8Array[] = [];
	const d = new Deflate({ level: 1 }, (c) => out.push(c));
	const block = new Uint8Array(1024 * 1024);
	if (kind === "spaces") block.fill(32);
	else {
		// Repeats of a 4 KB random block, broken by a random byte about every 64 bytes: packs some 10
		// to 20 times, like dense but ordinary data (well under the 200x of a bomb).
		let x = 9;
		const next = () => {
			x ^= x << 13;
			x ^= x >>> 17;
			x ^= x << 5;
			return x >>> 0;
		};
		for (let i = 0; i < block.length; i++) {
			const r = next();
			block[i] = i < 4096 || r % 64 === 0 ? (r >>> 8) & 0xff : (block[i - 4096] as number);
		}
	}
	const head = block.slice();
	head.set(enc.encode("BT /F1 12 Tf 72 720 Td (Hello) Tj ET\n"), 0);
	for (let i = 0; i < mb; i++) d.push(i === 0 ? head : block, i === mb - 1);
	const raw = concat(out);
	// zlib = 2-byte header + raw deflate (+ adler, which PDF.js doesn't need).
	return concat([new Uint8Array([0x78, 0x01]), raw]);
}

const small = (s: string) => zlibSync(enc.encode(s));

describe("pdfPrecheck", () => {
	it("ordinary PDFs stay in the Worker", () => {
		expect(pdfPrecheck(textPdf(["Hello", "World"]))).toBe("worker");
		expect(pdfPrecheck(fixture("onlyoffice-budget.pdf"))).toBe("worker");
		expect(pdfPrecheck(pdfWith([{ dict: "/Filter /FlateDecode", data: small("BT /F1 12 Tf 72 720 Td (Hi) Tj ET") }]))).toBe("worker");
		expect(pdfPrecheck(pdfWith([{ dict: "/Filter [/FlateDecode]", data: small("BT ET") }]))).toBe("worker");
	});
	it("a content stream that unpacks more than 200 times past 8 MB is a bomb, refused", () => {
		const bomb = pdfWith([{ dict: "/Filter /FlateDecode", data: zlibOf(20, "spaces") }]);
		expect(bomb.length).toBeLessThan(200_000);
		expect(() => pdfPrecheck(bomb)).toThrow(ToolError);
		expect(() => pdfPrecheck(bomb)).toThrow("This PDF unpacks to far more than its size (more than 200 times), so it isn't read here.");
	});
	it("a big ordinary stream (past 8 MB) or more than 64 MB in all goes to the conversion", () => {
		expect(pdfPrecheck(pdfWith([{ dict: "/Filter /FlateDecode", data: zlibOf(9, "block") }]))).toBe("server");
		const nine = Array.from({ length: 9 }, () => ({ dict: "/Filter /FlateDecode", data: zlibOf(8, "block") }));
		// Exactly 8 MB each (within the per-stream limit): 9 of them are 72 MB in all, 7 are 56 MB.
		expect(pdfPrecheck(pdfWith(nine))).toBe("server");
		expect(pdfPrecheck(pdfWith(nine.slice(0, 7)))).toBe("worker");
	});
	it("filters it can't count, encryption and indirect or chained filters go to the conversion", () => {
		const data = new Uint8Array([1, 2, 3, 4]);
		for (const dict of ["/Filter /LZWDecode", "/Filter /LZ#57Decode", "/Filter/RL", "/F /A85", "/Filter /AHx", "/Filter /BrotliDecode", "/Filter 9 0 R", "/F 9 0 R", "/Filter [/FlateDecode /FlateDecode]", "/Filter [ /Fl 9 0 R ]", "/Filter [/ASCII85Decode /FlateDecode]"]) {
			expect(pdfPrecheck(pdfWith([{ dict, data }])), dict).toBe("server");
		}
		expect(pdfPrecheck(textPdf(["secret"], { encrypted: true }))).toBe("server");
		expect(pdfPrecheck(pdfWith([{ dict: "", data }], "/Encr#79pt 9 0 R"))).toBe("server");
	});
	it("more than 20,000 compressed streams go to the conversion", () => {
		const one = small("x");
		const many = Array.from({ length: MAX_PDF_STREAMS + 1 }, () => ({ dict: "", data: one }));
		expect(pdfPrecheck(pdfWith(many))).toBe("server");
	});
	it("counting stops where the deflate data ends (pins fflate 0.8.3's end-of-stream state)", () => {
		const content = "BT /F1 12 Tf 72 720 Td (Hello) Tj ET";
		const z = small(content);
		const junk = new Uint8Array(2 * 1024 * 1024).fill(0x41);
		const r = inflateCount(concat([z, junk]), 0, 1_000_000);
		expect(r.out).toBe(content.length);
		expect(r.capped).toBe(false);
		// Read to the end of its 4 KB piece at most, never on through the 2 MB after it.
		expect(r.consumed).toBeLessThanOrEqual(z.length + 4096);
	});
});

describe("reading PDFs in the Worker", () => {
	it("the bomb is refused by files_read_text's reader, and uncountable files ask for the conversion", async () => {
		const bomb = pdfWith([{ dict: "/Filter /FlateDecode", data: zlibOf(20, "spaces") }]);
		await expect(extractText(bomb, { name: "b.pdf", mime: null, offset: 0, maxChars: 1000 })).rejects.toMatchObject({ code: "too_large" });
		expect(await extractText(pdfWith([{ dict: "/Filter /LZWDecode", data: new Uint8Array([1]) }]), { name: "l.pdf", mime: null, offset: 0, maxChars: 1000 })).toEqual({ needsServer: true, target: "txt" });
	});
	it("PDF.js's text comes in batches and stops once enough is collected", async () => {
		const pdf = textPdf(["a".repeat(80), "b".repeat(80), "c".repeat(80)]);
		const out = new TextOut(100);
		// Cut on page 2: the result says pages 1 to 2 of 3 were read.
		expect(await pdfText(pdf, out, null)).toEqual({ ok: true, pages: { from: 1, to: 2, total: 3 } });
		expect(out.cut).toBe(true);
		expect(out.text()).toContain("## Page 1");
		expect(out.text()).not.toContain("ccc");
	});
});
