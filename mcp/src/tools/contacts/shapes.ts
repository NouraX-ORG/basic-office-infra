/** Input pieces and output shapes shared by the four contacts tools (DESIGN 11.7). */
import { z } from "zod";
import { LIMITS } from "../../core/limits";
import { type Address, checkBirthday, checkEmail, checkPhone, checkWebsite, cleanText, type ContactFields, type Email, type Phone } from "../../pim/vcard";
import { ToolError } from "../../core/errors";
import { jsonLength, shown } from "../sharing/bounded";
import { type Book, contactIdOf, encodeIdPart, webUrlOf } from "./books";

export const NAME_MAX = 255;
export const LIST_MAX = 20;

export const emailIn = z
	.object({
		address: z.string().min(3).max(254).describe("Email address."),
		label: z.enum(["home", "work", "other"]).default("other").describe("Label."),
	})
	.strict();

export const phoneIn = z
	.object({
		number: z.string().min(2).max(50).describe("Phone number."),
		label: z.enum(["mobile", "home", "work", "fax", "other"]).default("other").describe("Label."),
	})
	.strict();

export const addressIn = z
	.object({
		street: z.string().max(255).optional().describe("Street."),
		city: z.string().max(100).optional().describe("City."),
		region: z.string().max(100).optional().describe("Region."),
		postal_code: z.string().max(20).optional().describe("Postcode."),
		country: z.string().max(100).optional().describe("Country."),
		label: z.enum(["home", "work", "other"]).default("other").describe("Label."),
	})
	.strict();

export const birthdayIn = z.string().max(10).describe("YYYY-MM-DD, or --MM-DD without a year.");

/**
 * How much of a contact the tools show (fix round 3). A card is read up to 1 MB (CARD_READ_BYTES),
 * and a card made in another app or a shared book can hold thousands of entries or a huge field,
 * so every text is cut to the input limit of the same field and every list to what one call can
 * set. The counts (*_total) and truncated_fields say what isn't shown; NoContacts shows it all.
 */
export const SHOWN_ITEMS = { emails: LIST_MAX, phones: LIST_MAX, addresses: 10, websites: 10 } as const;
export const SHOWN_CHARS = {
	name: NAME_MAX,
	email: 254,
	phone: 50,
	street: 255,
	city: 100,
	region: 100,
	postal_code: 20,
	country: 100,
	website: 2_048,
	birthday: 40,
	book: 200,
	notes: LIMITS.notesOutChars,
} as const;

export const emailOut = z.object({ address: z.string().max(SHOWN_CHARS.email), label: z.string() });
export const phoneOut = z.object({ number: z.string().max(SHOWN_CHARS.phone), label: z.string() });
export const addressOut = z.object({
	street: z.string().max(SHOWN_CHARS.street).nullable(),
	city: z.string().max(SHOWN_CHARS.city).nullable(),
	region: z.string().max(SHOWN_CHARS.region).nullable(),
	postal_code: z.string().max(SHOWN_CHARS.postal_code).nullable(),
	country: z.string().max(SHOWN_CHARS.country).nullable(),
	label: z.string(),
});

const TEXT_FIELDS = ["full_name", "given_name", "family_name", "organization", "job_title", "birthday", "address_book", "emails", "phones", "addresses", "websites", "notes"] as const;

export const ContactOut = z.object({
	contact_id: z.string(),
	address_book_id: z.string(),
	address_book: z.string().max(SHOWN_CHARS.book),
	read_only: z.boolean(),
	full_name: z.string().max(SHOWN_CHARS.name).nullable(),
	given_name: z.string().max(SHOWN_CHARS.name).nullable(),
	family_name: z.string().max(SHOWN_CHARS.name).nullable(),
	emails: z.array(emailOut).max(SHOWN_ITEMS.emails),
	/** How many email addresses the contact has; more than shown when the list is cut. */
	emails_total: z.number().int(),
	phones: z.array(phoneOut).max(SHOWN_ITEMS.phones),
	phones_total: z.number().int(),
	organization: z.string().max(SHOWN_CHARS.name).nullable(),
	job_title: z.string().max(SHOWN_CHARS.name).nullable(),
	addresses: z.array(addressOut).max(SHOWN_ITEMS.addresses),
	addresses_total: z.number().int(),
	birthday: z.string().max(SHOWN_CHARS.birthday).nullable(),
	websites: z.array(z.string().max(SHOWN_CHARS.website)).max(SHOWN_ITEMS.websites),
	websites_total: z.number().int(),
	notes: z.string().max(SHOWN_CHARS.notes).nullable(),
	notes_truncated: z.boolean(),
	/** The fields shown cut short (a text, or an entry of a list); the lists' own counts are in *_total. */
	truncated_fields: z.array(z.enum(TEXT_FIELDS)),
	web_url: z.string().nullable(),
});
export type ContactOut = z.infer<typeof ContactOut>;

/** Whether some of the contact isn't shown (a field cut short, or a list shown in part). */
export function isPartial(c: ContactOut): boolean {
	return (
		c.truncated_fields.length > 0 ||
		c.emails.length < c.emails_total ||
		c.phones.length < c.phones_total ||
		c.addresses.length < c.addresses_total ||
		c.websites.length < c.websites_total
	);
}

/** The summary words for a contact that isn't shown whole (no text people wrote). */
export function partialNote(c: ContactOut): string {
	return isPartial(c) ? " Some of it is longer than shown here: truncated_fields and the *_total counts say what." : "";
}

const LISTS = ["websites", "addresses", "emails", "phones"] as const;

