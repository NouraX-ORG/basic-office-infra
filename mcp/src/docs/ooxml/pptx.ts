/**
 * The PowerPoint (.pptx) writer (DESIGN 12.1): 16:9, one slide master, three layouts (title,
 * title and content, section header), a theme with the Nourax cobalt accent, bullets on two
 * levels, body text and speaker notes (a notes master plus one notes slide per slide that has
 * notes). No images.
 */
import { writeZip } from "../zip";
import { appPropsXml, CT, contentTypesXml, corePropsXml, esc, REL, type Rel, relsXml, rootRels, XML_HEAD } from "./common";

export type SlideLayout = "title" | "content" | "section";

export interface SlideSpec {
	title: string;
	layout: SlideLayout;
	/** Bullets with level 0 or 1. */
	bullets: { text: string; level: 0 | 1 }[];
	body: string;
	notes: string;
}

const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const NOTES_W = 6858000;
const NOTES_H = 9144000;

const GRP = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
const CLR_MAP = `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>`;

function xfrm(x: number, y: number, cx: number, cy: number): string {
	return `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
}

function phShape(id: number, name: string, ph: string, spPr: string, txBody: string): string {
	return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${spPr}</p:spPr>${txBody}</p:sp>`;
}

function themeXml(name: string): string {
	const c = (n: string, rgb: string) => `<a:${n}><a:srgbClr val="${rgb}"/></a:${n}>`;
	const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
	const ln = (w: number) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
	const font = (t: string) => `<a:latin typeface="${t}"/><a:ea typeface=""/><a:cs typeface=""/>`;
	return `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${esc(name)}"><a:themeElements><a:clrScheme name="Nourax">${c("dk1", "0F172A")}${c("lt1", "FFFFFF")}${c("dk2", "1E293B")}${c("lt2", "F8FAFC")}${c("accent1", "2563EB")}${c("accent2", "F97316")}${c("accent3", "3B82F6")}${c("accent4", "EA580C")}${c("accent5", "64748B")}${c("accent6", "0EA5E9")}${c("hlink", "2563EB")}${c("folHlink", "7C3AED")}</a:clrScheme><a:fontScheme name="Nourax"><a:majorFont>${font("Calibri")}</a:majorFont><a:minorFont>${font("Calibri")}</a:minorFont></a:fontScheme><a:fmtScheme name="Nourax"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${ln(6350)}${ln(12700)}${ln(19050)}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

function lvlPPr(n: number, marL: number, bullet: string | null, size: number, extra = ""): string {
	const bu = bullet ? `<a:buFont typeface="Arial"/><a:buChar char="${bullet}"/>` : "<a:buNone/>";
	return `<a:lvl${n}pPr marL="${marL}" indent="${bullet ? -228600 : 0}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="${n === 1 ? 1000 : 500}"/></a:spcBef>${bu}<a:defRPr sz="${size}" kern="1200"${extra}><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`;
}

const BODY_LEVELS = [
	lvlPPr(1, 228600, "•", 2800),
	lvlPPr(2, 685800, "–", 2400),
	lvlPPr(3, 1143000, "•", 2000),
	lvlPPr(4, 1600200, "–", 2000),
	lvlPPr(5, 2057400, "•", 2000),
	lvlPPr(6, 2514600, "•", 2000),
	lvlPPr(7, 2971800, "•", 2000),
	lvlPPr(8, 3429000, "•", 2000),
	lvlPPr(9, 3886200, "•", 2000),
].join("");

const TITLE_STYLE = `<p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4000" b="1" kern="1200"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>`;
const OTHER_STYLE = `<p:otherStyle><a:defPPr><a:defRPr lang="en-GB"/></a:defPPr>${lvlPPr(1, 0, null, 1800)}</p:otherStyle>`;

const TITLE_BOX = xfrm(838200, 365125, 10515600, 1325563);
const BODY_BOX = xfrm(838200, 1825625, 10515600, 4351338);

const EMPTY_TX = `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-GB"/></a:p></p:txBody>`;

