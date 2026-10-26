/**
 * docs_convert (DESIGN 11.4 and 12.5): a converted copy through the ONLYOFFICE connector's own
 * downloadas route, as the person. The file id always comes from our own PROPFIND of the person's
 * path, never from the client. Allowed pairs are the connector's conversion table (formats.ts).
 * The answer is checked by core (status, content type, magic bytes); a failure is plain words.
 *
 * Fix round 2:
 * - Markdown never goes to the converter (it imports Markdown as HTML, whose reader downloads
 *   linked images: formats.ts). A .md file becomes a .docx in the Worker, with our own writer, and
 *   that .docx can then be converted like any other.
 * - The folder of output_path is checked before the conversion is spent.
 * - A workbook made into a PDF or CSV keeps only its first sheet (seen live); the result says so,
 *   with the number of sheets left out when the file can be counted here.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import { basenameOf, joinPath, normalizePath, parentOf, splitExt, type UserPath } from "../../core/paths";
import { pathArg } from "../../core/shapes";
import { defineTool, type ToolCtx } from "../../core/tool";
import { decodeTextNote } from "../../docs/extract/classify";
import { odsSheetCount } from "../../docs/extract/odf";
import { sheetNames } from "../../docs/extract/xlsx";
import { toolCanConvert } from "../../docs/formats";
import { parseMarkdown } from "../../docs/markdown";
import { buildDocx, DOCX_MIME } from "../../docs/ooxml/docx";
import { hasExternalMediaRefs, looksLikeHtmlOrMht } from "../../docs/sniff";
import { looksLikeZip, ZipReader, zipTailLooksSound } from "../../docs/zip";
import { guardExposure } from "../files/exposure";
import { extOf, folderMustExist, mustBeFile, renamedNote, sizeText, targetPath, writeNewFile } from "./shared";

/** Sources that are zip packages (Office Open XML and OpenDocument). */
const ZIP_SOURCES = new Set("docx docm dotx dotm xlsx xlsm xltx xltm pptx pptm potx potm ppsx ppsm odt ott ods ots odp otp".split(" "));

/** Spreadsheets whose sheets can be counted here (zip packages), and all spreadsheets with more than one possible sheet. */
const COUNTABLE_SHEETS = new Set("xlsx xlsm xltx xltm ods ots".split(" "));
const WORKBOOKS = new Set("xlsx xlsm xltx xltm xls xlsb xlt ods ots".split(" "));

/** The end-of-directory record sits in the last 64 KB + 22 bytes of a zip. */
const ZIP_TAIL = 65_535 + 22;

/** Bytes read from the start to decide whether a text-based source is really HTML or an MHT archive. */
const SNIFF_BYTES = 4096;

/** The start of an old binary Office file (doc, xls, ppt). */
const COMPOUND = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Throws already_exists when `path` is taken. */
async function mustBeFree(ctx: ToolCtx, path: UserPath): Promise<void> {
	try {
		await ctx.nc.files.stat(path);
	} catch (e) {
		if (e instanceof ToolError && e.code === "not_found") return;
		throw e;
	}
	throw new ToolError("already_exists", `${path} already exists.`, { hint: 'Use if_exists "rename", or another output_path.' });
}

/**
 * Whether a zip-based source looks sound, from its last bytes: an end-of-directory record and a
 * directory inside the file. An old binary Office file under a new name also passes (the converter
 * reads those). One ranged read; two when the tail doesn't look like a zip. With the whole file
 * already read (`whole`), no request at all.
 */
async function soundOfficeFile(ctx: ToolCtx, path: UserPath, size: number, whole: Uint8Array | null): Promise<boolean> {
	if (size < 22) return false;
	if (whole) return zipTailLooksSound(whole, whole.length) || COMPOUND.every((x, i) => whole[i] === x);
	const n = Math.min(size, ZIP_TAIL);
	const tail = await ctx.nc.files.read(path, { range: [size - n, size - 1], maxBytes: n });
	if (zipTailLooksSound(tail.bytes, size)) return true;
	const head = await ctx.nc.files.read(path, { range: [0, 7], maxBytes: 8 });
	return COMPOUND.every((x, i) => head.bytes[i] === x);
}

/** The number of sheets of a workbook read whole, or null when it can't be counted here. */
function countSheets(bytes: Uint8Array, ext: string): number | null {
	if (!looksLikeZip(bytes)) return null;
	try {
		const zip = ZipReader.open(bytes);
		return ext === "ods" || ext === "ots" ? odsSheetCount(zip) : sheetNames(zip).length;
	} catch {
		// Damaged or too big to count here: the converter decides, and the warning stays general.
		return null;
	}
}

