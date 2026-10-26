/**
 * files_create_file, files_overwrite_file and files_create_folder (DESIGN 11.2).
 *
 * Version facts checked on the server (NC 35.0.2): the version list of a file includes its current
 * content, whose version id is the file's last-modified time in unix seconds. After an overwrite the
 * replaced content is the version whose id is the old last-modified time, so that is the undo.
 *
 * A PUT into a folder that doesn't exist answers 404, not 409 (checked live 2026-10-25, with and
 * without If-None-Match), so files_create_file looks at the folder before it explains the error.
 * MKCOL under a missing folder answers 409.
 *
 * Summaries and errors never repeat a path or a name (common.ts, at the top): the new path is in the
 * data, and errors from core's writeNew and overwrite go through plainFileError().
 */
import { z } from "zod";
import { ToolError, isToolError } from "../../core/errors";
import { basenameOf, checkName, davFilesPath, joinPath, numberedName, parentOf, segmentsOf, type UserPath } from "../../core/paths";
import { FileItem, pathArg, Undo } from "../../core/shapes";
import type { ToolCtx } from "../../core/tool";
import type { FileDetails } from "../../nc/index";
import {
	contentArg,
	encodingArg,
	ifExists,
	isNotFound,
	item,
	mimeArg,
	mimeFor,
	mtimeSec,
	parentMissing,
	plainFileError,
	statFile,
	statOrNull,
	statPath,
	toUserPath,
	uploadBytes,
	versionKept,
} from "./common";
import { filesTool } from "./define";
import { guardExposure } from "./exposure";

const MAX_NEW_LEVELS = 10;

/** files_create_file tries the name, then "name (2)" up to "name (20)" for if_exists "rename". */
const MAX_NAMES = 20;

/**
 * The current etag for a conflict message. Etags are NoDrive's own (hex on this server), so one is
 * shown only when it looks like that; anything else stays out of the unframed text.
 */
function etagNow(etag: string | null): string {
	return etag !== null && /^[A-Za-z0-9._:-]{1,80}$/.test(etag) ? ` (etag now "${etag}")` : "";
}

/** The name is taken and if_exists is "fail": the hint depends on what is there. */
async function explainTaken(ctx: ToolCtx, path: UserPath): Promise<never> {
	const there = await statOrNull(ctx, path);
	if (there?.type === "folder") {
		throw new ToolError("already_exists", "There's a folder with that name there, so a file can't have it.", { hint: 'Use if_exists "rename", or choose another name.', field: "path" });
	}
	throw new ToolError("already_exists", "A file with that name already exists there.", { hint: 'Use if_exists "rename", or files_overwrite_file to replace it.', field: "path" });
}

/** A 404 to a PUT: say that the folder is missing, or that the "folder" is a file. */
async function explainNotFound(ctx: ToolCtx, path: UserPath, e: unknown): Promise<never> {
	const folder = parentOf(path);
	if (folder === "/") throw plainFileError(e);
	const d = await statOrNull(ctx, folder);
	if (d === null) throw new ToolError("parent_missing", "The folder it should go in doesn't exist.", { hint: "files_create_folder can make it.", field: "path" });
	if (d.type === "file") throw new ToolError("invalid_input", "The folder in that path is a file, so nothing can be created inside it.", { field: "path" });
	throw new ToolError("upstream_unavailable", "NoDrive couldn't save the file in that folder. Try again in a minute.");
}

