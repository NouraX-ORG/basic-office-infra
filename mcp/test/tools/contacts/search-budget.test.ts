/**
 * contacts_search after the review of fix round 3 (DESIGN 17.3):
 * - when no address book could be searched it fails (upstream_unavailable, or too_large), and
 *   never answers "No contacts matched";
 * - when some books couldn't be searched, the summary says how many were searched ("in 2 of 3
 *   address books") and the note names the others;
 * - the books are read inside one memory budget (src/tools/contacts/fan-out.ts): at most 3 answers
 *   are read at a time, each up to 1 MiB, all together up to 6 MiB; a book over its share is left
 *   out and named;
 * - every book beyond the first 3 counts one more read against the person's per-minute limit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCapped } from "../../../src/core/egress";
import { ToolError } from "../../../src/core/errors";
import type { ToolCtx } from "../../../src/core/tool";
import type { Book } from "../../../src/tools/contacts/books";
import { SEARCH_FAN_OUT, type SearchFanOutLimits, searchBooks } from "../../../src/tools/contacts/fan-out";
import { type FakeCardDav, installCardDav } from "../../fake-nc/carddav";
import type { FakeNc } from "../../fake-nc/index";
import { fakeWithQa, QA } from "../../helpers/index";
import { callTool, errorCode, expectBounded, expectNoBrand, expectOutputSchema, tokenFor } from "../sharing/_call";
import { callsTo, freshDay } from "../sharing/setup";

const DIR = "org-acme_shared_by_nourax-teams";

let fake: FakeNc;
let dav: FakeCardDav;

const card = (uid: string, fn: string, extra: unknown[][] = []) => ["vcard", [["version", {}, "text", "4.0"], ["uid", {}, "text", uid], ["fn", {}, "text", fn], ...extra]];

beforeEach(() => {
	vi.restoreAllMocks();
	freshDay();
	fake = fakeWithQa();
	dav = installCardDav(fake);
	dav.addBook(QA.a, "contacts", { displayName: "Contacts" });
	dav.addCard(QA.a, "contacts", "ana.vcf", card("ana-1", "Ana Diaz", [["org", {}, "text", ["Acme"]]]));
	dav.addBook(QA.a, DIR, { displayName: "Directory: Acme", owner: "principals/users/nourax-teams", readOnly: true });
	dav.addCard(QA.a, DIR, "bo.vcf", card("bo-1", "Bo Acme"));
	dav.addBook(QA.a, "z-app-generated--contactsinteraction--recent", { displayName: "Recently contacted", readOnly: true });
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const summaryOf = (r: { content: { text: string }[] }) => r.content[0]?.text.split("\n")[0];

describe("contacts_search when address books can't be searched", () => {
	it("fails when every book fails, and never says no contact matched", async () => {
		dav.failEveryReport = 500;
		const r = await callTool("contacts_search", { query: "acme" });
		expect(r.isError).toBe(true);
		expect(errorCode(r)).toBe("upstream_unavailable");
		expect(r._meta?.["nourax/error"]?.retryable).toBe(true);
		expect(r.content[0]?.text).toBe("NoContacts didn't answer. Try again in a minute.");
		expect(JSON.stringify(r)).not.toMatch(/No contacts matched/);
		expectNoBrand(r);
		// The same for one book asked for by id, and for a 503 (retried once by the client).
		const one = await callTool("contacts_search", { query: "acme", address_book_id: "contacts" });
		expect(errorCode(one)).toBe("upstream_unavailable");
		dav.failEveryReport = 503;
		expect(errorCode(await callTool("contacts_search", { query: "acme" }))).toBe("upstream_unavailable");
	});

	it("says how many books were searched when some fail, and names the others in the note", async () => {
		dav.failReportOn = DIR;
		const none = await callTool("contacts_search", { query: "nobody-here" });
		expect(none.isError, none.content[0]?.text).toBeFalsy();
		expectOutputSchema("contacts_search", none);
		expect(summaryOf(none)).toBe("No contacts matched in 2 of 3 address books; 1 couldn't be searched just now.");
		expect(none.structuredContent.note).toBe('The address book "Directory: Acme" couldn\'t be searched just now; it was left out.');
		const some = await callTool("contacts_search", { query: "acme" });
		expect(some.isError, some.content[0]?.text).toBeFalsy();
		expectOutputSchema("contacts_search", some);
		expect(summaryOf(some)).toBe("Found 1 contact in 2 of 3 address books (1 couldn't be searched just now); showing 1.");
		expect((some.structuredContent.contacts as { full_name: string }[]).map((c) => c.full_name)).toEqual(["Ana Diaz"]);
		// With every book answering, the summary is as before.
		dav.failReportOn = null;
		expect(summaryOf(await callTool("contacts_search", { query: "acme" }))).toBe("Found 2 contacts; showing 2.");
		expect(summaryOf(await callTool("contacts_search", { query: "nobody-here" }))).toBe("No contacts matched in 3 address books.");
	});

	it("names several books that failed, in the order they were searched", async () => {
		fake.on("REPORT", /^\/remote\.php\/dav\/addressbooks\/users\/[^/]+\/(contacts|z-app[^/]*)\/$/, () => new Response("boom", { status: 500 }));
		const r = await callTool("contacts_search", { query: "acme" });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		expect(summaryOf(r)).toBe("Found 1 contact in 1 of 3 address books (2 couldn't be searched just now); showing 1.");
		expect(r.structuredContent.note).toBe('The address books "Contacts" and "Recently contacted" couldn\'t be searched just now; they were left out.');
	});
});

// --- The memory budget, through the whole Worker --------------------------------------------------

const CHUNK = 64 * 1024;
const MiB = 1024 * 1024;

it("the budget is the one the design names: 3 at a time, 1 MiB a book, 6 MiB a call, 3 books per read", () => {
	expect(SEARCH_FAN_OUT).toEqual({ concurrency: 3, perBookBytes: MiB, totalBytes: 6 * MiB, minShareBytes: 128 * 1024, includedBooks: 3 });
});

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A multistatus with one matching card, padded to `bytes` bytes. */
function answer(uid: string, book: string, bytes: number): string {
	const data = esc(JSON.stringify(card(`${book}-1`, `Match ${book}`)));
	const head = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:response><d:href>/remote.php/dav/addressbooks/users/${uid}/${book}/m.vcf</d:href><d:propstat><d:prop><d:getetag>"e1"</d:getetag><card:address-data>${data}</card:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
	const tail = "</d:multistatus>";
	const pad = Math.max(0, bytes - head.length - tail.length - 7);
	return `${head}<!--${"x".repeat(pad)}-->${tail}`;
}

