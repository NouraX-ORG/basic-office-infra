/**
 * Helpers shared by the document tools: extension checks, the macro-format refusal, writing a new
 * file (never replacing one), and the daily upload count.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { basenameOf, joinPath, normalizePath, numberedName, parentOf, splitExt, type UserPath } from "../../core/paths";
import type { ToolCtx } from "../../core/tool";
import type { FileItem } from "../../core/shapes";
import { toFileItem } from "../../nc/index";
import { guardExposure } from "../files/exposure";

/**
 * A new document in a folder shared by link is shared too: refused without the share scope, else
 * written with a warning (fix round 3, files/exposure.ts). Called before any heavy work.
 */
export async function checkTargetFolder(ctx: ToolCtx, path: UserPath, field = "path"): Promise<void> {
	await guardExposure(ctx, parentOf(path), { field, what: "new" });
}

const MACRO_EXTS = new Set(["docm", "dotm", "xlsm", "xltm", "xlsb", "pptm", "potm", "ppsm"]);

/**
 * The output schema of a tool that saves a file (docs_fill_template): the saved file (every
 * FileItem field is returned; path and web_url are the ones to use) and whether it was renamed,
 * plus `extra`. Loose objects, so the published JSON Schema stays small and never refuses the other
 * fields a result carries, such as warnings. The four simpler save tools (docs_create_*,
 * docs_convert) publish no output schema at all (fix round 1: the whole tools/list has a 60 KB
 * budget; recorded in DESIGN 12.7); their structuredContent still carries file, renamed and their
 * own fields, the Out shapes of DESIGN 11.4.
 */
export function savedOutput<S extends z.ZodRawShape>(extra?: S) {
	return z.looseObject({
		file: z.looseObject({ path: z.string(), web_url: z.string().nullable() }),
		renamed: z.boolean(),
		...(extra ?? {}),
	});
}

/** The extension of a path or name, lower case, without the dot ("" when there is none). */
export function extOf(path: string): string {
	return splitExt(path.slice(path.lastIndexOf("/") + 1)).ext.slice(1).toLowerCase();
}

/** Normalises a target path and checks it ends in `.ext` (macro formats are always refused). */
export function targetPath(raw: string, ext: string, field = "path"): UserPath {
	const p = normalizePath(raw, { field, allowRoot: false, newName: true });
	const got = extOf(basenameOf(p));
	if (MACRO_EXTS.has(got)) {
		throw new ToolError("invalid_input", `Files that can hold macros (.${got}) aren't made here. Use .${ext} instead.`, { field });
	}
	if (got !== ext) {
		throw new ToolError("invalid_input", `${field} must end in ".${ext}" (it ends in "${got ? `.${got}` : "no extension"}").`, { field, hint: `For example "${p.replace(/\.[^./]*$/, "")}.${ext}".` });
	}
	return p;
}

/**
 * Throws parent_missing when the folder a new file should go in isn't there (or is a file), in
 * words that name the folder, not the file (fix round 2: a missing folder read as if the file being
 * converted was missing). The root always exists.
 */
export async function folderMustExist(ctx: ToolCtx, folder: UserPath, field = "path"): Promise<void> {
	if (folder === "/") return;
	let item: { type: string };
	try {
		item = await ctx.nc.files.stat(folder);
	} catch (e) {
		if (e instanceof ToolError && e.code === "not_found") {
			throw new ToolError("parent_missing", `The folder ${folder} doesn't exist.`, { hint: "files_create_folder can make it.", field });
		}
		throw e;
	}
	if (item.type !== "folder") throw new ToolError("parent_missing", `${folder} is a file, not a folder, so nothing can be saved in it.`, { field });
}

/** The name and this many numbered copies ("Plan (2).pdf" ...) are tried under "rename". */
const NAMES = 20;

/** Whether something is at `path` now (a PROPFIND Depth 0, no body sent). */
async function nameTaken(ctx: ToolCtx, path: UserPath): Promise<boolean> {
	try {
		await ctx.nc.files.stat(path);
		return true;
	} catch (e) {
		if (e instanceof ToolError && e.code === "not_found") return false;
		throw e;
	}
}

/**
 * Writes a brand-new file (If-None-Match: *) and counts its bytes toward the daily upload cap. A
 * taken name gets the document tools' own hint (core's points to files_overwrite_file, which writes
 * text and can't replace an Office file), and a missing folder is said as such.
 *
 * Fix round 4: every PUT sends the whole file, even one NoDrive refuses with 412 because the name
 * is taken, and a converted PDF can be 25 MB. So each name is looked at first (PROPFIND Depth 0) and
 * the body goes only to a name that was free just before; each PUT sent counts toward the daily
 * upload cap, and a second one happens only when someone takes that name in between (as
 * files_create_file does).
 */
export async function writeNewFile(ctx: ToolCtx, path: UserPath, bytes: Uint8Array, mime: string, ifExists: "fail" | "rename", field = "path"): Promise<{ file: FileItem; path: UserPath; renamed: boolean }> {
	const parent = parentOf(path);
	const name = basenameOf(path);
	const taken = (target: UserPath) =>
		new ToolError("already_exists", `${target} already exists.`, { hint: `Use if_exists "rename", or another ${field}.`, field });
	for (let n = 1; n <= NAMES; n++) {
		const target = n === 1 ? path : joinPath(parent, numberedName(name, n));
		if (await nameTaken(ctx, target)) {
			if (ifExists === "fail") throw taken(target);
			continue;
		}
		await ctx.charge("heavy", 0, bytes.length);
		let r: Awaited<ReturnType<ToolCtx["nc"]["files"]["writeNew"]>>;
		try {
			r = await ctx.nc.files.writeNew(target, bytes, mime, "fail");
		} catch (e) {
			if (e instanceof ToolError && e.code === "already_exists") {
				// Someone took the name between the look and the PUT.
				if (ifExists === "fail") throw taken(target);
				continue;
			}
			// NoDrive answers a PUT into a missing folder with 404 (409 in plain WebDAV).
			if (e instanceof ToolError && (e.code === "not_found" || e.code === "parent_missing")) await folderMustExist(ctx, parent, field);
			throw e;
		}
		return { file: toFileItem(r.item), path: r.path, renamed: n > 1 };
	}
	throw new ToolError("already_exists", `${path} and ${NAMES - 1} numbered copies of it already exist.`, { hint: `Use another ${field}.`, field });
}

export function sizeText(n: number): string {
	if (n < 1024) return `${n} bytes`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A folder or a file other than what the tool needs gives a plain error. */
export function mustBeFile(item: { type: string; path: string }, field = "path"): void {
	if (item.type !== "file") throw new ToolError("invalid_input", `${item.path} is a folder, not a file.`, { field });
}

export function renamedNote(renamed: boolean, path: string): string {
	return renamed ? ` The name was taken, so it was saved as ${path}.` : "";
}

export { splitExt };
