/**
 * files_list_versions and files_restore_version (DESIGN 11.2). Never a DELETE of a version.
 *
 * Checked on the server (NC 35.0.2): the version list holds the current content too, with the
 * file's last-modified time (unix seconds) as its id; that entry is left out here. Restoring an older
 * version keeps the replaced content as a version whose id is the file's previous last-modified time,
 * which is the undo. The restore MOVE needs "Overwrite: T" (see common.ts).
 */
import { z } from "zod";
import { ToolError, isToolError } from "../../core/errors";
import { FileItem, pathArg, Undo } from "../../core/shapes";
import type { ToolCtx } from "../../core/tool";
import { type DavResponse, NS, propText, XMLNS } from "../../nc/index";
import { item, mtimeSec, nextCursor, offsetPage, perCall, statFile, statPath, toUserPath, versionIdArg, versionKept, versionRestoreTarget, versionsPath } from "./common";
import { filesTool } from "./define";

const VERSION_PROPS = `<?xml version="1.0" encoding="UTF-8"?><d:propfind ${XMLNS}><d:prop><d:getlastmodified/><d:getcontentlength/><d:getcontenttype/><nc:version-author/><nc:version-label/></d:prop></d:propfind>`;

const Version = z.object({
	version_id: z.string(),
	modified: z.string().nullable(),
	size: z.number(),
	author: z.string().nullable(),
	label: z.string().nullable(),
});
type Version = z.infer<typeof Version>;

function versionOf(r: DavResponse, fileId: number): Version | null {
	const segs = r.href.replace(/\/+$/, "").split("/");
	const id = segs[segs.length - 1] ?? "";
	const parent = segs[segs.length - 2] ?? "";
	if (!/^\d{1,20}$/.test(id) || parent !== String(fileId)) return null;
	const lm = propText(r, NS.d, "getlastmodified");
	const t = lm ? Date.parse(lm) : Number.NaN;
	const size = propText(r, NS.d, "getcontentlength");
	return {
		version_id: id,
		modified: Number.isFinite(t) ? new Date(t).toISOString() : null,
		size: size && /^\d+$/.test(size) ? Number(size) : 0,
		author: propText(r, NS.nc, "version-author"),
		label: propText(r, NS.nc, "version-label"),
	};
}

async function requireVersions(ctx: ToolCtx): Promise<void> {
	const caps = await ctx.nc.capabilities();
	if (!caps.versions) throw new ToolError("not_available", "Version history is switched off in NoDrive.");
}

export const filesListVersions = filesTool({
	name: "files_list_versions",
	title: "Version history",
	description:
		"Lists the earlier versions of a NoDrive file, newest first, with time, size, author and label; the current content is not one of them. version_id is what files_restore_version needs. Up to 100 per call, with next_cursor for older ones; total counts them all. Folders have no versions.",
	input: z.object({ path: pathArg("The file, such as \"/Reports/Q4.xlsx\"."), limit: perCall(100, 20), cursor: nextCursor() }).strict(),
	output: z.object({
		path: z.string(),
		current_modified: z.string().nullable(),
		versions: z.array(Version),
		total: z.number(),
		next_cursor: z.string().nullable(),
		has_more: z.boolean(),
	}),
	async run(ctx, args) {
		const path = toUserPath(args.path, "path", false);
		await requireVersions(ctx);
		const d = await statFile(ctx, path, "Folders have no version history.");
		if (d.file_id === null) throw new ToolError("upstream_unavailable", "NoDrive didn't return a file id.");
		const current = mtimeSec(d);
		const fileId = d.file_id;
		const rs = await ctx.nc.dav.propfind(versionsPath(ctx.uid, fileId), 1, VERSION_PROPS);
		const all = rs
			.map((r) => versionOf(r, fileId))
			.filter((v): v is Version => v !== null && v.version_id !== String(current))
			.sort((a, b) => Number(b.version_id) - Number(a.version_id));
		// Offset paging inside the result budget, so the oldest versions of a busy file can be reached
		// too (NoDrive's "auto" version rule can keep more than 100 of them for years).
		const total = all.length;
		const page = await offsetPage(ctx, all, args.limit, (versions) => ({ path, current_modified: d.modified, versions, total, next_cursor: "x".repeat(200), has_more: true }));
		const versions = page.items;
		return {
			data: { path, current_modified: d.modified, versions, total, next_cursor: page.next_cursor, has_more: page.has_more },
			// The file's path is in the data; the summary doesn't repeat it (common.ts, at the top).
			summary:
				total === 0
					? "The file has no earlier versions."
					: versions.length === 0
						? `The file has ${total} earlier version${total === 1 ? "" : "s"}; this cursor is past the end of the list.`
						: `Listed earlier versions ${page.offset + 1} to ${page.offset + versions.length} of ${total} of the file, newest first.`,
		};
	},
});

export const filesRestoreVersion = filesTool({
	name: "files_restore_version",
	title: "Restore a version",
	description:
		"Makes an earlier version of a NoDrive file the current one. The content it replaces is kept as a new version, so this can be undone with files_restore_version. version_id comes from files_list_versions.",
	input: z.object({ path: pathArg("The file, such as \"/Reports/Q4.xlsx\"."), version_id: versionIdArg() }).strict(),
	output: z.object({ file: FileItem, restored_version_id: z.string(), undo: Undo, warnings: z.array(z.string()).optional() }),
	async run(ctx, args) {
		const path = toUserPath(args.path, "path", false);
		await requireVersions(ctx);
		const d = await statFile(ctx, path, "Folders have no version history.");
		if (d.file_id === null) throw new ToolError("upstream_unavailable", "NoDrive didn't return a file id.");
		const current = mtimeSec(d);
		if (args.version_id === String(current)) throw new ToolError("invalid_input", "That version is already the current content.", { field: "version_id" });
		try {
			const res = await ctx.nc.dav.move(versionsPath(ctx.uid, d.file_id, args.version_id), versionRestoreTarget(ctx.uid), { overwrite: true });
			await res.body?.cancel();
		} catch (e) {
			if (isToolError(e) && e.code === "not_found") {
				throw new ToolError("not_found", "The file has no version with that version_id.", { hint: "files_list_versions lists them.", field: "version_id" });
			}
			throw e;
		}
		const after = await statPath(ctx, path);
		const kept = await versionKept(ctx, after.file_id, current);
		const undo = kept ? { tool: "files_restore_version", arguments: { path, version_id: String(current) } } : null;
		const warnings = kept ? undefined : ["NoDrive didn't keep the replaced content as a version this time, so this can't be undone."];
		return {
			data: { file: item(after), restored_version_id: args.version_id, undo, ...(warnings ? { warnings } : {}) },
			summary: `Restored an earlier version of the file.${kept ? " The replaced content is kept as a version." : ""}`,
		};
	},
});
