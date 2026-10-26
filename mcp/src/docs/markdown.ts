/**
 * Our own Markdown subset parser (DESIGN 12.2): a block pass over lines and an inline pass over
 * characters, both linear in time. No regular expression runs over unbounded input, so there is
 * no ReDoS risk. Input is at most 400,000 characters (checked by the tool).
 *
 * Supported: ATX and setext headings, paragraphs, emphasis (* and _, ** and __), ~~strikethrough~~,
 * `inline code`, [links](https://…) and <https://…> autolinks and bare https:// links, bullet
 * (- * +) and ordered (1. or 1)) lists nested by indentation (three levels at most), GFM tables,
 * block quotes, fenced code blocks, horizontal rules and <!-- pagebreak -->. Only https: and
 * mailto: become links; anything else stays text. Raw HTML stays literal text.
 */

export interface Inline {
	text: string;
	b?: true;
	i?: true;
	s?: true;
	code?: true;
	href?: string;
	/** A hard line break (the text is empty). */
	br?: true;
}

export interface ListItem {
	level: 0 | 1 | 2;
	ordered: boolean;
	/** The number of the first item of an ordered run, when it isn't 1. */
	start?: number;
	inlines: Inline[];
}

export type Align = "left" | "center" | "right" | null;

export type Block =
	| { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[] }
	| { kind: "paragraph"; inlines: Inline[] }
	| { kind: "list"; items: ListItem[] }
	| { kind: "quote"; paragraphs: Inline[][] }
	| { kind: "code"; lines: string[]; lang: string | null }
	| { kind: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] }
	| { kind: "hr" }
	| { kind: "pagebreak" };

const MAX_TABLE_COLUMNS = 64;

// ---------------------------------------------------------------- block pass

function indentOf(line: string): number {
	let n = 0;
	for (const ch of line) {
		if (ch === " ") n++;
		else if (ch === "\t") n += 4 - (n % 4);
		else break;
	}
	return n;
}

function isBlank(line: string): boolean {
	for (let i = 0; i < line.length; i++) {
		const c = line.charCodeAt(i);
		if (c !== 32 && c !== 9) return false;
	}
	return true;
}

function isPagebreak(t: string): boolean {
	return t.trim().toLowerCase().replace(/\s+/g, " ") === "<!-- pagebreak -->";
}

function isHr(t: string): boolean {
	const s = t.trim();
	const ch = s[0];
	if (ch !== "-" && ch !== "*" && ch !== "_") return false;
	let n = 0;
	for (const c of s) {
		if (c === ch) n++;
		else if (c !== " " && c !== "\t") return false;
	}
	return n >= 3;
}

function fenceOf(t: string): { ch: "`" | "~"; len: number; info: string } | null {
	const ch = t[0];
	if (ch !== "`" && ch !== "~") return null;
	let n = 0;
	while (t[n] === ch) n++;
	if (n < 3) return null;
	const info = t.slice(n).trim();
	if (ch === "`" && info.includes("`")) return null;
	return { ch, len: n, info };
}

function headingOf(t: string): { level: number; text: string } | null {
	let n = 0;
	while (t[n] === "#" && n < 7) n++;
	if (n === 0 || n > 6) return null;
	const next = t[n];
	if (next !== undefined && next !== " " && next !== "\t") return null;
	let text = t.slice(n).trim();
	// An optional closing run of # preceded by a space.
	let end = text.length;
	while (end > 0 && text[end - 1] === "#") end--;
	if (end === 0) text = "";
	else if (end < text.length && (text[end - 1] === " " || text[end - 1] === "\t")) text = text.slice(0, end).trimEnd();
	return { level: n, text };
}

