/**
 * Shared pieces of our OOXML writers (DESIGN 12.1): XML escaping, relationship parts, content
 * types and document properties. Every text node and attribute value goes through `esc`, which also
 * drops characters that are illegal in XML 1.0. No external relationships are written except
 * https: and mailto: hyperlinks in Word documents.
 */
import { escapeXml } from "../../core/xml";

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Escapes text and attribute values (and strips characters XML 1.0 forbids). */
export const esc = escapeXml;

export const REL = {
	officeDocument: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
	coreProps: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
	extProps: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
	styles: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
	numbering: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering",
	settings: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings",
	hyperlink: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
	worksheet: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
	slideMaster: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster",
	slideLayout: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout",
	slide: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
	theme: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme",
	notesMaster: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster",
	notesSlide: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide",
	presProps: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps",
	viewProps: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps",
	tableStyles: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles",
} as const;

export const CT = {
	rels: "application/vnd.openxmlformats-package.relationships+xml",
	xml: "application/xml",
	core: "application/vnd.openxmlformats-package.core-properties+xml",
	app: "application/vnd.openxmlformats-officedocument.extended-properties+xml",
	theme: "application/vnd.openxmlformats-officedocument.theme+xml",
} as const;

export interface Rel {
	id: string;
	type: string;
	target: string;
	external?: boolean;
}

export function relsXml(rels: readonly Rel[]): string {
	const items = rels
		.map((r) => `<Relationship Id="${esc(r.id)}" Type="${esc(r.type)}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ""}/>`)
		.join("");
	return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
}

export function contentTypesXml(overrides: ReadonlyArray<readonly [string, string]>): string {
	const o = overrides.map(([part, type]) => `<Override PartName="${esc(part)}" ContentType="${esc(type)}"/>`).join("");
	return `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="${CT.rels}"/><Default Extension="xml" ContentType="${CT.xml}"/>${o}</Types>`;
}

function w3cdtf(d: Date): string {
	return `${d.toISOString().slice(0, 19)}Z`;
}

export function corePropsXml(opts: { title?: string | null; creator?: string | null; now?: Date }): string {
	const now = w3cdtf(opts.now ?? new Date());
	const title = opts.title ? `<dc:title>${esc(opts.title)}</dc:title>` : "";
	const creator = opts.creator ? `<dc:creator>${esc(opts.creator)}</dc:creator><cp:lastModifiedBy>${esc(opts.creator)}</cp:lastModifiedBy>` : "";
	return `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${title}${creator}<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}

export function appPropsXml(): string {
	return `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Nourax Workspace</Application></Properties>`;
}

/** Root relationships of every package: the main part plus the two property parts. */
export function rootRels(mainPart: string): string {
	return relsXml([
		{ id: "rId1", type: REL.officeDocument, target: mainPart },
		{ id: "rId2", type: REL.coreProps, target: "docProps/core.xml" },
		{ id: "rId3", type: REL.extProps, target: "docProps/app.xml" },
	]);
}

/** Text with leading or trailing spaces, tabs or newlines needs xml:space="preserve". */
export function needsPreserve(s: string): boolean {
	return s.length > 0 && (/^\s/.test(s) || /\s$/.test(s) || s.includes("  ") || s.includes("\t") || s.includes("\n"));
}
