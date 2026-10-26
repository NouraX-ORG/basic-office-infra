/**
 * contacts_search (DESIGN 11.7): an addressbook-query REPORT on each of the person's address books,
 * test=anyof on FN, N, EMAIL, TEL and ORG with i;unicode-casemap "contains" matching, answered as
 * jCard with only the properties shown. Results are merged, sorted by name and paged with a cursor
 * bound to the arguments.
 *
 * The books are read inside one memory budget (fan-out.ts: 3 at a time, 1 MiB each, 6 MiB a call,
 * one more read counted per book beyond the first 3). A book that can't be searched is left out
 * and named in `note`, and the summary says how many were searched ("in 2 of 3 address books"), so
 * "no match" is never said about a book nobody looked in. When no book at all could be searched,
 * the call fails instead of answering "No contacts matched".
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { cursorArg, limitArg } from "../../core/shapes";
import { defineTool } from "../../core/tool";
import { rawXml, xml } from "../../core/xml";
import { type DavResponse, NS, propText, XMLNS } from "../../nc/index";
import { cleanText, parseJCard, readCard } from "../../pim/vcard";
import { answerRoom, pageWindow, shownOrNull } from "../sharing/bounded";
import { type Book, contactIdOf, encodeIdPart, findBook, lastSegment, listBooks, parseBookId } from "./books";
import { type BooksSearched, searchBooks } from "./fan-out";
import { SHOWN_CHARS } from "./shapes";

/**
 * Matches read per address book (DESIGN 11.7: nresults 25). Every page reads the books again (the
 * cursor holds only an offset), so this keeps each call small for the server: at most 25 books ×
 * 25 cards. A book that answers with 25 may hold more; the note then says to search more exactly.
 */
export const PER_BOOK = 25;
/** Address books searched per call. More are named in the note, for address_book_id (fix round 3). */
export const MAX_BOOKS = 25;
/** Email addresses and phone numbers shown per hit; contacts_get shows more. */
const HIT_ITEMS = 10;
/** Book ids or names listed in one sentence of the note at most. */
const BOOKS_NAMED = 20;

const input = z
	.object({
		query: z.string().min(1).max(100).describe("Text in a name, email, phone number or organisation."),
		address_book_id: z.string().max(200).optional().describe("Only this address book."),
		limit: limitArg(50, 20),
		cursor: cursorArg(),
	})
	.strict();

const Hit = z.object({
	contact_id: z.string(),
	address_book_id: z.string(),
	address_book: z.string(),
	full_name: z.string().nullable(),
	emails: z.array(z.string()),
	phones: z.array(z.string()),
	organization: z.string().nullable(),
	read_only: z.boolean(),
});
type Hit = z.infer<typeof Hit>;

/**
 * The shape of structuredContent. Not published as outputSchema: tools/list must stay small (60 KB
 * for every tool together); the same JSON is in the framed text block, and the tests hold every
 * result to this schema.
 */
export const contactsSearchOutput = z.object({
	contacts: z.array(Hit),
	next_cursor: z.string().nullable(),
	has_more: z.boolean(),
	note: z.string().nullable(),
});

function reportBody(q: string) {
	const match = (name: string) =>
		xml`<card:prop-filter name="${name}"><card:text-match collation="i;unicode-casemap" match-type="contains">${q}</card:text-match></card:prop-filter>`;
	return xml`<?xml version="1.0" encoding="UTF-8"?><card:addressbook-query ${rawXml(XMLNS)}><d:prop><d:getetag/><card:address-data content-type="application/vcard+json" version="4.0"><card:prop name="UID"/><card:prop name="FN"/><card:prop name="N"/><card:prop name="EMAIL"/><card:prop name="TEL"/><card:prop name="ORG"/></card:address-data></d:prop><card:filter test="anyof">${[match("FN"), match("N"), match("EMAIL"), match("TEL"), match("ORG")]}</card:filter><card:limit><card:nresults>${PER_BOOK}</card:nresults></card:limit></card:addressbook-query>`;
}

