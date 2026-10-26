/**
 * Searching many address books in one contacts_search call inside one memory budget (lane B, the
 * review round after fix round 3). Without address_book_id the tool searches up to 25 books, and
 * the isolate's 128 MB is shared by every request it serves. NC 35 sets no size limit on a vCard
 * (apps/dav/lib/CardDAV, read on the server), and the REPORT returns FN, N, EMAIL, TEL and ORG in
 * full, so large cards in a book the person can see (their own, a shared one, or one a prompted
 * assistant filled) must not be able to push the isolate past its limit. So, as the calendar
 * tools do (tools/calendar/fan-out.ts):
 * - at most 3 REPORTs run at a time, each read to its end before the next book is asked; the
 *   client's own 4-at-a-time limit covers only the wait for the headers, not the body;
 * - one answer is read up to 1 MiB (25 matches of these five properties are a few KB for real
 *   cards), and all answers of one call together up to 6 MiB; a read in progress holds its full
 *   share of that budget until it is done, so the three in flight never exceed it, and an answer
 *   that ran over its share keeps that share counted as read;
 * - each book's answer becomes small records at once (`each`), and parsing is synchronous, so only
 *   one answer is ever parsed at a time and it is dropped before the next one is;
 * - every book beyond the first 3 counts one more read against the person's per-minute limit,
 *   because each one is another query on the server.
 * A book whose answer is over its share, or that is reached when too little of the budget is left,
 * is left out (`tooBig`); a book that answers with an error is left out too (`unreadable`). Both
 * keep the order the books were given in, so the tool can name them.
 */
import { isToolError } from "../../core/errors";
import type { ToolCtx } from "../../core/tool";
import { type DavResponse, parseMultistatus } from "../../nc/index";
import { type Book, bookPath } from "./books";

export const SEARCH_FAN_OUT = {
	concurrency: 3,
	perBookBytes: 1024 * 1024,
	totalBytes: 6 * 1024 * 1024,
	/** A book is not even asked for when less than this is left of the budget. */
	minShareBytes: 128 * 1024,
	/** Books covered by the call's own unit of the read limit. */
	includedBooks: 3,
} as const;

export type SearchFanOutLimits = { readonly [K in keyof typeof SEARCH_FAN_OUT]: number };

/** Errors that end the whole call rather than leave one book out. */
const FATAL = new Set(["reconnect_required", "rate_limited", "daily_limit", "timeout"]);

export interface BooksSearched<T> {
	/** One entry per book that answered, in the order the books were given. */
	items: T[];
	/** Books that answered with an error. */
	unreadable: Book[];
	/** Books whose answer didn't fit in their share of the budget. */
	tooBig: Book[];
}

/** One REPORT on one book, read up to `maxBytes`. */
async function reportCapped(ctx: ToolCtx, path: string, body: string, maxBytes: number): Promise<{ responses: DavResponse[]; bytes: number }> {
	const res = await ctx.nc.request("REPORT", path, {
		headers: { "content-type": "application/xml; charset=utf-8", depth: "1" },
		body,
		what: "the address book",
	});
	if (res.status === 204) {
		await res.body?.cancel();
		return { responses: [], bytes: 0 };
	}
	const raw = await ctx.nc.readBytes(res, maxBytes);
	return { responses: parseMultistatus(new TextDecoder().decode(raw)), bytes: raw.byteLength };
}

/** Runs the same addressbook-query REPORT on each book inside the budget above. */
export async function searchBooks<T>(
	ctx: ToolCtx,
	books: readonly Book[],
	body: string,
	each: (responses: DavResponse[], book: Book, path: string) => T,
	limits: SearchFanOutLimits = SEARCH_FAN_OUT,
): Promise<BooksSearched<T>> {
	const extra = books.length - limits.includedBooks;
	if (extra > 0) await ctx.charge("read", extra);
	const per: (T | undefined)[] = books.map(() => undefined);
	const outcome: ("ok" | "unreadable" | "tooBig" | undefined)[] = books.map(() => undefined);
	let left = limits.totalBytes;
	let next = 0;
	let stop = false;
	const worker = async (): Promise<void> => {
		while (!stop) {
			const i = next++;
			const book = books[i];
			if (!book) return;
			const cap = Math.min(limits.perBookBytes, left);
			if (cap < limits.minShareBytes) {
				outcome[i] = "tooBig";
				continue;
			}
			left -= cap;
			let used = 0;
			try {
				const path = bookPath(ctx.uid, book.id);
				const { responses, bytes } = await reportCapped(ctx, path, body, cap);
				used = bytes;
				per[i] = each(responses, book, path);
				outcome[i] = "ok";
			} catch (e) {
				if (!isToolError(e) || e.deadCredential || FATAL.has(e.code)) {
					stop = true;
					throw e;
				}
				if (e.code === "too_large") {
					// Up to the whole share may have been read before it ran over: count it all.
					used = cap;
					outcome[i] = "tooBig";
				} else outcome[i] = "unreadable";
			} finally {
				left += cap - used;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limits.concurrency, books.length) }, () => worker()));
	const items: T[] = [];
	const unreadable: Book[] = [];
	const tooBig: Book[] = [];
	books.forEach((b, i) => {
		const o = outcome[i];
		if (o === "ok") items.push(per[i] as T);
		else if (o === "tooBig") tooBig.push(b);
		else unreadable.push(b);
	});
	return { items, unreadable, tooBig };
}