/**
 * One contact as the tools show it, within `room` characters of JSON (nulls kept, as
 * structuredContent carries it). Texts are display text cut to SHOWN_CHARS and lists to
 * SHOWN_ITEMS; if the contact is still too large, entries are left out from the end of the
 * largest list, then the notes are shortened. Everything else is bounded by its field limit, so
 * the contact always fits a whole result. Undos never come from this view: contacts_update uses
 * the card's own values.
 */
export function contactView(f: ContactFields, book: Book, cardName: string, driveOrigin: string, room: number = LIMITS.resultChars - 2_000): ContactOut {
	const cutFields = new Set<(typeof TEXT_FIELDS)[number]>();
	const text = (field: (typeof TEXT_FIELDS)[number], s: string | null, max: number, multiline = false): string | null => {
		if (s === null || s.length === 0) return null;
		const r = shown(s, max, multiline);
		if (r.cut) cutFields.add(field);
		return r.text.length ? r.text : null;
	};
	const notes = text("notes", f.notes, SHOWN_CHARS.notes, true);
	const view: ContactOut = {
		contact_id: contactIdOf(book.id, cardName),
		address_book_id: encodeIdPart(book.id),
		address_book: text("address_book", book.name, SHOWN_CHARS.book) ?? "",
		read_only: book.read_only,
		full_name: text("full_name", f.full_name, SHOWN_CHARS.name),
		given_name: text("given_name", f.given_name, SHOWN_CHARS.name),
		family_name: text("family_name", f.family_name, SHOWN_CHARS.name),
		emails: f.emails.slice(0, SHOWN_ITEMS.emails).map((e) => ({ address: text("emails", e.address, SHOWN_CHARS.email) ?? "", label: e.label })),
		emails_total: f.emails.length,
		phones: f.phones.slice(0, SHOWN_ITEMS.phones).map((p) => ({ number: text("phones", p.number, SHOWN_CHARS.phone) ?? "", label: p.label })),
		phones_total: f.phones.length,
		organization: text("organization", f.organization, SHOWN_CHARS.name),
		job_title: text("job_title", f.job_title, SHOWN_CHARS.name),
		addresses: f.addresses.slice(0, SHOWN_ITEMS.addresses).map((a) => ({
			street: text("addresses", a.street, SHOWN_CHARS.street),
			city: text("addresses", a.city, SHOWN_CHARS.city),
			region: text("addresses", a.region, SHOWN_CHARS.region),
			postal_code: text("addresses", a.postal_code, SHOWN_CHARS.postal_code),
			country: text("addresses", a.country, SHOWN_CHARS.country),
			label: a.label,
		})),
		addresses_total: f.addresses.length,
		birthday: text("birthday", f.birthday, SHOWN_CHARS.birthday),
		websites: f.websites.slice(0, SHOWN_ITEMS.websites).map((w) => text("websites", w, SHOWN_CHARS.website) ?? ""),
		websites_total: f.websites.length,
		notes,
		notes_truncated: cutFields.has("notes"),
		truncated_fields: [],
		web_url: webUrlOf(driveOrigin, f.uid, book.id),
	};
	view.truncated_fields = [...cutFields];

	// Within the room, measured as JSON. Leaving out the last entry of a list of n saves its own
	// JSON plus the comma before it (none when it was the only one).
	let size = jsonLength(view);
	while (size > room) {
		let pick: (typeof LISTS)[number] | null = null;
		let pickSize = 0;
		for (const k of LISTS) {
			const s = view[k].length ? jsonLength(view[k]) : 0;
			if (s > pickSize) {
				pick = k;
				pickSize = s;
			}
		}
		if (pick) {
			const list = view[pick] as unknown[];
			const last = list.pop();
			size -= jsonLength(last) + (list.length > 0 ? 1 : 0);
			continue;
		}
		if (!view.notes) break;
		const keep = Math.floor(view.notes.length / 2);
		view.notes = keep > 0 ? shown(view.notes, keep, true).text : null;
		view.notes_truncated = true;
		if (!view.truncated_fields.includes("notes")) view.truncated_fields.push("notes");
		size = jsonLength(view);
	}
	return view;
}

// --- Cleaning input for the vCard writer ----------------------------------------------------------

function textOrUndefined(s: string | undefined, multiline = false): string | undefined {
	if (s === undefined) return undefined;
	const t = cleanText(s, multiline);
	return t.length ? t : undefined;
}

export function cleanName(s: string | undefined, field: string): string | undefined {
	const t = textOrUndefined(s);
	if (s !== undefined && t === undefined) throw new ToolError("invalid_input", `${field} is empty.`, { field });
	return t;
}

export function cleanEmails(list: { address: string; label: Email["label"] }[] | undefined, field: string): Email[] {
	return (list ?? []).map((e, i) => ({ address: checkEmail(e.address, `${field}[${i}].address`), label: e.label }));
}

export function cleanPhones(list: { number: string; label: Phone["label"] }[] | undefined, field: string): Phone[] {
	return (list ?? []).map((p, i) => ({ number: checkPhone(p.number, `${field}[${i}].number`), label: p.label }));
}

export function cleanAddresses(list: z.output<typeof addressIn>[] | undefined): Address[] {
	return (list ?? []).map((a) => ({
		street: textOrUndefined(a.street) ?? null,
		city: textOrUndefined(a.city) ?? null,
		region: textOrUndefined(a.region) ?? null,
		postal_code: textOrUndefined(a.postal_code) ?? null,
		country: textOrUndefined(a.country) ?? null,
		label: a.label,
	}));
}

export { checkBirthday, checkWebsite, cleanText };
