/**
 * files_read_text (DESIGN 11.2 and 12.4). Text formats come back as they are; Word, Excel,
 * PowerPoint, OpenDocument and PDF files are turned into text in the Worker; legacy formats (doc,
 * xls, ppt, rtf and similar) and big Office or PDF files go through the connector's conversion
 * route. The text itself is framed as data in the text block; structuredContent holds the metadata
 * and, as `text`, the same framed block (core's outcomeToResult, fix round 3), so the text is inside
 * the data markers whichever part a client reads (10.4). Office and PDF formats count as heavy work
 * and are off when HEAVY_TOOLS is off.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import { normalizePath } from "../../core/paths";
import { pathArg } from "../../core/shapes";
import { defineTool, type ToolCtx } from "../../core/tool";
import { classify, type Classified, decodeText, NO_CONVERT } from "../../docs/extract/classify";
import { extractText, pageOf } from "../../docs/extract/index";
import { toolCanConvert } from "../../docs/formats";
import { DOC_LIMITS } from "../../docs/limits";
import { looksLikeHtmlOrMht } from "../../docs/sniff";
import { mustBeFile, sizeText } from "./shared";

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Bytes read from the start to decide whether a legacy source is really HTML or an MHT archive. */
const SNIFF_BYTES = 4096;

const output = z.object({
	path: z.string(),
	format: z.string(),
	etag: z.string().nullable(),
	total_chars: z.number().nullable(),
	offset: z.number(),
	returned_chars: z.number(),
	next_offset: z.number().nullable(),
	truncated: z.boolean(),
	sheets: z.array(z.string()).optional(),
	pages: z.object({ from: z.number(), to: z.number(), total: z.number() }).optional(),
	slides: z.number().optional(),
	note: z.string().optional(),
	// Filled in by core (outcomeToResult) from `text` below; never set here.
	text: z.string().optional().describe("The text, framed as data like the text block."),
});

/** Size limits per route: in the Worker, or through the connector's conversion. */
function route(c: Classified, size: number): "worker" | "server" | "too_large" {
	if (c.kind === "server") return size <= LIMITS.serverRouteBytes ? "server" : "too_large";
	if (c.kind === "pdf") return size <= LIMITS.pdfInWorkerBytes ? "worker" : size <= LIMITS.serverRouteBytes && c.serverTarget ? "server" : "too_large";
	if (c.heavy) return size <= LIMITS.officeInWorkerBytes ? "worker" : size <= LIMITS.serverRouteBytes && c.serverTarget ? "server" : "too_large";
	return "worker";
}

async function viaServer(ctx: ToolCtx, fileId: number | null, target: "txt" | "csv", path: string): Promise<string> {
	if (fileId === null) throw new ToolError("upstream_unavailable", "NoDrive didn't return a file id.");
	ctx.log.note(`read_server_${target}`);
	try {
		return decodeText(await ctx.nc.officeConvert(fileId, target, { maxBytes: LIMITS.serverRouteBytes }));
	} catch (e) {
		if (e instanceof ToolError && e.code === "unsupported_type") {
			throw new ToolError("unsupported_type", `The text of ${path} couldn't be read. The file may be damaged or protected with a password.`);
		}
		throw e;
	}
}

