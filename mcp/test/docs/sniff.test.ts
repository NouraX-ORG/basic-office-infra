/**
 * Content checks before the converter runs (DESIGN 12.5, fix round 3): refusing a file that is
 * really HTML or an MHT archive whatever its extension, and a package that links an image or other
 * file by URL (which the converter would fetch). These close the gap where narrowing the converter
 * sources by extension alone let HTML content in a .doc/.txt/.rtf/.csv, or an external image link
 * in an Office/OpenDocument package, reach the converter's downloader.
 */
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { hasExternalMediaRefs, looksLikeHtmlOrMht } from "../../src/docs/sniff";
import { ZipReader } from "../../src/docs/zip";
import { fixture, zipOf } from "./helpers";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

describe("looksLikeHtmlOrMht", () => {
	it("flags HTML content whatever the name says", () => {
		for (const s of ["<html><body>hi</body></html>", "<!DOCTYPE html>\n<html>", "  \n <HTML>", "<meta><title>x</title><HTML>", "<!-- c --><html>"]) {
			expect(looksLikeHtmlOrMht(bytes(s)), s).toBe(true);
		}
	});
	it("flags an MHT (MIME HTML) archive", () => {
		const mht = "From: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=b\r\n\r\n--b\r\nContent-Type: text/html\r\n\r\n<html></html>";
		expect(looksLikeHtmlOrMht(bytes(mht))).toBe(true);
	});
	it("does not flag RTF, plain text, a compound file, a zip, or a real docx", () => {
		expect(looksLikeHtmlOrMht(bytes("{\\rtf1\\ansi hello <html> later"))).toBe(false); // RTF wins, even with <html> after
		expect(looksLikeHtmlOrMht(bytes("Name,Qty\nWidget,1\n"))).toBe(false);
		expect(looksLikeHtmlOrMht(bytes("Just a sentence about HTML and the web."))).toBe(false); // "HTML" not in a tag
		expect(looksLikeHtmlOrMht(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(false);
		expect(looksLikeHtmlOrMht(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]))).toBe(false);
		expect(looksLikeHtmlOrMht(fixture("word-python-docx.docx"))).toBe(false);
		expect(looksLikeHtmlOrMht(new Uint8Array(0))).toBe(false);
	});
});

describe("hasExternalMediaRefs: OOXML", () => {
	const docx = (rels: string) =>
		ZipReader.open(
			zipOf({
				"[Content_Types].xml": "<Types/>",
				"word/document.xml": '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
				"word/_rels/document.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
			}),
		);
	it("flags an external image relationship by URL", () => {
		expect(hasExternalMediaRefs(docx(`<Relationship Id="r1" Type="${REL}/image" Target="http://169.254.169.254/x.png" TargetMode="External"/>`), "docx")).toBe(true);
		expect(hasExternalMediaRefs(docx(`<Relationship Id="r1" Type="${REL}/media" Target="https://evil.example/a.mp4" TargetMode="External"/>`), "docx")).toBe(true);
		expect(hasExternalMediaRefs(docx(`<Relationship Id="r1" Type="${REL}/image" Target="//evil.example/a.png" TargetMode="External"/>`), "docx")).toBe(true);
	});
	it("leaves embedded images and ordinary web hyperlinks alone", () => {
		expect(hasExternalMediaRefs(docx(`<Relationship Id="r1" Type="${REL}/image" Target="media/image1.png"/>`), "docx")).toBe(false);
		expect(hasExternalMediaRefs(docx(`<Relationship Id="r1" Type="${REL}/hyperlink" Target="https://nourax.org" TargetMode="External"/>`), "docx")).toBe(false);
		// An external image whose target is not http(s)/ftp (e.g. a local file) isn't a network fetch.
		expect(hasExternalMediaRefs(docx(`<Relationship Id="r1" Type="${REL}/image" Target="file:///etc/passwd" TargetMode="External"/>`), "docx")).toBe(false);
	});
});

describe("hasExternalMediaRefs: OpenDocument", () => {
	const O = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"';
	const odt = (body: string) =>
		ZipReader.open(
			zipSync({
				mimetype: enc.encode("application/vnd.oasis.opendocument.text"),
				"content.xml": enc.encode(`<?xml version="1.0"?><office:document-content ${O}><office:body><office:text>${body}</office:text></office:body></office:document-content>`),
			}),
		);
	it("flags a draw:image linked by http(s)", () => {
		expect(hasExternalMediaRefs(odt('<text:p><draw:frame><draw:image xlink:href="http://169.254.169.254/x.png"/></draw:frame></text:p>'), "odt")).toBe(true);
	});
	it("leaves an embedded image and a text hyperlink alone", () => {
		expect(hasExternalMediaRefs(odt('<text:p><draw:frame><draw:image xlink:href="Pictures/x.png"/></draw:frame></text:p>'), "odt")).toBe(false);
		expect(hasExternalMediaRefs(odt('<text:p><text:a xlink:href="http://nourax.org">link</text:a></text:p>'), "odt")).toBe(false);
	});
});