/** The warning for a workbook made into a PDF or CSV, which keeps only its first sheet. */
export function firstSheetWarning(sheets: number | null, to: "pdf" | "csv"): string | null {
	const kind = to === "pdf" ? "PDF" : "CSV";
	if (sheets === null) return `When a workbook becomes a ${kind} file here, only its first sheet is converted; any other sheets aren't in the copy. The ONLYOFFICE editor can export every sheet.`;
	if (sheets <= 1) return null;
	const others = sheets - 1;
	return `Only the first sheet was converted: this workbook has ${sheets.toLocaleString("en-GB")} sheets, so ${others.toLocaleString("en-GB")} ${others === 1 ? "isn't" : "aren't"} in the ${kind} file. The ONLYOFFICE editor can export every sheet.`;
}

export const CONVERT_TARGETS = ["pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp", "txt", "csv"] as const;
export type ConvertTarget = (typeof CONVERT_TARGETS)[number];

export const MIME_OF: Record<ConvertTarget, string> = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	odt: "application/vnd.oasis.opendocument.text",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	odp: "application/vnd.oasis.opendocument.presentation",
	txt: "text/plain",
	csv: "text/csv",
};

/** Bytes a Markdown file of the 400,000-character limit can take (4 bytes a character, and a BOM). */
const MARKDOWN_BYTES = LIMITS.markdownChars * 4 + 3;

/** A .md file made into a .docx in the Worker (our own writer: no images, https: and mailto: links only). */
async function markdownToDocx(ctx: ToolCtx, src: UserPath, out: UserPath, size: number, ifExists: "fail" | "rename") {
	if (size > MARKDOWN_BYTES) throw new ToolError("too_large", `${src} is ${sizeText(size)}. Markdown files up to 400,000 characters can be made into a .docx here.`);
	const got = await ctx.nc.files.read(src, { maxBytes: MARKDOWN_BYTES });
	if (got.truncated) throw new ToolError("too_large", `${src} is too long. Markdown files up to 400,000 characters can be made into a .docx here.`);
	const text = decodeTextNote(got.bytes).text;
	if (text.length > LIMITS.markdownChars) {
		throw new ToolError("too_large", `${src} has ${text.length.toLocaleString("en-GB")} characters. Markdown files up to 400,000 characters can be made into a .docx here.`);
	}
	const bytes = buildDocx(parseMarkdown(text), { title: null, creator: ctx.displayName, pageSize: "A4" });
	return { bytes, w: await writeNewFile(ctx, out, bytes, DOCX_MIME, ifExists, "output_path") };
}

