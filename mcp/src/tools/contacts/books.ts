/**
 * Address books and cards for the contacts tools (DESIGN 11.7).
 * - Books are the collections in /remote.php/dav/addressbooks/users/{uid}/. A book is read-only when
 *   the server says so (oc:read-only, or no DAV write privilege), when it is shared with the person
 *   (an organisation directory or a team book), or when it is one of the two generated books.
 *   Writes go only to the person's own books.
 * - Ids are opaque: address_book_id is the book's name, contact_id is "<book>/<card file>", each
 *   part percent-encoded so only [A-Za-z0-9_.%-] remain.
 * - Cards travel as jCard (application/vcard+json). A card we write is at most 100 KB.
 */
import { ToolError } from "../../core/errors";
import { splitPairId } from "../../core/ids";
import { LIMITS } from "../../core/limits";
import { davPath, encodeSegment } from "../../core/paths";
import type { ToolCtx } from "../../core/tool";
import { rawXml, xml } from "../../core/xml";
import { type DavResponse, NS, propEl, propText, XMLNS } from "../../nc/index";
import { parseJCard } from "../../pim/vcard";
import type ICAL from "ical.js";

export const READ_ONLY_BOOKS = new Set(["z-server-generated--system", "z-app-generated--contactsinteraction--recent"]);
/** The name of the default book NoContacts makes for every account. */
export const DEFAULT_BOOK = "contacts";
/** Reading a card: more than we write, so cards with a photo can still be shown and changed. */
export const CARD_READ_BYTES = 1024 * 1024;

export interface Book {
	id: string;
	name: string;
	read_only: boolean;
	/** Shared with the person by someone else (for example an organisation directory). */
	shared: boolean;
}