interface Streams {
	maxOpen: () => number;
	pulled: () => number;
	asked: string[];
}

/** Every book's REPORT answers `size(book)` bytes as a slow stream; counts the answers being read at once. */
function streamingReports(size: (book: string) => number): Streams {
	let open = 0;
	let max = 0;
	let pulled = 0;
	const asked: string[] = [];
	fake.on("REPORT", /^\/remote\.php\/dav\/addressbooks\/users\/([^/]+)\/([^/]+)\/$/, (_req, _f, m) => {
		const uid = decodeURIComponent(m[1] as string);
		const book = decodeURIComponent(m[2] as string);
		asked.push(book);
		const bytes = new TextEncoder().encode(answer(uid, book, size(book)));
		let at = 0;
		let started = false;
		let done = false;
		const finish = () => {
			if (started && !done) open--;
			done = true;
		};
		const body = new ReadableStream<Uint8Array>(
			{
				async pull(c) {
					if (!started) {
						started = true;
						open++;
						max = Math.max(max, open);
					}
					await new Promise((r) => setTimeout(r, 1));
					const part = bytes.subarray(at, at + CHUNK);
					at += part.byteLength;
					pulled += part.byteLength;
					c.enqueue(part);
					if (at >= bytes.byteLength) {
						finish();
						c.close();
					}
				},
				cancel() {
					finish();
				},
			},
			{ highWaterMark: 0 },
		);
		return new Response(body, { status: 207, headers: { "content-type": "application/xml; charset=utf-8" } });
	});
	return { maxOpen: () => max, pulled: () => pulled, asked };
}

