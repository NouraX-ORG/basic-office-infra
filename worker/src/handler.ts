// NoDrive upload Worker: lets the NoMail web page upload big files into the user's Drive.
//
// Nextcloud sends no CORS headers and the NoMail server (Supabase Edge Functions) cannot carry
// large bodies, so the browser sends 50 MiB chunks here instead. Each request carries an upload
// ticket that NoMail's server sealed (see ticket.ts). This Worker answers the CORS preflight,
// opens the ticket and replays the chunk to Nextcloud's chunked-upload v2 API with the user's
// app password. It never stores anything.
//
// Routes (all under /nomail-upload, ticket in the X-Upload-Ticket header):
//   GET    /health          no ticket; {"status":"ok"}
//   POST   /start           create /NoMail/... folders and the upload session
//   PUT    /chunks/{n}      upload chunk n (1-based), exact length required
//   GET    /chunks          list chunks already received (to resume)
//   POST   /finish          assemble the file; returns its file id, size and etag
//   DELETE /                cancel the upload session
// SPDX-License-Identifier: AGPL-3.0-or-later

import { chunkCount, expectedChunkLength, importTicketKey, openTicket, TicketError, type Ticket } from "./ticket";

export interface Env {
	/** Base URL of Nextcloud, e.g. https://drive.nourax.org */
	ORIGIN_BASE: string;
	/** Comma-separated browser origins allowed to call this Worker. */
	ALLOWED_ORIGINS: string;
	/** Largest chunk accepted, in bytes (Cloudflare caps request bodies at 100 MB on Free). */
	MAX_CHUNK_BYTES: string;
	/** Largest file accepted, in bytes. */
	MAX_UPLOAD_BYTES: string;
	/** Secret: 32 random bytes, base64url. The same value is NoMail's DRIVE_UPLOAD_TICKET_KEY. */
	UPLOAD_TICKET_KEY?: string;
}

const PREFIX = "/nomail-upload";
const USER_AGENT = "NoDrive-Upload-Worker/1.0";

type Cors = Headers | null;

export async function handle(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith(PREFIX)) return fail(null, 404, "not_found", "unknown path");
	const route = url.pathname.slice(PREFIX.length) || "/";
	const cors = corsHeaders(request, env);
	if (cors === null) return fail(null, 403, "origin_not_allowed", "this origin may not use the upload service");

	if (request.method === "OPTIONS") {
		cors.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
		cors.set("Access-Control-Allow-Headers", "X-Upload-Ticket, Content-Type");
		cors.set("Access-Control-Max-Age", "86400");
		return new Response(null, { status: 204, headers: cors });
	}
	if (request.method === "GET" && route === "/health") return json(cors, 200, { status: "ok" });

	let ticket: Ticket;
	try {
		const key = await importTicketKey(env.UPLOAD_TICKET_KEY);
		ticket = await openTicket(request.headers.get("X-Upload-Ticket"), key, {
			maxChunk: Number(env.MAX_CHUNK_BYTES),
			maxBytes: Number(env.MAX_UPLOAD_BYTES),
		});
	} catch (err) {
		if (err instanceof TicketError) return fail(cors, 401, "bad_ticket", err.message);
		return fail(cors, 500, "misconfigured", "upload service is not configured");
	}
	const dav = new Dav(env.ORIGIN_BASE, ticket);

	try {
		if (request.method === "POST" && route === "/start") return await start(dav, ticket, cors);
		const chunkMatch = /^\/chunks\/(\d{1,5})$/.exec(route);
		if (request.method === "PUT" && chunkMatch) return await putChunk(dav, ticket, Number(chunkMatch[1]), request, cors);
		if (request.method === "GET" && route === "/chunks") return await listChunks(dav, cors);
		if (request.method === "POST" && route === "/finish") return await finish(dav, ticket, cors);
		if (request.method === "DELETE" && route === "/") return await abort(dav, cors);
	} catch (err) {
		if (err instanceof UpstreamError) return fromUpstream(cors, err.status, err.step);
		throw err;
	}
	return fail(cors, 404, "not_found", "unknown path or method");
}

