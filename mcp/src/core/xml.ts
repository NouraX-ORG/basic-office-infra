/**
 * XML building and guarded parsing.
 * - `xml` is a template tag: every interpolated value is escaped, and characters that are illegal
 *   in XML 1.0 are dropped, so request bodies (PROPFIND, SEARCH, REPORT, PROPPATCH) can't be broken
 *   by user text.
 * - `parseXml` uses saxes with namespaces on. A DOCTYPE is refused (no DTD, so no entity tricks),
 *   depth is at most 64 and the input has a size cap.
 */
import { SaxesParser, type SaxesTagNS } from "saxes";
import { ToolError } from "./errors";
import { LIMITS } from "./limits";

// biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 forbids these
const ILLEGAL_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export function stripIllegalXml(s: string): string {
	return s.replace(ILLEGAL_XML, "");
}

export function escapeXml(s: string): string {
	return stripIllegalXml(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** An already-safe XML fragment. Only `xml` and `rawXml` make these. */
export class XmlFragment {
	constructor(readonly xml: string) {}
	toString(): string {
		return this.xml;
	}
}

type XmlValue = string | number | boolean | XmlFragment | readonly XmlFragment[] | null | undefined;

export function xml(strings: TemplateStringsArray, ...values: XmlValue[]): XmlFragment {
	let out = strings[0] ?? "";
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		if (v instanceof XmlFragment) out += v.xml;
		else if (Array.isArray(v)) out += (v as readonly XmlFragment[]).map((f) => f.xml).join("");
		else if (v === null || v === undefined) out += "";
		else out += escapeXml(String(v));
		out += strings[i + 1] ?? "";
	}
	return new XmlFragment(out);
}

/** For constant fragments written in code only. Never pass user input. */
export function rawXml(s: string): XmlFragment {
	return new XmlFragment(s);
}

/** A parsed element. `name` is "{namespace}local". */
export interface XmlEl {
	name: string;
	ns: string;
	local: string;
	attrs: Record<string, string>;
	text: string;
	children: XmlEl[];
}

export function parseXml(text: string, opts: { maxBytes?: number; maxDepth?: number } = {}): XmlEl {
	const maxBytes = opts.maxBytes ?? LIMITS.davXmlBytes;
	const maxDepth = opts.maxDepth ?? 64;
	if (text.length > maxBytes) throw new ToolError("too_large", "The server's answer was too large to read.");
	const parser = new SaxesParser({ xmlns: true, position: false });
	const stack: XmlEl[] = [];
	let root: XmlEl | null = null;
	let failure: Error | null = null;
	parser.on("doctype", () => {
		failure = new Error("DOCTYPE refused");
		throw failure;
	});
	parser.on("error", (e) => {
		failure = e;
		throw e;
	});
	parser.on("opentag", (tag: SaxesTagNS) => {
		if (stack.length >= maxDepth) {
			failure = new Error("XML too deep");
			throw failure;
		}
		const attrs: Record<string, string> = {};
		for (const a of Object.values(tag.attributes)) {
			if (a.prefix === "xmlns" || a.name === "xmlns") continue;
			attrs[a.uri ? `{${a.uri}}${a.local}` : a.local] = a.value;
		}
		const el: XmlEl = { name: `{${tag.uri ?? ""}}${tag.local}`, ns: tag.uri ?? "", local: tag.local ?? tag.name, attrs, text: "", children: [] };
		const parent = stack[stack.length - 1];
		if (parent) parent.children.push(el);
		else root = el;
		stack.push(el);
	});
	const onText = (t: string) => {
		const top = stack[stack.length - 1];
		if (top) top.text += t;
	};
	parser.on("text", onText);
	parser.on("cdata", onText);
	parser.on("closetag", () => {
		stack.pop();
	});
	try {
		parser.write(text).close();
	} catch {
		throw new ToolError("upstream_unavailable", "The server's answer couldn't be read.");
	}
	if (failure || !root) throw new ToolError("upstream_unavailable", "The server's answer couldn't be read.");
	return root;
}

export function childEl(el: XmlEl | undefined, ns: string, local: string): XmlEl | undefined {
	return el?.children.find((c) => c.ns === ns && c.local === local);
}

export function childEls(el: XmlEl | undefined, ns: string, local: string): XmlEl[] {
	return el ? el.children.filter((c) => c.ns === ns && c.local === local) : [];
}

/** Text of an element, trimmed; null when absent. */
export function textOf(el: XmlEl | undefined): string | null {
	if (!el) return null;
	return el.text.trim();
}
