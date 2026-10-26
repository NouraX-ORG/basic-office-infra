/**
 * Word (.docx) to Markdown-like text (DESIGN 12.4): headings from the paragraph style (HeadingN,
 * "heading N" or an outline level), lists from numPr with their numbers, tables as Markdown tables,
 * links as [text](url). Tracked insertions are kept and deletions dropped (w:delText is never
 * read). Text boxes are read once (mc:Fallback copies are skipped).
 *
 * Every part is streamed. What is kept is bounded (DOC_LIMITS): one paragraph collects at most
 * 1,000,000 characters, and a table that would pass the 5,000,000-character text cap is written
 * as far as it got and reading stops there.
 */
import { DOC_LIMITS } from "../limits";
import { NS, attr, parsePart, SaxStream, type Tag } from "../sax";
import type { ZipReader } from "../zip";
import { addCapped, joinLines, type TextOut, trimLineEnds } from "./out";
import { readRels, relsPathFor } from "./rels";

interface StyleInfo {
	heading: Map<string, number>;
	/** List numbering set on a paragraph style (python-docx's "List Bullet", Word's list styles). */
	numbering: Map<string, { numId: string; ilvl: number }>;
}

function readStyles(zip: ZipReader): StyleInfo {
	const heading = new Map<string, number>();
	const numbering = new Map<string, { numId: string; ilvl: number }>();
	const basedOn = new Map<string, string>();
	// More styles than this is never a real document; the rest are ignored.
	const full = () => heading.size + numbering.size + basedOn.size >= DOC_LIMITS.tableEntries;
	let id: string | null = null;
	let level: number | null = null;
	let inPPr = false;
	let inNumPr = false;
	let num: { numId: string | null; ilvl: number } = { numId: null, ilvl: 0 };
	parsePart(zip, "word/styles.xml", {
		open(t) {
			if (t.uri !== NS.w) return;
			if (t.local === "style") {
				id = attr(t, NS.w, "styleId") ?? null;
				level = null;
				num = { numId: null, ilvl: 0 };
			} else if (t.local === "name" && id) {
				const name = (attr(t, NS.w, "val") ?? "").toLowerCase();
				const m = /^heading\s?([1-9])$/.exec(name);
				if (m) level = Number(m[1]);
				else if (name === "title") level = 1;
				else if (name === "subtitle") level = 2;
			} else if (t.local === "basedOn" && id) {
				const b = attr(t, NS.w, "val");
				if (b && !full()) basedOn.set(id, b);
			} else if (t.local === "pPr") inPPr = true;
			else if (t.local === "numPr" && inPPr) inNumPr = true;
			else if (t.local === "numId" && inNumPr) num.numId = attr(t, NS.w, "val") ?? null;
			else if (t.local === "ilvl" && inNumPr) num.ilvl = Math.max(0, Math.min(8, Number(attr(t, NS.w, "val") ?? 0) || 0));
			else if (t.local === "outlineLvl" && inPPr && level === null) {
				const v = Number(attr(t, NS.w, "val"));
				if (Number.isInteger(v) && v >= 0 && v < 6) level = v + 1;
			}
		},
		close(t) {
			if (t.uri !== NS.w) return;
			if (t.local === "pPr") inPPr = false;
			else if (t.local === "numPr") inNumPr = false;
			else if (t.local === "style") {
				if (id && level && !full()) heading.set(id, Math.min(6, level));
				if (id && num.numId && !full()) numbering.set(id, { numId: num.numId, ilvl: num.ilvl });
				id = null;
			}
		},
	});
	// Styles inherit numbering through basedOn (a few steps at most).
	for (const sid of basedOn.keys()) {
		if (numbering.has(sid)) continue;
		let cur = basedOn.get(sid);
		for (let k = 0; cur && k < 5; k++) {
			const n = numbering.get(cur);
			if (n) {
				numbering.set(sid, n);
				break;
			}
			cur = basedOn.get(cur);
		}
	}
	return { heading, numbering };
}

interface Numbering {
	ordered(numId: string, ilvl: number): boolean;
}

