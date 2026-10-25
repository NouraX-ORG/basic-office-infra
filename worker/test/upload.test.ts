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

// The upload folder as the Drive lists it (PROPFIND Depth 1): the folder, ".file", ".target" and
// one entry per stored part, named by its part number (R2 multipart parts on object storage).
function uploadFolder(parts: Array<[number, number]>): Response {
	return multistatus([
		{ href: "/remote.php/dav/uploads/hammad/nomail-0123456789/" },
		{ href: "/remote.php/dav/uploads/hammad/nomail-0123456789/.file" },
		{ href: "/remote.php/dav/uploads/hammad/nomail-0123456789/.target", "d:getcontentlength": "0" },
		...parts.map(([n, size]) => ({
			href: `/remote.php/dav/uploads/hammad/nomail-0123456789/${n}`,
			"d:getcontentlength": String(size),
		})),
	]);
}

function finishedFile(size: number): Response {
	return multistatus([
		{
			href: "/remote.php/dav/files/hammad/NoMail/Sent/2026-10/report.pdf",
			"d:getetag": "&quot;abc123&quot;",
			"d:getcontentlength": String(size),
			"d:getcontenttype": "application/pdf",
			"oc:fileid": "4242",
			"oc:size": String(size),
		},
	]);
}

// The default ticket: 12 MiB in chunks of 5, 5 and 2 MiB.
const ALL_PARTS: Array<[number, number]> = [
	[1, 5 * MiB],
	[2, 5 * MiB],
	[3, 2 * MiB],
];

async function errorOf(res: Response): Promise<{ code: string; message: string; missing?: number[] }> {
	return ((await res.json()) as { error: { code: string; message: string; missing?: number[] } }).error;
}

describe("finish and cancel", () => {
	it("checks every chunk, assembles the file and returns its id", async () => {
		const calls = mockDrive([uploadFolder(ALL_PARTS), 201, finishedFile(12 * MiB)]);
		const res = await call("/finish", { method: "POST", ticket: await sealed({ mtime: 1761200000 }) });
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({
			path: "/NoMail/Sent/2026-10/report.pdf",
			fileId: 4242,
			size: 12 * MiB,
			etag: "abc123",
			contentType: "application/pdf",
		});
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`PROPFIND ${UPLOADS}`,
			`MOVE ${UPLOADS}/.file`,
			`PROPFIND ${FILES}/NoMail/Sent/2026-10/report.pdf`,
		]);
		expect(calls[0]?.headers.get("Depth")).toBe("1");
		expect(calls[1]?.headers.get("Destination")).toBe(`${FILES}/NoMail/Sent/2026-10/report.pdf`);
		expect(calls[1]?.headers.get("OC-Total-Length")).toBe(String(12 * MiB));
		expect(calls[1]?.headers.get("X-OC-Mtime")).toBe("1761200000");
	});

	it("says incomplete when a chunk is missing, and never assembles a short file", async () => {
		// Nextcloud 35 on object storage does not compare the parts with OC-Total-Length: a MOVE here
		// would save the 10 MiB it has and answer 201.
		const calls = mockDrive([uploadFolder([[1, 5 * MiB], [2, 5 * MiB]])]);
		const res = await call("/finish", { method: "POST" });
		expect(res.status).toBe(409);
		const error = await errorOf(res);
		expect(error.code).toBe("incomplete");
		expect(error.missing).toEqual([3]);
		expect(calls.map((c) => c.method)).toEqual(["PROPFIND"]);
	});

	it("says incomplete for a finish before any chunk, so the session stays usable", async () => {
		// A MOVE with no parts fails on R2, and the Drive then drops the multipart upload (500s after).
		const calls = mockDrive([uploadFolder([])]);
		const res = await call("/finish", { method: "POST" });
		expect(res.status).toBe(409);
		const error = await errorOf(res);
		expect(error.code).toBe("incomplete");
		expect(error.missing).toEqual([1, 2, 3]);
		expect(calls).toHaveLength(1);
	});

	it("counts a chunk of the wrong length as missing", async () => {
		const calls = mockDrive([uploadFolder([[1, 5 * MiB], [2, 4 * MiB], [3, 2 * MiB]])]);
		const res = await call("/finish", { method: "POST" });
		expect(res.status).toBe(409);
		expect((await errorOf(res)).missing).toEqual([2]);
		expect(calls).toHaveLength(1);
	});

	it("refuses chunks past the end of the file", async () => {
		const calls = mockDrive([uploadFolder([...ALL_PARTS, [4, 5 * MiB]])]);
		const res = await call("/finish", { method: "POST" });
		expect(res.status).toBe(409);
		expect((await errorOf(res)).code).toBe("unexpected_chunks");
		expect(calls).toHaveLength(1);
	});

	it("still says incomplete when the Drive itself refuses the MOVE", async () => {
		mockDrive([uploadFolder(ALL_PARTS), 400]);
		const res = await call("/finish", { method: "POST" });
		expect(res.status).toBe(409);
		expect((await errorOf(res)).code).toBe("incomplete");
	});

	it("does not answer 201 when the saved file has the wrong size", async () => {
		mockDrive([uploadFolder(ALL_PARTS), 201, finishedFile(10 * MiB)]);
		const res = await call("/finish", { method: "POST" });
		expect(res.status).toBe(500);
		expect((await errorOf(res)).code).toBe("size_mismatch");
	});

	it("answers a repeated finish with the file when the first one went through", async () => {
		// The first answer was lost on the way, so NoMail sends /finish again; the session is gone.
		const calls = mockDrive([404, finishedFile(12 * MiB)]);
		const res = await call("/finish", { method: "POST" });
		expect(res.status).toBe(201);
		expect(((await res.json()) as { fileId: number; size: number }).fileId).toBe(4242);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`PROPFIND ${UPLOADS}`,
			`PROPFIND ${FILES}/NoMail/Sent/2026-10/report.pdf`,
		]);
	});

	it("says upload_not_found when neither the session nor the file is there", async () => {
		mockDrive([404, 404]);
		const res = await call("/finish", { method: "POST" });
		expect(res.status).toBe(404);
		expect((await errorOf(res)).code).toBe("upload_not_found");
	});

	it("does not take a file of the wrong size for a finished upload", async () => {
		mockDrive([404, finishedFile(10 * MiB)]);
		const res = await call("/finish", { method: "POST" });
		expect(res.status).toBe(500);
		expect((await errorOf(res)).code).toBe("size_mismatch");
	});

	it("cancels the session", async () => {
		const calls = mockDrive([204]);
		const res = await call("/", { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(calls[0]?.method).toBe("DELETE");
		expect(calls[0]?.url).toBe(UPLOADS);
	});
});

