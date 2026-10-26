/**
 * Lane C's part of the fake NoDrive (DESIGN 17.3): a small DAV file store (PROPFIND Depth 0, GET
 * with Range, PUT with If-None-Match) and the ONLYOFFICE connector's downloadas route. Response
 * shapes follow NC 35.0.2: multistatus props as files.ts asks for them, 206 with Content-Range, 412
 * for a taken name, 409 for a missing folder, and downloadas answering 200 with an HTML error page
 * for a file it can't convert.
 *
 * The core fake decodes request bodies as text, which would damage binary uploads, so this file
 * re-wraps the fetch spy to keep the raw bytes of every PUT.
 */
import { vi } from "vitest";
import { type FakeNc, type Recorded } from "./index";

export interface FakeFile {
	bytes: Uint8Array;
	mime: string;
	etag: string;
	fileId: number;
	mtime: number;
}

const enc = new TextEncoder();

function xmlEsc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function encPath(uid: string, path: string): string {
	const segs = path.split("/").filter(Boolean).map(encodeURIComponent);
	return `/remote.php/dav/files/${encodeURIComponent(uid)}/${segs.join("/")}`;
}

function mimeFor(name: string): string {
	const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
	const map: Record<string, string> = {
		txt: "text/plain",
		md: "text/markdown",
		csv: "text/csv",
		json: "application/json",
		pdf: "application/pdf",
		png: "image/png",
		zip: "application/zip",
		doc: "application/msword",
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		xls: "application/vnd.ms-excel",
		pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		odt: "application/vnd.oasis.opendocument.text",
		ods: "application/vnd.oasis.opendocument.spreadsheet",
		odp: "application/vnd.oasis.opendocument.presentation",
	};
	return map[ext] ?? "application/octet-stream";
}

export type Converter = (file: FakeFile, name: string, ext: string) => Response;

/** The default conversion: well-formed bytes of the target kind, like the real converter. */
export const defaultConverter: Converter = (file, name, ext) => {
	if (ext === "pdf") return new Response(enc.encode(`%PDF-1.7\n% converted from ${name}\n%%EOF\n`), { headers: { "content-type": "application/pdf" } });
	if (["docx", "xlsx", "pptx", "odt", "ods", "odp"].includes(ext)) {
		// A tiny but real zip (stored entry), enough for the magic-bytes check.
		const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...enc.encode(`fake ${ext} from ${name}`)]);
		return new Response(zip, { headers: { "content-type": mimeFor(`x.${ext}`) } });
	}
	if (ext === "txt") return new Response(enc.encode(`﻿Text of ${name}\nsecond line\n`), { headers: { "content-type": "text/plain" } });
	if (ext === "csv") return new Response(enc.encode("a,b\n1,2\n"), { headers: { "content-type": "text/csv" } });
	return new Response("<!DOCTYPE html><html><body>error</body></html>", { headers: { "content-type": "text/html" } });
};

export class OfficeFake {
	files = new Map<string, FakeFile>();
	folders = new Set<string>();
	private nextId = 4100;
	private tick = 0;
	convert: Converter = defaultConverter;
	/** Raw bytes of PUT bodies by URL (the core fake only keeps text). */
	raw = new Map<string, Uint8Array>();

	constructor(readonly fake: FakeNc) {}

	key(uid: string, path: string): string {
		return `${uid}:${path}`;
	}

	addFolder(uid: string, path: string): void {
		const segs = path.split("/").filter(Boolean);
		for (let i = 1; i <= segs.length; i++) this.folders.add(this.key(uid, `/${segs.slice(0, i).join("/")}`));
	}

	addFile(uid: string, path: string, content: Uint8Array | string, mime?: string): FakeFile {
		const parent = path.slice(0, path.lastIndexOf("/")) || "/";
		if (parent !== "/") this.addFolder(uid, parent);
		const bytes = typeof content === "string" ? enc.encode(content) : content;
		const f: FakeFile = { bytes, mime: mime ?? mimeFor(path), etag: `e${++this.tick}`, fileId: ++this.nextId, mtime: 1761300000 + this.tick };
		this.files.set(this.key(uid, path), f);
		return f;
	}

	file(uid: string, path: string): FakeFile | undefined {
		return this.files.get(this.key(uid, path));
	}

