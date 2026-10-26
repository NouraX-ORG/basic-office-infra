/**
 * files_list_folder (DESIGN 11.2): PROPFIND Depth 1, then sorted and sliced in the Worker. At most
 * 2,000 entries are read; beyond that a note points to files_search.
 *
 * Fix round 3: the answer is read as a stream and reading stops after the folder itself and its first
 * 2,000 entries (or at the 8 MB cap, at the last whole entry), so a folder of any size gets its
 * listing and the note instead of a refusal, and the Worker never parses more than that.
 */
import { z } from "zod";
import { ToolError, isToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import { davFilesPath, type UserPath } from "../../core/paths";
import { FileItem, Paging, pathArg } from "../../core/shapes";
import type { ToolCtx } from "../../core/tool";
import { type DavResponse, parseMultistatus, propfindBody } from "../../nc/index";
import { detailsOf, item, nextCursor, offsetPage, perCall, toUserPath } from "./common";
import { filesTool } from "./define";

const output = z.object({
	folder: FileItem,
	items: z.array(FileItem),
	total: z.number(),
	note: z.string().nullable(),
	...Paging,
});

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** The end of one <d:response> element, whatever prefix the server gives the DAV namespace. */
const RESPONSE_END = /<\/(?:[A-Za-z_][\w.-]*:)?response\s*>/g;

/**
 * The folder's PROPFIND Depth 1, read until the folder itself and one child more than `entries` have
 * arrived (Sabre sends the folder first; the extra one shows that there are more) or `maxChars` is
 * reached; the rest is never read. `cut` is true when reading stopped early.
 */
export async function readListing(ctx: ToolCtx, path: UserPath, entries: number = LIMITS.folderReadEntries, maxChars: number = LIMITS.davXmlBytes): Promise<{ rs: DavResponse[]; cut: boolean }> {
	const res = await ctx.nc.request("PROPFIND", davFilesPath(ctx.uid, path, { trailingSlash: true }), {
		headers: { depth: "1", "content-type": "application/xml; charset=utf-8" },
		body: propfindBody(),
	});
	if (res.status === 204 || !res.body) return { rs: [], cut: false };
	const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
	let text = "";
	let count = 0;
	let lastEnd = 0;
	let cut = false;
	const want = entries + 2;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			text += value;
			RESPONSE_END.lastIndex = lastEnd;
			let m: RegExpExecArray | null = RESPONSE_END.exec(text);
			while (m && count < want) {
				count++;
				lastEnd = m.index + m[0].length;
				if (count >= want) break;
				m = RESPONSE_END.exec(text);
			}
			if (count >= want || text.length > maxChars) {
				cut = true;
				break;
			}
		}
	} finally {
		if (cut) await reader.cancel().catch(() => undefined);
		else reader.releaseLock();
	}
	if (!cut) return { rs: parseMultistatus(text), cut: false };
	const prefix = /<([A-Za-z_][\w.-]*:)?multistatus\b/.exec(text)?.[1] ?? "";
	return { rs: parseMultistatus(`${text.slice(0, lastEnd)}</${prefix}multistatus>`), cut: true };
}

export const filesListFolder = filesTool({
	name: "files_list_folder",
	title: "List a folder",
	description:
		'Lists the files and folders in one NoDrive folder, folders first, with type, size, last change and a link to each. Paths start with "/", the top of the person\'s NoDrive. files_search finds items when the folder isn\'t known. Up to 200 items per call.',
	input: z
		.object({
			path: pathArg('The folder; "/" is the top of NoDrive.').default("/"),
			kind: z.enum(["all", "files", "folders"]).default("all").describe("Which items to list."),
			sort: z.enum(["name", "modified", "size"]).default("name").describe("Folders always come first."),
			order: z.enum(["asc", "desc"]).default("asc").describe("Sort direction."),
			limit: perCall(200, 50),
			cursor: nextCursor(),
		})
		.strict(),
	output,
	async run(ctx, args) {
		const path = toUserPath(args.path);
		let rs: DavResponse[];
		let cut = false;
		try {
			({ rs, cut } = await readListing(ctx, path));
		} catch (e) {
			if (isToolError(e) && e.code === "not_found") throw new ToolError("not_found", "There's no folder at that path.", { hint: "files_search can find it by name.", field: "path" });
			if (isToolError(e) && e.code === "too_large") {
				throw new ToolError("too_large", "That folder holds too many items to list here.", { hint: "files_search can find items in it by name." });
			}
			throw e;
		}
		const all = detailsOf(ctx, rs);
		const self = all.find((d) => d.path === path);
		if (!self) throw new ToolError("not_found", "There's no folder at that path.", { hint: "files_search can find it by name.", field: "path" });
		if (self.type !== "folder") throw new ToolError("invalid_input", "That path is a file, not a folder.", { field: "path", hint: "files_get_info shows its details." });

		let children = all.filter((d) => d.path !== path);
		let note: string | null = null;
		if (children.length > LIMITS.folderReadEntries || cut) {
			children = children.slice(0, LIMITS.folderReadEntries);
			note = `This folder holds more than ${LIMITS.folderReadEntries.toLocaleString("en-GB")} items; only the first ${LIMITS.folderReadEntries.toLocaleString("en-GB")} that NoDrive sent are listed. files_search finds items by name.`;
		}
		if (args.kind === "files") children = children.filter((d) => d.type === "file");
		if (args.kind === "folders") children = children.filter((d) => d.type === "folder");
		const dir = args.order === "desc" ? -1 : 1;
		const key = (a: (typeof children)[number], b: (typeof children)[number]): number => {
			if (args.sort === "modified") return (Date.parse(a.modified ?? "") || 0) - (Date.parse(b.modified ?? "") || 0);
			if (args.sort === "size") return a.size - b.size;
			return collator.compare(a.name, b.name);
		};
		children.sort((a, b) => {
			if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
			return dir * key(a, b) || collator.compare(a.name, b.name) || a.path.localeCompare(b.path);
		});
		const items = children.map(item);
		const folder = item(self);
		const total = items.length;
		const render = (page: typeof items) => ({ folder, items: page, total, note, next_cursor: "x".repeat(200), has_more: true });
		const page = await offsetPage(ctx, items, args.limit, render);
		const data = { folder, items: page.items, total, note, next_cursor: page.next_cursor, has_more: page.has_more };
		const shown = page.items.length;
		const range = page.offset > 0 || page.has_more ? ` (${page.offset + 1} to ${page.offset + shown} of ${total})` : "";
		// The folder's path is in the data (folder.path); the summary doesn't repeat it (common.ts).
		const where = path === "/" ? "the top folder" : "the folder";
		return {
			data,
			summary:
				total === 0
					? args.kind === "all"
						? `${path === "/" ? "The top folder" : "The folder"} is empty.`
						: `There are no ${args.kind} in ${where}.`
					: `Listed ${shown} item${shown === 1 ? "" : "s"} in ${where}${range}.`,
		};
	},
});