function masterXml(): string {
	const title = phShape(2, "Title Placeholder 1", '<p:ph type="title"/>', `${TITLE_BOX}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`, `<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:endParaRPr lang="en-GB"/></a:p></p:txBody>`);
	const body = phShape(3, "Text Placeholder 2", '<p:ph type="body" idx="1"/>', `${BODY_BOX}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`, `<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr lvl="0"/><a:endParaRPr lang="en-GB"/></a:p></p:txBody>`);
	// A thin cobalt bar along the top: the Nourax accent on every slide.
	const bar = `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Accent Bar"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr>${xfrm(0, 0, SLIDE_W, 91440)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-GB"/></a:p></p:txBody></p:sp>`;
	return `${XML_HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}${title}${body}${bar}</p:spTree></p:cSld>${CLR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/><p:sldLayoutId id="2147483651" r:id="rId3"/></p:sldLayoutIdLst><p:txStyles>${TITLE_STYLE}<p:bodyStyle>${BODY_LEVELS}</p:bodyStyle>${OTHER_STYLE}</p:txStyles></p:sldMaster>`;
}

function layoutXml(kind: SlideLayout): string {
	let name: string;
	let type: string;
	let shapes: string;
	if (kind === "title") {
		name = "Title Slide";
		type = "title";
		shapes =
			phShape(2, "Title 1", '<p:ph type="ctrTitle"/>', xfrm(1524000, 1122363, 9144000, 2387600), `<p:txBody><a:bodyPr anchor="b"><a:normAutofit/></a:bodyPr><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="5400"/></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr lang="en-GB"/></a:p></p:txBody>`) +
			phShape(3, "Subtitle 2", '<p:ph type="subTitle" idx="1"/>', xfrm(1524000, 3602038, 9144000, 1655762), `<p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2400"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr lang="en-GB"/></a:p></p:txBody>`);
	} else if (kind === "section") {
		name = "Section Header";
		type = "secHead";
		shapes =
			phShape(2, "Title 1", '<p:ph type="title"/>', xfrm(831850, 1709738, 10515600, 2852737), `<p:txBody><a:bodyPr anchor="b"><a:normAutofit/></a:bodyPr><a:lstStyle><a:lvl1pPr><a:defRPr sz="5400"/></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr lang="en-GB"/></a:p></p:txBody>`) +
			phShape(3, "Text Placeholder 2", '<p:ph type="body" idx="1"/>', xfrm(831850, 4589463, 10515600, 1500187), `<p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle><a:lvl1pPr marL="0" indent="0"><a:buNone/><a:defRPr sz="2400"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr lang="en-GB"/></a:p></p:txBody>`);
	} else {
		name = "Title and Content";
		type = "obj";
		shapes = phShape(2, "Title 1", '<p:ph type="title"/>', "", EMPTY_TX) + phShape(3, "Content Placeholder 2", '<p:ph idx="1"/>', "", EMPTY_TX);
	}
	return `${XML_HEAD}<p:sldLayout ${NS} type="${type}" preserve="1"><p:cSld name="${name}"><p:spTree>${GRP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

const LAYOUT_FILE: Record<SlideLayout, number> = { title: 1, content: 2, section: 3 };

function paragraphs(text: string, pPr = ""): string {
	const lines = text.split("\n");
	return lines.map((l) => `<a:p>${pPr}${l ? `<a:r><a:rPr lang="en-GB" dirty="0"/><a:t>${esc(l)}</a:t></a:r>` : '<a:endParaRPr lang="en-GB"/>'}</a:p>`).join("");
}

function slideXml(s: SlideSpec): string {
	const titlePh = s.layout === "title" ? '<p:ph type="ctrTitle"/>' : '<p:ph type="title"/>';
	const title = phShape(2, "Title 1", titlePh, "", `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs(s.title || "")}</p:txBody>`);
	let second = "";
	if (s.layout === "content") {
		let body = "";
		if (s.bullets.length) {
			body = s.bullets.map((b) => `<a:p>${b.level ? '<a:pPr lvl="1"/>' : ""}<a:r><a:rPr lang="en-GB" dirty="0"/><a:t>${esc(b.text)}</a:t></a:r></a:p>`).join("");
			if (s.body) body += paragraphs(s.body, '<a:pPr marL="0" indent="0"><a:buNone/></a:pPr>');
		} else if (s.body) body = paragraphs(s.body, '<a:pPr marL="0" indent="0"><a:buNone/></a:pPr>');
		if (body) second = phShape(3, "Content Placeholder 2", '<p:ph idx="1"/>', "", `<p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody>`);
	} else {
		const text = [s.body, ...s.bullets.map((b) => b.text)].filter(Boolean).join("\n");
		const ph = s.layout === "title" ? '<p:ph type="subTitle" idx="1"/>' : '<p:ph type="body" idx="1"/>';
		if (text) second = phShape(3, s.layout === "title" ? "Subtitle 2" : "Text Placeholder 2", ph, "", `<p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs(text)}</p:txBody>`);
	}
	return `${XML_HEAD}<p:sld ${NS}><p:cSld><p:spTree>${GRP}${title}${second}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function notesMasterXml(): string {
	const img = phShape(2, "Slide Image Placeholder 1", '<p:ph type="sldImg" idx="2"/>', `${xfrm(685800, 1143000, 5486400, 3086100)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln>`, "");
	const body = phShape(3, "Notes Placeholder 2", '<p:ph type="body" sz="quarter" idx="3"/>', `${xfrm(685800, 4400550, 5486400, 3600450)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`, `<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:endParaRPr lang="en-GB"/></a:p></p:txBody>`);
	const notesStyle = `<p:notesStyle>${lvlPPr(1, 0, null, 1200)}</p:notesStyle>`;
	return `${XML_HEAD}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}${img}${body}</p:spTree></p:cSld>${CLR_MAP}${notesStyle}</p:notesMaster>`;
}