function listMarker(line: string): { indent: number; ordered: boolean; num: number; content: string } | null {
	const indent = indentOf(line);
	const t = line.trimStart();
	const c = t[0];
	if (c === "-" || c === "*" || c === "+") {
		const next = t[1];
		if (next === undefined || next === " " || next === "\t") return { indent, ordered: false, num: 0, content: t.slice(2).trimStart() };
		return null;
	}
	let n = 0;
	while (n < 9 && t.charCodeAt(n) >= 48 && t.charCodeAt(n) <= 57) n++;
	if (n === 0) return null;
	const d = t[n];
	if (d !== "." && d !== ")") return null;
	const next = t[n + 1];
	if (next !== undefined && next !== " " && next !== "\t") return null;
	return { indent, ordered: true, num: Number.parseInt(t.slice(0, n), 10), content: t.slice(n + 2).trimStart() };
}

/** Splits a table row on unescaped "|", dropping one leading and one trailing pipe. */
export function splitRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
	const cells: string[] = [];
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i] as string;
		if (ch === "\\" && s[i + 1] === "|") {
			cur += "|";
			i++;
		} else if (ch === "|") {
			cells.push(cur.trim());
			cur = "";
			if (cells.length > MAX_TABLE_COLUMNS) break;
		} else cur += ch;
	}
	cells.push(cur.trim());
	return cells.slice(0, MAX_TABLE_COLUMNS);
}

function delimiterRow(line: string): Align[] | null {
	if (!line.includes("-")) return null;
	const cells = splitRow(line);
	const out: Align[] = [];
	for (const c of cells) {
		if (c.length === 0) return null;
		let a = 0;
		let b = c.length;
		const left = c[0] === ":";
		const right = c[c.length - 1] === ":";
		if (left) a++;
		if (right && b - 1 >= a) b--;
		if (b - a < 1) return null;
		for (let i = a; i < b; i++) if (c[i] !== "-") return null;
		out.push(left && right ? "center" : right ? "right" : left ? "left" : null);
	}
	return out;
}

function tableStart(lines: string[], i: number): Align[] | null {
	const head = lines[i];
	const delim = lines[i + 1];
	if (head === undefined || delim === undefined || !head.includes("|")) return null;
	const align = delimiterRow(delim);
	if (!align) return null;
	if (splitRow(head).length !== align.length) return null;
	return align;
}

function quoteStrip(line: string): string | null {
	if (indentOf(line) > 3) return null;
	let t = line.trimStart();
	if (t[0] !== ">") return null;
	// Nested quotes are flattened.
	while (t[0] === ">") {
		t = t.slice(1);
		if (t[0] === " ") t = t.slice(1);
		const u = t.trimStart();
		if (u[0] === ">") t = u;
		else break;
	}
	return t;
}

/** True when the line begins a block other than a paragraph (so it ends a paragraph). */
function startsBlock(lines: string[], i: number): boolean {
	const line = lines[i] ?? "";
	if (indentOf(line) > 3) return false;
	const t = line.trimStart();
	if (isPagebreak(t) || fenceOf(t) || headingOf(t) || isHr(t) || t[0] === ">") return true;
	const m = listMarker(line);
	if (m && m.content !== "" && (!m.ordered || m.num === 1)) return true;
	return tableStart(lines, i) !== null;
}