export const filesCreateFile = filesTool({
	name: "files_create_file",
	title: "Create a file",
	description:
		'Creates a new NoDrive file from text or base64 data. An existing file is never replaced; if_exists "rename" saves it as "name (2).ext". Text up to 1,000,000 characters, data up to 2 MB decoded; bigger files need the NoDrive app or website. The docs_create_ tools make Office files.',
	input: z
		.object({
			path: pathArg('The new file and its name, such as "/Notes/today.md".'),
			content: contentArg(),
			encoding: encodingArg(),
			if_exists: ifExists("fail"),
			mime: mimeArg(),
		})
		.strict(),
	output: z.object({ file: FileItem, renamed: z.boolean(), warnings: z.array(z.string()).optional() }),
	async run(ctx, args) {
		const path = toUserPath(args.path, "path", false, true);
		const bytes = uploadBytes(args.content, args.encoding);
		const mime = mimeFor(basenameOf(path), args.encoding, args.mime);
		const parent = parentOf(path);
		const name = basenameOf(path);
		// A new file in a folder shared by link is shared too (fix round 3, files/exposure.ts).
		await guardExposure(ctx, parent, { field: "path", what: "new" });
		// Every PUT sends the whole body, even one NoDrive refuses with 412 because the name is
		// taken. So each PUT counts toward the daily upload cap, and for "rename" each numbered name
		// is looked at first (PROPFIND Depth 0), so a body goes only to a name that was free just
		// before; a second PUT happens only when someone takes that name in between.
		let res: Awaited<ReturnType<typeof ctx.nc.files.writeNew>> | undefined;
		for (let n = 1; n <= MAX_NAMES && !res; n++) {
			const target = n === 1 ? path : joinPath(parent, numberedName(name, n));
			if (n > 1 && (await statOrNull(ctx, target)) !== null) continue;
			await ctx.charge("write", 0, bytes.byteLength);
			try {
				res = await ctx.nc.files.writeNew(target, bytes, mime, "fail");
			} catch (e) {
				if (isToolError(e) && e.code === "already_exists") {
					if (args.if_exists === "fail") await explainTaken(ctx, path);
					continue;
				}
				if (isNotFound(e)) await explainNotFound(ctx, target, e);
				parentMissing(plainFileError(e));
			}
		}
		if (!res) {
			throw new ToolError("already_exists", `That name and ${MAX_NAMES - 1} numbered copies of it are all taken there.`, { hint: "Choose another name.", field: "path" });
		}
		if (res.item.type !== "file") throw new ToolError("upstream_unavailable", "NoDrive didn't save the file as expected. Try again in a minute.");
		const renamed = res.path !== path;
		return {
			data: { file: item(res.item), renamed },
			summary: renamed ? "Created the file under a numbered name, because the name was taken." : "Created the file.",
		};
	},
});

export const filesOverwriteFile = filesTool({
	name: "files_overwrite_file",
	title: "Replace a file's content",
	description:
		"Replaces an existing NoDrive file's content with text or base64 data. The old content stays in its version history, so files_restore_version undoes it. expected_etag (from files_get_info or files_read_text) must still match, so a newer change by someone else is never lost. Limits as in files_create_file.",
	input: z
		.object({
			path: pathArg("The file whose content is replaced."),
			content: contentArg(),
			encoding: encodingArg(),
			expected_etag: z.string().min(1).max(200).describe("The etag from files_get_info or files_read_text."),
		})
		.strict(),
	output: z.object({ file: FileItem, previous_etag: z.string(), undo: Undo, warnings: z.array(z.string()).optional() }),
	async run(ctx, args) {
		const path = toUserPath(args.path, "path", false);
		const bytes = uploadBytes(args.content, args.encoding);
		const caps = await ctx.nc.capabilities();
		if (!caps.versions) {
			throw new ToolError("not_available", "Version history is off in NoDrive, so replacing the content couldn't be undone. Nothing was changed.", {
				hint: "files_create_file can save the new content under another name.",
			});
		}
		const before = await statFile(ctx, path, "Only a file's content can be replaced.");
		// New content in a file shared by link (or in a folder that is) is shared too (fix round 3).
		await guardExposure(ctx, path, { field: "path", what: "replace" });
		const expected = args.expected_etag.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
		if (before.etag !== null && before.etag !== expected) {
			throw new ToolError("conflict", `The file changed since it was read${etagNow(before.etag)}.`, { hint: "Read it again first.", field: "expected_etag" });
		}
		await ctx.charge("write", 0, bytes.byteLength);
		let res: { item: FileDetails; previousEtag: string };
		try {
			res = await ctx.nc.files.overwrite(path, bytes, expected, mimeFor(basenameOf(path), args.encoding));
		} catch (e) {
			if (isToolError(e) && e.code === "conflict") {
				const now = await statOrNull(ctx, path);
				throw new ToolError("conflict", `The file changed since it was read${etagNow(now?.etag ?? null)}.`, { hint: "Read it again first.", field: "expected_etag" });
			}
			if (isNotFound(e)) throw new ToolError("not_found", "The file isn't there any more.", { field: "path" });
			throw plainFileError(e);
		}
		const oldVersion = mtimeSec(before);
		const kept = await versionKept(ctx, res.item.file_id, oldVersion);
		const undo = kept ? { tool: "files_restore_version", arguments: { path, version_id: String(oldVersion) } } : null;
		const warnings = kept ? undefined : ["NoDrive didn't keep a version of the old content this time, so this change can't be undone with files_restore_version."];
		return {
			data: { file: item(res.item), previous_etag: res.previousEtag, undo, ...(warnings ? { warnings } : {}) },
			summary: kept ? "Replaced the file's content. The old content is kept as a version." : "Replaced the file's content.",
		};
	},
});