/** One book's answer as hits; `full` when the server gave as many matches as were asked for. */
function hitsOf(rs: DavResponse[], book: Book, path: string): { hits: Hit[]; full: boolean } {
	const hits: Hit[] = [];
	for (const r of rs) {
		const name = lastSegment(r.href, path);
		const data = propText(r, NS.card, "address-data");
		if (!name || !data) continue;
		let f: ReturnType<typeof readCard>;
		try {
			f = readCard(parseJCard(data));
		} catch {
			continue;
		}
		// Display text cut to the field limits, so one card made elsewhere can't outgrow a page (fix round 3).
		hits.push({
			contact_id: contactIdOf(book.id, name),
			address_book_id: encodeIdPart(book.id),
			address_book: shownOrNull(book.name, SHOWN_CHARS.book) ?? "",
			full_name: shownOrNull(f.full_name ?? [f.given_name, f.family_name].filter(Boolean).join(" "), SHOWN_CHARS.name),
			emails: f.emails.slice(0, HIT_ITEMS).map((e) => shownOrNull(e.address, SHOWN_CHARS.email) ?? ""),
			phones: f.phones.slice(0, HIT_ITEMS).map((p) => shownOrNull(p.number, SHOWN_CHARS.phone) ?? ""),
			organization: shownOrNull(f.organization, SHOWN_CHARS.name),
			read_only: book.read_only,
		});
	}
	return { hits, full: rs.length >= PER_BOOK };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** `The address book "A"` or `The address books "A", "B" and 3 more` (names are data: note only). */
function namedBooks(books: readonly Book[]): string {
	const names = books.slice(0, BOOKS_NAMED).map((b) => `"${shownOrNull(b.name, SHOWN_CHARS.book) ?? encodeIdPart(b.id)}"`);
	const more = books.length - names.length;
	if (more > 0) names.push(`${more} more`);
	const list = names.length === 1 ? (names[0] as string) : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
	return `${books.length === 1 ? "The address book" : "The address books"} ${list}`;
}

/** The books left out, in counts only (for the summary and errors, which are not framed). */
function leftOutWords(r: BooksSearched<unknown>): string {
	const parts: string[] = [];
	if (r.unreadable.length) parts.push(`${r.unreadable.length} couldn't be searched just now`);
	if (r.tooBig.length) parts.push(`${r.tooBig.length} held more matches than can be read in one go`);
	return parts.join(" and ");
}

/** The error when not one of the books could be searched: never "No contacts matched". */
function nothingSearched(r: BooksSearched<unknown>): ToolError {
	if (r.tooBig.length === 0) return new ToolError("upstream_unavailable", "NoContacts didn't answer. Try again in a minute.");
	if (r.unreadable.length === 0) {
		const which = r.tooBig.length === 1 ? "the address book" : `all ${r.tooBig.length} address books`;
		return new ToolError("too_large", `The matches in ${which} were more than can be read in one go.`, { field: "query", hint: "A more exact query finds them." });
	}
	return new ToolError(
		"upstream_unavailable",
		`No address book could be searched: ${r.unreadable.length} didn't answer and ${r.tooBig.length} held more matches than can be read in one go. Try again in a minute, or use a more exact query.`,
	);
}

export const contactsSearch = defineTool({
	name: "contacts_search",
	title: "Search contacts",
	description:
		"Searches the person's NoContacts address books by name, email address, phone number or organisation, including the workspace's own people directories, which are read-only. contacts_get returns every field of one contact. Up to 50 results per call, with next_cursor.",
	input,
	async run(ctx, args) {
		const q = cleanText(args.query);
		if (!q) throw new ToolError("invalid_input", "query is empty.", { field: "query" });
		const all = await listBooks(ctx);
		const notes: string[] = [];
		let books: Book[];
		if (args.address_book_id !== undefined) books = [findBook(all, parseBookId(args.address_book_id))];
		else {
			// The person's own books first, then shared and generated ones, each in the server's order.
			const ordered = [...all.filter((b) => !b.read_only), ...all.filter((b) => b.read_only)];
			books = ordered.slice(0, MAX_BOOKS);
			const rest = ordered.slice(MAX_BOOKS);
			if (rest.length) {
				const named = rest.slice(0, BOOKS_NAMED).map((b) => encodeIdPart(b.id));
				const more = rest.length > named.length ? ` and ${rest.length - named.length} more` : "";
				notes.push(
					`Only ${MAX_BOOKS} of the person's ${all.length} address books were searched (their own books first). address_book_id searches one of the others: ${named.join(", ")}${more}.`,
				);
			}
		}
		const r = await searchBooks(ctx, books, reportBody(q).xml, hitsOf);
		const failed = r.unreadable.length + r.tooBig.length;
		if (failed > 0 && failed === books.length) throw nothingSearched(r);
		if (r.unreadable.length) notes.push(`${namedBooks(r.unreadable)} couldn't be searched just now; ${r.unreadable.length === 1 ? "it was" : "they were"} left out.`);
		if (r.tooBig.length) {
			notes.push(`${namedBooks(r.tooBig)} held more matches than can be read in one go, so ${r.tooBig.length === 1 ? "it was" : "they were"} left out; a more exact query finds them.`);
		}
		if (r.items.some((x) => x.full)) notes.push(`Each address book gives at most ${PER_BOOK} matches, so there may be more than shown; a more exact query finds them.`);
		const hits = r.items
			.flatMap((x) => x.hits)
			.sort((a, b) => (a.full_name ?? "").localeCompare(b.full_name ?? "", undefined, { sensitivity: "base" }) || a.contact_id.localeCompare(b.contact_id));

		const raw = await ctx.page.decode<number>();
		const offset = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= hits.length ? raw : 0;
		const note = notes.length ? notes.join(" ") : null;
		// Fitted as structuredContent carries it (JSON with nulls kept), and always moving on (fix round 3).
		const page = pageWindow(hits, offset, args.limit, (xs) => ({ contacts: xs, next_cursor: "x".repeat(200), has_more: true, note }), answerRoom(ctx));
		const has_more = page.next < hits.length;
		const data = {
			contacts: page.items,
			next_cursor: has_more ? await ctx.page.encode(page.next) : null,
			has_more,
			note,
		};
		const skipped = page.skipped ? ` ${page.skipped} contact was too large to show and was left out.` : "";
		// Counts only: how many books were searched is said exactly, so "no match" is never claimed
		// for a book that wasn't read (their names are in the note, which is framed as data).
		const searched = books.length - failed;
		const where = failed ? `${searched} of ${books.length} address books` : plural(books.length, "address book", "address books");
		const showing = `showing ${page.items.length}${offset ? ` from number ${offset + 1}` : ""}`;
		let summary: string;
		if (hits.length === 0) summary = failed ? `No contacts matched in ${where}; ${leftOutWords(r)}.` : `No contacts matched in ${where}.`;
		else if (failed) summary = `Found ${plural(hits.length, "contact", "contacts")} in ${where} (${leftOutWords(r)}); ${showing}.${skipped}`;
		else summary = `Found ${plural(hits.length, "contact", "contacts")}; ${showing}.${skipped}`;
		return { data, summary };
	},
});