export function parseMarkdown(src: string): Block[] {
	const lines = src.replace(/\r\n?/g, "\n").split("\n");
	const blocks: Block[] = [];
	let i = 0;
	const n = lines.length;
	while (i < n) {
		const line = lines[i] as string;
		if (isBlank(line)) {
			i++;
			continue;
		}
		const ind = indentOf(line);
		const t = line.trimStart();

		if (ind <= 3 && isPagebreak(t)) {
			blocks.push({ kind: "pagebreak" });
			i++;
			continue;
		}

		const fence = ind <= 3 ? fenceOf(t) : null;
		if (fence) {
			const body: string[] = [];
			i++;
			while (i < n) {
				const l = lines[i] as string;
				const lt = l.trimStart();
				if (indentOf(l) <= 3 && lt[0] === fence.ch) {
					let k = 0;
					while (lt[k] === fence.ch) k++;
					if (k >= fence.len && lt.slice(k).trim() === "") {
						i++;
						break;
					}
				}
				// Remove up to the fence's own indentation.
				let strip = 0;
				while (strip < ind && l[strip] === " ") strip++;
				body.push(l.slice(strip));
				i++;
			}
			blocks.push({ kind: "code", lines: body, lang: fence.info ? fence.info.split(/\s/)[0]?.slice(0, 40) ?? null : null });
			continue;
		}

		const h = ind <= 3 ? headingOf(t) : null;
		if (h) {
			blocks.push({ kind: "heading", level: h.level as 1, inlines: parseInline(h.text) });
			i++;
			continue;
		}

		if (ind <= 3 && isHr(t)) {
			blocks.push({ kind: "hr" });
			i++;
			continue;
		}

		if (quoteStrip(line) !== null) {
			const paras: string[][] = [[]];
			while (i < n) {
				const q = quoteStrip(lines[i] as string);
				if (q === null) {
					// Lazy continuation: a plain line right after quote text continues it.
					const l = lines[i] as string;
					const last = paras[paras.length - 1] as string[];
					if (!isBlank(l) && last.length > 0 && !startsBlock(lines, i)) {
						last.push(l.trim());
						i++;
						continue;
					}
					break;
				}
				if (isBlank(q)) {
					if ((paras[paras.length - 1] as string[]).length > 0) paras.push([]);
				} else (paras[paras.length - 1] as string[]).push(q);
				i++;
			}
			const paragraphs = paras.filter((p) => p.length > 0).map((p) => parseInline(p.join("\n")));
			blocks.push({ kind: "quote", paragraphs });
			continue;
		}

		const align = tableStart(lines, i);
		if (align) {
			const header = splitRow(line).map((c) => parseInline(c));
			const rows: Inline[][][] = [];
			i += 2;
			while (i < n) {
				const l = lines[i] as string;
				if (isBlank(l)) break;
				if (startsBlock(lines, i) && !l.includes("|")) break;
				const cells = splitRow(l);
				const row: Inline[][] = [];
				for (let c = 0; c < align.length; c++) row.push(parseInline(cells[c] ?? ""));
				rows.push(row);
				i++;
			}
			blocks.push({ kind: "table", align, header, rows });
			continue;
		}

		const m = listMarker(line);
		if (m) {
			const items: ListItem[] = [];
			const stack: number[] = [];
			const texts: string[][] = [];
			let prevBlank = false;
			let lastStart: number | null = null;
			let topOrdered: boolean | null = null;
			while (i < n) {
				const l = lines[i] as string;
				if (isBlank(l)) {
					prevBlank = true;
					i++;
					continue;
				}
				const lm = listMarker(l);
				const li = indentOf(l);
				if (lm && !(lm.indent <= 3 && isHr(l.trimStart()))) {
					if (prevBlank && stack.length > 0 && lm.indent < (stack[0] ?? 0)) break;
					if (stack.length === 0) stack.push(lm.indent);
					else if (lm.indent >= (stack[stack.length - 1] as number) + 2) stack.push(lm.indent);
					else while (stack.length > 1 && lm.indent < (stack[stack.length - 1] as number)) stack.pop();
					const level = Math.min(stack.length - 1, 2) as 0 | 1 | 2;
					// A top-level item of the other kind (bullets after numbers, or numbers after bullets)
					// starts a new list, as in CommonMark (fix round 2: the summary counted two lists as one).
					if (level === 0) {
						if (topOrdered !== null && topOrdered !== lm.ordered) break;
						topOrdered = lm.ordered;
					}
					const item: ListItem = { level, ordered: lm.ordered, inlines: [] };
					if (lm.ordered && level === 0 && lm.num !== 1) {
						const prev = items[items.length - 1];
						if (!prev || !prev.ordered || prev.level !== 0) item.start = lm.num;
					}
					items.push(item);
					texts.push([lm.content]);
					lastStart = li;
					prevBlank = false;
					i++;
					continue;
				}
				// A continuation line: lazy (right after the item) or indented after a blank line.
				const cur = texts[texts.length - 1];
				if (!cur) break;
				if (!prevBlank && !startsBlock(lines, i)) {
					cur.push(l.trim());
					i++;
					continue;
				}
				if (prevBlank && lastStart !== null && li >= lastStart + 2 && !fenceOf(l.trimStart())) {
					cur.push("");
					cur.push(l.trim());
					prevBlank = false;
					i++;
					continue;
				}
				break;
			}
			for (let k = 0; k < items.length; k++) {
				const parts = (texts[k] ?? []).join("\n").replace(/\n\n+/g, "\n");
				(items[k] as ListItem).inlines = parseInline(parts);
			}
			blocks.push({ kind: "list", items });
			continue;
		}

		// A paragraph, or a setext heading.
		const para: string[] = [line.trimStart()];
		i++;
		let setext: 1 | 2 | null = null;
		while (i < n) {
			const l = lines[i] as string;
			if (isBlank(l)) break;
			const lt = l.trim();
			if (indentOf(l) <= 3 && lt.length > 0) {
				if (/^=+$/.test(lt)) {
					setext = 1;
					i++;
					break;
				}
				if (/^-+$/.test(lt)) {
					setext = 2;
					i++;
					break;
				}
			}
			if (startsBlock(lines, i)) break;
			para.push(l.trimStart());
			i++;
		}
		const text = para.join("\n");
		if (setext) blocks.push({ kind: "heading", level: setext, inlines: parseInline(text.trim()) });
		else blocks.push({ kind: "paragraph", inlines: parseInline(text) });
	}
	return blocks;
}