export const filesCreateFolder = filesTool({
	name: "files_create_folder",
	title: "New folder",
	description:
		"Creates a folder in NoDrive. With create_parents (default true) missing parent folders are created too, up to 10 levels deep. An existing folder is left as it is and reported.",
	input: z
		.object({
			path: pathArg('The new folder, such as "/Projects/2026/Reports".'),
			create_parents: z.boolean().default(true).describe("Also create missing parent folders."),
		})
		.strict(),
	output: z.object({ folder: FileItem, created: z.boolean(), created_folders: z.number() }),
	async run(ctx, args) {
		const path = toUserPath(args.path, "path", false, true);
		const mk = async (p: UserPath): Promise<"created" | "exists" | "parent_missing"> => {
			const r = await ctx.nc.dav.mkcol(davFilesPath(ctx.uid, p), undefined, { allow: [405, 409] });
			await r.body?.cancel();
			if (r.status === 405) return "exists";
			if (r.status === 409) return "parent_missing";
			return "created";
		};
		const done = async (created: number) => {
			const d = await statPath(ctx, path);
			if (d.type !== "folder") throw new ToolError("already_exists", "A file already has that name, so the folder can't be made.", { field: "path" });
			return {
				data: { folder: item(d), created: created > 0, created_folders: created },
				summary:
					created === 0
						? "The folder already exists."
						: created === 1
							? "Created the folder."
							: `Created the folder and ${created - 1} folder${created === 2 ? "" : "s"} above it.`,
			};
		};

		const first = await mk(path);
		if (first === "created") return done(1);
		if (first === "exists") return done(0);
		if (!args.create_parents) {
			throw new ToolError("parent_missing", "The folder above it doesn't exist.", { hint: "create_parents true creates it too.", field: "path" });
		}
		// Find the deepest folder that exists, then create the missing ones from the top down.
		const segs = segmentsOf(path);
		const missing: UserPath[] = [path];
		let probe = parentOf(path);
		while (probe !== "/") {
			const d = await statOrNull(ctx, probe);
			if (d) {
				if (d.type !== "folder") throw new ToolError("invalid_input", "A part of that path is a file, so no folder can be made inside it.", { field: "path" });
				break;
			}
			missing.unshift(probe);
			if (missing.length > MAX_NEW_LEVELS) {
				throw new ToolError("invalid_input", `That would create more than ${MAX_NEW_LEVELS} new folders at once (the path has ${segs.length} levels).`, {
					field: "path",
					hint: "Create the upper folders first.",
				});
			}
			probe = parentOf(probe);
		}
		// The parents made here are new names this tool chooses, so they follow the new-name rule too
		// (checkName: no space at either end), not only the existing-item rule every path segment
		// passed (DESIGN 29.10). Checked for all of them before the first MKCOL, so nothing is half made.
		for (const p of missing) {
			try {
				checkName(basenameOf(p), "path");
			} catch (e) {
				if (!isToolError(e)) throw e;
				throw new ToolError("invalid_input", "A folder above it doesn't exist yet, and its name can't be used for a new folder: new names can't start or end with a space. Nothing was created.", {
					field: "path",
					hint: "Remove the spaces at the ends of that folder's name, or create it first in NoDrive.",
				});
			}
		}
		let created = 0;
		for (const p of missing) {
			const r = await mk(p);
			if (r === "created") created++;
			else if (r === "parent_missing") throw new ToolError("parent_missing", "A folder above it couldn't be made.", { hint: "Try again in a minute." });
		}
		return done(created);
	},
});
