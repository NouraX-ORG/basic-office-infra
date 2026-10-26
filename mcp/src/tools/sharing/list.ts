/**
 * sharing_list (DESIGN 11.3): GET /shares as this person.
 * - "mine": the shares the person made (no path, reshares off);
 * - "path": every share on one file or folder (path=, reshares=true);
 * - "with_me": what other people shared with the person (shared_with_me=true).
 * Newest first (by the server's share time, then id), paged with a cursor bound to the arguments,
 * and cut to the result budget.
 */
import { z } from "zod";
import { isToolError, ToolError } from "../../core/errors";
import { normalizePath } from "../../core/paths";
import { cursorArg, limitArg } from "../../core/shapes";
import { defineTool } from "../../core/tool";
import { answerRoom, pageWindow } from "./bounded";
import { type RawShare, SHARES, ShareOut, shareError, shareView } from "./shares";

const input = z
	.object({
		which: z.enum(["mine", "path", "with_me"]).describe('"mine": made by the person; "path": on one item; "with_me": shared with them.'),
		path: z.string().max(1024).optional().describe('File or folder, for which "path".'),
		limit: limitArg(200, 50),
		cursor: cursorArg(),
	})
	.strict();

/**
 * The shape of structuredContent. Not published as outputSchema: tools/list must stay small (60 KB
 * for every tool together); the same JSON is in the framed text block, and the tests hold every
 * result to this schema.
 */
export const sharingListOutput = z.object({
	shares: z.array(ShareOut),
	total: z.number(),
	next_cursor: z.string().nullable(),
	has_more: z.boolean(),
});

/** When a share was made, in seconds; 0 (oldest) when the server gave no time. */
function stimeOf(r: RawShare): number {
	return typeof r.stime === "number" && Number.isFinite(r.stime) && r.stime > 0 ? r.stime : 0;
}

/** The numeric share id; 0 when it isn't one. */
function idOf(r: RawShare): number {
	const n = Number(r.id);
	return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export const sharingList = defineTool({
	name: "sharing_list",
	title: "List shares",
	description:
		'Lists shares: the ones the person made (which "mine"), the ones on a file or folder (which "path"), or items other people shared with the person (which "with_me"). Each share shows its kind (link, person, group or team), access, expiry and, for links, the URL. mine says whether sharing_update and sharing_delete can change it.',
	input,
	async run(ctx, args) {
		let query: Record<string, string> = {};
		let what = "the shares";
		if (args.which === "path") {
			if (args.path === undefined) throw new ToolError("invalid_input", 'path is needed with which "path".', { field: "path" });
			const path = normalizePath(args.path);
			query = { path, reshares: "true" };
			what = path;
		} else if (args.path !== undefined) {
			throw new ToolError("invalid_input", 'path is used only with which "path".', { field: "path" });
		} else if (args.which === "with_me") {
			query = { shared_with_me: "true" };
		}
		let raws: RawShare[];
		try {
			const data = await ctx.nc.ocs.get<unknown>(SHARES, query, { what });
			raws = Array.isArray(data) ? (data as RawShare[]).filter((r) => r && typeof r === "object" && typeof r.uid_owner === "string") : [];
		} catch (e) {
			if (isToolError(e) && e.code === "not_found" && args.which === "path") {
				throw new ToolError("not_found", `There's no file or folder at ${what}.`, { field: "path", hint: "files_search can find it by name." });
			}
			throw shareError(e, what);
		}
		// Newest first by the server's own time (stime, seconds), then by id. Sorting the formatted
		// local times would misorder shares made in the hour that repeats when the clocks go back
		// ("01:30+01:00" is earlier than "01:10+00:00").
		const all = raws
			.slice()
			.sort((a, b) => stimeOf(b) - stimeOf(a) || idOf(b) - idOf(a))
			.map((r) => shareView(ctx, r));

		const raw = await ctx.page.decode<number>();
		const offset = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= all.length ? raw : 0;
		// Fitted as structuredContent carries it (JSON with nulls kept), and always moving on, so one
		// share someone made with a huge note can't stall the paging (fix round 3).
		const page = pageWindow(all, offset, args.limit, (xs) => ({ shares: xs, total: all.length, next_cursor: "x".repeat(200), has_more: true }), answerRoom(ctx));
		const has_more = page.next < all.length;
		const words = { mine: "made by the person", path: `on ${what}`, with_me: "shared with the person" }[args.which];
		const skipped = page.skipped ? ` ${page.skipped} share was too large to show and was left out.` : "";
		return {
			data: { shares: page.items, total: all.length, next_cursor: has_more ? await ctx.page.encode(page.next) : null, has_more },
			summary: `Listed ${page.items.length} of ${all.length} share${all.length === 1 ? "" : "s"} ${words}.${skipped}`,
		};
	},
});
