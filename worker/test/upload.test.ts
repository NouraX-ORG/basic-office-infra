import { afterEach, describe, expect, it, vi } from "vitest";
import { parseResponses } from "../src/handler";
import { call, MiB, mockDrive, multistatus, sealed, testEnv } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const FILES = "https://drive.test/remote.php/dav/files/hammad";
const UPLOADS = "https://drive.test/remote.php/dav/uploads/hammad/nomail-0123456789";

describe("CORS and access", () => {
	it("answers the preflight for NoMail's origin", async () => {
		const res = await call("/start", { method: "OPTIONS", ticket: null });
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://mail.test");
		expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Upload-Ticket");
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
	});

	it("refuses other origins", async () => {
		const calls = mockDrive([]);
		const res = await call("/start", { method: "POST", origin: "https://evil.test" });
		expect(res.status).toBe(403);
		expect(calls).toHaveLength(0);
	});

	it("needs a ticket", async () => {
		const calls = mockDrive([]);
		const res = await call("/start", { method: "POST", ticket: null });
		expect(res.status).toBe(401);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_ticket");
		expect(calls).toHaveLength(0);
	});

	it("reports a missing key as misconfiguration, without calling the Drive", async () => {
		const calls = mockDrive([]);
		const res = await call("/start", { method: "POST", env: { ...testEnv, UPLOAD_TICKET_KEY: undefined } });
		expect(res.status).toBe(500);
		expect(calls).toHaveLength(0);
	});

	it("serves a health check without a ticket", async () => {
		const res = await call("/health", { ticket: null });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});
});

describe("start", () => {
	it("creates the folders, checks the name and opens the upload session", async () => {
		const calls = mockDrive([201, 405, 201, 404, 201]);
		const res = await call("/start", { method: "POST" });
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({
			upload: "nomail-0123456789",
			path: "/NoMail/Sent/2026-10/report.pdf",
			size: 12 * MiB,
			chunkSize: 5 * MiB,
			chunks: 3,
		});
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`MKCOL ${FILES}/NoMail`,
			`MKCOL ${FILES}/NoMail/Sent`,
			`MKCOL ${FILES}/NoMail/Sent/2026-10`,
			`PROPFIND ${FILES}/NoMail/Sent/2026-10/report.pdf`,
			`MKCOL ${UPLOADS}`,
		]);
		expect(calls[4]?.headers.get("Destination")).toBe(`${FILES}/NoMail/Sent/2026-10/report.pdf`);
		expect(calls[0]?.headers.get("Authorization")).toBe(`Basic ${btoa("hammad:app-password-0123456789")}`);
	});

	it("encodes spaces and unicode in names", async () => {
		const calls = mockDrive([405, 405, 405, 404, 201]);
		const ticket = await sealed({ path: "/NoMail/Sent/2026-10/Q3 plan é.pdf" });
		await call("/start", { method: "POST", ticket });
		expect(calls[3]?.url).toBe(`${FILES}/NoMail/Sent/2026-10/Q3%20plan%20%C3%A9.pdf`);
	});

	it("refuses to overwrite an existing file", async () => {
		mockDrive([405, 405, 405, multistatus([{ href: "/x" }])]);
		const res = await call("/start", { method: "POST" });
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("exists");
	});

	it("turns a rejected app password into drive_unauthorized", async () => {
		mockDrive([401]);
		const res = await call("/start", { method: "POST" });
		expect(res.status).toBe(401);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("drive_unauthorized");
	});
});