export const readText = defineTool({
	name: "files_read_text",
	title: "Read a file as text",
	description:
		"Reads a NoDrive file as text: txt, md, csv, json and similar as they are; Word, Excel, PowerPoint, OpenDocument and PDF files turned into text, with sheets as tables and numbered slides and pages. Long files come in parts; next_offset continues. Images and scanned PDFs have no text. Files up to 25 MB.",
	input: z
		.object({
			path: pathArg("The file to read."),
			offset: z.number().int().min(0).max(100_000_000).default(0).describe("Start, in characters (next_offset of the last call)."),
			max_chars: z.number().int().min(1_000).max(LIMITS.readCharsMax).default(LIMITS.readCharsDefault).describe("Characters to return."),
			sheet: z.string().max(100).optional().describe("Spreadsheets: one sheet, by name or number."),
			pages: z.string().max(20).optional().describe('PDFs: a page or range, e.g. "2-10".'),
		})
		.strict(),
	output,
	async run(ctx, args) {
		const path = normalizePath(args.path, { allowRoot: false });
		const info = await ctx.nc.files.stat(path);
		mustBeFile(info);
		const c = classify(info.name, info.mime);
		if (args.sheet !== undefined && !["xlsx", "ods"].includes(c.kind) && c.serverTarget !== "csv") {
			throw new ToolError("invalid_input", "sheet works only for spreadsheets.", { field: "sheet" });
		}
		if (args.pages !== undefined && c.kind !== "pdf") throw new ToolError("invalid_input", "pages works only for PDF files.", { field: "pages" });
		if (c.kind === "image") throw new ToolError("unsupported_type", "Images have no text to read.");
		if (c.kind === "binary") throw new ToolError("unsupported_type", "This kind of file (archives, audio, video, programs) has no text to read.");
		if (c.kind === "noconvert") throw new ToolError("unsupported_type", NO_CONVERT, { hint: "The NoDrive app or ONLYOFFICE can open it." });
		if (c.heavy) {
			if (!ctx.cfg.heavyTools) {
				throw new ToolError("not_available", "Reading Office and PDF files is switched off in Nourax Workspace right now.", { hint: "Plain text files can still be read." });
			}
			await ctx.charge("heavy", 1);
		}
		const how = route(c, info.size);
		if (how === "too_large") {
			const cap = c.kind === "pdf" || c.heavy ? "25 MB" : "10 MB";
			throw new ToolError("too_large", `${path} is ${sizeText(info.size)}. This kind of file can be read here up to ${cap}; the NoDrive app or ONLYOFFICE can open it.`);
		}

		let full: string;
		let format = c.format;
		let etag = info.etag;
		const extra: { sheets?: string[]; pages?: { from: number; to: number; total: number }; slides?: number } = {};
		const notes: string[] = [];
		// Whether some of the file's content isn't in `full` (DESIGN 10.4: truncated with a note). Set
		// explicitly where a limit cut it (fix round 2), never read back from a note's wording.
		let sourceCut = false;
		// Notes for text that came through the connector's conversion.
		const serverNotes = (target: "txt" | "csv") => {
			notes.push(target === "csv" ? "Read through a conversion to CSV, which may hold only the first sheet." : "Read through a conversion to plain text; some spacing may be lost.");
			// Seen live: ONLYOFFICE drops accented letters written as RTF escapes (caf\'e9 came back as "caf .").
			if (c.ext === "rtf") notes.push("Accented letters in RTF files may be lost in this conversion.");
			if (args.pages !== undefined) notes.push("Pages can't be picked when a file is read through a conversion; the whole text comes in parts.");
			if (args.sheet !== undefined) notes.push("A sheet can't be picked when a file is read through a conversion.");
		};
		if (how === "server") {
			// The connector decides a file's format from its content and fetches what HTML links to. A
			// legacy source (doc, xls, ppt, rtf) whose bytes are really HTML is refused before it is sent
			// (an SSRF from the converter's network). A real doc/xls/ppt (OLE) or rtf head isn't HTML, so
			// this passes. Only these legacy kinds are sniffed; a big zip-based file taking the server
			// route (over the in-Worker cap) starts with "PK", so the head sniff would add nothing, and
			// external references in such a file can't be scanned here (a documented residual, DESIGN 22).
			if (c.kind === "server") {
				const head = await ctx.nc.files.read(path, { range: [0, SNIFF_BYTES - 1], maxBytes: SNIFF_BYTES });
				if (looksLikeHtmlOrMht(head.bytes)) {
					throw new ToolError("unsupported_type", `The text of ${path} can't be read here: it looks like a web page (HTML).`, { hint: "The NoDrive app or ONLYOFFICE can open it." });
				}
			}
			const target = c.serverTarget ?? "txt";
			full = await viaServer(ctx, info.file_id, target, path);
			serverNotes(target);
		} else {
			const maxBytes = c.heavy ? (c.kind === "pdf" ? LIMITS.pdfInWorkerBytes : LIMITS.officeInWorkerBytes) : LIMITS.readTextSourceBytes;
			const got = await ctx.nc.files.read(path, { maxBytes });
			if (got.etag) etag = got.etag;
			if (got.truncated && c.heavy) throw new ToolError("conflict", `${path} changed while it was being read. Try again.`);
			const r = await extractText(got.bytes, { name: info.name, mime: info.mime, offset: args.offset, maxChars: args.max_chars, sheet: args.sheet, pages: args.pages });
			if ("unsupported" in r) throw new ToolError("unsupported_type", r.reason);
			if ("needsServer" in r) {
				// Only pairs from the connector's table that our tools send (formats.ts toolCanConvert).
				if (!toolCanConvert(c.ext, r.target)) throw new ToolError("unsupported_type", `The text of ${path} can't be read here. The NoDrive app or ONLYOFFICE can open it.`);
				if (info.size > LIMITS.serverRouteBytes) throw new ToolError("too_large", `${path} is ${sizeText(info.size)}, more than 25 MB.`);
				full = await viaServer(ctx, info.file_id, r.target, path);
				serverNotes(r.target);
			} else {
				full = r.text;
				format = r.format;
				if (r.sheets) {
					// Sheet names come from the file and sit outside the data frame (structuredContent),
					// so they are limited and cleaned; the text itself carries every "## Sheet:" heading.
					extra.sheets = r.sheets.slice(0, DOC_LIMITS.sheetNames).map((s) => s.replace(CONTROL, "").slice(0, DOC_LIMITS.sheetNameChars));
					if (r.sheets.length > DOC_LIMITS.sheetNames) notes.push(`This file has ${r.sheets.length.toLocaleString("en-GB")} sheets; sheets lists the first ${DOC_LIMITS.sheetNames}.`);
				}
				if (r.pages) extra.pages = r.pages;
				if (r.slides !== undefined) extra.slides = r.slides;
				if (r.note) notes.push(r.note);
				if (r.cut) sourceCut = true;
			}
			if (got.truncated) {
				notes.push(`Only the first ${sizeText(maxBytes)} of this ${sizeText(got.size ?? info.size)} file was read.`);
				sourceCut = true;
			}
		}

		const page = pageOf(full, args.offset, args.max_chars);
		const total = full.length;
		const next = page.next;
		const data = {
			path,
			format,
			etag,
			total_chars: total,
			offset: args.offset,
			returned_chars: page.text.length,
			next_offset: next,
			truncated: next !== null || sourceCut,
			...extra,
			...(notes.length ? { note: notes.join(" ") } : {}),
		};
		const range = total === 0 ? "no text" : `characters ${args.offset.toLocaleString("en-GB")} to ${(args.offset + page.text.length).toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")}`;
		const more = next !== null ? ` next_offset ${next} continues.` : "";
		return {
			data,
			summary: `Read ${range} from ${path} (${format}).${more}`,
			text: page.text,
		};
	},
});
