/**
 * Lane C test helpers: fixtures (made by python-docx, openpyxl, xlsxwriter and python-pptx; see
 * test/docs/fixtures/README.md), unzipping for checks, and hand-built PDFs (text, encrypted,
 * blank) so no binary PDF needs to live in the repo.
 */
import { strToU8, unzipSync, zipSync } from "fflate";
import { fromB64 } from "../../src/core/bytes";
import { saxParse } from "../../src/docs/sax";

// Fixtures are stored as base64 text (*.b64): the test bundler can't inline Office files.
const files = import.meta.glob("./fixtures/*.b64", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export function fixture(name: string): Uint8Array {
	const b64 = files[`./fixtures/${name}.b64`];
	if (!b64) throw new Error(`no fixture ${name}`);
	return fromB64(b64.replace(/\s+/g, ""));
}

export function unzipText(bytes: Uint8Array): Map<string, string> {
	const out = new Map<string, string>();
	for (const [k, v] of Object.entries(unzipSync(bytes))) out.set(k, new TextDecoder().decode(v));
	return out;
}

/** Every XML part parses (no DOCTYPE, well-formed) and every part is covered by [Content_Types].xml. */
export function checkPackage(bytes: Uint8Array): Map<string, string> {
	const parts = unzipText(bytes);
	const ct = parts.get("[Content_Types].xml");
	if (!ct) throw new Error("no [Content_Types].xml");
	const defaults = new Set([...ct.matchAll(/<Default Extension="([^"]+)"/g)].map((m) => (m[1] as string).toLowerCase()));
	const overrides = new Set([...ct.matchAll(/<Override PartName="([^"]+)"/g)].map((m) => (m[1] as string).toLowerCase()));
	for (const [name, text] of parts) {
		if (name.endsWith(".xml") || name.endsWith(".rels")) saxParse(text, {});
		if (name === "[Content_Types].xml") continue;
		const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
		if (!overrides.has(`/${name}`.toLowerCase()) && !defaults.has(ext)) throw new Error(`part ${name} has no content type`);
	}
	for (const o of overrides) if (![...parts.keys()].some((k) => `/${k}`.toLowerCase() === o)) throw new Error(`override ${o} has no part`);
	// Every internal relationship target exists.
	for (const [name, text] of parts) {
		if (!name.endsWith(".rels")) continue;
		const base = name.replace(/_rels\/[^/]*\.rels$/, "");
		for (const m of text.matchAll(/<Relationship ([^>]*)\/>/g)) {
			const attrs = m[1] as string;
			if (/TargetMode="External"/.test(attrs)) continue;
			const target = /Target="([^"]+)"/.exec(attrs)?.[1] as string;
			const segs = (target.startsWith("/") ? target.slice(1) : `${base}${target}`).split("/");
			const resolved: string[] = [];
			for (const s of segs) {
				if (s === "..") resolved.pop();
				else if (s && s !== ".") resolved.push(s);
			}
			if (!parts.has(resolved.join("/"))) throw new Error(`${name}: missing target ${resolved.join("/")}`);
		}
	}
	return parts;
}

export function zipOf(entries: Record<string, string | Uint8Array>): Uint8Array {
	const z: Record<string, Uint8Array> = {};
	for (const [k, v] of Object.entries(entries)) z[k] = typeof v === "string" ? strToU8(v) : v;
	return zipSync(z);
}

function pdfFrom(objects: string[], trailerExtra = ""): Uint8Array {
	let out = "%PDF-1.4\n%âãÏÓ\n";
	const offsets: number[] = [];
	objects.forEach((o, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`;
	const bytes = new Uint8Array(out.length);
	for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
	return bytes;
}

/** A PDF with one page per string, in Helvetica. */
export function textPdf(pages: string[], opts: { encrypted?: boolean } = {}): Uint8Array {
	const n = pages.length;
	const objs: string[] = [];
	objs.push("<< /Type /Catalog /Pages 2 0 R >>");
	const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
	objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
	const fontRef = 3 + n * 2;
	pages.forEach((text, i) => {
		const esc = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
		const stream = text ? `BT /F1 18 Tf 72 700 Td (${esc}) Tj ET` : "";
		objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontRef} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
		objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
	});
	objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
	if (!opts.encrypted) return pdfFrom(objs);
	const hex32 = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
	objs.push(`<< /Filter /Standard /V 1 /R 2 /O <${hex32}> /U <${hex32}> /P -4 >>`);
	return pdfFrom(objs, `/Encrypt ${objs.length} 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] `);
}
