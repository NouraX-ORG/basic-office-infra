/** contacts_get (DESIGN 11.7): GET one card as jCard, with its etag for contacts_update. */
import { z } from "zod";
import { isToolError, ToolError } from "../../core/errors";
import { defineTool } from "../../core/tool";
import { readCard } from "../../pim/vcard";
import { answerRoom, jsonLength } from "../sharing/bounded";
import { findBook, getCard, listBooks, parseContactId } from "./books";
import { ContactOut, contactView, partialNote } from "./shapes";

const input = z
	.object({
		contact_id: z.string().min(3).max(420).describe("contact_id from contacts_search."),
	})
	.strict();

/**
 * The shape of structuredContent. Not published as outputSchema: tools/list must stay small (60 KB
 * for every tool together); the same JSON is in the framed text block, and the tests hold every
 * result to this schema.
 */
export const contactsGetOutput = z.object({ contact: ContactOut, etag: z.string().nullable() });

export const contactsGet = defineTool({
	name: "contacts_get",
	title: "Contact details",
	description:
		"Gets every field of one contact: names, email addresses, phone numbers, organisation and job title, postal addresses, birthday, websites and notes (up to 2,000 characters), plus the etag that contacts_update can check and whether the contact can be changed. Very long fields and lists are cut short and say so (truncated_fields, *_total).",
	input,
	async run(ctx, args) {
		const id = parseContactId(args.contact_id);
		const book = findBook(await listBooks(ctx), id.book);
		let read: Awaited<ReturnType<typeof getCard>>;
		try {
			read = await getCard(ctx, book.id, id.card);
		} catch (e) {
			if (isToolError(e) && e.code === "not_found") throw new ToolError("not_found", "There's no contact with that id. contacts_search can find it.", { field: "contact_id" });
			throw e;
		}
		// The contact fits the result as structuredContent carries it (fix round 3).
		const contact = contactView(readCard(read.card), book, id.card, ctx.cfg.driveOrigin, answerRoom(ctx) - jsonLength({ contact: null, etag: read.etag }));
		// Summaries carry no text people wrote (names stay inside the data markers).
		const summary = `${contact.read_only ? "Got one contact from a read-only address book." : "Got one contact."}${partialNote(contact)}`;
		return { data: { contact, etag: read.etag }, summary };
	},
});
