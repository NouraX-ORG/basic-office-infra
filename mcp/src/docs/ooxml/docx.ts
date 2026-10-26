/**
 * The Word (.docx) writer (DESIGN 12.1): our own minimal template (content types, relationships,
 * styles in the Nourax colours, numbering and settings) plus a body built from the Markdown blocks.
 * Headings use the built-in Heading styles, lists use numbering.xml (three levels), tables use a
 * bordered style with a bold header row, links are hyperlink relationships (https: and mailto:).
 */
import type { Align, Block, Inline } from "../markdown";
import { writeZip } from "../zip";
import { appPropsXml, contentTypesXml, corePropsXml, esc, REL, type Rel, relsXml, rootRels, XML_HEAD } from "./common";

export type PageSize = "A4" | "Letter";

const PAGE: Record<PageSize, { w: number; h: number }> = {
	A4: { w: 11906, h: 16838 },
	Letter: { w: 12240, h: 15840 },
};
const MARGIN = 1440;

const W_NS =
	'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const COBALT = "2563EB";
const SLATE = "1E293B";
const MUTED = "475569";
const RULE = "CBD5E1";
const CODE_BG = "F1F5F9";
const HEADER_BG = "DBEAFE";

const FONT = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>';
const MONO = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/>';

function headingStyle(level: number): string {
	const sizes = [0, 32, 28, 26, 24, 22, 22];
	const color = level <= 2 ? COBALT : SLATE;
	const italic = level === 6 ? "<w:i/>" : "";
	return (
		`<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>` +
		`<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${level === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
		`<w:rPr><w:b/><w:bCs/>${italic}<w:color w:val="${color}"/><w:sz w:val="${sizes[level]}"/><w:szCs w:val="${sizes[level]}"/></w:rPr></w:style>`
	);
}

const STYLES = `${XML_HEAD}<w:styles ${W_NS}>
<w:docDefaults><w:rPrDefault><w:rPr>${FONT}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="0F172A"/></w:rPr></w:style>
<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:semiHidden/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:color w:val="${COBALT}"/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>
${[1, 2, 3, 4, 5, 6].map(headingStyle).join("\n")}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="${COBALT}"/></w:pBdr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="${MUTED}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="NxCodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="${CODE_BG}"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:contextualSpacing/></w:pPr><w:rPr>${MONO}<w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:customStyle="1" w:styleId="NxCode"><w:name w:val="Inline Code"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr>${MONO}<w:sz w:val="20"/><w:szCs w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="${CODE_BG}"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="${COBALT}"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:customStyle="1" w:styleId="NxTable"><w:name w:val="Nourax Table"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="${RULE}"/><w:left w:val="single" w:sz="4" w:space="0" w:color="${RULE}"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="${RULE}"/><w:right w:val="single" w:sz="4" w:space="0" w:color="${RULE}"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="${RULE}"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="${RULE}"/></w:tblBorders><w:tblCellMar><w:top w:w="57" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="57" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:bCs/></w:rPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="${HEADER_BG}"/></w:tcPr></w:tblStylePr></w:style>
</w:styles>`;

const BULLETS = ["•", "◦", "▪"];
const ORDERED: [string, string][] = [
	["decimal", "%1."],
	["lowerLetter", "%2."],
	["lowerRoman", "%3."],
];

function numberingXml(orderedStarts: { level: number; start: number }[]): string {
	const lvl = (i: number, fmt: string, text: string, font: string) =>
		`<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${esc(text)}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr>${font}</w:lvl>`;
	const bullet = `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${BULLETS.map((b, i) => lvl(i, "bullet", b, `<w:rPr>${FONT}</w:rPr>`)).join("")}</w:abstractNum>`;
	const ordered = `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${ORDERED.map(([f, t], i) => lvl(i, f, t, "")).join("")}</w:abstractNum>`;
	const nums = [`<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`];
	orderedStarts.forEach((o, k) => {
		nums.push(`<w:num w:numId="${k + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="${o.level}"><w:startOverride w:val="${o.start}"/></w:lvlOverride></w:num>`);
	});
	return `${XML_HEAD}<w:numbering ${W_NS}>${bullet}${ordered}${nums.join("")}</w:numbering>`;
}

