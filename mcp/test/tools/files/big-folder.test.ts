/**
 * Fix round 3: a folder too big for one answer still gets its listing. files_list_folder reads the
 * PROPFIND as a stream and stops after the folder and its first 2,000 entries (or at the 8 MB cap),
 * so the promised 2,000-item listing and its note come back instead of "too many items".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCtx } from "../../../src/core/tool";
import { readListing } from "../../../src/tools/files/list-folder";
import { QA } from "../../helpers/index";
import { sc, setup } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const UID = "u1";
const resp = (name: string) =>
	`<d:response><d:href>/remote.php/dav/files/${UID}/Big/${name}</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

/** A ctx whose PROPFIND answer arrives in small chunks, counting how many were read. */
function streamingCtx(children: number, chunk = 97): { ctx: ToolCtx; pulled: () => number; total: number } {
	const head = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/${UID}/Big/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
	let body = head;
	for (let i = 0; i < children; i++) body += resp(`f${i}.txt`);
	body += "</d:multistatus>";
	const bytes = new TextEncoder().encode(body);
	let pos = 0;
	let pulls = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(c) {
			if (pos >= bytes.length) return c.close();
			pulls++;
			c.enqueue(bytes.subarray(pos, pos + chunk));
			pos += chunk;
		},
	});
	const ctx = { uid: UID, nc: { request: async () => new Response(stream, { status: 207 }) } } as unknown as ToolCtx;
	return { ctx, pulled: () => pulls, total: Math.ceil(bytes.length / chunk) };
}

describe("reading a big folder", () => {
	it("stops after the folder and one entry more than the limit, splitting tags across chunks safely", async () => {
		const s = streamingCtx(50);
		const { rs, cut } = await readListing(s.ctx, "/Big" as never, 10);
		expect(cut).toBe(true);
		expect(rs).toHaveLength(12);
		expect(rs[11]?.href).toBe(`/remote.php/dav/files/${UID}/Big/f10.txt`);
		expect(s.pulled()).toBeLessThan(s.total);
	});
	it("reads a small folder whole", async () => {
		const s = streamingCtx(5);
		const { rs, cut } = await readListing(s.ctx, "/Big" as never, 10);
		expect(cut).toBe(false);
		expect(rs).toHaveLength(6);
	});
	it("stops at the size cap at the last whole entry", async () => {
		const s = streamingCtx(400, 512);
		const { rs, cut } = await readListing(s.ctx, "/Big" as never, 2000, 20_000);
		expect(cut).toBe(true);
		expect(rs.length).toBeGreaterThan(10);
		expect(rs.length).toBeLessThan(120);
	});
	it("files_list_folder on 2,050 items lists from the first 2,000, with the note", async () => {
		const e = await setup();
		for (let i = 0; i < 2050; i++) e.files.write(QA.a, `/Big/f${String(i).padStart(4, "0")}.txt`, "x");
		const r = sc<{ total: number; note: string | null; items: unknown[] }>(await e.call("files_list_folder", { path: "/Big", limit: 10 }));
		expect(r.total).toBe(2000);
		expect(r.items).toHaveLength(10);
		expect(r.note).toContain("more than 2,000 items");
	}, 60_000);
});
