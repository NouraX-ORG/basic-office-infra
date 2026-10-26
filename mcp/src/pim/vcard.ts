/**
 * jCard (RFC 7095) for NoContacts (DESIGN 11.7, lane B). jCard is the wire format both ways: the
 * server's CardDAV layer turns a jCard PUT into a vCard 4.0 and serves any card as jCard on request,
 * so all vCard escaping, folding and validation happen on the server and user text can never break
 * out of a property.
 *
 * ical.js (2.2.1) holds the card as an ICAL.Component. We read and write raw jCard property arrays
 * through it (Property#toJSON is the live array), so properties we don't own are kept exactly as
 * they came, and every edit is limited to the properties named here.
 *
 * Labels map to TYPE parameters: emails home | work | other, phones mobile | home | work | fax |
 * other, addresses home | work | other. TEL is written as type text, not uri.
 */
import ICAL from "ical.js";
import { ToolError } from "../core/errors";

export type EmailLabel = "home" | "work" | "other";
export type PhoneLabel = "mobile" | "home" | "work" | "fax" | "other";
export type AddressLabel = "home" | "work" | "other";

export interface Email {
	address: string;
	label: EmailLabel;
}
export interface Phone {
	number: string;
	label: PhoneLabel;
}
export interface Address {
	street: string | null;
	city: string | null;
	region: string | null;
	postal_code: string | null;
	country: string | null;
	label: AddressLabel;
}

/** What our tools show of a card. notes is the full text; tools cut it for output. */
export interface ContactFields {
	uid: string | null;
	full_name: string | null;
	given_name: string | null;
	family_name: string | null;
	emails: Email[];
	phones: Phone[];
	organization: string | null;
	job_title: string | null;
	addresses: Address[];
	birthday: string | null;
	websites: string[];
	notes: string | null;
}

export interface NewContact {
	full_name?: string;
	given_name?: string;
	family_name?: string;
	emails?: Email[];
	phones?: Phone[];
	organization?: string;
	job_title?: string;
	addresses?: Address[];
	birthday?: string;
	website?: string;
	notes?: string;
}

export interface ContactEdits {
	full_name?: string;
	given_name?: string | null;
	family_name?: string | null;
	organization?: string | null;
	job_title?: string | null;
	birthday?: string | null;
	website?: string | null;
	notes?: string | null;
	add_emails?: Email[];
	remove_emails?: string[];
	add_phones?: Phone[];
	remove_phones?: string[];
	addresses?: Address[];
}

export interface EditResult {
	/** Field names that really changed. */
	changed: string[];
	/**
	 * contacts_update arguments that put the card back, or null when that can't be done exactly.
	 * Values come from the card as it was; contacts_update checks them against its own input rules
	 * before it offers them as an undo (a card made elsewhere may hold values our input refuses).
	 */
	inverse: Record<string, unknown> | null;
	warnings: string[];
}

type Raw = unknown[];
type Params = Record<string, unknown>;

const PRODID = "-//Nourax//Nourax Workspace AI connector//EN";

// --- Checking and cleaning input ------------------------------------------------------------------

function bad(message: string, field: string): never {
	throw new ToolError("invalid_input", message, { field });
}

// C0 and C1 controls (but \n, \r and \t), line and paragraph separators and the byte-order mark.
const CONTROL_ALL = new RegExp(`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f${String.fromCharCode(0x2028, 0x2029, 0xfeff)}]`, "g");