const SETTINGS = `${XML_HEAD}<w:settings ${W_NS}><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

class Body {
	readonly parts: string[] = [];
	readonly links: Rel[] = [];
	readonly orderedStarts: { level: number; start: number }[] = [];
	private linkIds = new Map<string, string>();

	linkId(href: string): string {
		let id = this.linkIds.get(href);
		if (!id) {
			id = `rIdL${this.links.length + 1}`;
			this.linkIds.set(href, id);
			this.links.push({ id, type: REL.hyperlink, target: href, external: true });
		}
		return id;
	}

	newOrdered(level: number, start: number): number {
		this.orderedStarts.push({ level, start });
		return this.orderedStarts.length + 1;
	}
}

function textRuns(text: string): string {
	// Tabs become <w:tab/>; every text node keeps its spaces.
	return text
		.split("\t")
		.map((t, i) => `${i > 0 ? "<w:tab/>" : ""}${t ? `<w:t xml:space="preserve">${esc(t)}</w:t>` : ""}`)
		.join("");
}

function run(x: Inline, forceBold = false): string {
	if (x.br) return "<w:r><w:br/></w:r>";
	const p: string[] = [];
	if (x.code) p.push('<w:rStyle w:val="NxCode"/>');
	else if (x.href) p.push('<w:rStyle w:val="Hyperlink"/>');
	if (x.b || forceBold) p.push("<w:b/><w:bCs/>");
	if (x.i) p.push("<w:i/><w:iCs/>");
	if (x.s) p.push("<w:strike/>");
	const rPr = p.length ? `<w:rPr>${p.join("")}</w:rPr>` : "";
	return `<w:r>${rPr}${textRuns(x.text)}</w:r>`;
}

function runs(body: Body, inlines: readonly Inline[], forceBold = false): string {
	let out = "";
	let k = 0;
	while (k < inlines.length) {
		const x = inlines[k] as Inline;
		if (x.href) {
			const href = x.href;
			let group = "";
			while (k < inlines.length && (inlines[k] as Inline).href === href) {
				group += run(inlines[k] as Inline, forceBold);
				k++;
			}
			out += `<w:hyperlink r:id="${body.linkId(href)}" w:history="1">${group}</w:hyperlink>`;
			continue;
		}
		out += run(x, forceBold);
		k++;
	}
	return out;
}

function para(pPr: string, content: string): string {
	return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${content}</w:p>`;
}

function jc(a: Align): string {
	return a === "center" ? '<w:jc w:val="center"/>' : a === "right" ? '<w:jc w:val="right"/>' : "";
}

function table(body: Body, b: Extract<Block, { kind: "table" }>, textWidth: number): string {
	const cols = Math.max(1, b.header.length);
	const w = Math.floor(textWidth / cols);
	const grid = Array.from({ length: cols }, () => `<w:gridCol w:w="${w}"/>`).join("");
	const cell = (inl: Inline[], a: Align, header: boolean) =>
		`<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${header ? `<w:shd w:val="clear" w:color="auto" w:fill="${HEADER_BG}"/>` : ""}</w:tcPr>${para(jc(a), runs(body, inl, header))}</w:tc>`;
	const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${b.header.map((c, i) => cell(c, b.align[i] ?? null, true)).join("")}</w:tr>`;
	const rows = b.rows.map((r) => `<w:tr>${Array.from({ length: cols }, (_, i) => cell(r[i] ?? [], b.align[i] ?? null, false)).join("")}</w:tr>`).join("");
	return `<w:tbl><w:tblPr><w:tblStyle w:val="NxTable"/><w:tblW w:w="${w * cols}" w:type="dxa"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${head}${rows}</w:tbl>`;
}

function list(body: Body, b: Extract<Block, { kind: "list" }>): string {
	// A new numbering instance for each run of ordered items at a level, so numbers restart where a
	// reader expects them to (after a shallower item or after bullets at the same level).
	const current: (number | null)[] = [null, null, null];
	let out = "";
	for (const item of b.items) {
		for (let l = item.level + 1; l < 3; l++) current[l] = null;
		let numId = 1;
		if (item.ordered) {
			let id = current[item.level];
			if (id === null || id === undefined) {
				id = body.newOrdered(item.level, item.start ?? 1);
				current[item.level] = id;
			}
			numId = id;
		} else current[item.level] = null;
		out += para(`<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${item.level}"/><w:numId w:val="${numId}"/></w:numPr>`, runs(body, item.inlines));
	}
	return out;
}