describe("chunks", () => {
	it("forwards a full chunk with Destination and total length", async () => {
		const calls = mockDrive([201]);
		const res = await call("/chunks/1", { method: "PUT", body: new Uint8Array(5 * MiB) });
		expect(res.status).toBe(201);
		expect(calls[0]?.method).toBe("PUT");
		expect(calls[0]?.url).toBe(`${UPLOADS}/00001`);
		expect(calls[0]?.headers.get("Destination")).toBe(`${FILES}/NoMail/Sent/2026-10/report.pdf`);
		expect(calls[0]?.headers.get("OC-Total-Length")).toBe(String(12 * MiB));
		expect(calls[0]?.bodyLength).toBe(5 * MiB);
	});

	it("accepts the shorter last chunk", async () => {
		mockDrive([201]);
		const res = await call("/chunks/3", { method: "PUT", body: new Uint8Array(2 * MiB) });
		expect(res.status).toBe(201);
	});

	it("accepts the empty 200 that Nextcloud 35 sends for a chunk on object storage", async () => {
		// ChunkingV2Plugin::beforePut sets 201 and stops the event chain, so Sabre never sends its
		// response and PHP's default 200 (text/html, no body) goes out. The chunk is stored.
		mockDrive([new Response(null, { status: 200, headers: { "Content-Type": "text/html; charset=UTF-8" } })]);
		const res = await call("/chunks/1", { method: "PUT", body: new Uint8Array(5 * MiB) });
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ chunk: 1, size: 5 * MiB });
	});

	it("does not take a redirect for a stored chunk", async () => {
		mockDrive([new Response(null, { status: 302, headers: { Location: "https://drive.test/login" } })]);
		const res = await call("/chunks/1", { method: "PUT", body: new Uint8Array(5 * MiB) });
		expect(res.status).toBe(502);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("drive_error");
	});

	it("rejects a chunk of the wrong length before calling the Drive", async () => {
		const calls = mockDrive([]);
		const res = await call("/chunks/1", { method: "PUT", body: new Uint8Array(4 * MiB) });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_chunk_length");
		expect(calls).toHaveLength(0);
	});

	it("rejects chunk numbers outside the file", async () => {
		const calls = mockDrive([]);
		expect((await call("/chunks/4", { method: "PUT", body: new Uint8Array(10) })).status).toBe(400);
		expect((await call("/chunks/0", { method: "PUT", body: new Uint8Array(10) })).status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it("lists received chunks for resuming", async () => {
		mockDrive([
			multistatus([
				{ href: "/remote.php/dav/uploads/hammad/nomail-0123456789/" },
				{ href: "/remote.php/dav/uploads/hammad/nomail-0123456789/00002", "d:getcontentlength": String(5 * MiB) },
				{ href: "/remote.php/dav/uploads/hammad/nomail-0123456789/00001", "d:getcontentlength": String(5 * MiB) },
			]),
		]);
		const res = await call("/chunks");
		expect(await res.json()).toEqual({ received: [{ n: 1, size: 5 * MiB }, { n: 2, size: 5 * MiB }] });
	});

	it("maps an expired session to upload_not_found", async () => {
		mockDrive([404]);
		const res = await call("/chunks/1", { method: "PUT", body: new Uint8Array(5 * MiB) });
		expect(res.status).toBe(404);
	});
});

describe("finish and cancel", () => {
	it("assembles the file and returns its id", async () => {
		const calls = mockDrive([
			201,
			multistatus([
				{
					href: "/remote.php/dav/files/hammad/NoMail/Sent/2026-10/report.pdf",
					"d:getetag": "&quot;abc123&quot;",
					"d:getcontentlength": String(12 * MiB),
					"d:getcontenttype": "application/pdf",
					"oc:fileid": "4242",
					"oc:size": String(12 * MiB),
				},
			]),
		]);
		const res = await call("/finish", { method: "POST", ticket: await sealed({ mtime: 1761200000 }) });
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({
			path: "/NoMail/Sent/2026-10/report.pdf",
			fileId: 4242,
			size: 12 * MiB,
			etag: "abc123",
			contentType: "application/pdf",
		});
		expect(calls[0]?.method).toBe("MOVE");
		expect(calls[0]?.url).toBe(`${UPLOADS}/.file`);
		expect(calls[0]?.headers.get("X-OC-Mtime")).toBe("1761200000");
	});

	it("says incomplete when chunks are missing", async () => {
		mockDrive([400]);
		const res = await call("/finish", { method: "POST" });
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("incomplete");
	});

	it("cancels the session", async () => {
		const calls = mockDrive([204]);
		const res = await call("/", { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(calls[0]?.method).toBe("DELETE");
		expect(calls[0]?.url).toBe(UPLOADS);
	});
});

describe("multistatus reader", () => {
	it("reads Nextcloud property names with any prefix", () => {
		const xml =
			'<d:multistatus xmlns:d="DAV:"><d:response><d:href>/a%20b</d:href><d:propstat><d:prop>' +
			"<oc:fileid>7</oc:fileid><d:getetag>&quot;e&quot;</d:getetag></d:prop></d:propstat></d:response></d:multistatus>";
		expect(parseResponses(xml)).toEqual([
			{ href: "/a%20b", fileId: 7, etag: "e", length: undefined, size: undefined, contentType: undefined },
		]);
	});
});
