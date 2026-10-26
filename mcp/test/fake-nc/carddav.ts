/**
 * Lane B's CardDAV part of the fake: address books under /remote.php/dav/addressbooks/users/{uid}/,
 * answering PROPFIND (books), REPORT addressbook-query (jCard in address-data, with the
 * properties asked for), GET as jCard with an ETag, PUT of a jCard (If-None-Match / If-Match, no
 * ETag back, as the server sends none for a converted card) and extended MKCOL. Shapes follow
 * what the live server answered for qa-t1-211 (an organisation directory and a team book shared
 * read-only by nourax-teams, "Recently contacted", no own book until one is made).
 */
import type { FakeNc, Recorded } from "./index";

export interface FakeCard {
	jcard: unknown[];
	etag: string;
}

export interface FakeBook {
	displayName: string;
	/** principals/users/<owner>; differs from the person's own for shared books. */
	owner: string;
	readOnly: boolean;
	cards: Map<string, FakeCard>;
}

export interface FakeCardDav {
	homes: Map<string, Map<string, FakeBook>>;
	addBook(uid: string, id: string, opts?: { displayName?: string; owner?: string; readOnly?: boolean }): FakeBook;
	addCard(uid: string, book: string, name: string, jcard: unknown[]): FakeCard;
	/** Makes every REPORT on this book answer 500. */
	failReportOn: string | null;
	/** Makes every REPORT on every book answer this status (for example 500 or 503), while set. */
	failEveryReport: number | null;
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function textOf(v: unknown): string {
	if (typeof v === "string") return v;
	if (Array.isArray(v)) return v.map(textOf).join(" ");
	return v === null || v === undefined ? "" : String(v);
}

const ms = (inner: string) =>
	new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:oc="http://owncloud.org/ns">${inner}</d:multistatus>`, {
		status: 207,
		headers: { "content-type": "application/xml; charset=utf-8" },
	});

export function installCardDav(fake: FakeNc): FakeCardDav {
	let n = 1;
	const dav: FakeCardDav = {
		homes: new Map(),
		failReportOn: null,
		failEveryReport: null,
		addBook(uid, id, opts = {}) {
			let h = dav.homes.get(uid);
			if (!h) {
				h = new Map();
				dav.homes.set(uid, h);
			}
			const b: FakeBook = { displayName: opts.displayName ?? id, owner: opts.owner ?? `principals/users/${uid}`, readOnly: opts.readOnly ?? false, cards: new Map() };
			h.set(id, b);
			return b;
		},
		addCard(uid, book, name, jcard) {
			const b = dav.homes.get(uid)?.get(book);
			if (!b) throw new Error(`no book ${book}`);
			const c = { jcard: structuredClone(jcard), etag: `etag${n++}` };
			b.cards.set(name, c);
			return c;
		},
	};

	const home = (uid: string) => dav.homes.get(uid) ?? new Map<string, FakeBook>();
	const own = (uid: string) => `principals/users/${uid}`;

	fake.on("PROPFIND", /^\/remote\.php\/dav\/addressbooks\/users\/([^/]+)\/$/, (req: Recorded, _f, m) => {
		const uid = decodeURIComponent(m[1] as string);
		if (!req.auth) return new Response("", { status: 401 });
		if (req.auth !== uid) return new Response("", { status: 404 });
		let inner = `<d:response><d:href>/remote.php/dav/addressbooks/users/${uid}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
		for (const [id, b] of home(uid)) {
			const priv = b.readOnly ? "<d:privilege><d:read/></d:privilege>" : "<d:privilege><d:all/></d:privilege><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege>";
			const shared = b.owner !== own(uid);
			inner += `<d:response><d:href>/remote.php/dav/addressbooks/users/${uid}/${encodeURIComponent(id)}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>${esc(b.displayName)}</d:displayname><d:current-user-privilege-set>${priv}</d:current-user-privilege-set>${b.readOnly ? "<oc:read-only>1</oc:read-only>" : ""}${shared ? `<oc:owner-principal>${b.owner}</oc:owner-principal>` : ""}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
		}
		return ms(inner);
	});

	fake.on("REPORT", /^\/remote\.php\/dav\/addressbooks\/users\/([^/]+)\/([^/]+)\/$/, (req, _f, m) => {
		const uid = decodeURIComponent(m[1] as string);
		const id = decodeURIComponent(m[2] as string);
		if (req.auth !== uid) return new Response("", { status: req.auth ? 404 : 401 });
		if (dav.failEveryReport !== null) return new Response("boom", { status: dav.failEveryReport });
		if (dav.failReportOn === id) return new Response("boom", { status: 500 });
		const b = home(uid).get(id);
		if (!b) return new Response("", { status: 404 });
		if (req.headers.get("depth") !== "1") return new Response("", { status: 501 });
		const tm = /<card:text-match[^>]*>([^<]*)<\/card:text-match>/.exec(req.body);
		const q = (tm?.[1] ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").toLowerCase();
		const limit = Number(/<card:nresults>(\d+)<\/card:nresults>/.exec(req.body)?.[1] ?? "1000");
		const wanted = new Set([...req.body.matchAll(/<card:prop name="([A-Z]+)"\/>/g)].map((x) => (x[1] as string).toLowerCase()));
		let inner = "";
		let count = 0;
		for (const [name, c] of b.cards) {
			const props = (c.jcard[1] as unknown[][]) ?? [];
			const hit = props.some((p) => ["fn", "n", "email", "tel", "org"].includes(String(p[0])) && textOf(p[3]).toLowerCase().includes(q));
			if (!hit) continue;
			if (count >= limit) break;
			count++;
			const filtered = wanted.size ? ["vcard", props.filter((p) => ["version", "uid", "fn", ...wanted].includes(String(p[0])))] : c.jcard;
			inner += `<d:response><d:href>/remote.php/dav/addressbooks/users/${uid}/${encodeURIComponent(id)}/${encodeURIComponent(name)}</d:href><d:propstat><d:prop><d:getetag>"${c.etag}"</d:getetag><card:address-data>${esc(JSON.stringify(filtered))}</card:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
		}
		return ms(inner);
	});

	fake.on("GET", /^\/remote\.php\/dav\/addressbooks\/users\/([^/]+)\/([^/]+)\/([^/]+)$/, (req, _f, m) => {
		const uid = decodeURIComponent(m[1] as string);
		if (req.auth !== uid) return new Response("", { status: req.auth ? 404 : 401 });
		const c = home(uid).get(decodeURIComponent(m[2] as string))?.cards.get(decodeURIComponent(m[3] as string));
		if (!c) return new Response("", { status: 404 });
		const jcardWanted = (req.headers.get("accept") ?? "").includes("application/vcard+json");
		const bodyText = jcardWanted ? JSON.stringify(c.jcard) : "BEGIN:VCARD\r\nEND:VCARD\r\n";
		return new Response(bodyText, { status: 200, headers: { "content-type": jcardWanted ? "application/vcard+json; charset=utf-8" : "text/vcard", etag: `"${c.etag}"` } });
	});

	fake.on("PUT", /^\/remote\.php\/dav\/addressbooks\/users\/([^/]+)\/([^/]+)\/([^/]+)$/, (req, _f, m) => {
		const uid = decodeURIComponent(m[1] as string);
		if (req.auth !== uid) return new Response("", { status: req.auth ? 404 : 401 });
		const b = home(uid).get(decodeURIComponent(m[2] as string));
		if (!b) return new Response("", { status: 404 });
		// ReadOnlyBooksPlugin (nourax_api) answers 403 on writes to a read-only book.
		if (b.readOnly) return new Response("This address book is read-only. Your organisation keeps it up to date.", { status: 403 });
		const name = decodeURIComponent(m[3] as string);
		const existing = b.cards.get(name);
		if (req.headers.get("if-none-match") === "*" && existing) return new Response("", { status: 412 });
		const im = req.headers.get("if-match");
		if (im && (!existing || im.replace(/"/g, "") !== existing.etag)) return new Response("", { status: 412 });
		if (!req.body.startsWith("[")) return new Response("only jCard here", { status: 415 });
		let j: unknown[];
		try {
			j = JSON.parse(req.body) as unknown[];
		} catch {
			return new Response("Parse error", { status: 415 });
		}
		const props = (j[1] as unknown[][]) ?? [];
		if (j[0] !== "vcard" || !props.some((p) => p[0] === "fn")) return new Response("Validation error in vCard", { status: 415 });
		b.cards.set(name, { jcard: j, etag: `etag${n++}` });
		return new Response(null, { status: existing ? 204 : 201 });
	});

	fake.on("MKCOL", /^\/remote\.php\/dav\/addressbooks\/users\/([^/]+)\/([^/]+)\/$/, (req, _f, m) => {
		const uid = decodeURIComponent(m[1] as string);
		if (req.auth !== uid) return new Response("", { status: req.auth ? 403 : 401 });
		const id = decodeURIComponent(m[2] as string);
		if (home(uid).has(id)) return new Response("", { status: 405 });
		if (!req.body.includes("<card:addressbook/>")) return new Response("", { status: 400 });
		const dn = /<d:displayname>([^<]*)<\/d:displayname>/.exec(req.body)?.[1] ?? id;
		dav.addBook(uid, id, { displayName: dn });
		return new Response(null, { status: 201 });
	});

	return dav;
}
