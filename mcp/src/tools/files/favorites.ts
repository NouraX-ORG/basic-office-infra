/**
 * files_list_favorites and files_set_favorite (DESIGN 11.2): DAV SEARCH for oc:favorite = "yes"
 * (the literal NoDrive matches, verified) and PROPPATCH oc:favorite to 1 or 0. files_set_favorite is
 * tier D (it changes the person's data), so its result carries undo (DESIGN 10.4): the mark as it
 * was, or null when the item was already as asked and nothing was sent.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { davFilesPath, type UserPath } from "../../core/paths";
import { FileItem, Paging, pathArg, Undo } from "../../core/shapes";
import { rawXml, xml } from "../../core/xml";
import { key, NS, XMLNS } from "../../nc/index";
import { item, nextCursor, perCall, searchRows, statPath, toUserPath, where } from "./common";
import { filesTool } from "./define";

export const filesListFavorites = filesTool({
	name: "files_list_favorites",
	title: "Favourites",
	description: "Lists the files and folders the person has marked as favourites in NoDrive, folders and files together in name order.",
	input: z.object({ limit: perCall(200, 50), cursor: nextCursor() }).strict(),
	output: z.object({ items: z.array(FileItem), ...Paging }),
	async run(ctx, args) {
		const raw = await ctx.page.decode<number>();
		const offset = typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
		// The cursor counts positions in NoDrive's own answer, not the rows kept here: a row that is
		// dropped (a failed propstat, or a name the path rules refuse) still uses its place, so a page
		// neither ends the listing early nor repeats items (DESIGN 29.7; files_search does the same).
		const rows = await searchRows(ctx, {
			scope: "/" as UserPath,
			where: where.eq("favorite", "yes"),
			order: [{ prop: "displayname", dir: "asc" }],
			limit: args.limit + 1,
			offset,
		});
		const window = rows.slice(0, args.limit).flatMap((d, k) => (d ? [{ it: item(d), raw: offset + k }] : []));
		const fitted = ctx.page.fit(
			window.map((w) => w.it),
			(page) => ({ items: page, next_cursor: "x".repeat(200), has_more: true }),
		);
		const items = fitted.items.length ? fitted.items : window.slice(0, 1).map((w) => w.it);
		const cutShort = items.length < window.length;
		const has_more = rows.length > args.limit || cutShort;
		// Next: the first kept row not shown, or the row after the last one this page read.
		const next = cutShort ? (window[items.length] as { raw: number }).raw : offset + Math.min(rows.length, args.limit);
		const data = { items, next_cursor: has_more ? await ctx.page.encode(next) : null, has_more };
		return {
			data,
			summary:
				items.length === 0
					? has_more
						? "Nothing to show on this page; next_cursor continues."
						: offset === 0
							? "The person has no favourites in NoDrive."
							: "No more favourites."
					: `Listed ${items.length} favourite${items.length === 1 ? "" : "s"}.`,
		};
	},
});

export const filesSetFavorite = filesTool({
	name: "files_set_favorite",
	title: "Mark or unmark a favourite",
	description: "Marks a NoDrive file or folder as a favourite, or removes the mark with favorite false. files_list_favorites lists them.",
	input: z
		.object({
			path: pathArg("The file or folder."),
			favorite: z.boolean().describe("true marks it as a favourite, false removes the mark."),
		})
		.strict(),
	output: z.object({ item: FileItem, changed: z.boolean(), undo: Undo }),
	async run(ctx, args) {
		const path = toUserPath(args.path, "path", false);
		const before = await statPath(ctx, path);
		// Already as asked: nothing to change, so nothing to undo (DESIGN 10.4).
		if (before.favorite === args.favorite) {
			return {
				data: { item: item(before), changed: false, undo: null },
				summary: args.favorite ? `The ${before.type} was already a favourite; nothing changed.` : `The ${before.type} wasn't marked as a favourite; nothing changed.`,
			};
		}
		const body = xml`<?xml version="1.0" encoding="UTF-8"?><d:propertyupdate ${rawXml(XMLNS)}><d:set><d:prop><oc:favorite>${args.favorite ? "1" : "0"}</oc:favorite></d:prop></d:set></d:propertyupdate>`;
		const rs = await ctx.nc.dav.proppatch(davFilesPath(ctx.uid, path), body);
		if (rs.some((r) => r.missing.has(key(NS.oc, "favorite")))) {
			throw new ToolError("permission_denied", "NoDrive didn't change the favourite mark.");
		}
		const d = await statPath(ctx, path);
		return {
			data: { item: item(d), changed: true, undo: { tool: "files_set_favorite", arguments: { path, favorite: before.favorite } } },
			// The path is in the data (item.path); the summary doesn't repeat it (common.ts, at the top).
			summary: args.favorite ? `Marked the ${d.type} as a favourite.` : `Removed the favourite mark from the ${d.type}.`,
		};
	},
});