/** NFC, no control characters; newlines become spaces unless multiline. Trimmed. */
export function cleanText(s: string, multiline = false): string {
	let t = s.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(CONTROL_ALL, "");
	if (!multiline) t = t.replace(/\n+/g, " ");
	return t.trim();
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]{1,253}\.[^\s@<>()[\]\\,;:".]{2,63}$/;

export function checkEmail(raw: string, field: string): string {
	const s = cleanText(raw);
	if (!EMAIL_RE.test(s) || s.length > 254) bad(`${field}: "${s.slice(0, 60)}" isn't an email address.`, field);
	return s;
}

const PHONE_RE = /^\+?[0-9][0-9 ()./-]{1,39}(?:\s*(?:x|ext\.?)\s*[0-9]{1,6})?$/i;

export function checkPhone(raw: string, field: string): string {
	const s = cleanText(raw);
	if (!PHONE_RE.test(s)) bad(`${field}: "${s.slice(0, 40)}" isn't a phone number (digits, spaces, + ( ) . / - only).`, field);
	return s;
}

/** Digits (and a leading +) only, for matching numbers written differently. */
export function phoneKey(s: string): string {
	const t = s.replace(/^tel:/i, "").trim();
	return (t.startsWith("+") ? "+" : "") + t.replace(/\D/g, "");
}

export function checkWebsite(raw: string, field: string): string {
	const s = cleanText(raw);
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		bad(`${field} must be a full web address starting with https:// or http://.`, field);
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") bad(`${field} must start with https:// or http://.`, field);
	if (u.username || u.password) bad(`${field} must not contain a user name or password.`, field);
	return u.href;
}

/** "YYYY-MM-DD", or "--MM-DD" for a birthday without a year. */
export function checkBirthday(raw: string, field: string): string {
	const s = raw.trim();
	let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
	if (m) {
		const y = Number(m[1]);
		const mo = Number(m[2]);
		const d = Number(m[3]);
		const t = new Date(Date.UTC(y, mo - 1, d));
		if (y < 1800 || y > 2200 || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) bad(`${field} isn't a real date (${s}).`, field);
		return s;
	}
	m = /^--(\d{2})-(\d{2})$/.exec(s);
	if (m) {
		const mo = Number(m[1]);
		const d = Number(m[2]);
		const t = new Date(Date.UTC(2000, mo - 1, d));
		if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) bad(`${field} isn't a real date (${s}).`, field);
		return s;
	}
	return bad(`${field} must look like 1990-05-31, or --05-31 without a year.`, field);
}

// --- Reading ---------------------------------------------------------------------------------------

/** Wraps a parsed jCard. Throws upstream_unavailable when the text isn't a jCard. */
export function parseJCard(text: string): ICAL.Component {
	let j: unknown;
	try {
		j = JSON.parse(text);
	} catch {
		throw new ToolError("upstream_unavailable", "NoContacts sent a contact that couldn't be read.");
	}
	return fromJCard(j);
}

export function fromJCard(j: unknown): ICAL.Component {
	const ok =
		Array.isArray(j) &&
		j[0] === "vcard" &&
		Array.isArray(j[1]) &&
		(j[1] as unknown[]).every((p) => Array.isArray(p) && p.length >= 4 && typeof p[0] === "string" && typeof p[1] === "object" && p[1] !== null && !Array.isArray(p[1]) && typeof p[2] === "string");
	if (!ok) throw new ToolError("upstream_unavailable", "NoContacts sent a contact that couldn't be read.");
	const arr = j as unknown[];
	// The server's jCard has no third (components) element; ical.js expects one.
	return new ICAL.Component(["vcard", arr[1] as unknown[], Array.isArray(arr[2]) ? arr[2] : []]);
}

function rawOf(p: ICAL.Property): Raw {
	return p.toJSON() as Raw;
}

function props(card: ICAL.Component, name: string): ICAL.Property[] {
	return card.getAllProperties(name);
}

/** A value as text: arrays (structured or multi values) are joined with a space. */
function textOf(v: unknown, sep = " "): string {
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (Array.isArray(v)) return v.map((x) => textOf(x, sep)).filter((x) => x.length > 0).join(sep);
	return "";
}

function orNull(s: string): string | null {
	const t = s.trim();
	return t.length ? t : null;
}

