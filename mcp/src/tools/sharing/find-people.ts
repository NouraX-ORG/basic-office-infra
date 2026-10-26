/** sharing_find_people (DESIGN 11.3): the server's sharees search as this person, with our filters. */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { limitArg } from "../../core/shapes";
import { defineTool } from "../../core/tool";
import { cleanText } from "../../pim/vcard";
import { findPeople, type PeopleKind } from "./people";

const input = z
	.object({
		query: z.string().min(2).max(100).describe("Part of a name, user id or group name."),
		kinds: z
			.array(z.enum(["person", "group", "team"]))
			.min(1)
			.max(3)
			.optional()
			.describe("Kinds to return (default all)."),
		limit: limitArg(25, 10),
	})
	.strict();

/**
 * The shape of structuredContent. Not published as outputSchema: tools/list must stay small (60 KB
 * for every tool together); the same JSON is in the framed text block, and the tests hold every
 * result to this schema.
 */
export const sharingFindPeopleOutput = z.object({
	results: z.array(
		z.object({
			id: z.string(),
			kind: z.enum(["person", "group", "team"]),
			display_name: z.string(),
			detail: z.string().nullable(),
		}),
	),
	note: z.string().nullable(),
});

/**
 * Said when nobody matched. Privacy between organisations is a switch (brief section 7, Task 6b),
 * so the words hold whichever way it is set.
 */
export const NOBODY_NOTE =
	"Nobody matched. Only people and groups the workspace lets this person see can be found; with privacy between organisations on, that is people who share an organisation or team with them, and their own groups and teams.";

export const sharingFindPeople = defineTool({
	name: "sharing_find_people",
	title: "Find people to share with",
	description:
		'Finds people, groups and teams in Nourax Workspace that the person may share with or invite, by name: only those the workspace lets this person see (with privacy between organisations on, their own organisation and teams). Returns ids such as "person:…" and "group:…" (a team\'s id is its group id). sharing_share_with takes every kind; calendar_add_attendees takes "person:…" ids only. Email addresses are not returned.',
	input,
	async run(ctx, args) {
		const q = cleanText(args.query);
		if (q.length < 2) throw new ToolError("invalid_input", "query needs at least 2 characters.", { field: "query" });
		const want = new Set<PeopleKind>(args.kinds ?? ["person", "group", "team"]);
		const results = await findPeople(ctx, q, want, args.limit);
		const note = results.length
			? null
			: NOBODY_NOTE;
		const summary = results.length ? `Found ${results.length} match${results.length === 1 ? "" : "es"} to share with.` : "Found nobody to share with by that name.";
		return { data: { results, note }, summary };
	},
});
