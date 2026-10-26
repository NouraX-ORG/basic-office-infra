/**
 * Text extraction for files_read_text (DESIGN 12.4). Core fixed the signature; lane C implements
 * it. Text formats come back as they are; Word, Excel, PowerPoint, OpenDocument and PDF files are
 * turned into Markdown-like text in the Worker. Legacy formats answer { needsServer } and the tool
 * asks the connector to convert them. Nothing is cached: content is never stored at rest.
 *
 * extractText returns the whole text (with totalChars); the caller pages it with pageOf, using the
 * offset and maxChars it was given.
 */
import { ToolError } from "../../core/errors";
import { looksLikeZip, ZipReader } from "../zip";
import { classify, decodeTextNote, LEGACY_NOTE, looksLikeText, NO_CONVERT } from "./classify";
import { docxText } from "./docx";
import { odfText } from "./odf";
import { runReader, TextOut } from "./out";
import { parsePages, pdfText } from "./pdf";
import { pdfPrecheck } from "./pdfcheck";
import { pptxText } from "./pptx";
import { xlsxText } from "./xlsx";

export interface ExtractOptions {
	name: string;
	mime: string | null;
	offset: number;
	maxChars: number;
	sheet?: string;
	pages?: string;
}

export type ExtractResult =
	| {
			text: string;
			format: string;
			totalChars: number;
			sheets?: string[];
			pages?: { from: number; to: number; total: number };
			slides?: number;
			/** A plain note for the person, for example that the text was cut. */
			note?: string;
			/**
			 * True when some of the file's content isn't in `text` (fix round 2): the text cap, PDF pages
			 * past 300, sheet rows past 5,000, cells past column 1,000, or a monstrous paragraph or cell
			 * cut short. files_read_text sets truncated from it, never from the wording of a note.
			 */
			cut: boolean;
	  }
	| { unsupported: true; reason: string }
	| { needsServer: true; target: "txt" | "csv" };

/**
 * The part [offset, offset + maxChars) of `full`, never splitting a surrogate pair. Throws
 * invalid_input when offset is past the end.
 */
export function pageOf(full: string, offset: number, maxChars: number): { text: string; next: number | null } {
	if (offset > full.length) {
		throw new ToolError("invalid_input", `offset ${offset} is past the end (the text has ${full.length.toLocaleString("en-GB")} characters).`, { field: "offset" });
	}
	let start = offset;
	const s = full.charCodeAt(start);
	if (start > 0 && s >= 0xdc00 && s <= 0xdfff) start--;
	let end = Math.min(full.length, start + maxChars);
	if (end < full.length && end > start) {
		const c = full.charCodeAt(end - 1);
		if (c >= 0xd800 && c <= 0xdbff) end--;
	}
	return { text: full.slice(start, end), next: end < full.length ? end : null };
}

const CUT_NOTE = "The file has more text than can be read here (5,000,000 characters); the end is missing.";
/** A reader limit left something out (fix round 2: truncated is set, and the note says why). */
const LEFT_NOTE = "Some of this file's content was left out because it is too big to read here: for example rows past 5,000 or columns past 1,000 in a sheet, or the end of an extremely long paragraph or cell.";

/** The old binary Office formats (doc, xls, ppt) start with this compound-file signature. */
function isCompoundFile(b: Uint8Array): boolean {
	const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
	return b.length >= 8 && sig.every((x, i) => b[i] === x);
}

async function inWorker(bytes: Uint8Array, opts: ExtractOptions, kind: string, format: string, ext: string): Promise<ExtractResult> {
	const out = new TextOut();
	if (kind === "pdf") {
		const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
		if (!head.includes("%PDF-")) return { unsupported: true, reason: "This file isn't a readable PDF." };
		// Count what the file unpacks to before PDF.js does (a bomb is refused here).
		if (pdfPrecheck(bytes) === "server") return { needsServer: true, target: "txt" };
		const range = parsePages(opts.pages);
		// pdfText handles the text cap itself and says which pages were read.
		const r = await pdfText(bytes, out, range);
		if (!r.ok) return { needsServer: true, target: "txt" };
		const full = out.text();
		const notes = [r.note, out.cut ? CUT_NOTE : undefined].filter(Boolean).join(" ");
		return { text: full, format, totalChars: full.length, pages: r.pages, cut: out.cut || out.left, ...(notes ? { note: notes } : {}) };
	}
	if (!looksLikeZip(bytes)) {
		// Some "Office" files are really the old binary formats under a new name: the connector reads those.
		if (isCompoundFile(bytes)) return { needsServer: true, target: kind === "xlsx" || kind === "ods" ? "csv" : "txt" };
		// Plain text under an Office name is read as the text it is, and said so.
		if (looksLikeText(bytes)) {
			const t = decodeTextNote(bytes);
			const note = `This file is named .${ext} but holds plain text, so it was read as text.${t.legacy ? ` ${LEGACY_NOTE}` : ""}`;
			return { text: t.text, format: "text", totalChars: t.text.length, note, cut: false };
		}
		return { unsupported: true, reason: "This file's contents couldn't be read; it may be damaged or not really an Office file." };
	}
	const zip = ZipReader.open(bytes);
	let sheets: string[] | undefined;
	let slides: number | undefined;
	runReader(() => {
		switch (kind) {
			case "docx":
				docxText(zip, out);
				break;
			case "xlsx":
				sheets = xlsxText(zip, out, { sheet: opts.sheet }).sheets;
				break;
			case "pptx":
				slides = pptxText(zip, out).slides;
				break;
			case "odt":
			case "ods":
			case "odp": {
				const r = odfText(zip, out, kind, { sheet: opts.sheet });
				sheets = r.sheets;
				slides = r.slides;
				break;
			}
		}
	});
	const full = out.text();
	const notes = [out.cut ? CUT_NOTE : undefined, out.left ? LEFT_NOTE : undefined].filter(Boolean).join(" ");
	return {
		text: full,
		format,
		totalChars: full.length,
		...(sheets ? { sheets } : {}),
		...(slides !== undefined ? { slides } : {}),
		...(notes ? { note: notes } : {}),
		cut: out.cut || out.left,
	};
}

/** Extracts the whole text of a file (paging is the caller's, with pageOf). */
export async function extractText(bytes: Uint8Array, opts: ExtractOptions): Promise<ExtractResult> {
	const c = classify(opts.name, opts.mime);
	switch (c.kind) {
		case "text": {
			const t = decodeTextNote(bytes);
			return { text: t.text, format: c.format, totalChars: t.text.length, cut: false, ...(t.legacy ? { note: LEGACY_NOTE } : {}) };
		}
		case "docx":
		case "xlsx":
		case "pptx":
		case "odt":
		case "ods":
		case "odp":
		case "pdf":
			return inWorker(bytes, opts, c.kind, c.format, c.ext);
		case "server":
			return { needsServer: true, target: c.serverTarget ?? "txt" };
		case "noconvert":
			return { unsupported: true, reason: NO_CONVERT };
		case "image":
			return { unsupported: true, reason: "Images have no text to read." };
		case "binary":
			return { unsupported: true, reason: "This kind of file (archives, audio, video, programs) has no text to read." };
		default: {
			if (looksLikeText(bytes)) {
				const t = decodeTextNote(bytes);
				return { text: t.text, format: "text", totalChars: t.text.length, cut: false, ...(t.legacy ? { note: LEGACY_NOTE } : {}) };
			}
			return { unsupported: true, reason: "This file doesn't look like text, and its format isn't one this connector reads." };
		}
	}
}

export { classify } from "./classify";