function readNumbering(zip: ZipReader): Numbering {
	const abstract = new Map<string, Map<number, string>>();
	const num = new Map<string, string>();
	const full = () => abstract.size + num.size >= DOC_LIMITS.tableEntries;
	let aid: string | null = null;
	let lvl: number | null = null;
	let nid: string | null = null;
	parsePart(zip, "word/numbering.xml", {
		open(t) {
			if (t.uri !== NS.w) return;
			if (t.local === "abstractNum") {
				aid = full() ? null : (attr(t, NS.w, "abstractNumId") ?? null);
				if (aid) abstract.set(aid, new Map());
			} else if (t.local === "lvl" && aid) lvl = Number(attr(t, NS.w, "ilvl") ?? 0);
			else if (t.local === "numFmt" && aid && lvl !== null && lvl >= 0 && lvl < 10) abstract.get(aid)?.set(lvl, (attr(t, NS.w, "val") ?? "decimal").slice(0, 64));
			else if (t.local === "num") nid = attr(t, NS.w, "numId") ?? null;
			else if (t.local === "abstractNumId" && nid && !full()) num.set(nid, attr(t, NS.w, "val") ?? "");
		},
		close(t) {
			if (t.uri !== NS.w) return;
			if (t.local === "abstractNum") aid = null;
			else if (t.local === "lvl") lvl = null;
			else if (t.local === "num") nid = null;
		},
	});
	return {
		ordered(numId, ilvl) {
			const fmt = abstract.get(num.get(numId) ?? "")?.get(ilvl);
			return fmt !== undefined && fmt !== "bullet" && fmt !== "none";
		},
	};
}

function cellText(s: string): string {
	return joinLines(s).replace(/\|/g, "\\|");
}

interface Para {
	text: string;
	style: string | null;
	numId: string | null;
	ilvl: number;
	/** Paragraphs from text boxes inside this one, emitted after it. */
	inner: string[];
	innerChars: number;
	link: { start: number; href: string | null } | null;
}

interface Table {
	rows: string[][];
	row: string[] | null;
	cell: string[] | null;
}

function tableMarkdown(rows: string[][]): string {
	let cols = 1;
	for (const r of rows) cols = Math.max(cols, r.length);
	const pad = (r: string[]) => `| ${Array.from({ length: cols }, (_, i) => r[i] ?? "").join(" | ")} |`;
	return [pad(rows[0] as string[]), `|${" --- |".repeat(cols)}`, ...rows.slice(1).map(pad)].join("\n");
}