describe("contacts_search reads many books inside one memory budget", () => {
	it("25 books with large answers: at most 3 read at a time, 6 MiB at most in all, the rest left out and named", async () => {
		for (let i = 0; i < 22; i++) dav.addBook(QA.a, `b${String(i).padStart(2, "0")}`, { displayName: `Book ${i}` });
		const s = streamingReports(() => 900 * 1024);
		const r = await callTool("contacts_search", { query: "match", limit: 50 });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		expectOutputSchema("contacts_search", r);
		expectBounded(r);
		expectNoBrand(r);
		expect(s.maxOpen()).toBeGreaterThan(0);
		expect(s.maxOpen()).toBeLessThanOrEqual(3);
		// Each read may run one chunk past its share before it stops, and the stream may be one ahead.
		expect(s.pulled()).toBeLessThanOrEqual(6 * MiB + s.asked.length * 2 * CHUNK);
		expect(s.asked.length).toBeLessThan(12);
		const hits = r.structuredContent.contacts as { address_book_id: string }[];
		expect(hits.length).toBeGreaterThanOrEqual(5);
		expect(hits.length).toBeLessThanOrEqual(6);
		const left = 25 - hits.length;
		expect(summaryOf(r)).toBe(`Found ${hits.length} contacts in ${hits.length} of 25 address books (${left} held more matches than can be read in one go); showing ${hits.length}.`);
		const note = String(r.structuredContent.note);
		expect(note).toMatch(/^The address books ".+" held more matches than can be read in one go, so they were left out; a more exact query finds them\.$/);
		// The last book searched is among those named.
		expect(note).toContain('"Recently contacted"');
	});

	it("leaves out one book whose answer is over its 1 MiB share, and fails when that was the only book", async () => {
		const s = streamingReports((book) => (book === "contacts" ? 3 * 1024 * 1024 : 4 * 1024));
		const r = await callTool("contacts_search", { query: "match" });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		expect(summaryOf(r)).toBe("Found 2 contacts in 2 of 3 address books (1 held more matches than can be read in one go); showing 2.");
		expect(r.structuredContent.note).toBe('The address book "Contacts" held more matches than can be read in one go, so it was left out; a more exact query finds them.');
		// The big answer was stopped near its cap, not read to its end.
		expect(s.pulled()).toBeLessThan(MiB + 3 * CHUNK + 2 * 4 * 1024);
		const one = await callTool("contacts_search", { query: "match", address_book_id: "contacts" });
		expect(one.isError).toBe(true);
		expect(errorCode(one)).toBe("too_large");
		expect(one._meta?.["nourax/error"]?.field).toBe("query");
		expect(one.content[0]?.text).toBe("The matches in the address book were more than can be read in one go. A more exact query finds them.");
	});

	it("counts one more read per book beyond the first 3 against the per-minute limit (120 reads)", async () => {
		for (let i = 0; i < 22; i++) dav.addBook(QA.a, `b${String(i).padStart(2, "0")}`, { displayName: `Book ${i}` });
		const token = await tokenFor();
		// Each call over 25 books is 1 read for the call and 22 for the books beyond the first 3.
		for (let i = 0; i < 5; i++) {
			const r = await callTool("contacts_search", { query: "acme" }, { token });
			expect(r.isError, r.content[0]?.text).toBeFalsy();
		}
		fake.requests.length = 0;
		const sixth = await callTool("contacts_search", { query: "acme" }, { token });
		expect(errorCode(sixth)).toBe("rate_limited");
		// Refused before any book was asked.
		expect(callsTo(fake, "REPORT", /\/$/)).toHaveLength(0);
	});
});

// --- The fan-out on its own ------------------------------------------------------------------------

function book(id: string): Book {
	return { id, name: `Book ${id}`, read_only: false, shared: false };
}

interface Stub {
	ctx: ToolCtx;
	charge: ReturnType<typeof vi.fn>;
	maxActive: () => number;
	bytesRead: () => number;
	asked: string[];
}

/** A ToolCtx whose client answers each book's REPORT with `sizes[id]` bytes, or throws `errors[id]`. */
function stub(sizes: Record<string, number>, errors: Record<string, ToolError | Error> = {}): Stub {
	let active = 0;
	let max = 0;
	let read = 0;
	const asked: string[] = [];
	const charge = vi.fn(async () => {});
	const nc = {
		uid: "u",
		async request(method: string, path: string, opts: { headers?: Record<string, string> }) {
			expect(method).toBe("REPORT");
			expect(opts.headers?.depth).toBe("1");
			const id = path.split("/").filter(Boolean).pop() as string;
			asked.push(id);
			active++;
			max = Math.max(max, active);
			await new Promise((r) => setTimeout(r, 5));
			const err = errors[id];
			if (err) {
				active--;
				throw err;
			}
			return new Response(answer("u", id, sizes[id] ?? 500), { status: 207 });
		},
		async readBytes(res: Response, cap: number) {
			try {
				const b = await readCapped(res, cap);
				read += b.byteLength;
				return b;
			} finally {
				active--;
			}
		},
	};
	const ctx = { uid: "u", nc, charge } as unknown as ToolCtx;
	return { ctx, charge, maxActive: () => max, bytesRead: () => read, asked };
}