function firstText(card: ICAL.Component, name: string): string | null {
	const p = props(card, name)[0];
	return p ? orNull(textOf(rawOf(p)[3])) : null;
}

function typesOf(p: ICAL.Property): string[] {
	const t = (rawOf(p)[1] as Params).type;
	const list = Array.isArray(t) ? t : typeof t === "string" ? t.split(",") : [];
	return list.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

function emailLabel(types: string[]): EmailLabel {
	if (types.includes("work")) return "work";
	if (types.includes("home")) return "home";
	return "other";
}

function phoneLabel(types: string[]): PhoneLabel {
	if (types.includes("cell") || types.includes("mobile") || types.includes("iphone")) return "mobile";
	if (types.includes("fax")) return "fax";
	if (types.includes("work")) return "work";
	if (types.includes("home")) return "home";
	return "other";
}

/** The parts of N: [family, given, additional, prefix, suffix]. */
function nParts(p: ICAL.Property | undefined): string[] {
	if (!p) return ["", "", "", "", ""];
	const v = rawOf(p)[3];
	const parts = Array.isArray(v) ? v.map((x) => textOf(x)) : [textOf(v)];
	while (parts.length < 5) parts.push("");
	return parts;
}

function adrParts(p: ICAL.Property): string[] {
	const v = rawOf(p)[3];
	const parts = Array.isArray(v) ? v.map((x) => textOf(x, ", ")) : [textOf(v)];
	while (parts.length < 7) parts.push("");
	return parts;
}

function readAddress(p: ICAL.Property): Address {
	const a = adrParts(p);
	const street = [a[1], a[2]].map((x) => (x ?? "").trim()).filter(Boolean).join(", ");
	return {
		street: orNull(street),
		city: orNull(a[3] ?? ""),
		region: orNull(a[4] ?? ""),
		postal_code: orNull(a[5] ?? ""),
		country: orNull(a[6] ?? ""),
		label: emailLabel(typesOf(p)),
	};
}

/**
 * Birthdays as "YYYY-MM-DD" or "--MM-DD" where the stored form allows it; any other text as it is
 * (the tools' view cuts it to 40 characters and says so; an undo with it is refused by the input).
 */
function normaliseDate(s: string): string {
	const t = s.trim();
	let m = /^(\d{4})-?(\d{2})-?(\d{2})(?:$|T)/.exec(t);
	if (m) return `${m[1]}-${m[2]}-${m[3]}`;
	m = /^--(\d{2})-?(\d{2})$/.exec(t);
	if (m) return `--${m[1]}-${m[2]}`;
	return t;
}

export function readCard(card: ICAL.Component): ContactFields {
	const n = nParts(props(card, "n")[0]);
	const orgProp = props(card, "org")[0];
	const bday = firstText(card, "bday");
	return {
		uid: firstText(card, "uid"),
		full_name: firstText(card, "fn"),
		given_name: orNull(n[1] ?? ""),
		family_name: orNull(n[0] ?? ""),
		emails: props(card, "email")
			.map((p) => ({ address: textOf(rawOf(p)[3]).trim(), label: emailLabel(typesOf(p)) }))
			.filter((e) => e.address.length > 0),
		phones: props(card, "tel")
			.map((p) => ({ number: textOf(rawOf(p)[3]).replace(/^tel:/i, "").trim(), label: phoneLabel(typesOf(p)) }))
			.filter((t) => t.number.length > 0),
		organization: orgProp ? orNull(textOf(rawOf(orgProp)[3], ", ")) : null,
		job_title: firstText(card, "title"),
		addresses: props(card, "adr").map(readAddress),
		birthday: bday ? normaliseDate(bday) : null,
		websites: props(card, "url")
			.map((p) => textOf(rawOf(p)[3]).trim())
			.filter(Boolean),
		notes: (() => {
			const p = props(card, "note")[0];
			return p ? orNull(textOf(rawOf(p)[3], "\n")) : null;
		})(),
	};
}

// --- Writing ---------------------------------------------------------------------------------------

function emailProp(e: Email): Raw {
	const params: Params = e.label === "other" ? {} : { type: e.label };
	return ["email", params, "text", e.address];
}

function phoneProp(t: Phone): Raw {
	const type = { mobile: "cell", home: ["home", "voice"], work: ["work", "voice"], fax: "fax", other: "voice" }[t.label];
	return ["tel", { type }, "text", t.number];
}

function adrProp(a: Address): Raw {
	const params: Params = a.label === "other" ? {} : { type: a.label };
	return ["adr", params, "text", ["", "", a.street ?? "", a.city ?? "", a.region ?? "", a.postal_code ?? "", a.country ?? ""]];
}

function bdayProp(s: string): Raw {
	return ["bday", {}, "date", s];
}

/**
 * An address in the shape contacts_update takes (its input has no nulls): empty parts are left
 * out, so an undo that puts addresses back passes the tool's own input check.
 */
export function addressInput(a: Address): Partial<Record<"street" | "city" | "region" | "postal_code" | "country", string>> & { label: AddressLabel } {
	const out: Partial<Record<"street" | "city" | "region" | "postal_code" | "country", string>> & { label: AddressLabel } = { label: a.label };
	for (const k of ["street", "city", "region", "postal_code", "country"] as const) {
		const v = a[k];
		if (v !== null && v !== "") out[k] = v;
	}
	return out;
}

function compose(given: string | null, family: string | null): string {
	return [given ?? "", family ?? ""].map((x) => x.trim()).filter(Boolean).join(" ");
}

/** A new vCard 4.0 as jCard. The caller checks that a name is present. */
export function newCard(c: NewContact, uid: string): unknown[] {
	const given = c.given_name ?? "";
	const family = c.family_name ?? "";
	const fn = c.full_name ?? compose(given, family);
	const out: Raw[] = [
		["version", {}, "text", "4.0"],
		["prodid", {}, "text", PRODID],
		["uid", {}, "text", uid],
		["fn", {}, "text", fn],
		["n", {}, "text", [family, given, "", "", ""]],
	];
	for (const e of c.emails ?? []) out.push(emailProp(e));
	for (const t of c.phones ?? []) out.push(phoneProp(t));
	if (c.organization) out.push(["org", {}, "text", [c.organization]]);
	if (c.job_title) out.push(["title", {}, "text", c.job_title]);
	for (const a of c.addresses ?? []) out.push(adrProp(a));
	if (c.birthday) out.push(bdayProp(c.birthday));
	if (c.website) out.push(["url", {}, "uri", c.website]);
	if (c.notes) out.push(["note", {}, "text", c.notes]);
	return ["vcard", out, []];
}

function add(card: ICAL.Component, raw: Raw): void {
	card.addProperty(new ICAL.Property(raw));
}

// --- Exact undo (fix round 3) ------------------------------------------------------------------------
//
// An undo writes properties the way our writer does (emailProp, phoneProp, adrProp, or a plain
// single value). It is exact only when that gives back what the card holds now. These checks run
// on the card before it is changed.

/** TYPE values in lower case, sorted, without repeats (jCard sends one value as text, several as a list). */
function typeKey(t: unknown): string {
	const list = Array.isArray(t) ? t : typeof t === "string" ? t.split(",") : [];
	return [...new Set(list.map((x) => String(x).trim().toLowerCase()).filter(Boolean))].sort().join(",");
}

/** A value for comparing: empty trailing parts don't count, and a one-part structured value equals that text. */
function valueKey(v: unknown): string {
	if (!Array.isArray(v)) return JSON.stringify(v ?? null);
	const parts = v.slice();
	while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
	return parts.length === 1 && typeof parts[0] === "string" ? JSON.stringify(parts[0]) : JSON.stringify(parts);
}

/**
 * Whether writing `rewritten` in place of `p` gives back exactly what the card holds: one value of
 * the same value type, the same value, and no parameter but TYPE, whose values match up to case
 * and order. PREF, a property group, a second TYPE such as "internet", or TEL as a "tel:" uri all
 * make it false: our writer would drop them.
 */
function rewritesExactly(p: ICAL.Property, rewritten: Raw): boolean {
	const a = rawOf(p);
	if (a.length !== 4 || rewritten.length !== 4) return false;
	if (String(a[2]).toLowerCase() !== String(rewritten[2]).toLowerCase()) return false;
	const pa = (a[1] ?? {}) as Params;
	const pb = rewritten[1] as Params;
	for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) if (k !== "type") return false;
	return typeKey(pa.type) === typeKey(pb.type) && valueKey(a[3]) === valueKey(rewritten[3]);
}

