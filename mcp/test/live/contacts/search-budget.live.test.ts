/**
 * Lane B live cases for contacts_search's memory budget (DESIGN 17.6; src/tools/contacts/fan-out.ts),
 * as qa-t1-211 against drive.nourax.org:
 * - a search over every book answers as before when every book answers, and a real REPORT answer
 *   for a directory search is far below the 1 MiB read per book (its size is logged, bytes only);
 * - one card larger than 1 MiB in the person's own book (made "in another app", straight over
 *   CardDAV) leaves that book out, named in the note, with the summary saying how many books were
 *   searched; asked for on its own, the book gives too_large with a hint.
 * The large card has a fixed name and a fixed search word, so every run reuses the same one card
 * (PUT with If-None-Match: *; 412 means it is already there). Its filler character ("¤") and the
 * word "zqbigcardqa" match no other search the live tests make. It stays in the QA account (there
 * is no delete tool, and nothing else is deleted).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { A, call, cardDav, code, devToken, ok, reportSize } from "../sharing/live";

const WORD = "zqbigcardqa";
const CARD = "mcp-qa-b-big-1.vcf";
const MiB = 1024 * 1024;

let token = "";

beforeAll(async () => {
	token = await devToken(A);
	const jcard = [
		"vcard",
		[
			["version", {}, "text", "4.0"],
			["uid", {}, "text", "mcp-qa-b-big-1"],
			["fn", {}, "text", `${WORD} Big`],
			["org", {}, "text", ["¤".repeat(600_000)]],
		],
	];
	const put = await cardDav(A, "PUT", "contacts", CARD, jcard);
	expect([201, 204, 412]).toContain(put.status);
	console.log(`large card: PUT answered ${put.status}`);
}, 120_000);

describe("live: contacts_search memory budget", () => {
	it("searches every book as before, and a real directory answer is far below the 1 MiB per book", async () => {
		const r = ok(await call(token, "contacts_search", { query: "qa-t1-21" }), "search every book");
		const summary = String(r.content[0]?.text.split("\n")[0]);
		expect(summary).toMatch(/^Found \d+ contacts?; showing \d+\.$/);
		expect(String(r.structuredContent.note ?? "")).not.toMatch(/couldn't be searched|held more matches/);
		const bytes = await reportSize(A, "org-", "qa-t1-21");
		console.log(`directory REPORT for "qa-t1-21": ${bytes.book} answered ${bytes.bytes} bytes`);
		expect(bytes.bytes).toBeLessThan(MiB / 10);
	});

	it("leaves out a book whose answer is over 1 MiB, names it, and says how many books were searched", async () => {
		const bytes = await reportSize(A, "contacts", WORD);
		console.log(`own book REPORT for the large card: ${bytes.bytes} bytes`);
		expect(bytes.bytes).toBeGreaterThan(MiB);
		const r = ok(await call(token, "contacts_search", { query: WORD }), "search with the large card");
		const summary = String(r.content[0]?.text.split("\n")[0]);
		console.log(`summary: ${summary}`);
		expect(summary).toMatch(/^No contacts matched in (\d+) of (\d+) address books; 1 held more matches than can be read in one go\.$/);
		const [, searched, all] = /in (\d+) of (\d+)/.exec(summary) as RegExpExecArray;
		expect(Number(searched)).toBe(Number(all) - 1);
		expect(String(r.structuredContent.note)).toMatch(/^The address book ".+" held more matches than can be read in one go, so it was left out; a more exact query finds them\.$/);
		const one = await call(token, "contacts_search", { query: WORD, address_book_id: "contacts" });
		expect(code(one)).toBe("too_large");
		expect(one.content[0]?.text).toBe("The matches in the address book were more than can be read in one go. A more exact query finds them.");
		// Everything else in that book is still found.
		const other = ok(await call(token, "contacts_search", { query: "Mcp Qa B", address_book_id: "contacts" }), "search the same book for others");
		expect(String(other.content[0]?.text)).toMatch(/^(Found \d+ contacts?; showing \d+\.|No contacts matched in 1 address book\.)/);
	});
});
