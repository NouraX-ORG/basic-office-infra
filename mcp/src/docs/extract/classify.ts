/**
 * Which reader handles a file (DESIGN 12.4), chosen by extension first and then by mime type.
 * - "text": read as it is (UTF-8, or UTF-16 with a byte-order mark; other bytes as Windows-1252);
 * - "docx", "xlsx", "pptx", "odt", "ods", "odp", "pdf": read in the Worker;
 * - "server": legacy formats (doc, xls, ppt, rtf and similar) through the connector's conversion,
 *   only for pairs our tools may send to it (formats.ts toolCanConvert);
 * - "noconvert": a document format the connector knows but our tools don't send to it (djvu, epub,
 *   pages and similar), so its text can't be read here;
 * - "image", "binary": no text to read.
 */
import { docTypeOf, toolCanConvert } from "../formats";

export type Kind = "text" | "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp" | "pdf" | "server" | "noconvert" | "image" | "binary" | "unknown";

/** The plain answer for a "noconvert" file. */
export const NO_CONVERT = "This kind of file can't be turned into text here.";

/** The note for text that wasn't UTF-8. */
export const LEGACY_NOTE = "The file isn't UTF-8, so it was read as Windows-1252 (Western European); a few characters may be wrong.";

export interface Classified {
	kind: Kind;
	/** The extension (lower case, no dot), or "" when there is none. */
	ext: string;
	/** A short format name for results, for example "docx" or "text". */
	format: string;
	/** For "server" and the big-file fallback: what the connector converts to. */
	serverTarget?: "txt" | "csv";
	/** Office and PDF formats count as heavy work and are off when HEAVY_TOOLS is off. */
	heavy: boolean;
}

const TEXT_EXTS = new Set(
	(
		"txt text md markdown csv tsv json jsonl ndjson xml yaml yml log ini cfg conf toml env properties html htm xhtml css scss less svg " +
		"js mjs cjs ts tsx jsx py rb php java kt kts scala go rs c h cpp hpp cc cs swift m mm sh bash zsh ps1 bat cmd sql r lua pl tex bib " +
		"vue svelte gradle make mk dockerfile gitignore editorconfig rst adoc org srt vtt ics vcf"
	).split(" "),
);

const TEXT_FORMAT: Record<string, string> = { md: "markdown", markdown: "markdown", csv: "csv", tsv: "tsv", json: "json", xml: "xml", html: "html", htm: "html", yaml: "yaml", yml: "yaml" };

const WORKER: Record<string, Kind> = {
	docx: "docx",
	docm: "docx",
	dotx: "docx",
	dotm: "docx",
	xlsx: "xlsx",
	xlsm: "xlsx",
	xltx: "xlsx",
	xltm: "xlsx",
	pptx: "pptx",
	pptm: "pptx",
	potx: "pptx",
	potm: "pptx",
	ppsx: "pptx",
	ppsm: "pptx",
	odt: "odt",
	ott: "odt",
	ods: "ods",
	ots: "ods",
	odp: "odp",
	otp: "odp",
	pdf: "pdf",
};

const IMAGE_EXTS = new Set("jpg jpeg png gif webp bmp tif tiff heic heif avif ico psd raw cr2 nef".split(" "));
const BINARY_EXTS = new Set("zip 7z rar gz tgz bz2 xz tar exe dll so dylib bin iso dmg msi apk mp3 wav flac ogg m4a aac mp4 mov avi mkv webm wmv sqlite db".split(" "));

function extOf(name: string): string {
	const i = name.lastIndexOf(".");
	if (i <= 0 || i === name.length - 1) return name.startsWith(".") ? name.slice(1).toLowerCase() : "";
	return name.slice(i + 1).toLowerCase();
}

/** The conversion target for an extension, only when our tools may send that pair to the connector. */
function serverTargetFor(ext: string): "txt" | "csv" | undefined {
	const t = docTypeOf(ext);
	const target = t === "cell" ? "csv" : t === "word" || t === "slide" || t === "pdf" ? "txt" : undefined;
	return target && toolCanConvert(ext, target) ? target : undefined;
}

