/**
 * A guarded, streaming XML reader for Office and OpenDocument parts (DESIGN 12.4): saxes with
 * namespaces on, a DOCTYPE refused (so no DTD and no entity tricks), depth at most 64. Text can be
 * pushed in chunks, so a big part never has to sit in memory as one string.
 */
import { SaxesParser, type SaxesTagNS } from "saxes";
import { ToolError } from "../core/errors";
import { TooBigHere } from "./errors";
import { DOC_LIMITS } from "./limits";
import type { ZipReader } from "./zip";

export const NS = {
	w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
	r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
	a: "http://schemas.openxmlformats.org/drawingml/2006/main",
	p: "http://schemas.openxmlformats.org/presentationml/2006/main",
	x: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
	rel: "http://schemas.openxmlformats.org/package/2006/relationships",
	ct: "http://schemas.openxmlformats.org/package/2006/content-types",
	mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
	office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
	text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
	table: "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
	draw: "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
	presentation: "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
	style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
	xml: "http://www.w3.org/XML/1998/namespace",
} as const;

/** Strict OOXML (ISO 29500 strict) uses other namespace URIs; we read both. */
const STRICT_ALIASES: Record<string, string> = {
	"http://purl.oclc.org/ooxml/wordprocessingml/main": NS.w,
	"http://purl.oclc.org/ooxml/officeDocument/relationships": NS.r,
	"http://purl.oclc.org/ooxml/drawingml/main": NS.a,
	"http://purl.oclc.org/ooxml/presentationml/main": NS.p,
	"http://purl.oclc.org/ooxml/spreadsheetml/main": NS.x,
};

export interface Tag {
	/** Namespace URI (strict OOXML URIs are mapped to the transitional ones). */
	uri: string;
	local: string;
	/** Attributes by "{uri}local" (namespaced) or "local" (no namespace). */
	attrs: Record<string, string>;
	selfClosing: boolean;
}

export interface SaxHandlers {
	open?(tag: Tag, depth: number): void;
	close?(tag: Tag, depth: number): void;
	text?(text: string, depth: number): void;
}

export function attr(tag: Tag, uri: string | null, local: string): string | undefined {
	return uri ? tag.attrs[`{${uri}}${local}`] : tag.attrs[local];
}

function unreadable(): ToolError {
	return new ToolError("unsupported_type", "This file's contents couldn't be read; it may be damaged.");
}

/** Ends of the markup that saxes buffers whole: comments, CDATA sections and instructions. */
const SPECIAL_END: Record<string, string> = { "!--": "-->", "![CDATA[": "]]>", "?": "?>" };

function tooLongRun(): ToolError {
	return new TooBigHere("This file has a piece of text or markup too long to read here.");
}

/**
 * Bounds what saxes buffers. saxes keeps a whole text node, attribute value, comment or CDATA
 * section in memory until it ends, so a part of one 30 MB text node would be held whole (and
 * copied) however it is streamed. This guard refuses a part where more than `max` characters pass
 * without a "<" (text, tags and attribute values, which can't contain "<"), or where a comment,
 * CDATA section or processing instruction runs longer than `max`. Linear: it jumps with indexOf.
 */
export class RunGuard {
	private run = 0;
	private carry = "";
	private end: string | null = null;

	constructor(private readonly max: number = DOC_LIMITS.xmlRunChars) {}

