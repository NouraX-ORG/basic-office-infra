/**
 * Template fields and filling (DESIGN 12.3). Placeholders are written {{name}}: the name is 1 to 64
 * letters, digits, "_", ".", "-" or spaces, and is trimmed.
 *
 * Scanned parts:
 * - Word: word/document.xml, headers, footers, footnotes and endnotes;
 * - PowerPoint: the slides and their notes;
 * - Excel: xl/sharedStrings.xml and the inline strings in each sheet.
 *
 * Within each paragraph (w:p, a:p) or string (si, is) the run texts are joined, so a placeholder
 * split across runs (the hard part of a home-made filler) is still found. The value goes into the
 * first run of the match, keeping its formatting, and the other runs it spanned are emptied.
 * Values are XML-escaped. A newline becomes <w:br/> in Word and <a:br/> in PowerPoint.
 * The output is always a new file; the template is never changed.
 *
 * Memory (fix round 1, after the security review measured 120 to 830 MB for hostile templates
 * within the byte caps): limits are on what is held, not only on bytes (DOC_LIMITS).
 * - A scanned part is held whole only up to 4 MB (the filler edits it by offset). A bigger part
 *   with no "{" and no character reference in it can't hold a field and is copied as it is;
 *   otherwise the template is refused as too big.
 * - Paragraphs are handled one at a time as the scan closes them: nothing is kept per paragraph
 *   afterwards. A paragraph keeps at most 10,000 text pieces and 1,000,000 characters, and a
 *   template at most 300,000 text pieces in all.
 * - Filling streams the result: unchanged parts are copied still packed (never unpacked), and an
 *   edited part is deflated piece by piece while it is checked again by the XML reader, so the
 *   filled text is never held as one string. At most 20,000 placeholders are replaced, an edited
 *   part is at most 12,000,000 characters, and the finished file at most 20 MB.
 * - Fix round 2 (the security review filled a 2.7 KB template of 20,000 {{a}} with 10,000 "&" and
 *   ran the isolate out of memory, because the 12,000,000 check came after every replacement had
 *   been built): sizes are now checked before anything is built. What each value adds once escaped
 *   is counted while it is joined in, against 2,000,000 characters per paragraph and the part's
 *   12,000,000; the exact XML length of each changed piece is worked out before that XML is made
 *   (a PowerPoint run split repeats the whole run for every line of a value); and edits are written
 *   out, deflated, as soon as the outermost paragraph holding them closes, so one paragraph's edits
 *   are the most that is held.
 */
import { ToolError } from "../core/errors";
import { LIMITS } from "../core/limits";
import { TooBigHere } from "./errors";
import { StopRead } from "./extract/out";
import { DOC_LIMITS } from "./limits";
import { esc, needsPreserve } from "./ooxml/common";
import { NS, SaxStream, saxParse } from "./sax";
import { decodeEntities, scanXml } from "./xmlscan";
import { decodeXmlBytes, type PartWriter, ZipBuilder, ZipReader } from "./zip";

export type Family = "docx" | "xlsx" | "pptx";

export const TEMPLATE_EXTS: Record<string, { family: Family; template: boolean }> = {
	docx: { family: "docx", template: false },
	dotx: { family: "docx", template: true },
	xlsx: { family: "xlsx", template: false },
	xltx: { family: "xlsx", template: true },
	pptx: { family: "pptx", template: false },
	potx: { family: "pptx", template: true },
};

const KEY_RE = /^[A-Za-z0-9_. -]{1,64}$/;

export function validKey(k: string): boolean {
	const t = k.trim();
	return t.length > 0 && KEY_RE.test(t);
}

function partsFor(family: Family, names: string[]): string[] {
	const re =
		family === "docx"
			? /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i
			: family === "pptx"
				? /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/i
				: /^xl\/(?:sharedStrings|worksheets\/sheet\d+)\.xml$/i;
	return names.filter((n) => re.test(n));
}