export interface DocxOptions {
	title?: string | null;
	creator?: string | null;
	pageSize?: PageSize;
}

/** Builds a complete .docx from Markdown blocks. */
export function buildDocx(blocks: readonly Block[], opts: DocxOptions = {}): Uint8Array {
	const page = PAGE[opts.pageSize ?? "A4"];
	const textWidth = page.w - 2 * MARGIN;
	const body = new Body();
	let lastWasTable = false;
	for (const b of blocks) {
		lastWasTable = false;
		switch (b.kind) {
			case "heading":
				body.parts.push(para(`<w:pStyle w:val="Heading${b.level}"/>`, runs(body, b.inlines)));
				break;
			case "paragraph":
				body.parts.push(para("", runs(body, b.inlines)));
				break;
			case "list":
				body.parts.push(list(body, b));
				break;
			case "quote":
				for (const p of b.paragraphs) body.parts.push(para('<w:pStyle w:val="Quote"/>', runs(body, p)));
				break;
			case "code": {
				const lines = b.lines.length ? b.lines : [""];
				for (const l of lines) body.parts.push(para('<w:pStyle w:val="NxCodeBlock"/>', l ? `<w:r>${textRuns(l)}</w:r>` : ""));
				// A small gap after the block.
				body.parts.push(para('<w:spacing w:after="0"/>', ""));
				break;
			}
			case "table":
				body.parts.push(table(body, b, textWidth));
				lastWasTable = true;
				break;
			case "hr":
				body.parts.push(para(`<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="${RULE}"/></w:pBdr>`, ""));
				break;
			case "pagebreak":
				body.parts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
				break;
		}
	}
	if (body.parts.length === 0 || lastWasTable) body.parts.push("<w:p/>");
	const sect = `<w:sectPr><w:pgSz w:w="${page.w}" w:h="${page.h}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/></w:sectPr>`;
	const document = `${XML_HEAD}<w:document ${W_NS}><w:body>${body.parts.join("")}${sect}</w:body></w:document>`;
	const docRels = relsXml([
		{ id: "rId1", type: REL.styles, target: "styles.xml" },
		{ id: "rId2", type: REL.numbering, target: "numbering.xml" },
		{ id: "rId3", type: REL.settings, target: "settings.xml" },
		...body.links,
	]);
	const W = "application/vnd.openxmlformats-officedocument.wordprocessingml";
	return writeZip([
		[
			"[Content_Types].xml",
			contentTypesXml([
				["/word/document.xml", `${W}.document.main+xml`],
				["/word/styles.xml", `${W}.styles+xml`],
				["/word/numbering.xml", `${W}.numbering+xml`],
				["/word/settings.xml", `${W}.settings+xml`],
				["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"],
				["/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"],
			]),
		],
		["_rels/.rels", rootRels("word/document.xml")],
		["docProps/core.xml", corePropsXml({ title: opts.title, creator: opts.creator })],
		["docProps/app.xml", appPropsXml()],
		["word/document.xml", document],
		["word/_rels/document.xml.rels", docRels],
		["word/styles.xml", STYLES],
		["word/numbering.xml", numberingXml(body.orderedStarts)],
		["word/settings.xml", SETTINGS],
	]);
}

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
