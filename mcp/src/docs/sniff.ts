/**
 * Content checks run before a file is handed to the ONLYOFFICE connector's converter (DESIGN 12.5,
 * fix round 3). The converter decides a file's format from its *content*, not from the extension
 * our tools pass it, so narrowing the sources by extension alone (formats.ts TOOL_SOURCES) is not
 * enough:
 * - a .doc, .txt, .rtf or .csv file whose bytes are really HTML (or an MHT archive) would be read
 *   by the converter's HTML importer, which fetches what the HTML links to (an SSRF from the
 *   converter's own network). `looksLikeHtmlOrMht` refuses such a file before it is sent;
 * - an Office Open XML or OpenDocument package can carry an *external* image reference (a picture
 *   linked by URL rather than embedded). The importer fetches those too. `hasExternalMediaRefs`
 *   refuses a package that holds one.
 *
 * Both checks mirror what the connector's own format detector looks at, read on the server
 * (Common/OfficeFileFormatChecker2.cpp): an "<...HTML" open tag in the first bytes, or a
 * multipart/related MIME archive with a text/html part. Hyperlinks (a document linking to a web
 * page) are left alone, because the converter does not fetch them and they are common in real
 * documents; only image, media, audio and video references, which the converter does fetch, are
 * refused.
 */
import { readRels } from "./extract/rels";
import { StopRead } from "./extract/out";
import { NS, parsePart } from "./sax";
import type { ZipReader } from "./zip";

const latin1 = new TextDecoder("latin1");

/** True when `target` points off the package over the network (so the converter would fetch it). */
function httpish(target: string): boolean {
	const t = target.trim().toLowerCase();
	return t.startsWith("http://") || t.startsWith("https://") || t.startsWith("ftp://") || t.startsWith("//");
}

/**
 * Whether the first bytes of a file look like HTML or an MHT (MIME HTML) archive, the two content
 * kinds whose import fetches linked resources. Mirrors the connector's own first-bytes detector.
 */
export function looksLikeHtmlOrMht(head: Uint8Array): boolean {
	const n = Math.min(head.length, 4096);
	if (n < 4) return false;
	// RTF ("{\rtf") is a document format, never HTML, so it is checked first and allowed.
	if (head[0] === 0x7b && head[1] === 0x5c && head[2] === 0x72 && head[3] === 0x74 && head[4] === 0x66) return false;
	// HTML: an open tag whose name is "HTML" (any case) in the first 100 bytes, as the converter
	// checks. "<" opens a tag, ">" closes it; inside a tag, H T M L in sequence means HTML.
	const eq = (x: number | undefined, up: number, lo: number): boolean => x === up || x === lo;
	let open = false;
	const limit = Math.min(n, 100);
	for (let i = 0; i + 3 < limit; i++) {
		const c = head[i];
		if (c === 0x3c) open = true;
		else if (c === 0x3e) open = false;
		else if (open && eq(head[i], 0x48, 0x68) && eq(head[i + 1], 0x54, 0x74) && eq(head[i + 2], 0x4d, 0x6d) && eq(head[i + 3], 0x4c, 0x6c)) return true;
	}
	// MHT: a MIME multipart/related archive that carries an HTML part.
	const text = latin1.decode(head.subarray(0, n));
	return text.includes("Content-Type: multipart/related") && text.includes("Content-Type: text/html");
}

/** OPC relationship types the converter fetches when they are external: pictures, media, av. */
const FETCHED_REL = /\/(image|media|audio|video)$/i;

/** OpenDocument kinds (their linked images live as draw:image in content.xml/styles.xml). */
const ODF_KINDS = new Set(["odt", "ott", "ods", "ots", "odp", "otp", "fodt", "fods", "fodp"]);

/** Whether an OpenDocument part holds a draw:image linked by an http(s) URL. */
function odfLinksImage(zip: ZipReader, part: string): boolean {
	let found = false;
	try {
		parsePart(zip, part, {
			open(t) {
				if (t.uri !== NS.draw || t.local !== "image") return;
				for (const [key, value] of Object.entries(t.attrs)) {
					if (key.endsWith("}href") && httpish(value)) {
						found = true;
						throw new StopRead();
					}
				}
			},
		});
	} catch (e) {
		if (!(e instanceof Error && e.name === "StopRead")) throw e;
	}
	return found;
}

/**
 * Whether a package (already opened) links an image or other media by URL, which the converter
 * would fetch. OOXML: a relationship with TargetMode="External" of an image/media/audio/video type
 * whose target is an http(s) URL, in any `.rels` part. OpenDocument: a draw:image whose xlink:href
 * is an http(s) URL, in content.xml or styles.xml. Hyperlinks are not flagged.
 */
export function hasExternalMediaRefs(zip: ZipReader, ext: string): boolean {
	if (ODF_KINDS.has(ext)) {
		return odfLinksImage(zip, "content.xml") || odfLinksImage(zip, "styles.xml");
	}
	for (const name of zip.names()) {
		if (!name.toLowerCase().endsWith(".rels")) continue;
		for (const rel of readRels(zip, name).values()) {
			if (rel.external && httpish(rel.target) && FETCHED_REL.test(rel.type)) return true;
		}
	}
	return false;
}
