/**
 * files_move, files_copy and files_rename (DESIGN 11.2): DAV MOVE and COPY with the Destination
 * built by the path normaliser and "Overwrite: F", so nothing that is already there is replaced.
 * Summaries and errors never repeat a path or a name (common.ts, at the top); the new path is in the
 * data (item.path), and a numbered rename is explained in warnings, inside the frame.
 */
import { z } from "zod";
import { ToolError, isToolError } from "../../core/errors";
import { basenameOf, checkName, davFilesPath, isWithin, joinPath, numberedName, parentOf, type UserPath } from "../../core/paths";
import { FileItem, pathArg, Undo } from "../../core/shapes";
import type { ToolCtx } from "../../core/tool";
import { ifExists, item, parentMissing, statFolder, statPath, toUserPath } from "./common";
import { filesTool } from "./define";
import { guardExposure } from "./exposure";

const MAX_NUMBERED = 20;

/** MOVE or COPY to `folder/name`, trying "name (2)" and up when if_exists is "rename". */
async function transfer(
	ctx: ToolCtx,
	method: "move" | "copy",
	from: UserPath,
	folder: UserPath,
	name: string,
	ifExistsMode: "fail" | "rename",
): Promise<{ to: UserPath; renamed: boolean }> {
	for (let n = 1; n <= MAX_NUMBERED; n++) {
		const to = joinPath(folder, n === 1 ? name : numberedName(name, n));
		// A copy onto itself is a taken name (NoDrive would answer 412 or 403).
		if (to === from) {
			if (ifExistsMode === "fail") throw new ToolError("already_exists", "Something with that name is already in that folder.", { hint: 'Give new_name, or use if_exists "rename" to add a number.' });
			continue;
		}
		let res: Response;
		try {
			res = await ctx.nc.dav[method](davFilesPath(ctx.uid, from), davFilesPath(ctx.uid, to), { allow: [412] });
		} catch (e) {
			if (isToolError(e) && e.code === "not_found") throw new ToolError("not_found", "There's no file or folder at that path.", { hint: "files_search can find it by name.", field: "path" });
			parentMissing(e);
		}
		await res.body?.cancel();
		if (res.status === 412) {
			if (ifExistsMode === "fail") {
				throw new ToolError("already_exists", "Something with that name is already in that folder.", { hint: 'Use if_exists "rename" to add a number to the name.' });
			}
			continue;
		}
		return { to, renamed: n > 1 };
	}
	throw new ToolError("already_exists", `That name and the ${MAX_NUMBERED - 1} numbered names after it are all taken in that folder.`, { hint: "Choose another name or folder." });
}

export const filesMove = filesTool({
	name: "files_move",
	title: "Move",
	description:
		'Moves a file or folder into another NoDrive folder and keeps its name. Nothing already there is replaced: if_exists "fail" (default) stops, "rename" adds a number. Shares and links on the item keep working. files_rename changes only the name.',
	input: z
		.object({
			path: pathArg("The file or folder to move."),
			to_folder: pathArg('The folder to move it into, such as "/Archive".'),
			if_exists: ifExists("fail"),
		})
		.strict(),
	output: z.object({ item: FileItem, from: z.string(), renamed: z.boolean(), undo: Undo, warnings: z.array(z.string()).optional() }),
	async run(ctx, args) {
		const path = toUserPath(args.path, "path", false);
		const folder = toUserPath(args.to_folder, "to_folder");
		if (isWithin(folder, path)) throw new ToolError("invalid_input", "A folder can't be moved into itself or into one of its own folders.", { field: "to_folder" });
		if (parentOf(path) === folder) throw new ToolError("invalid_input", "The item is already in that folder.", { field: "to_folder", hint: "files_rename changes only the name." });
		await statFolder(ctx, folder, "to_folder");
		const src = await statPath(ctx, path);
		// Moving into a folder shared by link is sharing (fix round 3, files/exposure.ts).
		await guardExposure(ctx, folder, { field: "to_folder", what: "move", source: path });
		const { to, renamed } = await transfer(ctx, "move", path, folder, basenameOf(path), args.if_exists);
		const d = await statPath(ctx, to);
		const from = parentOf(path);
		// files_move keeps the name, so after a numbered rename one call can't put things back as they were.
		const undo = renamed ? null : { tool: "files_move", arguments: { path: to, to_folder: from } };
		const warnings = renamed
			? [
					`A ${src.type} named "${basenameOf(path)}" was already in ${folder}, so this one was saved as "${basenameOf(to)}". To undo the move, files_move it back to ${from}, then files_rename it to "${basenameOf(path)}".`,
				]
			: undefined;
		return {
			data: { item: item(d), from: path, renamed, undo, ...(warnings ? { warnings } : {}) },
			summary: renamed ? `Moved the ${src.type} to the new folder under a numbered name, because its name was taken there.` : `Moved the ${src.type} to the new folder.`,
		};
	},
});