// ---------------------------------------------------------------- inline pass

type Node =
	| { t: "text"; v: string }
	| { t: "code"; v: string }
	| { t: "br" }
	| { t: "link"; href: string; kids: Node[] }
	| { t: "delim"; ch: "*" | "_" | "~"; n: number; open: boolean; close: boolean };

const ASCII_PUNCT = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");

function isSpace(ch: string | undefined): boolean {
	return ch === undefined || ch === " " || ch === "\t" || ch === "\n" || ch === " ";
}

const ALNUM = /[\p{L}\p{N}]/u;

function isAlnum(ch: string | undefined): boolean {
	if (ch === undefined) return false;
	return ALNUM.test(ch);
}

// A plausible https URL: host labels of letters, digits and "-", an optional port, then a path,
// query or fragment without spaces, quotes or angle brackets. No nested quantifier can backtrack
// (the label class has no "."), and the URL constructor is never called: in workerd every invalid
// URL it throws on is expensive, which hostile input could repeat thousands of times.
const HTTPS_URL = /^https:\/\/[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.?(?::(\d{1,5}))?(?:[/?#][^\s<>"]*)?$/iu;
const MAILTO = /^mailto:[^\s<>"]+$/i;

/** Only https: and mailto: become links. */
export function safeHref(raw: string): string | null {
	const s = raw.trim();
	if (s.length === 0 || s.length > 2048) return null;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
	if (/[\u0000-\u001f\u007f-\u009f\s<>"\\]/.test(s)) return null;
	const m = HTTPS_URL.exec(s);
	if (m) return m[1] !== undefined && Number(m[1]) > 65535 ? null : s;
	if (MAILTO.test(s)) return s;
	return null;
}

/** Precomputed matches for code spans, brackets and parentheses, so the scan stays linear. */
function matchCodeSpans(s: string): Map<number, number> {
	// Backtick runs: start -> length. Opener at run r closes at the next run of the same length.
	const runs: { pos: number; len: number }[] = [];
	for (let i = 0; i < s.length; ) {
		if (s[i] === "\\" && s[i + 1] === "`") {
			i += 2;
			continue;
		}
		if (s[i] === "`") {
			let j = i;
			while (s[j] === "`") j++;
			runs.push({ pos: i, len: j - i });
			i = j;
		} else i++;
	}
	const byLen = new Map<number, number[]>();
	runs.forEach((r, idx) => {
		const list = byLen.get(r.len) ?? [];
		list.push(idx);
		byLen.set(r.len, list);
	});
	const ptr = new Map<number, number>();
	const out = new Map<number, number>();
	let consumedUntil = -1;
	for (let k = 0; k < runs.length; k++) {
		const r = runs[k] as { pos: number; len: number };
		if (r.pos <= consumedUntil) continue;
		const list = byLen.get(r.len) as number[];
		let p = ptr.get(r.len) ?? 0;
		while (p < list.length && (list[p] as number) <= k) p++;
		ptr.set(r.len, p);
		if (p < list.length) {
			const closer = runs[list[p] as number] as { pos: number; len: number };
			out.set(r.pos, closer.pos);
			consumedUntil = closer.pos + closer.len - 1;
			ptr.set(r.len, p + 1);
		}
	}
	return out;
}

function matchPairs(s: string, open: string, close: string, code: Map<number, number>): Map<number, number> {
	const out = new Map<number, number>();
	const stack: number[] = [];
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		const cEnd = code.get(i);
		if (cEnd !== undefined) {
			let j = cEnd;
			while (s[j] === "`") j++;
			i = j - 1;
			continue;
		}
		if (ch === open) stack.push(i);
		else if (ch === close) {
			const o = stack.pop();
			if (o !== undefined) out.set(o, i);
		}
	}
	return out;
}

/**
 * A linearity instrument for tests (DESIGN 12.2): the characters the trailing-space bookkeeping in
 * tokenize examines. It must stay linear in the input length; a quadratic regression (reading the
 * end of one growing string on every "\n") would blow it up. Off in production (no cost), turned on
 * by the markdown test, where workerd's frozen clock can't catch the regression any other way.
 */
export const scan = { on: false, ops: 0 };

function tokenize(s: string, allowLinks: boolean): Node[] {
	const code = matchCodeSpans(s);
	const brackets = allowLinks ? matchPairs(s, "[", "]", code) : new Map<number, number>();
	const parens = allowLinks ? matchPairs(s, "(", ")", code) : new Map<number, number>();
	const nodes: Node[] = [];
	// Text is collected as pieces and joined once per flush, with a running count of the trailing
	// spaces. Reading or slicing one growing string on every "\n" (buf.endsWith("  "), trimSpacesEnd)
	// flattens a V8 rope each time, which is quadratic on a paragraph of many short lines; pieces plus
	// a counter keep the scan linear (DESIGN 12.2, fix round 3).
	let parts: string[] = [];
	let trail = 0;
	const pushText = (str: string) => {
		if (str.length === 0) return;
		parts.push(str);
		let t = 0;
		while (t < str.length && str.charCodeAt(str.length - 1 - t) === 32) t++;
		if (scan.on) scan.ops += t + 1;
		trail = t === str.length ? trail + t : t;
	};
	// Drops the last `n` characters (all of them trailing spaces, living at the end of `parts`).
	const dropTrailingSpaces = (n: number) => {
		let rem = n;
		while (rem > 0 && parts.length > 0) {
			if (scan.on) scan.ops += 1;
			const last = parts[parts.length - 1] as string;
			if (last.length <= rem) {
				parts.pop();
				rem -= last.length;
			} else {
				parts[parts.length - 1] = last.slice(0, last.length - rem);
				rem = 0;
			}
		}
		trail = 0;
	};
	const flush = () => {
		if (parts.length > 0) {
			const v = parts.length === 1 ? (parts[0] as string) : parts.join("");
			if (v) nodes.push({ t: "text", v });
			parts = [];
		}
		trail = 0;
	};
	let i = 0;
	while (i < s.length) {
		const ch = s[i] as string;
		if (ch === "\\") {
			const nx = s[i + 1];
			if (nx === "\n") {
				flush();
				nodes.push({ t: "br" });
				i += 2;
				continue;
			}
			if (nx !== undefined && ASCII_PUNCT.has(nx)) {
				pushText(nx);
				i += 2;
				continue;
			}
			pushText(ch);
			i++;
			continue;
		}
		if (ch === "\n") {
			// Two or more trailing spaces make a hard break; otherwise the newline becomes a space.
			const hard = trail >= 2;
			dropTrailingSpaces(trail);
			if (hard) {
				flush();
				nodes.push({ t: "br" });
			} else {
				pushText(" ");
			}
			i++;
			while (s[i] === " " || s[i] === "\t") i++;
			continue;
		}
		if (ch === "`") {
			let j = i;
			while (s[j] === "`") j++;
			const closePos = code.get(i);
			if (closePos !== undefined) {
				let inner = s.slice(j, closePos).replace(/\n/g, " ");
				if (inner.length >= 2 && inner[0] === " " && inner[inner.length - 1] === " " && inner.trim() !== "") inner = inner.slice(1, -1);
				flush();
				nodes.push({ t: "code", v: inner });
				i = closePos + (j - i);
				continue;
			}
			pushText(s.slice(i, j));
			i = j;
			continue;
		}
		if (ch === "[" && allowLinks) {
			const close = brackets.get(i);
			if (close !== undefined && s[close + 1] === "(") {
				const pclose = parens.get(close + 1);
				if (pclose !== undefined) {
					let dest = s.slice(close + 2, pclose).trim();
					if (dest.startsWith("<")) {
						const e = dest.indexOf(">");
						dest = e > 0 ? dest.slice(1, e) : dest;
					} else {
						const sp = dest.search(/\s/);
						if (sp >= 0) dest = dest.slice(0, sp);
					}
					const label = s.slice(i + 1, close);
					const href = safeHref(dest);
					flush();
					if (href) nodes.push({ t: "link", href, kids: tokenize(label, false) });
					else {
						for (const k of tokenize(label, false)) nodes.push(k);
						if (dest) nodes.push({ t: "text", v: ` (${dest})` });
					}
					i = pclose + 1;
					continue;
				}
			}
			pushText(ch);
			i++;
			continue;
		}
		if (ch === "<" && allowLinks) {
			// An autolink has no spaces and no "<", so the scan stops at the next candidate: linear.
			let end = i + 1;
			while (end < s.length && end - i < 2050 && s[end] !== ">" && s[end] !== "<" && !isSpace(s[end])) end++;
			if (s[end] === ">" && end > i + 1) {
				const inner = s.slice(i + 1, end);
				const href = safeHref(inner);
				if (href) {
					flush();
					nodes.push({ t: "link", href, kids: [{ t: "text", v: inner.replace(/^mailto:/i, "") }] });
					i = end + 1;
					continue;
				}
			}
			pushText(ch);
			i++;
			continue;
		}
		if (allowLinks && (ch === "h" || ch === "H") && s.slice(i, i + 8).toLowerCase() === "https://" && !isAlnum(s[i - 1])) {
			let j = i + 8;
			while (j < s.length && !isSpace(s[j]) && s[j] !== "<" && j - i < 2048) j++;
			let url = s.slice(i, j);
			let opens = 0;
			let closes = 0;
			for (const c of url) {
				if (c === "(") opens++;
				else if (c === ")") closes++;
			}
			while (url.length > 8 && ".,:;!?)'\"*_~".includes(url[url.length - 1] as string)) {
				if (url.endsWith(")")) {
					if (opens >= closes) break;
					closes--;
				}
				url = url.slice(0, -1);
			}
			const href = safeHref(url);
			flush();
			if (href) nodes.push({ t: "link", href, kids: [{ t: "text", v: url }] });
			else nodes.push({ t: "text", v: url });
			// Never rescan inside the same token (keeps pathological input linear).
			i += url.length;
			continue;
		}
		if (ch === "*" || ch === "_" || ch === "~") {
			let j = i;
			while (s[j] === ch) j++;
			const count = j - i;
			if (ch === "~" && count !== 2) {
				pushText(s.slice(i, j));
				i = j;
				continue;
			}
			const before = i > 0 ? s[i - 1] : undefined;
			const after = s[j];
			let open = !isSpace(after);
			let close = !isSpace(before);
			if (ch === "_") {
				open = open && !isAlnum(before);
				close = close && !isAlnum(after);
			}
			flush();
			nodes.push({ t: "delim", ch, n: count, open, close });
			i = j;
			continue;
		}
		pushText(ch);
		i++;
	}
	flush();
	return nodes;
}

interface Flags {
	b: number;
	i: number;
	s: number;
}

function resolve(nodes: Node[], base: { b?: true; i?: true; s?: true }, href: string | undefined, out: Inline[]): void {
	// Match delimiters with one stack per character; a match drops the other stacks' openers that
	// come after its opener, so ranges never cross. Each node is pushed and popped once: linear.
	type Opener = { idx: number };
	const stacks: Record<string, Opener[]> = { "*": [], _: [], "~": [] };
	const starts = new Map<number, ("b" | "i" | "s")[]>();
	const ends = new Map<number, ("b" | "i" | "s")[]>();
	for (let k = 0; k < nodes.length; k++) {
		const d = nodes[k] as Node;
		if (d.t !== "delim") continue;
		const own = stacks[d.ch] as Opener[];
		if (d.close) {
			while (d.n > 0 && own.length > 0) {
				const op = own[own.length - 1] as Opener;
				const od = nodes[op.idx] as Extract<Node, { t: "delim" }>;
				const use = d.ch === "~" ? 2 : d.n >= 2 && od.n >= 2 ? 2 : 1;
				if (d.ch === "~" && (d.n < 2 || od.n < 2)) break;
				const style = d.ch === "~" ? "s" : use === 2 ? "b" : "i";
				od.n -= use;
				d.n -= use;
				(starts.get(op.idx) ?? starts.set(op.idx, []).get(op.idx))?.push(style);
				(ends.get(k) ?? ends.set(k, []).get(k))?.push(style);
				for (const other of Object.keys(stacks)) {
					if (other === d.ch) continue;
					const st = stacks[other] as Opener[];
					while (st.length > 0 && (st[st.length - 1] as Opener).idx > op.idx) st.pop();
				}
				if (od.n <= 0) own.pop();
			}
		}
		if (d.n > 0 && d.open) own.push({ idx: k });
	}
	const f: Flags = { b: base.b ? 1 : 0, i: base.i ? 1 : 0, s: base.s ? 1 : 0 };
	const emit = (text: string, extra: Partial<Inline> = {}) => {
		if (!text && !extra.br) return;
		const x: Inline = { text };
		if (f.b > 0) x.b = true;
		if (f.i > 0) x.i = true;
		if (f.s > 0) x.s = true;
		if (href) x.href = href;
		Object.assign(x, extra);
		const prev = out[out.length - 1];
		if (prev && !prev.br && !x.br && !prev.code && !x.code && prev.b === x.b && prev.i === x.i && prev.s === x.s && prev.href === x.href) prev.text += x.text;
		else out.push(x);
	};
	for (let k = 0; k < nodes.length; k++) {
		const nd = nodes[k] as Node;
		for (const st of ends.get(k) ?? []) f[st]--;
		switch (nd.t) {
			case "text":
				emit(nd.v);
				break;
			case "code":
				emit(nd.v, { code: true });
				break;
			case "br":
				emit("", { br: true });
				break;
			case "link":
				resolve(nd.kids, { ...(f.b > 0 ? { b: true as const } : {}), ...(f.i > 0 ? { i: true as const } : {}), ...(f.s > 0 ? { s: true as const } : {}) }, nd.href, out);
				break;
			case "delim":
				if (nd.n > 0) emit(nd.ch.repeat(nd.n));
				break;
		}
		for (const st of starts.get(k) ?? []) f[st]++;
	}
}

export function parseInline(s: string): Inline[] {
	const out: Inline[] = [];
	resolve(tokenize(s, true), {}, undefined, out);
	// Trim a trailing space left by line joins.
	const last = out[out.length - 1];
	if (last && !last.br && !last.code) last.text = last.text.trimEnd();
	return out.filter((x) => x.br || x.text.length > 0);
}

/** The plain text of inlines (for titles and tests). */
export function plainText(inlines: readonly Inline[]): string {
	return inlines.map((x) => (x.br ? "\n" : x.text)).join("");
}