interface Carrier {
	/** The text element's qualified name, prefix and raw attributes. */
	qname: string;
	prefix: string;
	attrs: string;
	/** Offsets of the whole element (open tag start, one past the close tag) in the part. */
	start: number;
	end: number;
	text: string;
	/** For PowerPoint: the enclosing run's span and its raw a:rPr, to split runs on newlines. */
	run?: { start: number; end: number; rPr: string; prefix: string };
}

interface Match {
	start: number;
	end: number;
	key: string;
}

/** Finds {{key}} matches in joined text, left to right, without overlap. Linear. */
export function findPlaceholders(s: string): Match[] {
	const out: Match[] = [];
	let pos = 0;
	for (;;) {
		const i = s.indexOf("{{", pos);
		if (i < 0) break;
		const window = s.slice(i + 2, i + 2 + 72);
		const j = window.indexOf("}}");
		if (j >= 0) {
			const inner = window.slice(0, j);
			if (!inner.includes("{") && validKey(inner)) {
				out.push({ start: i, end: i + 2 + j + 2, key: inner.trim() });
				pos = i + 2 + j + 2;
				continue;
			}
		}
		pos = i + 1;
	}
	return out;
}

function tooBig(message: string): ToolError {
	return new ToolError("too_large", message);
}

const TOO_BIG_PART = "This template is too big to work with here: a part of it unpacks to more than 4 MB of text.";
const TOO_MUCH_TEXT = "This template has more text than can be scanned here (300,000 text pieces at most).";

/** What one template may use in all, across its parts. */
interface Budget {
	carriers: number;
	chars: number;
}

/**
 * Scans one part and calls `onUnit` for each paragraph (or string) with text, as soon as it closes.
 * Nested paragraphs (text boxes) are their own units. Nothing is kept once a unit is handed over.
 * `onOuter` runs each time an outermost unit closes (no unit is open any more): every edit made so
 * far lies before what comes next, so the filler can write it out.
 */