async function start(dav: Dav, t: Ticket, cors: Headers): Promise<Response> {
	const dirs = t.path.split("/").slice(1, -1);
	let dir = "";
	for (const part of dirs) {
		dir += `/${part}`;
		const res = await dav.send("MKCOL", dav.fileUrl(dir));
		if (res.status !== 201 && res.status !== 405) throw new UpstreamError(res.status, "create folder");
	}
	const exists = await dav.send("PROPFIND", dav.fileUrl(t.path), { Depth: "0" });
	if (exists.status === 207) return fail(cors, 409, "exists", "a file with this name already exists - pick another name");
	if (exists.status !== 404) throw new UpstreamError(exists.status, "check destination");

	const session = await dav.send("MKCOL", dav.uploadUrl(), { Destination: dav.fileUrl(t.path) });
	if (session.status !== 201 && session.status !== 405) throw new UpstreamError(session.status, "start upload");
	return json(cors, 201, { upload: t.upload, path: t.path, size: t.size, chunkSize: t.chunk, chunks: chunkCount(t) });
}

async function putChunk(dav: Dav, t: Ticket, n: number, request: Request, cors: Headers): Promise<Response> {
	const expected = expectedChunkLength(t, n);
	if (expected === null) return fail(cors, 400, "bad_chunk_number", `chunk number must be 1..${chunkCount(t)}`);
	const lengthHeader = request.headers.get("Content-Length");
	if (lengthHeader === null) return fail(cors, 411, "length_required", "send Content-Length");
	if (Number(lengthHeader) !== expected) {
		return fail(cors, 400, "bad_chunk_length", `chunk ${n} must be exactly ${expected} bytes`);
	}
	if (request.body === null) return fail(cors, 400, "empty_body", "chunk body is missing");

	// A fixed-length stream keeps Content-Length on the way to Nextcloud, which sizes the R2 part from it.
	const { readable, writable } = new FixedLengthStream(expected);
	// Not awaited: if Nextcloud answers early (e.g. 401) the rest of the body is simply dropped.
	request.body.pipeTo(writable).catch(() => undefined);
	const res = await dav.send("PUT", dav.uploadUrl(`/${String(n).padStart(5, "0")}`), {
		Destination: dav.fileUrl(t.path),
		"OC-Total-Length": String(t.size),
		"Content-Type": "application/octet-stream",
	}, readable);
	if (res.status !== 201 && res.status !== 204) throw new UpstreamError(res.status, `upload chunk ${n}`);
	return json(cors, 201, { chunk: n, size: expected });
}

async function listChunks(dav: Dav, cors: Headers): Promise<Response> {
	const res = await dav.send("PROPFIND", dav.uploadUrl(), { Depth: "1", "Content-Type": "application/xml" }, PROPFIND_LENGTH);
	if (res.status !== 207) throw new UpstreamError(res.status, "list chunks");
	const received = parseResponses(await res.text())
		.map((r) => ({ n: Number(/\/(\d{1,5})\/?$/.exec(decodeURIComponent(r.href))?.[1] ?? NaN), size: r.length ?? 0 }))
		.filter((c) => Number.isInteger(c.n))
		.sort((a, b) => a.n - b.n);
	return json(cors, 200, { received });
}

async function finish(dav: Dav, t: Ticket, cors: Headers): Promise<Response> {
	const headers: Record<string, string> = { Destination: dav.fileUrl(t.path), "OC-Total-Length": String(t.size) };
	if (t.mtime !== undefined) headers["X-OC-Mtime"] = String(t.mtime);
	const res = await dav.send("MOVE", dav.uploadUrl("/.file"), headers);
	if (res.status === 400 || res.status === 412) {
		return fail(cors, 409, "incomplete", "not all chunks have arrived - check GET /chunks and resend the missing ones");
	}
	if (res.status !== 201 && res.status !== 204) throw new UpstreamError(res.status, "finish upload");

	const info = await dav.send("PROPFIND", dav.fileUrl(t.path), { Depth: "0", "Content-Type": "application/xml" }, PROPFIND_FILE);
	if (info.status !== 207) throw new UpstreamError(info.status, "read finished file");
	const file = parseResponses(await info.text())[0];
	return json(cors, 201, {
		path: t.path,
		fileId: file?.fileId ?? null,
		size: file?.size ?? file?.length ?? t.size,
		etag: file?.etag ?? null,
		contentType: file?.contentType ?? null,
	});
}

