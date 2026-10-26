/**
 * contacts_add (DESIGN 11.7): a jCard PUT with If-None-Match: * into one of the person's own
 * address books ("contacts" unless address_book_id is given; made when missing). The card is read
 * back afterwards, because the server stores it as vCard 4.0 and sends no ETag for a converted PUT.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { allowDuplicateArg } from "../../core/shapes";
import { defineTool } from "../../core/tool";
import { newCard, readCard } from "../../pim/vcard";
import { answerRoom, jsonLength } from "../sharing/bounded";
import { cardPath, checkCardSize, getCard, listBooks, writableBook, writeError } from "./books";
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

const input = z
	.object({
		full_name: z.string().max(NAME_MAX).optional().describe("Name as shown; or give given_name and family_name."),
		given_name: z.string().max(NAME_MAX).optional().describe("First name."),
		family_name: z.string().max(NAME_MAX).optional().describe("Last name."),
		emails: z.array(emailIn).max(LIST_MAX).optional().describe("Email addresses."),
		phones: z.array(phoneIn).max(LIST_MAX).optional().describe("Phone numbers."),
		organization: z.string().max(NAME_MAX).optional().describe("Organisation."),
		job_title: z.string().max(NAME_MAX).optional().describe("Job title."),
		addresses: z.array(addressIn).max(10).optional().describe("Postal addresses."),
		birthday: birthdayIn.optional(),
		website: z.string().max(2048).optional().describe("Web address (https://…)."),
		notes: z.string().max(10_000).optional().describe("Notes."),
		address_book_id: z.string().max(200).optional().describe("One of the person's own books (default: the main one)."),
		allow_duplicate: allowDuplicateArg(),
	})
	.strict();

/**
 * The shape of structuredContent. Not published as outputSchema: tools/list must stay small (60 KB
 * for every tool together); the same JSON is in the framed text block, and the tests hold every
 * result to this schema.
 */
export const contactsAddOutput = z.object({ contact: ContactOut, etag: z.string().nullable() });

export const contactsAdd = defineTool({
	name: "contacts_add",
	title: "Add a contact",
	description:
		"Adds a contact to one of the person's NoContacts address books (the default one unless address_book_id is given), with name, email addresses, phone numbers, organisation, job title, postal addresses, birthday, website and notes. The workspace directories are read-only.",
	input,
	async run(ctx, args) {
		const full_name = cleanName(args.full_name, "full_name");
		const given_name = cleanName(args.given_name, "given_name");
		const family_name = cleanName(args.family_name, "family_name");
		if (!full_name && !given_name && !family_name) {
			throw new ToolError("invalid_input", "A name is needed: give full_name, or given_name and family_name.", { field: "full_name" });
		}
		const notes = args.notes !== undefined ? cleanText(args.notes, true) : undefined;
		const card = newCard(
			{
				full_name,
				given_name,
				family_name,
				emails: cleanEmails(args.emails, "emails"),
				phones: cleanPhones(args.phones, "phones"),
				organization: cleanName(args.organization, "organization"),
				job_title: cleanName(args.job_title, "job_title"),
				addresses: cleanAddresses(args.addresses),
				birthday: args.birthday !== undefined ? checkBirthday(args.birthday, "birthday") : undefined,
				website: args.website !== undefined ? checkWebsite(args.website, "website") : undefined,
				notes: notes || undefined,
			},
			crypto.randomUUID(),
		);
		const json = JSON.stringify(card);
		checkCardSize(json);
		const book = await writableBook(ctx, await listBooks(ctx), args.address_book_id);
		const uid = String(((card[1] as unknown[][]).find((p) => p[0] === "uid") ?? [])[3]);
		const fileName = `${uid}.vcf`;
		try {
			const res = await ctx.nc.dav.put(cardPath(ctx.uid, book.id, fileName), json, {
				headers: { "content-type": "application/vcard+json; charset=utf-8", "if-none-match": "*" },
				precondition: "if-none-match",
				what: "the new contact",
			});
			await res.body?.cancel();
		} catch (e) {
			throw writeError(e);
		}
		const read = await getCard(ctx, book.id, fileName);
		const contact = contactView(readCard(read.card), book, fileName, ctx.cfg.driveOrigin, answerRoom(ctx) - jsonLength({ contact: null, etag: read.etag }));
		return { data: { contact, etag: read.etag }, summary: `Added the contact.${partialNote(contact)}` };
	},
});
