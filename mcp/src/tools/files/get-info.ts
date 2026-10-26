/**
 * files_get_info (DESIGN 11.2): PROPFIND Depth 0. shared_with_me comes from nc:mount-type "shared"
 * and in_team_folder from "group" (common.ts): removing an item in a team folder removes it for the
 * whole team, so an assistant can tell that before it asks.
 */
import { z } from "zod";
import { FileItem, pathArg, Permissions } from "../../core/shapes";
import { item, statPath, toUserPath } from "./common";
import { filesTool } from "./define";

const output = z.object({
	...FileItem.shape,
	created: z.string().nullable(),
	owner: z.object({ user_id: z.string().nullable(), display_name: z.string().nullable() }),
	permissions: Permissions,
	share_types: z.array(z.string()),
	shared_with_me: z.boolean(),
	in_team_folder: z.boolean(),
	has_preview: z.boolean(),
});

export const filesGetInfo = filesTool({
	name: "files_get_info",
	title: "File details",
	description:
		"Gets the details of one NoDrive file or folder: type, size, created and last changed, etag (files_overwrite_file needs it), file id, owner, what the person may do with it (edit, delete, rename, share), whether it is a favourite, shared or in a team folder, and a link to open it.",
	input: z.object({ path: pathArg('The file or folder, such as "/Projects/Plan.docx".') }).strict(),
	output,
	async run(ctx, args) {
		const path = toUserPath(args.path);
		const d = await statPath(ctx, path);
		const data = {
			...item(d),
			created: d.created,
			owner: d.owner,
			permissions: d.permissions,
			share_types: d.share_types,
			shared_with_me: d.shared_with_me,
			in_team_folder: d.mount === "team",
			has_preview: d.has_preview,
		};
		// The path is in the data; the summary doesn't repeat it (common.ts, at the top).
		return { data, summary: path === "/" ? "Details of the top folder." : `Details of the ${d.type}.` };
	},
});
