/**
 * PowerPoint (.pptx) to text (DESIGN 12.4): slides in the order of p:sldIdLst, each as
 * "## Slide N: title", then the other text of the slide (bullet levels indented), then its
 * speaker notes. Field text (slide numbers, dates) is left out.
 */
import { ToolError } from "../../core/errors";
import { attr, NS, parsePart, SaxStream } from "../sax";
import { DOC_LIMITS } from "../limits";
import type { ZipReader } from "../zip";
import { addCapped, joinLines, type TextOut } from "./out";
import { readRels, relsPathFor, resolvePart } from "./rels";

const REL_SLIDE = "/slide";
const REL_NOTES = "/notesSlide";

function slideParts(zip: ZipReader): string[] {
	if (!zip.has("ppt/presentation.xml")) throw new ToolError("unsupported_type", "This PowerPoint file has no presentation part.");
	const rels = readRels(zip, relsPathFor("ppt/presentation.xml"));
	const out: string[] = [];
	parsePart(zip, "ppt/presentation.xml", {
		open(t) {
			if (t.uri === NS.p && t.local === "sldId" && out.length < 10_000) {
				const rid = attr(t, NS.r, "id");
				const rel = rid ? rels.get(rid) : undefined;
				if (rel && !rel.external && rel.type.endsWith(REL_SLIDE)) out.push(resolvePart("ppt/presentation.xml", rel.target));
			}
		},
	});
	return out;
}

interface Shape {
	title: boolean;
	body: boolean;
	lines: string[];
}

/**
 * Reads one slide or notes part into shapes with their paragraphs. A part keeps at most `room`
 * characters (what the text cap still allows); `full` then says reading should stop after it.
 */
function readShapes(zip: ZipReader, part: string, room: number, out: TextOut): { shapes: Shape[]; hidden: boolean; full: boolean } | null {
	const shapes: Shape[] = [];
	const stack: Shape[] = [];
	let hidden = false;
	let para: string | null = null;
	let level = 0;
	let inT = false;
	let fld = 0;
	let row: string[] | null = null;
	let cell: string[] | null = null;
	let kept = 0;
	let full = false;
	const keep = (n: number): boolean => {
		if (kept + n > room) {
			full = true;
			return false;
		}
		kept += n;
		return true;
	};
	const stream = new SaxStream({
		open(t) {
			if (t.uri === NS.p && (t.local === "sld" || t.local === "notes")) hidden = attr(t, null, "show") === "0";
			if (t.uri === NS.p && (t.local === "sp" || t.local === "graphicFrame")) {
				const s: Shape = { title: false, body: false, lines: [] };
				stack.push(s);
				shapes.push(s);
				return;
			}
			if (t.uri === NS.p && t.local === "ph") {
				const s = stack[stack.length - 1];
				const type = attr(t, null, "type") ?? "obj";
				if (s) {
					s.title = type === "title" || type === "ctrTitle";
					s.body = type === "body" || type === "obj" || type === "subTitle";
				}
				return;
			}
			if (t.uri !== NS.a) return;
			switch (t.local) {
				case "tr":
					row = [];
					break;
				case "tc":
					cell = [];
					break;
				case "p":
					para = "";
					level = 0;
					break;
				case "pPr":
					level = Math.max(0, Math.min(8, Number(attr(t, null, "lvl") ?? 0) || 0));
					break;
				case "fld":
					fld++;
					break;
				case "t":
					if (fld === 0) inT = true;
					break;
				case "br":
					if (para !== null) para = addCapped(para, "\n", DOC_LIMITS.blockChars, out);
					break;
			}
		},
		close(t) {
			if (t.uri === NS.p && (t.local === "sp" || t.local === "graphicFrame")) {
				stack.pop();
				return;
			}
			if (t.uri !== NS.a) return;
			switch (t.local) {
				case "t":
					inT = false;
					break;
				case "fld":
					fld--;
					break;
				case "p": {
					const s = stack[stack.length - 1];
					const text = (para ?? "").trim();
					if (cell) {
						if (text && keep(text.length + 1)) cell.push(text);
					} else if (s && text && keep(text.length + 1)) s.lines.push(`${"  ".repeat(level)}${text}`);
					para = null;
					break;
				}
				case "tc":
					if (row && cell && row.length >= 1_000 && cell.length) out.leftOut();
					if (row && cell && row.length < 1_000) row.push(cell.join(" ").replace(/\|/g, "\\|"));
					cell = null;
					break;
				case "tr": {
					const s = stack[stack.length - 1];
					if (s && row && row.some((c) => c)) s.lines.push(`| ${row.join(" | ")} |`);
					row = null;
					break;
				}
			}
		},
		text(x) {
			if (inT && para !== null) para = addCapped(para, x, DOC_LIMITS.blockChars, out);
		},
	});
	if (!zip.streamText(part, (c) => stream.write(c))) return null;
	stream.close();
	return { shapes, hidden, full };
}

export function pptxText(zip: ZipReader, out: TextOut): { slides: number } {
	const parts = slideParts(zip);
	parts.forEach((part, i) => {
		const r = readShapes(zip, part, out.room() + 1, out);
		if (!r) return;
		const title = r.shapes.find((s) => s.title)?.lines.join(" ").trim() ?? "";
		out.block(`## Slide ${i + 1}${title ? `: ${joinLines(title)}` : ""}${r.hidden ? " (hidden)" : ""}`);
		const body = r.shapes.filter((s) => !s.title).flatMap((s) => s.lines);
		if (body.length) out.block(body.join("\n"));
		const notesRel = [...readRels(zip, relsPathFor(part)).values()].find((x) => !x.external && x.type.endsWith(REL_NOTES));
		if (notesRel) {
			const n = readShapes(zip, resolvePart(part, notesRel.target), out.room() + 1, out);
			const notes = n?.shapes.filter((s) => s.body).flatMap((s) => s.lines) ?? [];
			if (notes.length) out.block(`Notes: ${notes.join("\n")}`);
			if (n?.full) out.stop();
		}
		if (r.full) out.stop();
	});
	return { slides: parts.length };
}