export function docxText(zip: ZipReader, out: TextOut): void {
	const styles = readStyles(zip);
	const numbering = readNumbering(zip);
	const rels = readRels(zip, relsPathFor("word/document.xml"));
	const counters = new Map<string, number[]>();
	const paras: Para[] = [];
	const tables: Table[] = [];
	// Characters held in open tables; they reach `out` only when the outer table ends.
	let tableChars = 0;
	let inT = false;
	let inRun = 0;
	let inPPr = false;
	let inNumPr = false;
	let skip = 0;

	const finishPara = (p: Para): string => {
		if (!p.numId && p.style) {
			const sn = styles.numbering.get(p.style);
			if (sn) {
				p.numId = sn.numId;
				p.ilvl = p.ilvl || sn.ilvl;
			}
		}
		const text = trimLineEnds(p.text);
		const level = p.style ? styles.heading.get(p.style) : undefined;
		if (level && text.trim()) return `${"#".repeat(level)} ${text.trim()}`;
		if (p.numId && p.numId !== "0" && text.trim()) {
			const ord = numbering.ordered(p.numId, p.ilvl);
			let marker = "-";
			if (ord) {
				const c = counters.get(p.numId) ?? [];
				c[p.ilvl] = (c[p.ilvl] ?? 0) + 1;
				for (let k = p.ilvl + 1; k < c.length; k++) c[k] = 0;
				counters.set(p.numId, c);
				marker = `${c[p.ilvl]}.`;
			}
			return `${"  ".repeat(Math.min(p.ilvl, 8))}${marker} ${text.trim()}`;
		}
		return text;
	};

	/** A table that would pass the text cap: write what there is (cut there) and stop reading. */
	const tableOverflow = () => {
		const outer = tables[0];
		if (outer) {
			const rows = [...outer.rows, ...(outer.row && outer.row.length ? [outer.row] : [])];
			if (rows.length) out.block(tableMarkdown(rows), false);
		}
		out.stop();
	};

	const emitBlock = (s: string, listItem: boolean) => {
		if (tables.length > 0) {
			const t = tables[tables.length - 1] as Table;
			if (t.cell) {
				t.cell.push(s);
				tableChars += s.length + 3;
				if (tableChars > out.room()) tableOverflow();
			}
			return;
		}
		out.block(s, listItem);
	};

	const append = (s: string) => {
		const p = paras[paras.length - 1];
		if (p) p.text = addCapped(p.text, s, DOC_LIMITS.blockChars, out);
	};

	const stream = new SaxStream({
		open(t: Tag) {
			if (skip > 0) {
				skip++;
				return;
			}
			if (t.uri === NS.mc && t.local === "Fallback") {
				skip = 1;
				return;
			}
			if (t.uri !== NS.w) return;
			switch (t.local) {
				case "p":
					paras.push({ text: "", style: null, numId: null, ilvl: 0, inner: [], innerChars: 0, link: null });
					break;
				case "pPr":
					inPPr = true;
					break;
				case "pStyle":
					if (inPPr) {
						const p = paras[paras.length - 1];
						if (p) p.style = attr(t, NS.w, "val") ?? null;
					}
					break;
				case "numPr":
					inNumPr = true;
					break;
				case "ilvl":
					if (inNumPr) {
						const p = paras[paras.length - 1];
						if (p) p.ilvl = Math.max(0, Math.min(8, Number(attr(t, NS.w, "val") ?? 0) || 0));
					}
					break;
				case "numId":
					if (inNumPr) {
						const p = paras[paras.length - 1];
						if (p) p.numId = attr(t, NS.w, "val") ?? null;
					}
					break;
				case "r":
					inRun++;
					break;
				case "t":
					if (inRun > 0) inT = true;
					break;
				case "tab":
					if (inRun > 0 && !inPPr) append("\t");
					break;
				case "br":
				case "cr":
					if (inRun > 0) append("\n");
					break;
				case "noBreakHyphen":
					if (inRun > 0) append("-");
					break;
				case "hyperlink": {
					const p = paras[paras.length - 1];
					const id = attr(t, NS.r, "id");
					const target = id ? rels.get(id) : undefined;
					const href = target && target.external && /^(https?:|mailto:)/i.test(target.target) ? target.target : null;
					if (p) p.link = { start: p.text.length, href };
					break;
				}
				case "tbl":
					tables.push({ rows: [], row: null, cell: null });
					break;
				case "tr": {
					const tb = tables[tables.length - 1];
					if (tb) tb.row = [];
					break;
				}
				case "tc": {
					const tb = tables[tables.length - 1];
					if (tb) tb.cell = [];
					break;
				}
			}
		},
		close(t: Tag) {
			if (skip > 0) {
				skip--;
				return;
			}
			if (t.uri !== NS.w) return;
			switch (t.local) {
				case "t":
					inT = false;
					break;
				case "r":
					inRun = Math.max(0, inRun - 1);
					break;
				case "pPr":
					inPPr = false;
					break;
				case "numPr":
					inNumPr = false;
					break;
				case "hyperlink": {
					const p = paras[paras.length - 1];
					if (p?.link) {
						const label = p.text.slice(p.link.start);
						if (p.link.href && label.trim() && label.trim() !== p.link.href) p.text = `${p.text.slice(0, p.link.start)}[${label}](${p.link.href})`;
						p.link = null;
					}
					break;
				}
				case "p": {
					const p = paras.pop();
					if (!p) break;
					const s = finishPara(p);
					const parent = paras[paras.length - 1];
					const isItem = !!(p.numId && p.numId !== "0" && !(p.style && styles.heading.has(p.style)));
					if (parent) {
						// A text box inside a paragraph: its text follows the outer paragraph.
						for (const x of s.trim() ? [s, ...p.inner] : p.inner) {
							if (parent.innerChars + x.length > DOC_LIMITS.blockChars) {
								out.leftOut();
								break;
							}
							parent.inner.push(x);
							parent.innerChars += x.length;
						}
					} else {
						emitBlock(s, isItem);
						for (const x of p.inner) emitBlock(x, false);
					}
					break;
				}
				case "tc": {
					const tb = tables[tables.length - 1];
					if (tb?.row && tb.cell) tb.row.push(cellText(tb.cell.filter((x) => x.trim()).join(" ")));
					if (tb) tb.cell = null;
					break;
				}
				case "tr": {
					const tb = tables[tables.length - 1];
					if (tb?.row) tb.rows.push(tb.row);
					if (tb) tb.row = null;
					break;
				}
				case "tbl": {
					const tb = tables.pop();
					if (!tb || tb.rows.length === 0) break;
					if (tables.length > 0) {
						// A table inside a table cell: flattened into that cell.
						const parent = tables[tables.length - 1] as Table;
						if (parent.cell) parent.cell.push(tb.rows.map((r) => r.join(", ")).join("; "));
					} else {
						tableChars = 0;
						out.block(tableMarkdown(tb.rows), false);
					}
					break;
				}
			}
		},
		text(s: string) {
			if (skip > 0 || !inT) return;
			append(s);
		},
	});
	const found = zip.streamText("word/document.xml", (chunk) => stream.write(chunk));
	if (!found) out.fail("This Word file has no document part.");
	stream.close();
}