function notesSlideXml(notes: string): string {
	const img = phShape(2, "Slide Image Placeholder 1", '<p:ph type="sldImg"/>', "", "");
	const body = phShape(3, "Notes Placeholder 2", '<p:ph type="body" idx="1"/>', "", `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs(notes)}</p:txBody>`);
	return `${XML_HEAD}<p:notes ${NS}><p:cSld><p:spTree>${GRP}${img}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

export function buildPptx(slides: readonly SlideSpec[], opts: { title?: string | null; creator?: string | null } = {}): Uint8Array {
	const P = "application/vnd.openxmlformats-officedocument.presentationml";
	const presRels: Rel[] = [{ id: "rId1", type: REL.slideMaster, target: "slideMasters/slideMaster1.xml" }];
	slides.forEach((_, i) => presRels.push({ id: `rId${i + 2}`, type: REL.slide, target: `slides/slide${i + 1}.xml` }));
	const n = slides.length;
	presRels.push(
		{ id: `rId${n + 2}`, type: REL.notesMaster, target: "notesMasters/notesMaster1.xml" },
		{ id: `rId${n + 3}`, type: REL.theme, target: "theme/theme1.xml" },
		{ id: `rId${n + 4}`, type: REL.presProps, target: "presProps.xml" },
		{ id: `rId${n + 5}`, type: REL.viewProps, target: "viewProps.xml" },
		{ id: `rId${n + 6}`, type: REL.tableStyles, target: "tableStyles.xml" },
	);
	const sldIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("");
	const presentation = `${XML_HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId${n + 2}"/></p:notesMasterIdLst><p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="${NOTES_W}" cy="${NOTES_H}"/></p:presentation>`;

	const overrides: [string, string][] = [
		["/ppt/presentation.xml", `${P}.presentation.main+xml`],
		["/ppt/slideMasters/slideMaster1.xml", `${P}.slideMaster+xml`],
		["/ppt/slideLayouts/slideLayout1.xml", `${P}.slideLayout+xml`],
		["/ppt/slideLayouts/slideLayout2.xml", `${P}.slideLayout+xml`],
		["/ppt/slideLayouts/slideLayout3.xml", `${P}.slideLayout+xml`],
		["/ppt/notesMasters/notesMaster1.xml", `${P}.notesMaster+xml`],
		["/ppt/theme/theme1.xml", CT.theme],
		["/ppt/theme/theme2.xml", CT.theme],
		["/ppt/presProps.xml", `${P}.presProps+xml`],
		["/ppt/viewProps.xml", `${P}.viewProps+xml`],
		["/ppt/tableStyles.xml", `${P}.tableStyles+xml`],
		["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"],
		["/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"],
	];
	const parts: [string, string][] = [];
	slides.forEach((s, i) => {
		const k = i + 1;
		overrides.push([`/ppt/slides/slide${k}.xml`, `${P}.slide+xml`]);
		const rels: Rel[] = [{ id: "rId1", type: REL.slideLayout, target: `../slideLayouts/slideLayout${LAYOUT_FILE[s.layout]}.xml` }];
		if (s.notes) {
			overrides.push([`/ppt/notesSlides/notesSlide${k}.xml`, `${P}.notesSlide+xml`]);
			rels.push({ id: "rId2", type: REL.notesSlide, target: `../notesSlides/notesSlide${k}.xml` });
			parts.push([`ppt/notesSlides/notesSlide${k}.xml`, notesSlideXml(s.notes)]);
			parts.push([
				`ppt/notesSlides/_rels/notesSlide${k}.xml.rels`,
				relsXml([
					{ id: "rId1", type: REL.notesMaster, target: "../notesMasters/notesMaster1.xml" },
					{ id: "rId2", type: REL.slide, target: `../slides/slide${k}.xml` },
				]),
			]);
		}
		parts.push([`ppt/slides/slide${k}.xml`, slideXml(s)]);
		parts.push([`ppt/slides/_rels/slide${k}.xml.rels`, relsXml(rels)]);
	});
	const layoutRels = relsXml([{ id: "rId1", type: REL.slideMaster, target: "../slideMasters/slideMaster1.xml" }]);
	return writeZip([
		["[Content_Types].xml", contentTypesXml(overrides)],
		["_rels/.rels", rootRels("ppt/presentation.xml")],
		["docProps/core.xml", corePropsXml({ title: opts.title, creator: opts.creator })],
		["docProps/app.xml", appPropsXml()],
		["ppt/presentation.xml", presentation],
		["ppt/_rels/presentation.xml.rels", relsXml(presRels)],
		["ppt/presProps.xml", `${XML_HEAD}<p:presentationPr ${NS}/>`],
		["ppt/viewProps.xml", `${XML_HEAD}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`],
		["ppt/tableStyles.xml", `${XML_HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`],
		["ppt/slideMasters/slideMaster1.xml", masterXml()],
		[
			"ppt/slideMasters/_rels/slideMaster1.xml.rels",
			relsXml([
				{ id: "rId1", type: REL.slideLayout, target: "../slideLayouts/slideLayout1.xml" },
				{ id: "rId2", type: REL.slideLayout, target: "../slideLayouts/slideLayout2.xml" },
				{ id: "rId3", type: REL.slideLayout, target: "../slideLayouts/slideLayout3.xml" },
				{ id: "rId4", type: REL.theme, target: "../theme/theme1.xml" },
			]),
		],
		["ppt/slideLayouts/slideLayout1.xml", layoutXml("title")],
		["ppt/slideLayouts/slideLayout2.xml", layoutXml("content")],
		["ppt/slideLayouts/slideLayout3.xml", layoutXml("section")],
		["ppt/slideLayouts/_rels/slideLayout1.xml.rels", layoutRels],
		["ppt/slideLayouts/_rels/slideLayout2.xml.rels", layoutRels],
		["ppt/slideLayouts/_rels/slideLayout3.xml.rels", layoutRels],
		["ppt/notesMasters/notesMaster1.xml", notesMasterXml()],
		["ppt/notesMasters/_rels/notesMaster1.xml.rels", relsXml([{ id: "rId1", type: REL.theme, target: "../theme/theme2.xml" }])],
		["ppt/theme/theme1.xml", themeXml("Nourax")],
		["ppt/theme/theme2.xml", themeXml("Nourax Notes")],
		...parts,
	]);
}

export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