function scanUnits(xml: string, family: Family, budget: Budget, onUnit: (carriers: Carrier[]) => void, onOuter?: () => void): void {
	const unitNs = family === "docx" ? NS.w : family === "pptx" ? NS.a : NS.x;
	const unitLocals = family === "xlsx" ? new Set(["si", "is"]) : new Set(["p"]);
	const stack: { carriers: Carrier[]; chars: number }[] = [];
	let skipDepth = 0; // inside xlsx phonetic runs or pptx fields
	let current: { c: Carrier; unit: { carriers: Carrier[]; chars: number }; cStart: number } | null = null;
	let run: { start: number; rPr: string; prefix: string; carriers: Carrier[] } | null = null;
	let rPrStart = -1;
	const addCarrier = (c: Carrier): { carriers: Carrier[]; chars: number } | null => {
		const unit = stack[stack.length - 1];
		if (!unit) return null;
		if (unit.carriers.length >= DOC_LIMITS.templateUnitCarriers) throw tooBig("A paragraph of this template has too many pieces of text to fill here (10,000 at most).");
		budget.carriers++;
		if (budget.carriers > DOC_LIMITS.templateCarriers) throw tooBig(TOO_MUCH_TEXT);
		unit.carriers.push(c);
		run?.carriers.push(c);
		return unit;
	};
	scanXml(xml, {
		tag(t) {
			const isNs = t.uri === unitNs || (family === "xlsx" && t.uri === "");
			if (family === "xlsx" && isNs && t.local === "rPh") {
				if (t.kind === "open") skipDepth++;
				else if (t.kind === "close") skipDepth--;
				return;
			}
			if (family === "pptx" && t.uri === NS.a && t.local === "fld") {
				if (t.kind === "open") skipDepth++;
				else if (t.kind === "close") skipDepth--;
				return;
			}
			if (isNs && unitLocals.has(t.local)) {
				if (t.kind === "open") stack.push({ carriers: [], chars: 0 });
				else if (t.kind === "close") {
					const u = stack.pop();
					if (u && u.carriers.length > 0) onUnit(u.carriers);
					if (stack.length === 0) onOuter?.();
				}
				return;
			}
			if (family === "pptx" && t.uri === NS.a && t.local === "r") {
				if (t.kind === "open") run = { start: t.start, rPr: "", prefix: t.prefix, carriers: [] };
				else if (t.kind === "close" && run) {
					for (const c of run.carriers) c.run = { start: run.start, end: t.end, rPr: run.rPr, prefix: run.prefix };
					run = null;
				}
				return;
			}
			if (family === "pptx" && run && t.uri === NS.a && t.local === "rPr") {
				if (t.kind === "empty") run.rPr = xml.slice(t.start, t.end);
				else if (t.kind === "open") rPrStart = t.start;
				else if (t.kind === "close" && rPrStart >= 0) {
					run.rPr = xml.slice(rPrStart, t.end);
					rPrStart = -1;
				}
				return;
			}
			if (isNs && t.local === "t" && skipDepth === 0) {
				if (t.kind === "empty") {
					addCarrier({ qname: t.qname, prefix: t.prefix, attrs: t.attrs, start: t.start, end: t.end, text: "" });
				} else if (t.kind === "open") {
					const c: Carrier = { qname: t.qname, prefix: t.prefix, attrs: t.attrs, start: t.start, end: t.end, text: "" };
					const unit = addCarrier(c);
					current = unit ? { c, unit, cStart: t.end } : null;
				} else if (t.kind === "close" && current) {
					const text = decodeEntities(xml.slice(current.cStart, t.start));
					current.c.text = text;
					current.c.end = t.end;
					current.unit.chars += text.length;
					if (current.unit.chars > DOC_LIMITS.blockChars) throw tooBig("A paragraph of this template is too long to fill here (1,000,000 characters at most).");
					current = null;
				}
			}
		},
	});
}

export interface FieldCount {
	name: string;
	count: number;
}

export interface ScanResult {
	family: Family;
	/** Distinct fields in document order with how often each appears (at most 10,000 names). */
	fields: FieldCount[];
	/** True when the template has more distinct names than were counted. */
	more: boolean;
}

function openTemplate(bytes: Uint8Array): ZipReader {
	if (bytes.length > LIMITS.templateBytes) throw tooBig("Templates can be at most 10 MB.");
	return ZipReader.open(bytes);
}

function familyCheck(zip: ZipReader, family: Family): void {
	const main = family === "docx" ? "word/document.xml" : family === "pptx" ? "ppt/presentation.xml" : "xl/workbook.xml";
	if (!zip.has(main)) throw new ToolError("unsupported_type", "This file isn't a valid document of the kind its name says.");
}

/**
 * Whether a part that is too big to hold could contain a field: any "{" (a placeholder may be
 * split across runs, so one brace is enough) or any character reference (which could spell one).
 * Streamed with the zip reader's counters; stops at the first sign.
 */
function mayHoldField(zip: ZipReader, name: string): boolean {
	let found = false;
	try {
		zip.streamText(name, (s) => {
			if (s.includes("{") || s.includes("&#")) {
				found = true;
				throw new StopRead();
			}
		});
	} catch (e) {
		if (!(e instanceof StopRead)) throw e;
	}
	return found;
}

/**
 * The text of one scanned part, checked by saxes (well-formed, no DOCTYPE, depth at most 64)
 * before the scanner edits anything. Null when the part is too big to hold but can't hold a field.
 */