/** Percent-encodes everything except [A-Za-z0-9_.-], so ids pass the opaque-id pattern. */
export function encodeIdPart(s: string): string {
	return encodeURIComponent(s).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeIdPart(s: string, field: string): string {
	try {
		const d = decodeURIComponent(s);
		if (!d || d === "." || d === ".." || d.includes("/") || d.includes("\\")) throw new Error("bad");
		return d;
	} catch {
		throw new ToolError("invalid_input", `${field} isn't valid. Ids come from contacts_search.`, { field });
	}
}

export function contactIdOf(bookId: string, cardName: string): string {
	return `${encodeIdPart(bookId)}/${encodeIdPart(cardName)}`;
}

export function parseContactId(raw: string, field = "contact_id"): { book: string; card: string } {
	const { collection, object } = splitPairId(raw, field);
	return { book: decodeIdPart(collection, field), card: decodeIdPart(object, field) };
}

export function parseBookId(raw: string, field = "address_book_id"): string {
	if (!/^[A-Za-z0-9_.%@+=-]{1,200}$/.test(raw)) throw new ToolError("invalid_input", `${field} isn't valid. Ids come from contacts_search.`, { field });
	return decodeIdPart(raw, field);
}

export function homePath(uid: string): string {
	return `/remote.php/dav/addressbooks/users/${encodeSegment(uid)}/`;
}

export function bookPath(uid: string, book: string): string {
	return `${davPath(`/remote.php/dav/addressbooks/users/${encodeSegment(uid)}`, book)}/`;
}

export function cardPath(uid: string, book: string, card: string): string {
	return davPath(`/remote.php/dav/addressbooks/users/${encodeSegment(uid)}`, book, card);
}

/** The last path segment of an href, decoded; null when the href is not inside `prefix`. */
export function lastSegment(href: string, prefix: string): string | null {
	let path = href;
	try {
		if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
	} catch {
		return null;
	}
	if (!path.startsWith(prefix)) return null;
	const rest = path.slice(prefix.length).replace(/\/+$/, "");
	if (!rest || rest.includes("/")) return null;
	try {
		const seg = decodeURIComponent(rest);
		return seg && seg !== "." && seg !== ".." && !seg.includes("/") ? seg : null;
	} catch {
		return null;
	}
}

function hasWrite(r: DavResponse): boolean {
	const set = propEl(r, NS.d, "current-user-privilege-set");
	if (!set) return true;
	return set.children.some((p) => p.local === "privilege" && p.children.some((c) => c.ns === NS.d && (c.local === "write" || c.local === "write-content" || c.local === "all")));
}

function isAddressBook(r: DavResponse): boolean {
	const rt = propEl(r, NS.d, "resourcetype");
	return Boolean(rt?.children.some((c) => c.ns === NS.card && c.local === "addressbook"));
}

const BOOKS_BODY = `<?xml version="1.0" encoding="UTF-8"?><d:propfind ${XMLNS}><d:prop><d:resourcetype/><d:displayname/><d:current-user-privilege-set/><oc:read-only/><oc:owner-principal/></d:prop></d:propfind>`;

export async function listBooks(ctx: ToolCtx): Promise<Book[]> {
	const prefix = homePath(ctx.uid);
	const rs = await ctx.nc.dav.propfind(prefix, 1, BOOKS_BODY, { what: "the address books" });
	const out: Book[] = [];
	for (const r of rs) {
		if (!isAddressBook(r)) continue;
		const id = lastSegment(r.href, prefix);
		if (!id) continue;
		const owner = propText(r, NS.oc, "owner-principal");
		const shared = owner !== null && owner !== `principals/users/${ctx.uid}`;
		const ro = propText(r, NS.oc, "read-only");
		const readOnly = READ_ONLY_BOOKS.has(id) || shared || ro === "1" || ro === "true" || !hasWrite(r);
		out.push({ id, name: (propText(r, NS.d, "displayname") ?? id).slice(0, 200), read_only: readOnly, shared });
	}
	return out;
}

export function findBook(books: Book[], id: string): Book {
	const b = books.find((x) => x.id === id);
	if (!b) throw new ToolError("not_found", "There's no address book with that id. contacts_search lists the person's contacts and their books.", { field: "address_book_id" });
	return b;
}

/** The book new contacts go to: the given one (must be the person's own), else "contacts", made when missing. */
export async function writableBook(ctx: ToolCtx, books: Book[], requested: string | undefined): Promise<Book> {
	if (requested !== undefined) {
		const b = findBook(books, parseBookId(requested));
		if (b.read_only) {
			throw new ToolError("permission_denied", "That address book is read-only; contacts can only be added to the person's own address books.", { field: "address_book_id" });
		}
		return b;
	}
	const own = books.filter((b) => !b.read_only);
	const preferred = own.find((b) => b.id === DEFAULT_BOOK) ?? own[0];
	if (preferred) return preferred;
	// No address book of their own yet (new accounts have only shared ones): make the default one.
	const body = xml`<?xml version="1.0" encoding="UTF-8"?><d:mkcol ${rawXml(XMLNS)}><d:set><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>${"Contacts"}</d:displayname></d:prop></d:set></d:mkcol>`;
	const res = await ctx.nc.dav.mkcol(bookPath(ctx.uid, DEFAULT_BOOK), body, { allow: [405], what: "the address book" });
	await res.body?.cancel();
	ctx.log.note("contacts_book_made");
	return { id: DEFAULT_BOOK, name: "Contacts", read_only: false, shared: false };
}

export interface CardRead {
	card: ICAL.Component;
	etag: string | null;
	bytes: number;
}

/** GET one card as jCard. */
export async function getCard(ctx: ToolCtx, book: string, cardName: string): Promise<CardRead> {
	const res = await ctx.nc.dav.get(cardPath(ctx.uid, book, cardName), {
		headers: { accept: "application/vcard+json" },
		what: "that contact",
	});
	const bytes = await ctx.nc.readBytes(res, CARD_READ_BYTES);
	const text = new TextDecoder().decode(bytes);
	const etag = res.headers.get("etag");
	return { card: parseJCard(text), etag: etag ? etag.replace(/^W\//, "").replace(/^"(.*)"$/, "$1") : null, bytes: bytes.length };
}

export function checkCardSize(json: string, before = 0): void {
	const size = new TextEncoder().encode(json).length;
	if (size > Math.max(LIMITS.cardBytes, before + 16 * 1024)) {
		throw new ToolError("too_large", `This contact would be ${Math.ceil(size / 1024)} KB; contacts are limited to 100 KB here. Shorter notes may fit.`);
	}
}

/** Maps a NoContacts refusal on a write to plain words (error texts carry no names people wrote). */
export function writeError(e: unknown): unknown {
	if (e instanceof ToolError && e.code === "permission_denied") {
		return new ToolError("permission_denied", "That address book is read-only, so its contacts can't be changed here.", { upstreamStatus: e.upstreamStatus });
	}
	if (e instanceof ToolError && e.code === "unsupported_type") {
		return new ToolError("invalid_input", "NoContacts refused the contact as invalid.", { upstreamStatus: e.upstreamStatus });
	}
	return e;
}

/** A link longer than this isn't one a person can use; a card's UID can be any length (fix round 3). */
const WEB_URL_MAX = 2_048;

export function webUrlOf(driveOrigin: string, vcardUid: string | null, book: string): string | null {
	if (!vcardUid) return null;
	const url = `${driveOrigin}/apps/contacts/direct/contact/${encodeURIComponent(`${vcardUid}~${book}`.toWellFormed())}`;
	return url.length <= WEB_URL_MAX ? url : null;
}