export const convert = defineTool({
	name: "docs_convert",
	title: "Convert to PDF or another format",
	description:
		"Saves a converted copy of a NoDrive document, most often as PDF, beside the original or at output_path. Word, Excel, PowerPoint, OpenDocument and text files can become PDF; Office and OpenDocument formats convert into each other; Markdown becomes .docx. A workbook made into PDF or CSV keeps only its first sheet. The original is unchanged; an existing file is never replaced. Up to 25 MB.",
	input: z
		.object({
			path: pathArg("The document to convert."),
			to: z.enum(CONVERT_TARGETS).default("pdf").describe("The new format."),
			output_path: pathArg('Where to save the copy, ending in ".<to>" (default: beside the original).').optional(),
			if_exists: z.enum(["rename", "fail"]).default("rename").describe('If the name is taken: "rename" adds a number, "fail" stops.'),
		})
		.strict(),
	async run(ctx, args) {
		const src = normalizePath(args.path, { allowRoot: false });
		const to = args.to as ConvertTarget;
		const fromExt = extOf(src);
		if (fromExt === to) throw new ToolError("invalid_input", `${src} is already a .${to} file.`, { field: "to" });
		const markdown = fromExt === "md" || fromExt === "markdown";
		if (markdown && to !== "docx") {
			throw new ToolError("unsupported_type", `A .${fromExt} file can become a .docx here (to "docx"), and that .docx can then be converted to .${to}.`, { field: "to" });
		}
		// Only the sources our tools send (formats.ts TOOL_SOURCES: no HTML, MHT, XML, EPUB or Markdown,
		// whose import may fetch what they link to) and only pairs in the connector's own table.
		if (!markdown && !toolCanConvert(fromExt, to)) {
			const options = CONVERT_TARGETS.filter((t) => toolCanConvert(fromExt, t));
			throw new ToolError(
				"unsupported_type",
				options.length
					? `A .${fromExt} file can't be converted to .${to} here. It can become: ${options.join(", ")}.`
					: `${fromExt ? `.${fromExt} files` : "Files without an extension"} can't be converted here.`,
			);
		}
		const out = args.output_path
			? targetPath(args.output_path, to, "output_path")
			: joinPath(parentOf(src), `${splitExt(basenameOf(src)).stem}.${to}`);
		const info = await ctx.nc.files.stat(src);
		mustBeFile(info);
		if (info.size > LIMITS.convertBytes) {
			throw new ToolError("too_large", `${src} is ${sizeText(info.size)}. Files up to 25 MB can be converted here; the ONLYOFFICE editor can export bigger ones.`);
		}
		// The folder of output_path, before anything is spent (the default sits beside the original).
		if (parentOf(out) !== parentOf(src)) await folderMustExist(ctx, parentOf(out), "output_path");
		// A copy in a folder shared by link is shared too; a link that already covers the original
		// adds nobody (fix round 3, files/exposure.ts).
		await guardExposure(ctx, parentOf(out), { field: "output_path", what: "new", source: src });
		// With if_exists "fail", a taken name is found before the conversion is spent (one of 20 an
		// hour, and the server's only converter slot). The PUT's If-None-Match still guards a race.
		if (args.if_exists === "fail") await mustBeFree(ctx, out);

		if (markdown) {
			ctx.log.note("convert_md_docx_worker");
			const { bytes, w } = await markdownToDocx(ctx, src, out, info.size, args.if_exists);
			return {
				data: { file: w.file, renamed: w.renamed, from: src },
				summary: `Saved ${src} as ${w.path} (${sizeText(bytes.length)}).${renamedNote(w.renamed, w.path)}`,
			};
		}

		if (info.file_id === null) throw new ToolError("upstream_unavailable", "NoDrive didn't return a file id.");
		const zipSource = ZIP_SOURCES.has(fromExt);
		// The converter decides a file's format from its content, not from the extension, and its
		// importers fetch what a file links to (an SSRF from the converter's own network). So a source
		// is checked by content before it is sent. For a package small enough to read here, one whole
		// read serves the soundness check, the external-reference check and the sheet count; a bigger
		// package keeps only the ranged-tail soundness check (external references in it are a documented
		// residual, DESIGN 22).
		let whole: Uint8Array | null = null;
		if (zipSource && info.size <= LIMITS.officeInWorkerBytes) {
			const got = await ctx.nc.files.read(src, { maxBytes: LIMITS.officeInWorkerBytes });
			if (!got.truncated) whole = got.bytes;
		}
		if (zipSource) {
			// The converter reads a damaged zip as plain text and "converts" that; refuse it here.
			if (!(await soundOfficeFile(ctx, src, info.size, whole))) {
				throw new ToolError("unsupported_type", `${src} couldn't be converted: it may be damaged, or not really a .${fromExt} file.`);
			}
			// A package that links an image or other file by URL would make the converter fetch it.
			if (whole && looksLikeZip(whole) && hasExternalMediaRefs(ZipReader.open(whole), fromExt)) {
				throw new ToolError("invalid_input", `${src} links to an image or file on the internet, which isn't fetched here. Embed it in the document, then convert.`, { field: "path" });
			}
		} else {
			// A text-based source (doc, txt, rtf, csv, tsv, xls): HTML content would be read as a web
			// page whose linked resources are fetched, whatever the extension. Refuse HTML or MHT.
			const head = await ctx.nc.files.read(src, { range: [0, SNIFF_BYTES - 1], maxBytes: SNIFF_BYTES });
			if (looksLikeHtmlOrMht(head.bytes)) {
				throw new ToolError("unsupported_type", `${src} looks like a web page (HTML), which isn't converted here because it can link to other content.`);
			}
		}
		// A workbook made into a PDF or CSV keeps only its first sheet: count its sheets when it was
		// read whole here.
		const sheetsMatter = WORKBOOKS.has(fromExt) && (to === "pdf" || to === "csv");
		const sheetWarning = sheetsMatter ? firstSheetWarning(whole && COUNTABLE_SHEETS.has(fromExt) ? countSheets(whole, fromExt) : null, to as "pdf" | "csv") : null;
		whole = null;
		ctx.log.note(`convert_${fromExt}_${to}`);
		let bytes: Uint8Array;
		try {
			bytes = await ctx.nc.officeConvert(info.file_id, to, { maxBytes: LIMITS.convertBytes });
		} catch (e) {
			if (e instanceof ToolError && e.code === "unsupported_type") {
				throw new ToolError("unsupported_type", `${src} couldn't be converted to .${to}. The file may be damaged, protected with a password, or not readable by ONLYOFFICE.`);
			}
			if (e instanceof ToolError && e.code === "too_large") throw new ToolError("too_large", "The converted file is larger than 25 MB, more than this connector saves.");
			throw e;
		}
		const w = await writeNewFile(ctx, out, bytes, MIME_OF[to], args.if_exists, "output_path");
		return {
			data: { file: w.file, renamed: w.renamed, from: src },
			summary: `Saved ${src} as ${w.path} (${sizeText(bytes.length)}).${renamedNote(w.renamed, w.path)}`,
			...(sheetWarning ? { warnings: [sheetWarning] } : {}),
		};
	},
});
