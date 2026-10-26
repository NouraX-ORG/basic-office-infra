/**
 * A look at a PDF before PDF.js reads it in the Worker (fix round 1, security review: a 154 KB PDF
 * whose content stream inflated to 150 MB took PDF.js to +341 MB, past the 128 MB isolate limit).
 *
 * PDF.js inflates a FlateDecode stream only when the stream's data starts with a zlib header, and
 * a stream's data always starts on the line after a "stream" keyword in the file. So every place
 * where "stream" is followed by zlib data is inflated here with counters (and nothing is kept):
 * - a stream cut at 8 MB unpacked (or all of them at 64 MB) after unpacking more than 200 times
 *   its packed size is a bomb, and the file is refused;
 * - a stream past 8 MB otherwise, more than 64 MB in all, or more than 20,000 such streams send
 *   the file to the connector's conversion instead ("server"). PDF.js also gets its text in
 *   batches (pdf.ts), so these sizes bound what a page costs (DOC_LIMITS has the measurements).
 * This holds however the file is laid out (cross-reference tables, object streams, damaged files),
 * because it doesn't depend on parsing the PDF's structure.
 *
 * Filters this can't count also send the file to the conversion: LZW, RunLength, ASCII85,
 * ASCIIHex, Brotli and encryption (/Encrypt, /Crypt), found as names anywhere in the file (with
 * #xx escapes decoded), and a /Filter (or /F) given as an indirect object, which could name any of
 * them from inside a compressed object stream. A false alarm only costs a conversion.
 *
 * Not covered: a content stream that names an image filter (DCT, JPX, JBIG2, CCITT). PDF.js decodes
 * those only when a crafted file uses them for page text, and telling the two uses apart needs a
 * full parse. The full fix is to run PDF.js in an isolate of its own; see src/docs/README.md.
 */
import { Inflate } from "fflate";
import { ToolError } from "../../core/errors";
import { DOC_LIMITS } from "../limits";

export type PdfVerdict = "worker" | "server";

/** Streams inflated by the check at most; past this the file goes to the conversion. */
export const MAX_PDF_STREAMS = 20_000;

/** Filter (and encryption) names the check can't count. Abbreviations are PDF.js's own. */
const UNCOUNTABLE = new Set(["LZWDecode", "LZW", "RunLengthDecode", "RL", "ASCII85Decode", "A85", "ASCIIHexDecode", "AHx", "BrotliDecode", "Crypt", "Encrypt"]);

const WHITE = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WHITE[c] = 1;
const DELIM = new Uint8Array(256);
for (const ch of "()<>[]{}/%") DELIM[ch.charCodeAt(0)] = 1;

function regular(c: number | undefined): boolean {
	return c !== undefined && !WHITE[c] && !DELIM[c];
}

function hex(c: number): number {
	if (c >= 48 && c <= 57) return c - 48;
	if (c >= 65 && c <= 70) return c - 55;
	if (c >= 97 && c <= 102) return c - 87;
	return -1;
}

/** Reads a name after "/" (with #xx escapes decoded); keeps its first 64 characters. */
function readName(b: Uint8Array, i: number): { name: string; end: number } {
	let name = "";
	while (i < b.length && regular(b[i])) {
		let c = b[i] as number;
		if (c === 0x23 && i + 2 < b.length) {
			const h = hex(b[i + 1] as number);
			const l = hex(b[i + 2] as number);
			if (h >= 0 && l >= 0) {
				c = h * 16 + l;
				i += 2;
			}
		}
		if (name.length < 64) name += String.fromCharCode(c);
		i++;
	}
	return { name, end: i };
}

/** Skips white space and comments. */
function skipSpace(b: Uint8Array, i: number): number {
	while (i < b.length) {
		const c = b[i] as number;
		if (WHITE[c]) i++;
		else if (c === 0x25) {
			while (i < b.length && b[i] !== 10 && b[i] !== 13) i++;
		} else break;
	}
	return i;
}

/** "12 0 R" at i: an indirect reference. */
function isRef(b: Uint8Array, i: number): boolean {
	const digits = (p: number): number => {
		const s = p;
		while (p < b.length && (b[p] as number) >= 48 && (b[p] as number) <= 57) p++;
		return p > s ? p : -1;
	};
	let p = digits(i);
	if (p < 0) return false;
	p = skipSpace(b, p);
	p = digits(p);
	if (p < 0) return false;
	p = skipSpace(b, p);
	return b[p] === 0x52 && !regular(b[p + 1]);
}

/**
 * Whether the value at i (after a /Filter or /F key) is one this check can't follow: an indirect
 * reference, or an array of two or more filters (a chain such as [/FlateDecode /FlateDecode] would
 * inflate a second time, out of sight of the count).
 */