function loadPart(zip: ZipReader, name: string, budget: Budget): string | null {
	const e = zip.entry(name);
	if (!e) throw new ToolError("unsupported_type", "The template is missing a part it should have.");
	// The declared size is only a hint (it may lie); the reader's own counters are what holds.
	if (e.usize > DOC_LIMITS.templatePartBytes) {
		if (mayHoldField(zip, name)) throw tooBig(TOO_BIG_PART);
		return null;
	}
	const pieces: string[] = [];
	try {
		zip.streamText(name, (s) => pieces.push(s), DOC_LIMITS.templatePartBytes);
	} catch (err) {
		if (err instanceof TooBigHere) throw tooBig(TOO_BIG_PART);
		throw err;
	}
	const xml = pieces.join("");
	budget.chars += xml.length;
	if (budget.chars > DOC_LIMITS.templateTotalBytes) throw tooBig("This template is too big to work with here: its text parts unpack to more than 32 MB in all.");
	saxParse(xml, {});
	return xml;
}

function joined(carriers: readonly Carrier[]): string {
	return carriers.map((c) => c.text).join("");
}

/** Lists the {{fields}} of a template with how often each appears. */
export function listFields(bytes: Uint8Array, family: Family): ScanResult {
	const zip = openTemplate(bytes);
	familyCheck(zip, family);
	const counts = new Map<string, number>();
	let more = false;
	const budget: Budget = { carriers: 0, chars: 0 };
	for (const part of partsFor(family, zip.names())) {
		const xml = loadPart(zip, part, budget);
		if (xml === null) continue;
		scanUnits(xml, family, budget, (carriers) => {
			for (const m of findPlaceholders(joined(carriers))) {
				const c = counts.get(m.key);
				if (c !== undefined) counts.set(m.key, c + 1);
				else if (counts.size < DOC_LIMITS.templateFieldNames) counts.set(m.key, 1);
				else more = true;
			}
		});
	}
	return { family, fields: [...counts.entries()].map(([name, count]) => ({ name, count })), more };
}

export type MissingPolicy = "fail" | "keep" | "blank";

export interface FillResult {
	bytes: Uint8Array;
	/** Sorted. filled and unused hold at most the 200 value names; missing at most 10,000 names. */
	filled: string[];
	missing: string[];
	unused: string[];
	/** True when more fields had no value than `missing` lists. */
	missingMore: boolean;
}

interface Edit {
	start: number;
	end: number;
	text: string;
}