async function abort(dav: Dav, cors: Headers): Promise<Response> {
	const res = await dav.send("DELETE", dav.uploadUrl());
	if (res.status !== 204 && res.status !== 404) throw new UpstreamError(res.status, "cancel upload");
	return new Response(null, { status: 204, headers: cors });
}

const PROPFIND_LENGTH = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/></d:prop></d:propfind>`;
const PROPFIND_FILE =
	`<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">` +
	`<d:prop><d:getetag/><d:getcontentlength/><d:getcontenttype/><oc:fileid/><oc:size/></d:prop></d:propfind>`;

class Dav {
	private readonly auth: string;
	constructor(
		private readonly base: string,
		private readonly t: Ticket,
	) {
		const bytes = new TextEncoder().encode(`${t.login}:${t.pass}`);
		let binary = "";
		for (const b of bytes) binary += String.fromCharCode(b);
		this.auth = `Basic ${btoa(binary)}`;
	}

	fileUrl(path: string): string {
		return `${this.base}/remote.php/dav/files/${encodeURIComponent(this.t.uid)}${encodePath(path)}`;
	}

	uploadUrl(suffix = ""): string {
		return `${this.base}/remote.php/dav/uploads/${encodeURIComponent(this.t.uid)}/${this.t.upload}${suffix}`;
	}

	send(method: string, url: string, headers: Record<string, string> = {}, body?: BodyInit): Promise<Response> {
		return fetch(url, {
			method,
			headers: { ...headers, Authorization: this.auth, "User-Agent": USER_AGENT },
			body,
			redirect: "manual",
		});
	}
}

class UpstreamError extends Error {
	constructor(
		readonly status: number,
		readonly step: string,
	) {
		super(`${step} failed with ${status}`);
	}
}

function fromUpstream(cors: Cors, status: number, step: string): Response {
	if (status === 401) return fail(cors, 401, "drive_unauthorized", "the Drive rejected the app password - reconnect the Drive");
	if (status === 404) return fail(cors, 404, "upload_not_found", `${step}: upload session not found or expired - start again`);
	if (status === 409) return fail(cors, 409, "conflict", `${step}: a parent folder is missing or is a file`);
	if (status === 507) return fail(cors, 507, "quota_exceeded", "not enough space in the Drive");
	if (status === 429) return fail(cors, 429, "throttled", "the Drive is throttling requests - wait and retry");
	return fail(cors, 502, "drive_error", `${step}: the Drive answered ${status}`);
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

interface DavItem {
	href: string;
	length?: number;
	size?: number;
	fileId?: number;
	etag?: string;
	contentType?: string;
}

/** Small WebDAV multistatus reader; Nextcloud's replies are regular enough for this. */
export function parseResponses(xml: string): DavItem[] {
	const items: DavItem[] = [];
	for (const block of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/g)) {
		const body = block[1] ?? "";
		const pick = (tag: string) => new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([^<]*)<`).exec(body)?.[1];
		const num = (tag: string) => {
			const v = pick(tag);
			return v === undefined || v === "" ? undefined : Number(v);
		};
		items.push({
			href: pick("href") ?? "",
			length: num("getcontentlength"),
			size: num("size"),
			fileId: num("fileid"),
			etag: pick("getetag")?.replaceAll("&quot;", "").replaceAll('"', ""),
			contentType: pick("getcontenttype"),
		});
	}
	return items;
}

function corsHeaders(request: Request, env: Env): Cors {
	const headers = new Headers();
	const origin = request.headers.get("Origin");
	if (origin === null) return headers; // not a browser (server tools, tests): the ticket is still required
	const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
	if (!allowed.includes(origin)) return null;
	headers.set("Access-Control-Allow-Origin", origin);
	headers.set("Vary", "Origin");
	return headers;
}

function json(cors: Cors, status: number, body: unknown): Response {
	const headers = new Headers(cors ?? undefined);
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", "no-store");
	return new Response(JSON.stringify(body), { status, headers });
}

function fail(cors: Cors, status: number, code: string, message: string): Response {
	return json(cors, status, { error: { code, message } });
}