function riskyFilterValue(b: Uint8Array, i: number): boolean {
	let p = skipSpace(b, i);
	if (b[p] !== 0x5b) return isRef(b, p);
	const stop = Math.min(b.length, p + 4096);
	let elements = 0;
	p++;
	while (p < stop) {
		p = skipSpace(b, p);
		if (p >= stop || b[p] === 0x5d) return false;
		if (isRef(b, p)) return true;
		elements++;
		if (elements > 1) return true;
		p++;
		while (p < stop && regular(b[p])) p++;
	}
	return true;
}

/** Where a stream's data starts: after the end of the line that holds "stream" (as PDF.js reads it). */
function dataStart(b: Uint8Array, i: number): number {
	while (i < b.length) {
		const c = b[i];
		if (c === 13) return b[i + 1] === 10 ? i + 2 : i + 1;
		if (c === 10) return i + 1;
		i++;
	}
	return -1;
}

/** A zlib header PDF.js's FlateStream accepts: deflate, a valid check value, no preset dictionary. */
function zlibHeader(b: Uint8Array, i: number): boolean {
	const cmf = b[i];
	const flg = b[i + 1];
	if (cmf === undefined || flg === undefined) return false;
	return (cmf & 0x0f) === 8 && ((cmf << 8) + flg) % 31 === 0 && (flg & 0x20) === 0;
}

const STOP = new Error("stop");

/**
 * Inflates the deflate data at `start` (after the 2-byte zlib header) just to count it, in 4 KB
 * pieces, until the deflate stream ends, the data is damaged, or more than `cap` bytes came out.
 * fflate 0.8.3 marks the end of a stream in its state (`s.f` set, `s.l` empty); past that it would
 * only pile up whatever is pushed, so pushing stops there (test/docs/pdfcheck.test.ts pins this).
 */
export function inflateCount(b: Uint8Array, start: number, cap: number): { out: number; consumed: number; capped: boolean } {
	let out = 0;
	let capped = false;
	const inf = new Inflate((chunk) => {
		out += chunk.length;
		if (out > cap) {
			capped = true;
			throw STOP;
		}
	});
	const state = (inf as unknown as { s: { f?: number; l?: unknown } }).s;
	let pos = start + 2;
	const step = DOC_LIMITS.inflatePushBytes;
	try {
		while (pos < b.length) {
			const end = Math.min(b.length, pos + step);
			const piece = b.subarray(pos, end);
			// Counted before the push: a push stopped part-way (over the cap) still used its piece.
			pos = end;
			inf.push(piece, end >= b.length);
			if (state.f && !state.l) break;
		}
	} catch (e) {
		// STOP: over the cap. Anything else: damaged data, which PDF.js can't inflate further either.
		if (e !== STOP && !(e instanceof Error)) throw e;
	}
	return { out, consumed: Math.max(1, pos - start), capped };
}

function bomb(): ToolError {
	return new ToolError("too_large", "This PDF unpacks to far more than its size (more than 200 times), so it isn't read here.");
}

/** Decides whether PDF.js may read this PDF in the Worker. Throws too_large for a bomb. */
export function pdfPrecheck(b: Uint8Array): PdfVerdict {
	let total = 0;
	let consumed = 0;
	let streams = 0;
	const n = b.length;
	for (let i = 0; i < n; i++) {
		const c = b[i];
		if (c === 0x2f) {
			const { name, end } = readName(b, i + 1);
			if (UNCOUNTABLE.has(name)) return "server";
			if ((name === "Filter" || name === "F") && riskyFilterValue(b, end)) return "server";
			i = end - 1;
			continue;
		}
		// "stream" as a keyword: no letter or digit right before or after it (so "endstream" is skipped),
		// as PDF.js's own lexer reads it. Any such place counts, whatever the file's structure says.
		if (c === 0x73 && b[i + 1] === 0x74 && b[i + 2] === 0x72 && b[i + 3] === 0x65 && b[i + 4] === 0x61 && b[i + 5] === 0x6d && !regular(b[i + 6]) && !regular(b[i - 1])) {
			const start = dataStart(b, i + 6);
			if (start < 0) break;
			if (zlibHeader(b, start)) {
				streams++;
				if (streams > MAX_PDF_STREAMS) return "server";
				const cap = Math.min(DOC_LIMITS.pdfStreamBytes, DOC_LIMITS.pdfTotalBytes - total);
				const r = inflateCount(b, start, cap);
				total += r.out;
				consumed += r.consumed;
				if (r.capped) {
					// One stream cut at its own limit, or all of them together, unpacking far beyond their
					// packed size: a bomb, refused (the converter would have to unpack it too). Otherwise
					// just too big to read here. (A stream cut short by the total limit has unpacked too
					// little for its own ratio to mean anything.)
					const ownLimit = cap === DOC_LIMITS.pdfStreamBytes;
					if ((ownLimit && r.out / r.consumed > DOC_LIMITS.pdfBombRatio) || total / consumed > DOC_LIMITS.pdfBombRatio) throw bomb();
					return "server";
				}
			}
			i += 5;
		}
	}
	return "worker";
}
