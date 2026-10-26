/**
 * contacts_update (DESIGN 11.7): GET the card as jCard, change only the properties named, keep every
 * other property as it came, and PUT it back with If-Match. Contacts in read-only books (the
 * workspace directories, team books, recently contacted) are refused before anything is sent.
 * The undo is offered only when it is exact: editCard says the card's earlier properties can be
 * written back as they were (no parameters our writer drops, one entry per address or number), and
 * its arguments pass this tool's own input checks with values the tool's clean-up leaves as they
 * are (fix round 3). Otherwise the result says the change can't be undone automatically.
 */
import { z } from "zod";
import { isToolError, ToolError } from "../../core/errors";
import { Undo } from "../../core/shapes";
import { defineTool } from "../../core/tool";
import { type ContactEdits, editCard, readCard, serializeCard } from "../../pim/vcard";
import { answerRoom, jsonLength } from "../sharing/bounded";
import { cardPath, checkCardSize, findBook, getCard, listBooks, parseContactId, writeError } from "./books";
import {
	partialNote,
	addressIn,
	birthdayIn,
	checkBirthday,
	checkWebsite,
	cleanAddresses,
	cleanEmails,
	cleanName,
	cleanPhones,
	cleanText,
	ContactOut,
	contactView,
	emailIn,
	LIST_MAX,
	NAME_MAX,
	phoneIn,
} from "./shapes";

const nullable = <T extends z.ZodType>(t: T, d: string) => t.nullable().optional().describe(d);

const input = z
	.object({
		contact_id: z.string().min(3).max(420).describe("From contacts_search."),
		expected_etag: z.string().max(200).optional().describe("etag from contacts_get; refused if the contact changed since."),
		full_name: z.string().min(1).max(NAME_MAX).optional().describe("Name as shown."),
		given_name: nullable(z.string().max(NAME_MAX), "First name; null clears."),
		family_name: nullable(z.string().max(NAME_MAX), "Last name; null clears."),
		organization: nullable(z.string().max(NAME_MAX), "Organisation; null clears."),
		job_title: nullable(z.string().max(NAME_MAX), "Job title; null clears."),
		birthday: nullable(birthdayIn, "YYYY-MM-DD or --MM-DD; null clears."),
		website: nullable(z.string().max(2048), "Replaces the first website; null removes it."),
		notes: nullable(z.string().max(10_000), "Replaces the notes; null clears."),
		add_emails: z.array(emailIn).max(LIST_MAX).optional().describe("Email addresses to add."),
		remove_emails: z.array(z.string().max(254)).max(LIST_MAX).optional().describe("Email addresses to remove."),
		add_phones: z.array(phoneIn).max(LIST_MAX).optional().describe("Phone numbers to add."),
		remove_phones: z.array(z.string().max(50)).max(LIST_MAX).optional().describe("Phone numbers to remove (by digits)."),
		addresses: z.array(addressIn).max(10).optional().describe("Replaces all postal addresses; [] removes them."),
	})
	.strict();

/**
 * The shape of structuredContent. Not published as outputSchema: tools/list must stay small (60 KB
 * for every tool together); the same JSON is in the framed text block, and the tests hold every
 * result to this schema. undo and warnings are merged in by the wrapper, so they are listed too.
 */
export const contactsUpdateOutput = z.object({
	contact: ContactOut,
	etag: z.string().nullable(),
	changed: z.array(z.string()),
	undo: Undo.optional(),
	warnings: z.array(z.string()).optional(),
});

const bare = (s: string) => s.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");

/** Optional text that may be null: undefined stays undefined, null stays null, text is cleaned. */
function cleanNullable(v: string | null | undefined, field: string, multiline = false): string | null | undefined {
	if (v === undefined || v === null) return v;
	const t = cleanText(v, multiline);
	if (!t) throw new ToolError("invalid_input", `${field} is empty; use null to clear it.`, { field });
	return t;
}

/** The checked, cleaned edits of one call. Throws invalid_input naming the field. */
function buildEdits(args: z.output<typeof input>): ContactEdits {
	return {
		full_name: cleanName(args.full_name, "full_name"),
		given_name: cleanNullable(args.given_name, "given_name"),
		family_name: cleanNullable(args.family_name, "family_name"),
		organization: cleanNullable(args.organization, "organization"),
		job_title: cleanNullable(args.job_title, "job_title"),
		birthday: args.birthday === undefined || args.birthday === null ? args.birthday : checkBirthday(args.birthday, "birthday"),
		website: args.website === undefined || args.website === null ? args.website : checkWebsite(args.website, "website"),
		notes: cleanNullable(args.notes, "notes", true),
		add_emails: args.add_emails ? cleanEmails(args.add_emails, "add_emails") : undefined,
		remove_emails: args.remove_emails?.map((s) => cleanText(s)).filter(Boolean),
		add_phones: args.add_phones ? cleanPhones(args.add_phones, "add_phones") : undefined,
		remove_phones: args.remove_phones?.map((s) => cleanText(s)).filter(Boolean),
		addresses: args.addresses ? cleanAddresses(args.addresses) : undefined,
	};
}

const SINGLE = ["full_name", "given_name", "family_name", "organization", "job_title", "birthday", "website", "notes"] as const;

/** Address parts as contacts_update's undo names them (empty parts left out), for comparing. */
function addressKey(a: Partial<Record<"street" | "city" | "region" | "postal_code" | "country", string | null>> & { label?: string }): string {
	return JSON.stringify(["street", "city", "region", "postal_code", "country", "label"].map((k) => (a as Record<string, unknown>)[k] ?? null));
}