export function classify(name: string, mime: string | null): Classified {
	const ext = extOf(name);
	const m = (mime ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
	const worker = WORKER[ext];
	if (worker) {
		return { kind: worker, ext, format: ext, heavy: true, ...(serverTargetFor(ext) ? { serverTarget: serverTargetFor(ext) } : {}) };
	}
	if (TEXT_EXTS.has(ext)) return { kind: "text", ext, format: TEXT_FORMAT[ext] ?? "text", heavy: false };
	if (IMAGE_EXTS.has(ext) || (m.startsWith("image/") && m !== "image/svg+xml")) return { kind: "image", ext, format: ext || "image", heavy: false };
	// Legacy office formats the connector turns into text or CSV for us; other document formats it
	// knows (djvu, epub, pages, Visio and similar) are not sent to it.
	const target = serverTargetFor(ext);
	if (target) return { kind: "server", ext, format: ext, serverTarget: target, heavy: true };
	if (docTypeOf(ext)) return { kind: "noconvert", ext, format: ext, heavy: false };
	if (BINARY_EXTS.has(ext) || m.startsWith("audio/") || m.startsWith("video/")) return { kind: "binary", ext, format: ext || "binary", heavy: false };
	if (m.startsWith("text/") || m === "application/json" || m === "application/xml" || m.endsWith("+xml") || m.endsWith("+json")) {
		return { kind: "text", ext, format: "text", heavy: false };
	}
	// The connector converts by extension, so a PDF without one can only be read in the Worker.
	if (m === "application/pdf") return { kind: "pdf", ext, format: "pdf", heavy: true, ...(toolCanConvert(ext, "txt") ? { serverTarget: "txt" as const } : {}) };
	return { kind: "unknown", ext, format: ext || "unknown", heavy: false };
}

/**
 * Decodes text bytes: a UTF-16 byte-order mark picks UTF-16, otherwise UTF-8; a UTF-8 BOM is
 * dropped and invalid bytes become U+FFFD. Line endings become "\n". (For the connector's output,
 * which core has already checked to be UTF-8.)
 */
export function decodeText(b: Uint8Array): string {
	let s: string;
	if (b[0] === 0xff && b[1] === 0xfe) s = new TextDecoder("utf-16le").decode(b.subarray(2));
	else if (b[0] === 0xfe && b[1] === 0xff) s = new TextDecoder("utf-16be").decode(b.subarray(2));
	else s = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(b);
	if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
	return s.replace(/\r\n?/g, "\n");
}

/** Where a UTF-8 character cut short by the end of a ranged read begins (or b.length). */
function utf8Cut(b: Uint8Array): number {
	let i = b.length;
	for (let k = 0; k < 3 && i > 0 && ((b[i - 1] as number) & 0xc0) === 0x80; k++) i--;
	return i > 0 && ((b[i - 1] as number) & 0xc0) === 0xc0 ? i - 1 : b.length;
}

function strictUtf8(b: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b);
	} catch {
		return null;
	}
}

/**
 * Decodes the bytes of a text file. Like decodeText, but bytes that aren't UTF-8 (CSV files saved
 * by Excel on Windows often aren't) are read as Windows-1252, and `legacy` says so. A character cut
 * short at the very end (a ranged read of a big file) doesn't count as "not UTF-8".
 */
export function decodeTextNote(b: Uint8Array): { text: string; legacy: boolean } {
	if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return { text: decodeText(b), legacy: false };
	let s = strictUtf8(b);
	if (s === null) {
		const cut = utf8Cut(b);
		if (cut < b.length) s = strictUtf8(b.subarray(0, cut));
	}
	let legacy = false;
	if (s === null) {
		// The WHATWG "windows-1252" decoder (also what the "latin1" label means).
		s = new TextDecoder("windows-1252").decode(b);
		legacy = true;
	}
	if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
	return { text: s.replace(/\r\n?/g, "\n"), legacy };
}

/**
 * A first look at unknown bytes (the first 8 KB): text has no NUL bytes and hardly any control
 * characters (other than tab, line breaks and form feed). Its high bytes are then UTF-8 or, if not,
 * 8-bit text read as Windows-1252 (decodeTextNote says which).
 */
export function looksLikeText(b: Uint8Array): boolean {
	const head = b.subarray(0, 8192);
	if (head[0] === 0xff && head[1] === 0xfe) return true;
	if (head[0] === 0xfe && head[1] === 0xff) return true;
	let controls = 0;
	for (const x of head) {
		if (x === 0) return false;
		if ((x < 0x20 && x !== 9 && x !== 10 && x !== 12 && x !== 13) || x === 0x7f) controls++;
	}
	return controls / Math.max(1, head.length) < 0.01;
}