	feed(chunk: string): void {
		const s = this.carry + chunk;
		this.carry = "";
		let i = 0;
		while (i < s.length) {
			if (this.end) {
				const j = s.indexOf(this.end, i);
				if (j < 0) {
					// Keep the last characters: the end marker may straddle two chunks.
					const keep = Math.min(s.length - i, this.end.length - 1);
					this.run += s.length - i - keep;
					if (this.run > this.max) throw tooLongRun();
					this.carry = s.slice(s.length - keep);
					return;
				}
				this.run += j - i;
				if (this.run > this.max) throw tooLongRun();
				i = j + this.end.length;
				this.end = null;
				this.run = 0;
				continue;
			}
			const lt = s.indexOf("<", i);
			if (lt < 0) {
				this.run += s.length - i;
				if (this.run > this.max) throw tooLongRun();
				return;
			}
			this.run += lt - i;
			if (this.run > this.max) throw tooLongRun();
			// Up to 8 characters after "<" decide what follows; wait for more when the chunk ends first.
			const head = s.slice(lt + 1, lt + 9);
			if (head.length < 8 && (head === "" || "![CDATA[".startsWith(head) || "!--".startsWith(head))) {
				this.carry = s.slice(lt);
				return;
			}
			this.run = 0;
			if (head.startsWith("!--")) (this.end = SPECIAL_END["!--"] as string), (i = lt + 4);
			else if (head.startsWith("![CDATA[")) (this.end = SPECIAL_END["![CDATA["] as string), (i = lt + 9);
			else if (head.startsWith("?")) (this.end = SPECIAL_END["?"] as string), (i = lt + 2);
			else i = lt + 1;
		}
	}
}

export class SaxStream {
	private readonly parser = new SaxesParser({ xmlns: true, position: false });
	private readonly stack: Tag[] = [];
	private failure: unknown = null;
	private readonly guardRuns = new RunGuard();

	constructor(handlers: SaxHandlers, maxDepth = 64) {
		const p = this.parser;
		p.on("doctype", () => {
			this.failure = unreadable();
			throw this.failure;
		});
		p.on("error", (e) => {
			this.failure = e;
			throw e;
		});
		p.on("opentag", (t: SaxesTagNS) => {
			if (this.stack.length >= maxDepth) {
				this.failure = new ToolError("unsupported_type", "This file is nested too deeply to read.");
				throw this.failure;
			}
			const attrs: Record<string, string> = {};
			for (const a of Object.values(t.attributes)) {
				if (a.prefix === "xmlns" || a.name === "xmlns") continue;
				const uri = a.uri ? (STRICT_ALIASES[a.uri] ?? a.uri) : "";
				attrs[uri ? `{${uri}}${a.local}` : a.local] = a.value;
			}
			const uri = t.uri ? (STRICT_ALIASES[t.uri] ?? t.uri) : "";
			const tag: Tag = { uri, local: t.local ?? t.name, attrs, selfClosing: t.isSelfClosing };
			this.stack.push(tag);
			handlers.open?.(tag, this.stack.length);
		});
		p.on("closetag", () => {
			const tag = this.stack.pop();
			if (tag) handlers.close?.(tag, this.stack.length + 1);
		});
		const onText = (s: string) => handlers.text?.(s, this.stack.length);
		p.on("text", onText);
		p.on("cdata", onText);
	}

	write(chunk: string): void {
		this.guardRuns.feed(chunk);
		this.guard(() => this.parser.write(chunk));
	}

	close(): void {
		this.guard(() => this.parser.close());
	}

	private guard(fn: () => void): void {
		try {
			fn();
		} catch (e) {
			// A handler's own early stop (extract/out.ts) passes through unchanged.
			if (e instanceof Error && e.name === "StopRead") throw e;
			const f = this.failure ?? e;
			if (f instanceof ToolError) throw f;
			throw unreadable();
		}
	}
}

/** Parses a whole string. */
export function saxParse(text: string, handlers: SaxHandlers, maxDepth = 64): void {
	const s = new SaxStream(handlers, maxDepth);
	s.write(text);
	s.close();
}

/**
 * Streams one zip part through the guarded parser, never holding it whole. Returns false when the
 * part doesn't exist.
 */
export function parsePart(zip: ZipReader, name: string, handlers: SaxHandlers): boolean {
	const s = new SaxStream(handlers);
	const ok = zip.streamText(name, (c) => s.write(c));
	if (ok) s.close();
	return ok;
}