function carrierXml(c: Carrier, text: string, family: Family): string {
	const q = c.qname;
	const p = c.prefix ? `${c.prefix}:` : "";
	const attrs = c.attrs.trimEnd();
	if (family === "docx") {
		const lines = text.split("\n");
		return lines.map((l, i) => `${i > 0 ? `<${p}br/>` : ""}<${q} xml:space="preserve">${esc(l)}</${q}>`).join("");
	}
	if (family === "xlsx") {
		const keep = attrs.replace(/\s+xml:space\s*=\s*("[^"]*"|'[^']*')/, "");
		return `<${q}${keep}${needsPreserve(text) ? ' xml:space="preserve"' : ""}>${esc(text)}</${q}>`;
	}
	return `<${q}${attrs}>${esc(text)}</${q}>`;
}

/**
 * The length of esc(s), at most (characters XML 1.0 forbids are counted, though esc drops them),
 * and how many newlines s holds. One pass, nothing built.
 */
export function measure(s: string): { esc: number; nl: number } {
	let n = s.length;
	let nl = 0;
	for (let i = 0; i < s.length; i++) {
		const ch = s.charCodeAt(i);
		if (ch === 38) n += 4; // &amp;
		else if (ch === 60 || ch === 62) n += 3; // &lt; &gt;
		else if (ch === 34 || ch === 39) n += 5; // &quot; &apos;
		else if (ch === 10) nl++;
	}
	return { esc: n, nl };
}

/** The pieces a PowerPoint run split repeats for every line: the run around the text, and the a:br. */
function runSplit(c: Carrier, xml: string): { pre: string; post: string; br: string } | null {
	if (!c.run) return null;
	const p = c.run.prefix ? `${c.run.prefix}:` : "";
	return {
		pre: xml.slice(c.run.start, c.start),
		post: xml.slice(c.end, c.run.end),
		br: c.run.rPr ? `<${p}br>${c.run.rPr}</${p}br>` : `<${p}br/>`,
	};
}

/**
 * The length of the XML an edited carrier becomes (carrierXml, or the run split for PowerPoint), at
 * most, worked out before any of it is built: a run split repeats the whole run, with its
 * formatting, for every line, so a long run and a value of many newlines would otherwise build a
 * huge string before any limit saw it.
 */
function editLength(c: Carrier, text: string, family: Family, xml: string): number {
	const m = measure(text);
	const q = c.qname.length;
	const attrs = c.attrs.length;
	const p = c.prefix ? c.prefix.length + 1 : 0;
	if (family === "docx") return (m.nl + 1) * (2 * q + 26) + m.esc + m.nl * (p + 5);
	if (family === "xlsx") return 2 * q + attrs + 21 + 5 + m.esc;
	const split = m.nl > 0 ? runSplit(c, xml) : null;
	if (!split) return 2 * q + attrs + 5 + m.esc;
	return (m.nl + 1) * (split.pre.length + split.post.length + 2 * q + attrs + 5) + m.esc + m.nl * split.br.length;
}

const PART_TOO_BIG = "The filled file would be too big (an edited part over 12,000,000 characters). Use shorter values or fewer placeholders.";
const UNIT_TOO_BIG = "A paragraph of the filled file would be too long (2,000,000 characters at most). Use shorter values, or fewer placeholders in one paragraph.";

/**
 * One scanned part being filled (fix round 2, after the security review ran a 2.7 KB template out
 * of memory). Edits are written out as soon as the outermost paragraph (or string) that holds them
 * closes, so at most one paragraph's edits are held, and the part is deflated as it is written.
 * `projected` is the part's length once filled, as far as the edits so far go (its own length plus
 * what each edit adds); the filler checks it before it builds an edit. The part is opened in the
 * builder at its first edit; a part without edits is copied still packed. Every piece written also
 * goes through a fresh XML reader, so a broken part is never written (the whole fill fails).
 */
class PartFill {
	private w: PartWriter | null = null;
	private check: SaxStream | null = null;
	private at = 0;
	private written = 0;
	private pending: Edit[] = [];
	projected: number;

	constructor(
		private readonly builder: ZipBuilder,
		private readonly name: string,
		readonly xml: string,
	) {
		this.projected = xml.length;
	}

	add(e: Edit): void {
		this.pending.push(e);
		this.projected += e.text.length - (e.end - e.start);
	}

	/** Writes the edits held so far, and the part's own text up to the last of them. */
	flush(): void {
		if (this.pending.length === 0) return;
		const edits = this.pending;
		this.pending = [];
		// Runs split for PowerPoint cover their carriers; keep the outermost edit of overlaps.
		edits.sort((a, b) => a.start - b.start || b.end - a.end);
		if (!this.w) {
			this.w = this.builder.part(this.name);
			this.check = new SaxStream({});
		}
		for (const e of edits) {
			if (e.start < this.at) continue;
			this.put(this.xml.slice(this.at, e.start));
			this.put(e.text);
			this.at = e.end;
		}
	}

	/** Ends the part. False when nothing was edited: the caller copies it still packed. */
	finish(): boolean {
		this.flush();
		if (!this.w || !this.check) return false;
		this.put(this.xml.slice(this.at));
		this.check.close();
		this.w.end();
		return true;
	}

	private put(s: string): void {
		this.written += s.length;
		if (this.written > DOC_LIMITS.templateOutputChars) throw tooBig(PART_TOO_BIG);
		const w = this.w as PartWriter;
		const check = this.check as SaxStream;
		for (let i = 0; i < s.length; ) {
			let j = Math.min(s.length, i + 65_536);
			// Never split a surrogate pair between two pieces.
			if (j < s.length) {
				const c = s.charCodeAt(j - 1);
				if (c >= 0xd800 && c <= 0xdbff) j++;
			}
			const piece = s.slice(i, j);
			check.write(piece);
			w.write(piece);
			i = j;
		}
	}
}

/** What one fill has done so far, across parts. */
interface FillState {
	vals: Map<string, string>;
	/** The escaped length of each value (measure), worked out once. */
	cost: Map<string, number>;
	missing: MissingPolicy;
	filled: Set<string>;
	missingSet: Set<string>;
	missingMore: boolean;
	seen: Set<string>;
	replaced: number;
}

/**
 * The edits for one paragraph, handed to the part as they are made. Linear in its carriers plus its
 * matches: one pointer walks the carriers from left to right, because matches come in order.
 *
 * Sizes are checked before anything is built (fix round 2): while the values are joined in, what
 * they add once escaped is counted against the paragraph's limit (2,000,000 characters) and the
 * part's (12,000,000), so the joined text stays bounded; then the exact XML length of every changed
 * piece is worked out (editLength) and checked again before the XML is made.
 */
function unitEdits(carriers: Carrier[], family: Family, part: PartFill, st: FillState): void {
	const xml = part.xml;
	const text = joined(carriers);
	const matches = findPlaceholders(text);
	if (matches.length === 0) return;
	const n = carriers.length;
	const offs: number[] = [];
	let o = 0;
	for (const c of carriers) {
		offs.push(o);
		o += c.text.length;
	}
	const out = carriers.map(() => "");
	let k = 0;
	// The last carrier that starts at or before p (p never goes backwards).
	const ownerOf = (p: number): number => {
		while (k + 1 < n && (offs[k + 1] as number) <= p) k++;
		return k;
	};
	const copy = (a: number, b: number) => {
		while (a < b) {
			const at = ownerOf(a);
			const ce = (offs[at] as number) + (carriers[at] as Carrier).text.length;
			const y = Math.min(b, Math.max(ce, a + 1));
			out[at] += text.slice(a, y);
			a = y;
		}
	};
	let pos = 0;
	let any = false;
	// What the values add once escaped: `added` bounds the joined text of this paragraph, `growth`
	// (less the placeholders they replace) the part's projected length.
	let added = 0;
	let growth = 0;
	for (const m of matches) {
		st.seen.add(m.key);
		const v = st.vals.get(m.key);
		let replacement: string;
		if (v !== undefined) {
			replacement = v;
			st.filled.add(m.key);
		} else {
			if (st.missingSet.size < DOC_LIMITS.templateFieldNames) st.missingSet.add(m.key);
			else if (!st.missingSet.has(m.key)) st.missingMore = true;
			if (st.missing === "keep") continue;
			replacement = "";
		}
		st.replaced++;
		if (st.replaced > DOC_LIMITS.templatePlaceholders) throw tooBig("This template has more placeholders than can be filled here (20,000 at most).");
		const cost = v !== undefined ? (st.cost.get(m.key) ?? 0) : 0;
		added += cost;
		growth += cost - (m.end - m.start);
		if (added > DOC_LIMITS.templateUnitOutputChars) throw tooBig(UNIT_TOO_BIG);
		if (part.projected + growth > DOC_LIMITS.templateOutputChars) throw tooBig(PART_TOO_BIG);
		copy(pos, m.start);
		out[ownerOf(m.start)] += replacement;
		pos = m.end;
		any = true;
	}
	if (!any) return;
	copy(pos, text.length);
	// The exact sizes, before any XML is built.
	let unitOut = 0;
	let unitGrowth = 0;
	carriers.forEach((c, i) => {
		const next = out[i] as string;
		if (next === c.text) return;
		const len = editLength(c, next, family, xml);
		unitOut += len;
		const split = family === "pptx" && c.run && next.includes("\n");
		unitGrowth += len - (split && c.run ? c.run.end - c.run.start : c.end - c.start);
	});
	if (unitOut > DOC_LIMITS.templateUnitOutputChars) throw tooBig(UNIT_TOO_BIG);
	if (part.projected + unitGrowth > DOC_LIMITS.templateOutputChars) throw tooBig(PART_TOO_BIG);
	carriers.forEach((c, i) => {
		const next = out[i] as string;
		if (next === c.text) return;
		const split = family === "pptx" && next.includes("\n") ? runSplit(c, xml) : null;
		if (split && c.run) {
			// Split the run: <a:r>…l1</a:r><a:br/><a:r>…l2</a:r>, each keeping the run's formatting.
			const parts = next.split("\n").map((l) => `${split.pre}${carrierXml(c, l, family)}${split.post}`);
			part.add({ start: c.run.start, end: c.run.end, text: parts.join(split.br) });
		} else {
			part.add({ start: c.start, end: c.end, text: carrierXml(c, next, family) });
		}
	});
}

const enc = new TextEncoder();

/** Fills a template. Throws invalid_input under missing "fail" when a field has no value. */
export function fillTemplate(bytes: Uint8Array, family: Family, values: Readonly<Record<string, string>>, missing: MissingPolicy, toDocument: boolean): FillResult {
	const zip = openTemplate(bytes);
	familyCheck(zip, family);
	const st: FillState = { vals: new Map(), cost: new Map(), missing, filled: new Set(), missingSet: new Set(), missingMore: false, seen: new Set(), replaced: 0 };
	for (const [k, v] of Object.entries(values)) {
		st.vals.set(k.trim(), v);
		st.cost.set(k.trim(), measure(v).esc);
	}
	const targets = new Set(partsFor(family, zip.names()));
	const budget: Budget = { carriers: 0, chars: 0 };
	const builder = new ZipBuilder();

	// One pass in the package's own order: each scanned part is read, edited and written before the
	// next is read; everything else is copied still packed.
	for (const e of zip.entries) {
		if (targets.has(e.name)) {
			const xml = loadPart(zip, e.name, budget);
			if (xml === null) {
				builder.copy(zip, e);
				continue;
			}
			const part = new PartFill(builder, e.name, xml);
			scanUnits(
				xml,
				family,
				budget,
				(carriers) => unitEdits(carriers, family, part, st),
				() => part.flush(),
			);
			if (!part.finish()) builder.copy(zip, e);
			continue;
		}
		if (toDocument && e.name.toLowerCase() === "[content_types].xml") {
			const raw = zip.read(e.name);
			if (raw === null) throw new ToolError("unsupported_type", "The template is missing a part it should have.");
			const ct = decodeXmlBytes(raw)
				.replace("wordprocessingml.template.main+xml", "wordprocessingml.document.main+xml")
				.replace("spreadsheetml.template.main+xml", "spreadsheetml.sheet.main+xml")
				.replace("presentationml.template.main+xml", "presentationml.presentation.main+xml");
			builder.addBytes(e.name, enc.encode(ct));
			continue;
		}
		builder.copy(zip, e);
	}

	const missingList = [...st.missingSet].sort();
	if (missing === "fail" && missingList.length > 0) {
		// The names come from the template, which someone else may have written: they never go into
		// an error (errors are plain text, outside the data frame).
		const n = missingList.length;
		throw new ToolError("invalid_input", `The template has ${st.missingMore ? "more than " : ""}${n.toLocaleString("en-GB")} field${n === 1 && !st.missingMore ? "" : "s"} with no value.`, {
			hint: 'docs_list_template_fields lists them. Give a value for each, or use missing "keep" or "blank".',
			field: "values",
		});
	}
	const unused = [...st.vals.keys()].filter((k) => !st.seen.has(k)).sort();
	return { bytes: builder.finish(), filled: [...st.filled].sort(), missing: missingList, unused, missingMore: st.missingMore };
}
