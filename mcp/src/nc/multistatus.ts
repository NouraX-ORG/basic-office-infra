/**
 * WebDAV multistatus parsing (PROPFIND, REPORT, SEARCH, PROPPATCH answers) over the guarded XML
 * parser. Props are keyed "{namespace}local". Only 2xx propstats count as found.
 */
import { childEl, childEls, parseXml, textOf, type XmlEl } from "../core/xml";

export const NS = {
	d: "DAV:",
	oc: "http://owncloud.org/ns",
	nc: "http://nextcloud.org/ns",
	cal: "urn:ietf:params:xml:ns:caldav",
	card: "urn:ietf:params:xml:ns:carddav",
	cs: "http://calendarserver.org/ns/",
	apple: "http://apple.com/ns/ical/",
} as const;

/** The xmlns declarations every request body uses. Lanes write `d:`, `oc:`, `nc:`, `cal:`, `card:`. */
export const XMLNS =
	'xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/" xmlns:x1="http://apple.com/ns/ical/"';

export interface DavResponse {
	/** The href as sent by the server (percent-encoded path). */
	href: string;
	/** A response-level status (for example 404 in a multistatus), when given. */
	status?: number;
	/** Found props (from 2xx propstats). */
	props: Map<string, XmlEl>;
	/** Props the server reported as missing (404 propstats). */
	missing: Set<string>;
}

function statusCode(line: string | null): number | undefined {
	const m = line ? /HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(line) : null;
	return m ? Number(m[1]) : undefined;
}

export function parseMultistatus(xmlText: string): DavResponse[] {
	const root = parseXml(xmlText);
	if (root.ns !== NS.d || root.local !== "multistatus") return [];
	const out: DavResponse[] = [];
	for (const r of childEls(root, NS.d, "response")) {
		const href = textOf(childEl(r, NS.d, "href")) ?? "";
		const resp: DavResponse = { href, props: new Map(), missing: new Set() };
		const st = statusCode(textOf(childEl(r, NS.d, "status")));
		if (st !== undefined) resp.status = st;
		for (const ps of childEls(r, NS.d, "propstat")) {
			const code = statusCode(textOf(childEl(ps, NS.d, "status"))) ?? 200;
			const prop = childEl(ps, NS.d, "prop");
			for (const p of prop?.children ?? []) {
				if (code >= 200 && code < 300) resp.props.set(p.name, p);
				else resp.missing.add(p.name);
			}
		}
		out.push(resp);
	}
	return out;
}

export function key(ns: string, local: string): string {
	return `{${ns}}${local}`;
}

/** Text of a prop, or null when absent or empty. */
export function propText(r: DavResponse, ns: string, local: string): string | null {
	const el = r.props.get(key(ns, local));
	const t = textOf(el);
	return t === null || t === "" ? null : t;
}

export function propEl(r: DavResponse, ns: string, local: string): XmlEl | undefined {
	return r.props.get(key(ns, local));
}

export function isCollection(r: DavResponse): boolean {
	const rt = r.props.get(key(NS.d, "resourcetype"));
	return Boolean(rt?.children.some((c) => c.ns === NS.d && c.local === "collection"));
}

/** The href children of a prop such as calendar-home-set. */
export function propHrefs(r: DavResponse, ns: string, local: string): string[] {
	const el = r.props.get(key(ns, local));
	return childEls(el, NS.d, "href").map((h) => h.text.trim()).filter(Boolean);
}
