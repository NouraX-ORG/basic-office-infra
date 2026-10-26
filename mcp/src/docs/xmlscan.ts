/**
 * A small XML tag scanner that reports raw offsets, for in-place edits of Office parts (the
 * template filler). It resolves namespace prefixes, so it works whatever prefixes a producer chose.
 * It assumes well-formed input without a DOCTYPE: callers check that with saxes first (sax.ts).
 * Linear in time: each character is looked at a constant number of times.
 */

export interface ScanTag {
	kind: "open" | "close" | "empty";
	/** The qualified name as written, for example "w:t". */
	qname: string;
	prefix: string;
	uri: string;
	local: string;
	/** Offset of "<" and one past ">". */
	start: number;
	end: number;
	/** Raw attribute text between the name and ">" or "/>". */
	attrs: string;
}

export interface ScanHandlers {
	tag(t: ScanTag): void;
	/** Raw character data between tags (entities not decoded), with its offsets. */
	text?(start: number, end: number): void;
}

const ATTR_RE = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttrs(raw: string): [string, string][] {
	const out: [string, string][] = [];
	ATTR_RE.lastIndex = 0;
	for (let m = ATTR_RE.exec(raw); m; m = ATTR_RE.exec(raw)) out.push([m[1] as string, (m[3] ?? m[4] ?? "") as string]);
	return out;
}

export function scanXml(s: string, h: ScanHandlers): void {
	const nsStack: Map<string, string>[] = [new Map([["xml", "http://www.w3.org/XML/1998/namespace"]])];
	const lookup = (prefix: string): string => {
		for (let k = nsStack.length - 1; k >= 0; k--) {
			const v = (nsStack[k] as Map<string, string>).get(prefix);
			if (v !== undefined) return v;
		}
		return "";
	};
	let i = 0;
	const n = s.length;
	while (i < n) {
		const lt = s.indexOf("<", i);
		if (lt < 0) {
			if (i < n) h.text?.(i, n);
			break;
		}
		if (lt > i) h.text?.(i, lt);
		if (s.startsWith("<!--", lt)) {
			const e = s.indexOf("-->", lt + 4);
			i = e < 0 ? n : e + 3;
			continue;
		}
		if (s.startsWith("<![CDATA[", lt)) {
			const e = s.indexOf("]]>", lt + 9);
			i = e < 0 ? n : e + 3;
			continue;
		}
		if (s.startsWith("<?", lt)) {
			const e = s.indexOf("?>", lt + 2);
			i = e < 0 ? n : e + 2;
			continue;
		}
		if (s.startsWith("<!", lt)) throw new Error("declaration refused");
		// Find the end of the tag, outside quotes.
		let j = lt + 1;
		let quote = "";
		while (j < n) {
			const c = s[j];
			if (quote) {
				if (c === quote) quote = "";
			} else if (c === '"' || c === "'") quote = c;
			else if (c === ">") break;
			j++;
		}
		if (j >= n) throw new Error("unterminated tag");
		const end = j + 1;
		if (s[lt + 1] === "/") {
			const qname = s.slice(lt + 2, j).trim();
			const ci = qname.indexOf(":");
			const prefix = ci > 0 ? qname.slice(0, ci) : "";
			const local = ci > 0 ? qname.slice(ci + 1) : qname;
			h.tag({ kind: "close", qname, prefix, uri: lookup(prefix), local, start: lt, end, attrs: "" });
			nsStack.pop();
			i = end;
			continue;
		}
		const selfClosing = s[j - 1] === "/";
		const inner = s.slice(lt + 1, selfClosing ? j - 1 : j);
		let k = 0;
		while (k < inner.length && !/\s/.test(inner[k] as string)) k++;
		const qname = inner.slice(0, k);
		const attrs = inner.slice(k);
		const decls = new Map<string, string>();
		if (attrs.includes("xmlns")) {
			for (const [name, value] of parseAttrs(attrs)) {
				if (name === "xmlns") decls.set("", value);
				else if (name.startsWith("xmlns:")) decls.set(name.slice(6), value);
			}
		}
		nsStack.push(decls);
		const ci = qname.indexOf(":");
		const prefix = ci > 0 ? qname.slice(0, ci) : "";
		const local = ci > 0 ? qname.slice(ci + 1) : qname;
		h.tag({ kind: selfClosing ? "empty" : "open", qname, prefix, uri: lookup(prefix), local, start: lt, end, attrs });
		if (selfClosing) nsStack.pop();
		i = end;
	}
}

/** Decodes the five XML entities and character references (the only ones without a DTD). */
export function decodeEntities(raw: string): string {
	if (!raw.includes("&")) return raw;
	return raw.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
		if (e === "lt") return "<";
		if (e === "gt") return ">";
		if (e === "amp") return "&";
		if (e === "quot") return '"';
		if (e === "apos") return "'";
		const code = e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
		try {
			return String.fromCodePoint(code);
		} catch {
			return "";
		}
	});
}
