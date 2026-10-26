/**
 * PDF text in the Worker with unpdf 1.8.1 (PDF.js, serverless build), imported on first use so the
 * Worker starts fast (DESIGN 12.4 and 12.6). At most 300 pages per call; `pages` picks a range.
 * Encrypted PDFs are refused plainly, and a PDF with no text layer is reported as scanned. Any other
 * failure asks for the server route (the connector converts to txt). pdfcheck.ts looks at the file
 * first, so PDF.js only gets files whose compressed streams were counted.
 */
import { ToolError } from "../../core/errors";
import { StopRead, type TextOut } from "./out";

export const MAX_PDF_PAGES = 300;

export interface PageRange {
	from: number;
	to: number;
}

/** Parses "3" or "2-10" (1-based, inclusive). */
export function parsePages(raw: string | undefined): PageRange | null {
	if (raw === undefined) return null;
	const m = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5})\s*)?$/.exec(raw);
	if (!m) throw new ToolError("invalid_input", 'pages must look like "3" or "2-10".', { field: "pages" });
	const from = Number(m[1]);
	const to = m[2] !== undefined ? Number(m[2]) : from;
	if (from < 1 || to < from) throw new ToolError("invalid_input", "pages must start at 1 or more, and the end can't come before the start.", { field: "pages" });
	return { from, to };
}

type TextItems = { items: ({ str?: string; hasEOL?: boolean } | object)[] };
type PdfJsPage = { streamTextContent(): ReadableStream<TextItems>; cleanup(): void };
type PdfJsDoc = { numPages: number; getPage(n: number): Promise<PdfJsPage>; destroy?(): Promise<void>; loadingTask?: { destroy(): Promise<void> } };

/** Collapses runs of spaces, trims each line and keeps at most one blank line in a row. */
function tidy(s: string): string {
	return s
		.replace(/[^\S\n]+/g, " ")
		.split("\n")
		.map((l) => l.trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * One page's text, taken from PDF.js in batches (streamTextContent) and never held as PDF.js's own
 * item list: getTextContent keeps every item of a page, and a page of many tiny text pieces then
 * costs hundreds of MB (measured: 16 MB of text operators, +327 MB; streamed, +76 MB). Reading
 * stops, and PDF.js is told to stop, once more than `room` characters are collected.
 */
async function pageText(page: PdfJsPage, room: number): Promise<string> {
	const reader = page.streamTextContent().getReader();
	let s = "";
	let full = false;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			for (const it of value.items) {
				const x = it as { str?: string; hasEOL?: boolean };
				if (typeof x.str === "string") s += x.str;
				if (x.hasEOL) s += "\n";
			}
			if (s.length > room) {
				full = true;
				break;
			}
		}
	} finally {
		// PDF.js refuses a cancel without a reason.
		if (full) await reader.cancel(new Error("enough text")).catch(() => undefined);
	}
	return tidy(s);
}

export type PdfOutcome = { ok: true; pages: { from: number; to: number; total: number }; note?: string } | { ok: false; needsServer: true };

export async function pdfText(bytes: Uint8Array, out: TextOut, range: PageRange | null): Promise<PdfOutcome> {
	let doc: PdfJsDoc;
	try {
		const { getDocumentProxy } = await import("unpdf");
		// A copy: PDF.js may transfer (detach) the buffer it is given.
		// verbosity 0: PDF.js warnings (which can quote font names or text) stay out of the logs.
		doc = (await getDocumentProxy(new Uint8Array(bytes), { useSystemFonts: false, disableFontFace: true, isOffscreenCanvasSupported: false, stopAtErrors: false, verbosity: 0 })) as unknown as PdfJsDoc;
	} catch (e) {
		const name = e instanceof Error ? e.name : "";
		if (name === "PasswordException" || (e instanceof Error && /password/i.test(e.message))) {
			throw new ToolError("unsupported_type", "This PDF is protected with a password, so its text can't be read.");
		}
		if (name === "InvalidPDFException") throw new ToolError("unsupported_type", "This file isn't a readable PDF.");
		return { ok: false, needsServer: true };
	}
	try {
		const total = doc.numPages;
		let from = range?.from ?? 1;
		let to = range?.to ?? total;
		if (from > total) throw new ToolError("invalid_input", `This PDF has ${total} page${total === 1 ? "" : "s"}; pages starts after the end.`, { field: "pages" });
		to = Math.min(to, total);
		let note: string | undefined;
		if (to - from + 1 > MAX_PDF_PAGES) {
			to = from + MAX_PDF_PAGES - 1;
			note = `Only pages ${from} to ${to} were read (${MAX_PDF_PAGES} at most per call); pages "${to + 1}-${Math.min(total, to + MAX_PDF_PAGES)}" continues.`;
			// Pages asked for (or, without pages, the rest of the file) were never read.
			out.leftOut();
		}
		from = Math.max(1, from);
		let anyText = false;
		for (let n = from; n <= to; n++) {
			const page = await doc.getPage(n);
			const text = await pageText(page, out.room() + 1);
			page.cleanup();
			if (text) anyText = true;
			try {
				out.block(`## Page ${n}`);
				if (text) out.block(text);
			} catch (e) {
				// The text cap was reached on this page: the pages say how far reading got.
				if (!(e instanceof StopRead)) throw e;
				return { ok: true, pages: { from, to: n, total }, ...(note ? { note } : {}) };
			}
		}
		if (!anyText) {
			throw new ToolError("unsupported_type", "This PDF seems to be scanned; it has no text to read.");
		}
		return { ok: true, pages: { from, to, total }, ...(note ? { note } : {}) };
	} finally {
		// unpdf's build destroys a document through its loading task.
		await (doc.loadingTask?.destroy() ?? doc.destroy?.())?.catch(() => undefined);
	}
}