/**
 * Whether the undo of a change to a single-value property (setSingle: the first one changes, null
 * removes them all) puts the card back: `before` is what the undo writes, null when it removes.
 */
function singleExact(card: ICAL.Component, name: string, forwardRemoves: boolean, before: Raw | null, same: (p: ICAL.Property, raw: Raw) => boolean = rewritesExactly): boolean {
	const all = props(card, name);
	if (all.length === 0) return true;
	if (forwardRemoves && all.length > 1) return false;
	if (before === null) return all.length <= 1;
	return same(all[0] as ICAL.Property, before);
}

/** A birthday's undo writes the normalised date; the same date in basic form ("19900531") counts as equal. */
function sameBirthday(p: ICAL.Property, before: Raw): boolean {
	const a = rawOf(p);
	if (a.length !== 4 || Object.keys((a[1] ?? {}) as Params).length > 0) return false;
	if (a[2] !== "date" && a[2] !== "date-and-or-time") return false;
	const v = a[3];
	const b = before[3];
	return typeof v === "string" && typeof b === "string" && /^(?:\d{4}-?\d{2}-?\d{2}|--\d{2}-?\d{2})$/.test(v) && v.replace(/-/g, "") === b.replace(/-/g, "");
}

/** Whether part `i` of N (0 family, 1 given) is exactly the text the undo writes back into it. */
function nPartExact(nProp: ICAL.Property | undefined, i: number, value: string | null): boolean {
	if (!nProp) return true;
	const v = rawOf(nProp)[3];
	const part = Array.isArray(v) ? v[i] : i === 0 ? v : "";
	const text = Array.isArray(part) ? (part.length <= 1 ? (part[0] ?? "") : null) : (part ?? "");
	return typeof text === "string" && text === (value ?? "");
}