export const filesCopy = filesTool({
	name: "files_copy",
	title: "Copy",
	description:
		'Copies a file or folder into a NoDrive folder, optionally under a new name. Nothing already there is replaced: if_exists "fail" (default) stops, "rename" adds a number. Shares are not copied.',
	input: z
		.object({
			path: pathArg("The file or folder to copy."),
			to_folder: pathArg("The folder for the copy; it may be the same folder."),
			new_name: z.string().min(1).max(250).optional().describe("One name, not a path. Default: the same name."),
			if_exists: ifExists("fail"),
		})
		.strict(),
	output: z.object({ item: FileItem, renamed: z.boolean(), warnings: z.array(z.string()).optional() }),
	async run(ctx, args) {
		const path = toUserPath(args.path, "path", false);
		const folder = toUserPath(args.to_folder, "to_folder");
		const name = args.new_name !== undefined ? checkName(args.new_name, "new_name") : basenameOf(path);
		await statFolder(ctx, folder, "to_folder");
		const src = await statPath(ctx, path);
		if (src.type === "folder" && isWithin(folder, path)) {
			throw new ToolError("invalid_input", "A folder can't be copied into itself or into one of its own folders.", { field: "to_folder" });
		}
		// Copying into a folder shared by link is sharing (fix round 3, files/exposure.ts).
		await guardExposure(ctx, folder, { field: "to_folder", what: "copy", source: path });
		const { to, renamed } = await transfer(ctx, "copy", path, folder, name, args.if_exists);
		const d = await statPath(ctx, to);
		return {
			data: { item: item(d), renamed },
			summary: renamed ? `Copied the ${src.type} under a numbered name, because the name was taken there.` : `Copied the ${src.type}.`,
		};
	},
});

export const filesRename = filesTool({
	name: "files_rename",
	title: "Rename",
	description:
		"Gives a NoDrive file or folder a new name in the same folder. new_name is one name, not a path, and must not be taken already. Shares and links keep working. files_move puts it in another folder.",
	input: z
		.object({
			path: pathArg("The file or folder to rename."),
			new_name: z.string().min(1).max(250).describe('The new name (one name, not a path), such as "Plan v2.docx".'),
		})
		.strict(),
	output: z.object({ item: FileItem, old_path: z.string(), undo: Undo }),
	async run(ctx, args) {
		const path = toUserPath(args.path, "path", false);
		const newName = checkName(args.new_name, "new_name");
		const oldName = basenameOf(path);
		if (newName === oldName) throw new ToolError("invalid_input", "The item already has that name.", { field: "new_name" });
		const src = await statPath(ctx, path);
		const folder = parentOf(path);
		const to = joinPath(folder, newName);
		let res: Response;
		try {
			res = await ctx.nc.dav.move(davFilesPath(ctx.uid, path), davFilesPath(ctx.uid, to), { allow: [412] });
		} catch (e) {
			if (isToolError(e) && e.code === "not_found") throw new ToolError("not_found", "There's no file or folder at that path.", { hint: "files_search can find it by name.", field: "path" });
			throw e;
		}
		await res.body?.cancel();
		if (res.status === 412) throw new ToolError("already_exists", "Something with that name is already in the same folder.", { hint: "Pick another name.", field: "new_name" });
		const d = await statPath(ctx, to);
		return {
			data: { item: item(d), old_path: path, undo: { tool: "files_rename", arguments: { path: to, new_name: oldName } } },
			summary: `Renamed the ${src.type}.`,
		};
	},
});