	private propXml(uid: string, path: string, f: FakeFile | null): string {
		const href = `${encPath(uid, path)}${f ? "" : "/"}`;
		const name = path.split("/").filter(Boolean).pop() ?? "";
		const common = `<d:displayname>${xmlEsc(name)}</d:displayname><oc:owner-id>${uid}</oc:owner-id><oc:owner-display-name>QA</oc:owner-display-name><oc:favorite>0</oc:favorite><oc:share-types/><nc:mount-type></nc:mount-type><nc:has-preview>false</nc:has-preview>`;
		const props = f
			? `<d:resourcetype/><d:getcontenttype>${f.mime}</d:getcontenttype><d:getcontentlength>${f.bytes.length}</d:getcontentlength><d:getetag>"${f.etag}"</d:getetag><d:getlastmodified>${new Date(f.mtime * 1000).toUTCString()}</d:getlastmodified><oc:fileid>${f.fileId}</oc:fileid><oc:permissions>RGDNVW</oc:permissions><oc:size>${f.bytes.length}</oc:size><nc:creation_time>${f.mtime}</nc:creation_time>`
			: `<d:resourcetype><d:collection/></d:resourcetype><d:getetag>"dir"</d:getetag><d:getlastmodified>${new Date(1761300000000).toUTCString()}</d:getlastmodified><oc:fileid>99</oc:fileid><oc:permissions>RGDNVCK</oc:permissions><oc:size>0</oc:size>`;
		return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${common}${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
	}

	/** Decoded path from the request (after /remote.php/dav/files/{uid}). */
	private pathOf(rec: Recorded, uid: string): string {
		const prefix = `/remote.php/dav/files/${encodeURIComponent(uid)}`;
		const rest = rec.url.pathname.slice(prefix.length);
		const segs = rest.split("/").filter(Boolean).map(decodeURIComponent);
		return `/${segs.join("/")}`;
	}

	install(): this {
		const fake = this.fake;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
			const req = new Request(input as RequestInfo, init);
			if (req.method.toUpperCase() === "PUT" && req.body) this.raw.set(req.url, new Uint8Array(await req.clone().arrayBuffer()));
			return fake.fetch(req);
		});
		const gate = (rec: Recorded, uid: string): Response | null => {
			if (!rec.auth) return new Response("", { status: 401 });
			if (rec.auth !== uid) return new Response("", { status: 404 });
			return null;
		};
		fake.on("PROPFIND", /^\/remote\.php\/dav\/files\/([^/]+)(\/.*)?$/, (rec, _f, m) => {
			const uid = decodeURIComponent(m[1] as string);
			const g = gate(rec, uid);
			if (g) return g;
			const path = this.pathOf(rec, uid);
			const f = this.file(uid, path);
			if (f) return new Response(this.propXml(uid, path, f), { status: 207, headers: { "content-type": "application/xml; charset=utf-8" } });
			if (path === "/" || this.folders.has(this.key(uid, path))) {
				return new Response(this.propXml(uid, path, null), { status: 207, headers: { "content-type": "application/xml; charset=utf-8" } });
			}
			return new Response("<d:error/>", { status: 404 });
		});
		fake.on("GET", /^\/remote\.php\/dav\/files\/([^/]+)(\/.*)?$/, (rec, _f, m) => {
			const uid = decodeURIComponent(m[1] as string);
			const g = gate(rec, uid);
			if (g) return g;
			const f = this.file(uid, this.pathOf(rec, uid));
			if (!f) return new Response("", { status: 404 });
			const range = /^bytes=(\d+)-(\d+)?$/.exec(rec.headers.get("range") ?? "");
			const headers = { "content-type": f.mime, etag: `"${f.etag}"` };
			if (range) {
				const a = Number(range[1]);
				const b = Math.min(f.bytes.length - 1, range[2] !== undefined ? Number(range[2]) : f.bytes.length - 1);
				if (f.bytes.length === 0) return new Response(new Uint8Array(0), { status: 200, headers: { ...headers, "content-length": "0" } });
				const part = f.bytes.slice(a, b + 1);
				return new Response(part, { status: 206, headers: { ...headers, "content-range": `bytes ${a}-${b}/${f.bytes.length}`, "content-length": String(part.length) } });
			}
			return new Response(f.bytes, { status: 200, headers: { ...headers, "content-length": String(f.bytes.length) } });
		});
		fake.on("PUT", /^\/remote\.php\/dav\/files\/([^/]+)(\/.*)?$/, (rec, _f, m) => {
			const uid = decodeURIComponent(m[1] as string);
			const g = gate(rec, uid);
			if (g) return g;
			const path = this.pathOf(rec, uid);
			const parent = path.slice(0, path.lastIndexOf("/")) || "/";
			if (parent !== "/" && !this.folders.has(this.key(uid, parent))) return new Response("", { status: 409 });
			if (rec.headers.get("if-none-match") === "*" && this.file(uid, path)) return new Response("", { status: 412 });
			const bytes = this.raw.get(rec.url.href) ?? enc.encode(rec.body);
			this.addFile(uid, path, bytes, rec.headers.get("content-type") ?? undefined);
			return new Response("", { status: 201, headers: { etag: `"${this.file(uid, path)?.etag}"` } });
		});
		fake.on("GET", /^\/index\.php\/apps\/onlyoffice\/downloadas$/, (rec) => {
			if (!rec.auth) return new Response("", { status: 401 });
			const id = Number(rec.url.searchParams.get("fileId"));
			const ext = rec.url.searchParams.get("toExtension") ?? "";
			for (const [k, f] of this.files) {
				if (f.fileId === id && k.startsWith(`${rec.auth}:`)) return this.convert(f, k.slice(k.indexOf(":") + 1), ext);
			}
			// The real connector answers an unknown file with an HTML error page and HTTP 200.
			return new Response("<!DOCTYPE html><html><body>File not found</body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
		});
		return this;
	}
}

export function installOffice(fake: FakeNc): OfficeFake {
	return new OfficeFake(fake).install();
}