function removeAll(card: ICAL.Component, name: string): void {
	for (const p of props(card, name)) card.removeProperty(p);
}

/** Sets the first property of a name (adding it when missing); null removes every one of them. */
function setSingle(card: ICAL.Component, name: string, raw: Raw | null): void {
	const existing = props(card, name);
	if (raw === null) {
		removeAll(card, name);
		return;
	}
	const first = existing[0];
	if (first) {
		const live = rawOf(first);
		live.length = 0;
		live.push(...raw);
	} else add(card, raw);
}

/**
 * Applies edits in place: removals before additions, so a label change can be given as remove
 * plus add of the same address. Returns what changed and the exact inverse for undo.
 */
export function editCard(card: ICAL.Component, ed: ContactEdits): EditResult {
	const before = readCard(card);
	const changed: string[] = [];
	const warnings: string[] = [];
	const inverse: Record<string, unknown> = {};
	let exact = true;

	// Names
	const nProp = props(card, "n")[0];
	const n = nParts(nProp);
	let nameTouched = false;
	if (ed.given_name !== undefined && (ed.given_name ?? "") !== (n[1] ?? "")) {
		if (!nPartExact(nProp, 1, before.given_name)) exact = false;
		inverse.given_name = before.given_name;
		n[1] = ed.given_name ?? "";
		nameTouched = true;
		changed.push("given_name");
	}
	if (ed.family_name !== undefined && (ed.family_name ?? "") !== (n[0] ?? "")) {
		if (!nPartExact(nProp, 0, before.family_name)) exact = false;
		inverse.family_name = before.family_name;
		n[0] = ed.family_name ?? "";
		nameTouched = true;
		changed.push("family_name");
	}
	if (nameTouched) {
		if (nProp) {
			const live = rawOf(nProp);
			live[3] = n;
			live.length = 4;
		} else add(card, ["n", {}, "text", n]);
	}
	let fn: string | undefined = ed.full_name;
	if (fn === undefined && nameTouched) {
		const oldComposed = compose(before.given_name, before.family_name);
		const newComposed = compose(orNull(n[1] ?? ""), orNull(n[0] ?? ""));
		if ((before.full_name === null || before.full_name === oldComposed) && newComposed) fn = newComposed;
		else if (before.full_name !== null) warnings.push("full_name was left as it is; give full_name to change it as well.");
	}
	if (fn !== undefined && fn !== before.full_name) {
		if (before.full_name !== null) {
			inverse.full_name = before.full_name;
			if (!singleExact(card, "fn", false, ["fn", {}, "text", before.full_name])) exact = false;
		} else exact = false;
		setSingle(card, "fn", ["fn", {}, "text", fn]);
		changed.push("full_name");
	}

	// Single-value fields. Each undo writes the earlier value back as one plain property, so it is
	// exact only when the card held just that (singleExact).
	if (ed.organization !== undefined && ed.organization !== before.organization) {
		if (!singleExact(card, "org", ed.organization === null, before.organization === null ? null : ["org", {}, "text", [before.organization]])) exact = false;
		inverse.organization = before.organization;
		setSingle(card, "org", ed.organization === null ? null : ["org", {}, "text", [ed.organization]]);
		changed.push("organization");
	}
	if (ed.job_title !== undefined && ed.job_title !== before.job_title) {
		if (!singleExact(card, "title", ed.job_title === null, before.job_title === null ? null : ["title", {}, "text", before.job_title])) exact = false;
		inverse.job_title = before.job_title;
		setSingle(card, "title", ed.job_title === null ? null : ["title", {}, "text", ed.job_title]);
		changed.push("job_title");
	}
	if (ed.birthday !== undefined && ed.birthday !== before.birthday) {
		if (!singleExact(card, "bday", ed.birthday === null, before.birthday === null ? null : bdayProp(before.birthday), sameBirthday)) exact = false;
		inverse.birthday = before.birthday;
		setSingle(card, "bday", ed.birthday === null ? null : bdayProp(ed.birthday));
		changed.push("birthday");
	}
	if (ed.website !== undefined && ed.website !== (before.websites[0] ?? null)) {
		const urls = props(card, "url");
		const first = urls[0];
		// Only the first web address changes (null removes just that one), and the undo writes the
		// first one back, so it is exact when that was one plain address and, for a removal, the only one.
		if (first && (before.websites[0] === undefined || !rewritesExactly(first, ["url", {}, "uri", before.websites[0]]))) exact = false;
		if (ed.website === null) {
			if (urls.length > 1) exact = false;
			if (first) card.removeProperty(first);
		} else {
			if (first) {
				const live = rawOf(first);
				live.length = 0;
				live.push("url", {}, "uri", ed.website);
			} else add(card, ["url", {}, "uri", ed.website]);
		}
		inverse.website = before.websites[0] ?? null;
		changed.push("website");
	}
	if (ed.notes !== undefined && ed.notes !== before.notes) {
		if ((before.notes?.length ?? 0) > 10_000 || !singleExact(card, "note", ed.notes === null, before.notes === null ? null : ["note", {}, "text", before.notes])) exact = false;
		inverse.notes = before.notes;
		setSingle(card, "note", ed.notes === null ? null : ["note", {}, "text", ed.notes]);
		changed.push("notes");
	}

	// Emails. The undo adds one entry back per address, the way emailProp writes it, so it is exact
	// only when each removed property was exactly that, and no two of them had the same address.
	const removedEmails: Email[] = [];
	for (const raw of ed.remove_emails ?? []) {
		const key = raw.trim().toLowerCase();
		const hits = props(card, "email").filter((p) => textOf(rawOf(p)[3]).trim().toLowerCase() === key);
		if (hits.length === 0) warnings.push(`${raw.trim()} wasn't on the contact.`);
		if (hits.length > 1) exact = false;
		for (const p of hits) {
			const entry: Email = { address: textOf(rawOf(p)[3]).trim(), label: emailLabel(typesOf(p)) };
			if (!rewritesExactly(p, emailProp(entry))) exact = false;
			removedEmails.push(entry);
			card.removeProperty(p);
		}
	}
	const addedEmails: string[] = [];
	for (const e of ed.add_emails ?? []) {
		const exists = props(card, "email").some((p) => textOf(rawOf(p)[3]).trim().toLowerCase() === e.address.toLowerCase());
		if (exists) {
			warnings.push(`${e.address} is already on the contact.`);
			continue;
		}
		add(card, emailProp(e));
		addedEmails.push(e.address);
	}
	if (removedEmails.length || addedEmails.length) {
		changed.push("emails");
		if (addedEmails.length) inverse.remove_emails = addedEmails;
		if (removedEmails.length) inverse.add_emails = removedEmails;
	}

	// Phones: the same rule. Numbers match by their digits, so "+44 1" and "+441" are one key, and
	// the undo would add back only one of them.
	const removedPhones: Phone[] = [];
	for (const raw of ed.remove_phones ?? []) {
		const key = phoneKey(raw);
		const hits = props(card, "tel").filter((p) => phoneKey(textOf(rawOf(p)[3])) === key);
		if (hits.length === 0) warnings.push(`${raw.trim()} wasn't on the contact.`);
		if (hits.length > 1) exact = false;
		for (const p of hits) {
			const entry: Phone = { number: textOf(rawOf(p)[3]).replace(/^tel:/i, "").trim(), label: phoneLabel(typesOf(p)) };
			if (!rewritesExactly(p, phoneProp(entry))) exact = false;
			removedPhones.push(entry);
			card.removeProperty(p);
		}
	}
	const addedPhones: string[] = [];
	for (const t of ed.add_phones ?? []) {
		const key = phoneKey(t.number);
		if (props(card, "tel").some((p) => phoneKey(textOf(rawOf(p)[3])) === key)) {
			warnings.push(`${t.number} is already on the contact.`);
			continue;
		}
		add(card, phoneProp(t));
		addedPhones.push(t.number);
	}
	if (removedPhones.length || addedPhones.length) {
		changed.push("phones");
		if (addedPhones.length) inverse.remove_phones = addedPhones;
		if (removedPhones.length) inverse.add_phones = removedPhones;
	}

	// Addresses: the whole list is replaced
	if (ed.addresses !== undefined) {
		const same = JSON.stringify(before.addresses) === JSON.stringify(ed.addresses);
		if (!same) {
			// The undo writes each earlier address back with adrProp: exact only when that gives the
			// same property (no PO box or extended part, no parameter but one home or work type).
			for (const p of props(card, "adr")) {
				if (!rewritesExactly(p, adrProp(readAddress(p)))) exact = false;
			}
			removeAll(card, "adr");
			for (const a of ed.addresses) add(card, adrProp(a));
			inverse.addresses = before.addresses.map(addressInput);
			changed.push("addresses");
		}
	}

	return { changed, inverse: exact && changed.length ? inverse : null, warnings };
}

export function serializeCard(card: ICAL.Component): string {
	return JSON.stringify(card.toJSON());
}