describe("the Drive's refusals", () => {
	it("passes a 403 on as drive_forbidden, not as a Drive error", async () => {
		mockDrive([403]);
		const res = await call("/start", { method: "POST" });
		expect(res.status).toBe(403);
		expect((await errorOf(res)).code).toBe("drive_forbidden");
	});
});

// A Sabre error answer, as the Drive (Nextcloud 35, sabre/dav Server.php) sends it for a 415.
function refusal(message: string): Response {
	return new Response(
		`<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">\n` +
			`  <s:exception>OCA\\DAV\\Connector\\Sabre\\Exception\\UnsupportedMediaType</s:exception>\n` +
			`  <s:message>${message}</s:message>\n</d:error>\n`,
		{ status: 415, headers: { "Content-Type": "application/xml; charset=utf-8" } },
	);
}

describe("the Drive's virus check (415)", () => {
	it("passes an infected file on as 415 virus_found with the signature, and stops", async () => {
		// Seen live on 2026-10-25: the MOVE of a chunked upload holding the EICAR string.
		const calls = mockDrive([
			uploadFolder(ALL_PARTS),
			refusal("Virus Eicar-Test-Signature is detected in the file. Upload cannot be completed."),
		]);
		const res = await call("/finish", { method: "POST" });
		expect(res.status).toBe(415);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://mail.test");
		expect(await res.json()).toEqual({
			error: {
				code: "virus_found",
				message: "the Drive's virus scanner found Eicar-Test-Signature in this file, so it was not saved",
				signature: "Eicar-Test-Signature",
			},
		});
		// No look for the file afterwards: there is none.
		expect(calls.map((c) => c.method)).toEqual(["PROPFIND", "MOVE"]);
	});

	it("passes 'no connection to the scanner' on as 415 scanner_unavailable", async () => {
		mockDrive([uploadFolder(ALL_PARTS), refusal("No connection to anti virus. Upload cannot be completed.")]);
		const res = await call("/finish", { method: "POST" });
		expect(res.status).toBe(415);
		const error = await errorOf(res);
		expect(error.code).toBe("scanner_unavailable");
		expect(error.message).toContain("could not be reached");
	});

	it("passes any other refusal on as 415 file_refused with the Drive's message, as plain text", async () => {
		// The Drive's messages follow the person's language, so they are not always the English ones.
		mockDrive([uploadFolder(ALL_PARTS), refusal("Virus &lt;X&gt; wurde gefunden &amp; entfernt.\n Hochladen nicht möglich.")]);
		const res = await call("/finish", { method: "POST" });
		expect(res.status).toBe(415);
		expect(await errorOf(res)).toEqual({
			code: "file_refused",
			message: "the Drive refused this file: Virus <X> wurde gefunden & entfernt. Hochladen nicht möglich.",
		});
	});

	it("still answers 415 when the Drive gives no message", async () => {
		mockDrive([uploadFolder(ALL_PARTS), 415]);
		const res = await call("/finish", { method: "POST" });
		expect(res.status).toBe(415);
		expect(await errorOf(res)).toEqual({ code: "file_refused", message: "finish upload: the Drive refused this file" });
	});

	it("passes a 415 for a chunk on as 415 too, never as a Drive error to retry", async () => {
		mockDrive([refusal("Virus Win.Test.EICAR_HDB-1 is detected in the file. Upload cannot be completed.")]);
		const res = await call("/chunks/1", { method: "PUT", body: new Uint8Array(5 * MiB) });
		expect(res.status).toBe(415);
		const error = (await res.json()) as { error: { code: string; signature?: string } };
		expect(error.error.code).toBe("virus_found");
		expect(error.error.signature).toBe("Win.Test.EICAR_HDB-1");
	});

	it("does not take an odd signature name for one", async () => {
		mockDrive([uploadFolder(ALL_PARTS), refusal("Virus &lt;b&gt;bad&lt;/b&gt; is detected in the file. Upload cannot be completed.")]);
		const res = await call("/finish", { method: "POST" });
		expect(res.status).toBe(415);
		expect((await errorOf(res)).code).toBe("file_refused");
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
