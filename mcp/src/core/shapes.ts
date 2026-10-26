/**
 * Shared shapes (DESIGN 11.0). Lanes build their input and output schemas from these, so every
 * tool describes files, people, undo hints and paging the same way.
 */
import { z } from "zod";
import { LIMITS } from "./limits";

/** A NoDrive path argument. The tool normalises it with normalizePath() before use. */
export const pathArg = (description = 'A path in the person\'s NoDrive, starting with "/", for example "/Projects/Plan.docx".') =>
	z.string().min(1).max(1024).describe(description);

export const limitArg = (max: number, dflt: number) =>
	z.number().int().min(1).max(max).default(dflt).describe(`How many to return, 1 to ${max} (default ${dflt}).`);

export const cursorArg = () => z.string().max(4096).optional().describe("next_cursor from the previous call, to continue the list.");

export const allowDuplicateArg = () =>
	z.boolean().default(false).describe("true makes a second identical item even if the same call was made in the last 10 minutes.");

export const ifExistsArg = (dflt: "fail" | "rename" = "fail") =>
	z.enum(["fail", "rename"]).default(dflt).describe('What to do when the name is taken: "fail" stops, "rename" adds a number.');

export const FileItem = z.object({
	path: z.string(),
	name: z.string(),
	type: z.enum(["file", "folder"]),
	mime: z.string().nullable(),
	size: z.number(),
	modified: z.string().nullable(),
	etag: z.string().nullable(),
	file_id: z.number().nullable(),
	favorite: z.boolean(),
	shared: z.boolean(),
	web_url: z.string().nullable(),
});
export type FileItem = z.infer<typeof FileItem>;

export const Permissions = z.object({
	can_edit: z.boolean(),
	can_delete: z.boolean(),
	can_rename: z.boolean(),
	can_share: z.boolean(),
	can_create_inside: z.boolean(),
});
export type Permissions = z.infer<typeof Permissions>;

export const Person = z.object({ id: z.string(), display_name: z.string().nullable() });
export type Person = z.infer<typeof Person>;

export const Undo = z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()) }).nullable();
export type Undo = z.infer<typeof Undo>;

export const Paging = { next_cursor: z.string().nullable(), has_more: z.boolean() };

export const Warnings = z.array(z.string()).optional();

/** The default list cap per tool family. */
export const LIST_DEFAULTS = { max: LIMITS.listMax };

/** Maps oc:permissions letters to plain flags (G read, W write, C/K create, D delete, N rename, V move, R share). */
export function permissionsFrom(letters: string | null | undefined, isFolder: boolean): Permissions {
	const p = letters ?? "";
	return {
		can_edit: isFolder ? p.includes("C") || p.includes("K") : p.includes("W"),
		can_delete: p.includes("D"),
		can_rename: p.includes("N"),
		can_share: p.includes("R"),
		can_create_inside: isFolder && (p.includes("C") || p.includes("K")),
	};
}