/**
 * Whether undo arguments would pass this tool's own checks (schema and the run-time rules) and put
 * the earlier values back exactly. A card made elsewhere can hold values our input refuses (a long
 * street, an email address or phone number in another form, a birthday before 1800), and an undo
 * that would be refused is worse than none. The tool also cleans what it is given (outer spaces,
 * tabs, line breaks in a name, control characters; a web address comes back in its normal form,
 * "https://a.example" as "https://a.example/"), so an undo whose values that cleaning would change
 * isn't exact either (fix round 3).
 */
export function undoReplayable(undoArgs: Record<string, unknown>): boolean {
	const parsed = input.safeParse(undoArgs);
	if (!parsed.success) return false;
	let ed: ContactEdits;
	try {
		ed = buildEdits(parsed.data);
	} catch {
		return false;
	}
	for (const k of SINGLE) {
		if (k in undoArgs && ed[k] !== undoArgs[k]) return false;
	}
	const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
	const u = undoArgs as { add_emails?: { address: string; label: string }[]; add_phones?: { number: string; label: string }[]; addresses?: Parameters<typeof addressKey>[0][] };
	if ("add_emails" in undoArgs && !same(ed.add_emails?.map((e) => [e.address, e.label]), u.add_emails?.map((e) => [e.address, e.label]))) return false;
	if ("add_phones" in undoArgs && !same(ed.add_phones?.map((p) => [p.number, p.label]), u.add_phones?.map((p) => [p.number, p.label]))) return false;
	if ("remove_emails" in undoArgs && !same(ed.remove_emails, undoArgs.remove_emails)) return false;
	if ("remove_phones" in undoArgs && !same(ed.remove_phones, undoArgs.remove_phones)) return false;
	if ("addresses" in undoArgs && !same(ed.addresses?.map(addressKey), u.addresses?.map(addressKey))) return false;
	return true;
}

/**
 * The most room an undo may take in one answer. Its arguments are bounded by this tool's own input
 * (notes 10,000 characters, 20 emails and phones, 10 addresses), but quotes double in JSON; one
 * that large is left out (with the usual warning) so the contact itself still fits.
 */
const UNDO_ROOM = 30_000;

export const contactsUpdate = defineTool({
	name: "contacts_update",
	title: "Change a contact",
	description:
		"Changes fields of an existing contact; everything not given stays as it is. add_emails, remove_emails, add_phones and remove_phones change single entries; addresses replaces the list. Contacts in the read-only workspace directories can't be changed. expected_etag from contacts_get guards against changes made in between.",
	input,
	async run(ctx, args) {
		const edits = buildEdits(args);
		const given = Object.entries(edits).filter(([, v]) => v !== undefined);
		if (given.length === 0) throw new ToolError("invalid_input", "Nothing to change: give at least one field to change.");

		const id = parseContactId(args.contact_id);
		const book = findBook(await listBooks(ctx), id.book);
		if (book.read_only) {
			throw new ToolError(
				"permission_denied",
				"This contact is in a read-only address book (a workspace directory, a team book or recently contacted), so it can't be changed. contacts_add can save a copy in the person's own book.",
			);
		}
		let read: Awaited<ReturnType<typeof getCard>>;
		try {
			read = await getCard(ctx, book.id, id.card);
		} catch (e) {
			if (isToolError(e) && e.code === "not_found") throw new ToolError("not_found", "There's no contact with that id. contacts_search can find it.", { field: "contact_id" });
			throw e;
		}
		if (!read.etag) throw new ToolError("upstream_unavailable", "NoContacts didn't say which version of the contact this is. Try again in a minute.");
		if (args.expected_etag !== undefined && bare(args.expected_etag) !== read.etag) {
			throw new ToolError("conflict", `The contact changed since it was read (etag now "${read.etag}"). Read it again with contacts_get.`, { field: "expected_etag" });
		}
		const result = editCard(read.card, edits);
		if (result.changed.length === 0) {
			throw new ToolError("invalid_input", `Nothing to change: the contact already has those values.${result.warnings.length ? ` ${result.warnings.join(" ")}` : ""}`);
		}
		const json = serializeCard(read.card);
		checkCardSize(json, read.bytes);
		try {
			const res = await ctx.nc.dav.put(cardPath(ctx.uid, book.id, id.card), json, {
				headers: { "content-type": "application/vcard+json; charset=utf-8", "if-match": `"${read.etag}"` },
				precondition: "if-match",
				what: "the contact",
			});
			await res.body?.cancel();
		} catch (e) {
			if (isToolError(e) && e.code === "conflict") {
				throw new ToolError("conflict", "The contact changed while it was being updated. Read it again with contacts_get, then try again.");
			}
			throw writeError(e);
		}
		const after = await getCard(ctx, book.id, id.card);
		const warnings = [...result.warnings];
		const undoArgs = result.inverse ? { contact_id: args.contact_id, ...result.inverse } : null;
		let undo = undoArgs && undoReplayable(undoArgs) ? { tool: "contacts_update", arguments: undoArgs } : null;
		if (undo && jsonLength(undo) > UNDO_ROOM) undo = null;
		if (!undo) warnings.push("This change can't be undone automatically.");
		// The whole answer (the contact, its undo and the warnings, which the wrapper adds to
		// structuredContent) fits one result (fix round 3).
		const rest = { contact: null, etag: after.etag, changed: result.changed, undo, warnings };
		const contact = contactView(readCard(after.card), book, id.card, ctx.cfg.driveOrigin, answerRoom(ctx) - jsonLength(rest));
		return {
			data: { contact, etag: after.etag, changed: result.changed },
			summary: `Changed ${result.changed.join(", ")} on the contact.${partialNote(contact)}`,
			undo,
			warnings,
		};
	},
});
