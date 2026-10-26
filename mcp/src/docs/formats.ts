/**
 * The ONLYOFFICE connector's own conversion table, copied from the installed app (version 10.2.1,
 * assets/document-formats/onlyoffice-docs-formats.json, read on the server 2026-10-25): for each
 * source extension, its document type and the extensions it can be converted to. docs_convert and
 * the server route of files_read_text allow only pairs listed here (DESIGN 12.5), and only from
 * the sources in TOOL_SOURCES (toolCanConvert). Regenerate it from the same file when the connector
 * is upgraded.
 */
export const CONNECTOR_VERSION = "10.2.1";

export type DocType = "word" | "cell" | "slide" | "pdf" | "diagram";

/** extension -> [type, space-separated conversion targets] */
const TABLE: Readonly<Record<string, readonly [DocType, string]>> = {
	"doc": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"docm": ["word", "docx bmp dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"docx": ["word", "bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"dot": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"dotm": ["word", "docx bmp docm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"dotx": ["word", "docx bmp docm dotm epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"epub": ["word", "docx bmp docm dotm dotx fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"fb2": ["word", "docx bmp docm dotm dotx epub gif html jpg md odt ott pdf pdfa png rtf txt"],
	"fodt": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"gdoc": ["word", ""],
	"hml": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"htm": ["word", "docx bmp docm dotm dotx epub fb2 gif jpg md odt ott pdf pdfa png rtf txt"],
	"html": ["word", "docx bmp docm dotm dotx epub fb2 gif jpg md odt ott pdf pdfa png rtf txt"],
	"hwp": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"hwpx": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"md": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg odt ott pdf pdfa png rtf txt"],
	"mht": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"mhtml": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"odt": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md ott pdf pdfa png rtf txt"],
	"ott": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt pdf pdfa png rtf txt"],
	"pages": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"rtf": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png txt"],
	"stw": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"sxw": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"txt": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf"],
	"wps": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"wpt": ["word", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"xml": ["word", "docx xlsx bmp csv docm dotm dotx epub fb2 gif html jpg md ods odt ots ott pdf pdfa png rtf txt tsv xlsm xltm xltx"],
	"csv": ["cell", "xlsx bmp gif jpg ods ots pdf pdfa png tsv xlsm xltm xltx"],
	"et": ["cell", "xlsx bmp csv gif jpg ods ots pdf pdfa png tsv xlsm xltm xltx"],
	"ett": ["cell", "xlsx bmp csv gif jpg ods ots pdf pdfa png tsv xlsm xltm xltx"],
	"fods": ["cell", "xlsx bmp csv gif jpg ods ots pdf pdfa png tsv xlsm xltm xltx"],
	"gsheet": ["cell", ""],
	"numbers": ["cell", "xlsx bmp csv gif jpg ods ots pdf pdfa png tsv xlsm xltm xltx"],
	"ods": ["cell", "xlsx bmp csv gif jpg ots pdf pdfa png tsv xlsm xltm xltx"],
	"ots": ["cell", "xlsx bmp csv gif jpg ods pdf pdfa png tsv xlsm xltm xltx"],
	"tsv": ["cell", "xlsx bmp csv gif jpg ods ots pdf pdfa png xlsm xltm xltx"],
	"sxc": ["cell", "xlsx bmp csv gif jpg ods ots pdf pdfa png tsv xlsm xltm xltx"],
	"xls": ["cell", "xlsx bmp csv gif jpg ods ots pdf pdfa png tsv xlsm xltm xltx"],
	"xlsb": ["cell", "xlsx bmp csv gif jpg ods ots pdf pdfa png tsv xlsm xltm xltx"],
	"xlsm": ["cell", "xlsx bmp csv gif jpg ods ots pdf pdfa png tsv xltm xltx"],
	"xlsx": ["cell", "bmp csv gif jpg ods ots pdf pdfa png tsv xlsm xltm xltx"],
	"xlt": ["cell", "xlsx bmp csv gif jpg ods ots pdf pdfa png tsv xlsm xltm xltx"],
	"xltm": ["cell", "xlsx bmp csv gif jpg ods ots pdf pdfa png tsv xlsm xltx"],
	"xltx": ["cell", "xlsx bmp csv gif jpg ods ots pdf pdfa png tsv xlsm xltm"],
	"dps": ["slide", "pptx bmp gif jpg odp otp pdf pdfa png potm potx ppsm ppsx pptm"],
	"dpt": ["slide", "pptx bmp gif jpg odp otp pdf pdfa png potm potx ppsm ppsx pptm"],
	"fodp": ["slide", "pptx bmp gif jpg odp otp pdf pdfa png potm potx ppsm ppsx pptm"],
	"gslides": ["slide", ""],
	"key": ["slide", "pptx bmp gif jpg odp otp pdf pdfa png potm potx ppsm ppsx pptm txt"],
	"odg": ["slide", "pptx bmp gif jpg odp otp pdf pdfa png potm potx ppsm ppsx pptm txt"],
	"odp": ["slide", "pptx bmp gif jpg otp pdf pdfa png potm potx ppsm ppsx pptm txt"],
	"otp": ["slide", "pptx bmp gif jpg odp pdf pdfa png potm potx ppsm ppsx pptm txt"],
	"pot": ["slide", "pptx bmp gif jpg odp otp pdf pdfa png potm potx ppsm ppsx pptm txt"],
	"potm": ["slide", "pptx bmp gif jpg odp otp pdf pdfa png potx ppsm ppsx pptm txt"],
	"potx": ["slide", "pptx bmp gif jpg odp otp pdf pdfa png potm ppsm ppsx pptm txt"],
	"pps": ["slide", "pptx bmp gif jpg odp otp pdf pdfa png potm potx ppsm ppsx pptm txt"],
	"ppsm": ["slide", "pptx bmp gif jpg odp otp pdf pdfa png potm potx ppsx pptm txt"],
	"ppsx": ["slide", "pptx bmp gif jpg odp otp pdf pdfa png potm potx ppsm pptm txt"],
	"ppt": ["slide", "pptx bmp gif jpg odp otp pdf pdfa png potm potx ppsm ppsx pptm txt"],
	"pptm": ["slide", "pptx bmp gif jpg odp otp pdf pdfa png potm potx ppsm ppsx txt"],
	"pptx": ["slide", "bmp gif jpg odp otp pdf pdfa png potm potx ppsm ppsx pptm txt"],
	"sxi": ["slide", "pptx bmp gif jpg odp otp pdf pdfa png potm potx ppsm ppsx pptm txt"],
	"djvu": ["pdf", "bmp gif jpg pdf pdfa png"],
	"docxf": ["pdf", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"oform": ["pdf", "pdf"],
	"oxps": ["pdf", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"pdf": ["pdf", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdfa png rtf txt"],
	"xps": ["pdf", "docx bmp docm dotm dotx epub fb2 gif html jpg md odt ott pdf pdfa png rtf txt"],
	"vsdx": ["diagram", "bmp gif jpg pdf pdfa png"],
	"vsdm": ["diagram", "bmp gif jpg pdf pdfa png"],
	"vssm": ["diagram", "bmp gif jpg pdf pdfa png"],
	"vssx": ["diagram", "bmp gif jpg pdf pdfa png"],
	"vstm": ["diagram", "bmp gif jpg pdf pdfa png"],
	"vstx": ["diagram", "bmp gif jpg pdf pdfa png"],
};

export function docTypeOf(ext: string): DocType | null {
	return TABLE[ext.toLowerCase()]?.[0] ?? null;
}

/** The targets the connector converts this extension to (empty when it can't). */
export function conversionTargets(ext: string): string[] {
	const row = TABLE[ext.toLowerCase()];
	return row && row[1] ? row[1].split(" ") : [];
}

export function canConvert(from: string, to: string): boolean {
	return conversionTargets(from).includes(to.toLowerCase());
}

/**
 * The source formats our tools hand to the connector (docs_convert and files_read_text's
 * conversion route): Word, Excel, PowerPoint, OpenDocument, RTF, text, CSV and PDF.
 * Narrower than the table on purpose (fix round 1, security review): HTML, MHT, XML, EPUB and FB2
 * are left out, because on import the converter may fetch what they link to, and so are the rare
 * formats (hwp, pages, wps, djvu, xps and others) whose import code is the least tried.
 * Markdown is left out too (fix round 2, security review): the converter turns it into HTML and
 * imports that with the same HTML reader, which downloads linked images (libHtmlFile2.so holds both
 * Md::ConvertMdFileToHtml and the network downloader). docs_convert makes a .docx from Markdown in
 * the Worker instead (our own writer: no images, only https: and mailto: links).
 *
 * The extension is only part of the decision (fix round 3): the converter detects a file's format
 * from its content, so a source in this set whose bytes are really HTML, or a package that links an
 * image by URL, is caught by the content checks in `sniff.ts` before it is sent (docs_convert and
 * the server route of files_read_text).
 */
export const TOOL_SOURCES: ReadonlySet<string> = new Set(
	"doc docx docm dot dotx dotm rtf odt ott txt xls xlsx xlsm xlsb xlt xltx xltm csv tsv ods ots ppt pptx pptm pps ppsx ppsm pot potx potm odp otp pdf".split(" "),
);

/** A pair our tools may send to the connector: a tool source and a pair in the connector's table. */
export function toolCanConvert(from: string, to: string): boolean {
	return TOOL_SOURCES.has(from.toLowerCase()) && canConvert(from, to);
}