const books = (n: number) => Array.from({ length: n }, (_, i) => book(`k${i + 1}`));
const ids = (rs: unknown[], b: Book) => [b.id, rs.length] as const;

describe("searchBooks", () => {
	it("searches every book, at most 3 at a time, and counts one more read per book beyond the first 3", async () => {
		const s = stub({});
		const r = await searchBooks(s.ctx, books(7), "<body/>", ids);
		expect(r.items.map((x) => x[0])).toEqual(["k1", "k2", "k3", "k4", "k5", "k6", "k7"]);
		expect(r.items.every((x) => x[1] === 1)).toBe(true);
		expect(r).toMatchObject({ unreadable: [], tooBig: [] });
		expect(s.maxActive()).toBeLessThanOrEqual(SEARCH_FAN_OUT.concurrency);
		expect(s.maxActive()).toBeGreaterThan(1);
		expect(s.charge).toHaveBeenCalledTimes(1);
		expect(s.charge).toHaveBeenCalledWith("read", 4);
		const few = stub({});
		await searchBooks(few.ctx, books(3), "<body/>", ids);
		expect(few.charge).not.toHaveBeenCalled();
	});

	it("never reads more than the call's budget, and leaves the rest out as too big", async () => {
		const limits: SearchFanOutLimits = { concurrency: 3, perBookBytes: 1000, totalBytes: 2500, minShareBytes: 100, includedBooks: 3 };
		const s = stub({ k1: 900, k2: 900, k3: 900, k4: 900, k5: 900, k6: 900 });
		const r = await searchBooks(s.ctx, books(6), "<body/>", ids, limits);
		expect(s.bytesRead()).toBeLessThanOrEqual(limits.totalBytes);
		expect(r.items.length + r.tooBig.length + r.unreadable.length).toBe(6);
		expect(r.tooBig.length).toBeGreaterThanOrEqual(3);
		expect(r.items.length).toBeGreaterThanOrEqual(2);
		// Left out books keep the order they were given in.
		const order = r.tooBig.map((b) => b.id);
		expect(order).toEqual([...order].sort());
	});

	it("counts the whole share of an answer that ran over it, so over-size books can't read past the budget", async () => {
		const limits: SearchFanOutLimits = { concurrency: 1, perBookBytes: 1000, totalBytes: 2500, minShareBytes: 100, includedBooks: 3 };
		const s = stub({ k1: 50_000, k2: 50_000, k3: 50_000, k4: 50_000, k5: 50_000 });
		const r = await searchBooks(s.ctx, books(5), "<body/>", ids, limits);
		expect(r.items).toEqual([]);
		expect(r.tooBig.map((b) => b.id)).toEqual(["k1", "k2", "k3", "k4", "k5"]);
		// k1 and k2 take 1000 each, k3 the 500 left; k4 and k5 are never asked.
		expect(s.asked).toEqual(["k1", "k2", "k3"]);
	});

	it("counts a book that answers with an error, and ends the call on a fatal one", async () => {
		const s = stub({}, { k2: new ToolError("upstream_unavailable"), k3: new ToolError("not_found") });
		const r = await searchBooks(s.ctx, books(4), "<body/>", ids);
		expect(r.items.map((x) => x[0])).toEqual(["k1", "k4"]);
		expect(r.unreadable.map((b) => b.id)).toEqual(["k2", "k3"]);
		for (const fatal of [new ToolError("reconnect_required"), new ToolError("rate_limited"), new ToolError("timeout"), new ToolError("permission_denied", undefined, { deadCredential: true }), new TypeError("bug")]) {
			const dead = stub({}, { k1: fatal });
			await expect(searchBooks(dead.ctx, books(8), "<body/>", ids)).rejects.toBe(fatal);
			// Once a fatal error is seen, no new book is asked for.
			expect(dead.asked.length).toBeLessThanOrEqual(SEARCH_FAN_OUT.concurrency);
		}
	});

	it("reads a 204 answer as no matches", async () => {
		const ctx = {
			uid: "u",
			charge: vi.fn(),
			nc: { request: async () => new Response(null, { status: 204 }), readBytes: () => Promise.reject(new Error("not read")) },
		} as unknown as ToolCtx;
		const r = await searchBooks(ctx, books(1), "<body/>", ids);
		expect(r.items).toEqual([["k1", 0]]);
	});
});
