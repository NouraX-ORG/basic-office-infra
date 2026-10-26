/**
 * Lane B fix round 3, contacts side (DESIGN 17.3):
 * - contacts_get, contacts_add and contacts_update are bounded as structuredContent carries them:
 *   a card with 6,000 email addresses, one with a 600,000-character organisation, and one whose
 *   lists are long together, with *_total counts and truncated_fields saying what isn't shown;
 * - contacts_update gives no undo that wouldn't put a removed entry back exactly, through the
 *   whole tool;
 * - contacts_search names the address books it didn't search, searches the person's own first,
 *   and pages through large hits without stalling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../../src/core/limits";
import { MAX_BOOKS } from "../../../src/tools/contacts/search";
import { SHOWN_CHARS, SHOWN_ITEMS } from "../../../src/tools/contacts/shapes";
import { type FakeCardDav, installCardDav } from "../../fake-nc/carddav";
import type { FakeNc } from "../../fake-nc/index";
import { fakeWithQa, QA } from "../../helpers/index";
import { callTool, expectBounded, expectNoBrand, expectOutputSchema, tokenFor } from "../sharing/_call";
import { callsTo, freshDay } from "../sharing/setup";

let fake: FakeNc;
let dav: FakeCardDav;

beforeEach(() => {
	vi.restoreAllMocks();
	freshDay();
	fake = fakeWithQa();
	dav = installCardDav(fake);
	dav.addBook(QA.a, "contacts", { displayName: "Contacts" });
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const ELLIPSIS = String.fromCharCode(0x2026);
const card = (uid: string, extra: unknown[][]) => ["vcard", [["version", {}, "text", "4.0"], ["uid", {}, "text", uid], ...extra]];

describe("contact answers fit one result (fix round 3)", () => {
	it("a card with 6,000 email addresses: 20 are shown, emails_total counts them all, for get and update", async () => {
		const emails = Array.from({ length: 6_000 }, (_, i) => ["email", { type: "work" }, "text", `person${i}@a-long-domain-name.example`]);
		dav.addCard(QA.a, "contacts", "many.vcf", card("many-1", [["fn", {}, "text", "Many Mails"], ...emails]));
		const g = await callTool("contacts_get", { contact_id: "contacts/many.vcf" });
		expect(g.isError, g.content[0]?.text).toBeFalsy();
		expectOutputSchema("contacts_get", g);
		expectBounded(g);
		expectNoBrand(g);
		const c = g.structuredContent.contact;
		expect(c.emails).toHaveLength(SHOWN_ITEMS.emails);
		expect(c.emails_total).toBe(6_000);
		expect(c.emails[0]).toEqual({ address: "person0@a-long-domain-name.example", label: "work" });
		expect(c.truncated_fields).toEqual([]);
		expect(g.content[0]?.text.split("\n")[0]).toBe("Got one contact. Some of it is longer than shown here: truncated_fields and the *_total counts say what.");
		// An update of one field gives the same bounded contact back, with its undo.
		const u = await callTool("contacts_update", { contact_id: "contacts/many.vcf", job_title: "Boss" });
		expect(u.isError, u.content[0]?.text).toBeFalsy();
		expectOutputSchema("contacts_update", u);
		expectBounded(u);
		expect(u.structuredContent.contact).toMatchObject({ job_title: "Boss", emails_total: 6_000 });
		expect(u.structuredContent.undo).toEqual({ tool: "contacts_update", arguments: { contact_id: "contacts/many.vcf", job_title: null } });
		// Nothing of the card was lost by showing less of it.
		const stored = dav.homes.get(QA.a)?.get("contacts")?.cards.get("many.vcf")?.jcard as [string, unknown[][]];
		expect(stored[1].filter((p) => p[0] === "email")).toHaveLength(6_000);
	});

	it("a 600,000-character organisation and other huge fields are cut to their limits and named", async () => {
		const quotes = '"\\'.repeat(10_000);
		dav.addCard(
			QA.a,
			"contacts",
			"huge.vcf",
			card("huge-1", [
				["fn", {}, "text", `F${quotes}`],
				["n", {}, "text", [`${quotes}`, "Given", "", "", ""]],
				["org", {}, "text", ["O".repeat(600_000)]],
				["title", {}, "text", "T".repeat(5_000)],
				["email", {}, "text", `${"e".repeat(400)}@x.example`],
				...Array.from({ length: 30 }, (_, i) => ["url", {}, "uri", `https://w.example/${"w".repeat(2_500)}${i}`]),
				...Array.from({ length: 30 }, (_, i) => ["adr", { type: "home" }, "text", ["", "", `${"S".repeat(900)}${i}`, "C".repeat(300), "", "P".repeat(60), "Land"]]),
				["note", {}, "text", quotes],
				["bday", {}, "text", "B".repeat(500)],
			]),
		);
		const g = await callTool("contacts_get", { contact_id: "contacts/huge.vcf" });
		expect(g.isError, g.content[0]?.text).toBeFalsy();
		expectOutputSchema("contacts_get", g);
		expectBounded(g);
		const c = g.structuredContent.contact;
		expect(c.organization).toHaveLength(SHOWN_CHARS.name);
		expect(c.organization.endsWith(ELLIPSIS)).toBe(true);
		expect(c.full_name).toHaveLength(SHOWN_CHARS.name);
		expect(c.job_title).toHaveLength(SHOWN_CHARS.name);
		expect(c.emails[0].address).toHaveLength(SHOWN_CHARS.email);
		expect(c.birthday).toHaveLength(SHOWN_CHARS.birthday);
		expect(c.notes.length).toBeLessThanOrEqual(LIMITS.notesOutChars);
		expect(c.notes_truncated).toBe(true);
		expect(c.websites.length).toBeLessThanOrEqual(SHOWN_ITEMS.websites);
		expect(c.websites_total).toBe(30);
		expect(c.addresses.length).toBeLessThanOrEqual(SHOWN_ITEMS.addresses);
		expect(c.addresses_total).toBe(30);
		for (const f of ["full_name", "family_name", "organization", "job_title", "emails", "birthday", "websites", "addresses", "notes"]) expect(c.truncated_fields).toContain(f);
		// The same contact through contacts_update, whose answer also carries the undo and warnings.
		const u = await callTool("contacts_update", { contact_id: "contacts/huge.vcf", given_name: "Other" });
		expect(u.isError, u.content[0]?.text).toBeFalsy();
		expectOutputSchema("contacts_update", u);
		expectBounded(u);
	});

	it("lists that are long together are shortened from the largest one until the contact fits", async () => {
		// Ten web addresses of 2,048 quote-heavy characters are 40 KB as JSON on their own.
		const site = (i: number) => `https://w.example/${'"'.repeat(2_000)}${i}`;
		dav.addCard(
			QA.a,
			"contacts",
			"lists.vcf",
			card("lists-1", [
				["fn", {}, "text", "Lists"],
				...Array.from({ length: 10 }, (_, i) => ["url", {}, "uri", site(i)]),
				...Array.from({ length: 20 }, (_, i) => ["email", {}, "text", `${'"'.repeat(240)}${i}@x.example`]),
				...Array.from({ length: 10 }, (_, i) => ["adr", {}, "text", ["", "", '"'.repeat(250), '"'.repeat(99), '"'.repeat(99), '"'.repeat(19), `${i}`]]),
				["note", {}, "text", '"'.repeat(1_999)],
			]),
		);
		const g = await callTool("contacts_get", { contact_id: "contacts/lists.vcf" });
		expect(g.isError, g.content[0]?.text).toBeFalsy();
		expectOutputSchema("contacts_get", g);
		expectBounded(g);
		const c = g.structuredContent.contact;
		expect(c.websites.length).toBeLessThan(10);
		expect(c.websites_total).toBe(10);
		// Entries are left out from the end, so the ones shown are the first ones.
		expect(c.websites[0]).toBe(site(0));
		expect(c.emails_total).toBe(20);
	});

	it("contacts_add answers with the bounded view of what it stored", async () => {
		const r = await callTool("contacts_add", { full_name: "Added", notes: "x".repeat(10_000) });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		expectOutputSchema("contacts_add", r);
		expectBounded(r);
		expect(r.structuredContent.contact).toMatchObject({ notes_truncated: true, truncated_fields: ["notes"], emails_total: 0 });
	});
});

describe("contacts_update gives only exact undos (fix round 3)", () => {
	it("none after removing an email with PREF and a second type, or two numbers with the same digits", async () => {
		dav.addCard(
			QA.a,
			"contacts",
			"pref.vcf",
			card("pref-1", [
				["fn", {}, "text", "Pref"],
				["email", { type: ["work", "internet"], pref: "1" }, "text", "a@b.example"],
				["email", { type: "home" }, "text", "c@d.example"],
				["tel", { type: "cell" }, "text", "+44 20 7946 0958"],
				["tel", { type: "cell" }, "text", "+442079460958"],
			]),
		);
		const e = await callTool("contacts_update", { contact_id: "contacts/pref.vcf", remove_emails: ["a@b.example"] });
		expect(e.isError, e.content[0]?.text).toBeFalsy();
		expect(e.structuredContent.undo).toBeNull();
		expect(e.structuredContent.warnings).toContain("This change can't be undone automatically.");
		const t = await callTool("contacts_update", { contact_id: "contacts/pref.vcf", remove_phones: ["+44 20 7946 0958"] });
		expect(t.structuredContent.contact.phones).toEqual([]);
		expect(t.structuredContent.undo).toBeNull();
		// A plain entry still gets an exact undo, and running it puts the entry back as it was.
		const h = await callTool("contacts_update", { contact_id: "contacts/pref.vcf", remove_emails: ["c@d.example"] });
		expect(h.structuredContent.undo).toEqual({ tool: "contacts_update", arguments: { contact_id: "contacts/pref.vcf", add_emails: [{ address: "c@d.example", label: "home" }] } });
		const back = await callTool("contacts_update", h.structuredContent.undo.arguments);
		expect(back.isError, back.content[0]?.text).toBeFalsy();
		const stored = dav.homes.get(QA.a)?.get("contacts")?.cards.get("pref.vcf")?.jcard as [string, unknown[][]];
		expect(stored[1].filter((p) => p[0] === "email")).toEqual([["email", { type: "home" }, "text", "c@d.example"]]);
	});

	it("none when the earlier web address would come back in another form", async () => {
		dav.addCard(QA.a, "contacts", "web.vcf", card("web-1", [["fn", {}, "text", "Web"], ["url", {}, "uri", "https://a.example"]]));
		const r = await callTool("contacts_update", { contact_id: "contacts/web.vcf", website: "https://b.example/" });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		expect(r.structuredContent.undo).toBeNull();
	});
});

describe("contacts_search (fix round 3)", () => {
	it("searches the person's own books first, and names the books it didn't search", async () => {
		dav.addBook(QA.a, "shared-dir", { displayName: "Directory", owner: "principals/users/nourax-teams", readOnly: true });
		for (let i = 0; i < 29; i++) dav.addBook(QA.a, `b${String(i).padStart(2, "0")}`, { displayName: `Book ${i}` });
		fake.requests.length = 0;
		const r = await callTool("contacts_search", { query: "zz" });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		expectOutputSchema("contacts_search", r);
		expectBounded(r);
		const searched = callsTo(fake, "REPORT", /\/$/).map((c) => decodeURIComponent(c.url.pathname.split("/").slice(-2)[0] ?? ""));
		expect(searched).toHaveLength(MAX_BOOKS);
		expect(searched).not.toContain("shared-dir");
		expect(searched).toContain("contacts");
		const note = String(r.structuredContent.note);
		expect(note).toMatch(/^Only 25 of the person's 31 address books were searched \(their own books first\)\. address_book_id searches one of the others: /);
		expect(note).toContain("shared-dir");
		for (const id of ["b24", "b25", "b26", "b27", "b28"]) expect(note).toContain(id);
		// The book named there can be searched.
		fake.requests.length = 0;
		await callTool("contacts_search", { query: "zz", address_book_id: "shared-dir" });
		expect(callsTo(fake, "REPORT", /\/shared-dir\/$/)).toHaveLength(1);
	});

	it("pages through hits that are large together, never repeating or stalling", async () => {
		// Each card is longer than shown in every field (about 6 KB as shown, so 25 need three pages),
		// while the book's whole REPORT answer stays under the per-book read cap of the search's
		// memory budget (SEARCH_FAN_OUT.perBookBytes, 1 MiB; about 0.7 MB here). A bigger answer is
		// refused as too large (search-budget.test.ts).
		for (let i = 0; i < 25; i++) {
			dav.addCard(
				QA.a,
				"contacts",
				`big${i}.vcf`,
				card(`big-${i}`, [
					["fn", {}, "text", `Big ${String(i).padStart(2, "0")} ${'"'.repeat(400)}`],
					["org", {}, "text", ["O".repeat(2_000)]],
					...Array.from({ length: 12 }, (_, k) => ["email", {}, "text", `${'"'.repeat(260)}${k}@x.example`]),
				]),
			);
		}
		const token = await tokenFor();
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		for (;;) {
			const r = await callTool("contacts_search", { query: "big", limit: 50, ...(cursor ? { cursor } : {}) }, { token });
			expect(r.isError, r.content[0]?.text).toBeFalsy();
			expectOutputSchema("contacts_search", r);
			expectBounded(r);
			const hits = r.structuredContent.contacts as { contact_id: string; full_name: string; emails: string[] }[];
			expect(hits.length).toBeGreaterThan(0);
			for (const h of hits) {
				expect(h.full_name.length).toBeLessThanOrEqual(SHOWN_CHARS.name);
				expect(h.emails.length).toBeLessThanOrEqual(10);
			}
			seen.push(...hits.map((h) => h.contact_id));
			pages++;
			if (!r.structuredContent.has_more) break;
			cursor = r.structuredContent.next_cursor as string;
			expect(pages).toBeLessThan(25);
		}
		expect(pages).toBeGreaterThan(1);
		expect(new Set(seen).size).toBe(25);
	});
});
