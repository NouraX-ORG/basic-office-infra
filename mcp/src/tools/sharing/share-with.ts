/**
 * sharing_share_with (DESIGN 11.3): POST /shares with shareType 0, 1 or 7.
 * The recipient is re-checked first with a fresh sharees search as this person and must come back
 * as an exact id match: creating a share only checks that the account or group exists, not that
 * the sharer may see it. Permissions: view 1; edit 3 for a file or 7 for a folder; +8 can_delete
 * (folders only), +16 can_reshare. sendMail is "false".
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { parseTypedId, typedIdSchema } from "../../core/ids";
import { LIMITS } from "../../core/limits";
import { normalizePath } from "../../core/paths";
import { pathArg, Undo } from "../../core/shapes";
import { defineTool } from "../../core/tool";
import { cleanText } from "../../pim/vcard";
import { classify } from "./people";
import { checkExpiry, dateArg, PEOPLE_MAX_DAYS, peopleBits, type RawShare, SHARES, sameRecipient, shareError, sharesOn, shareView, TYPE } from "./shares";

const input = z
	.object({
		path: pathArg("File or folder to share."),
		share_with: typedIdSchema.describe('Id from sharing_find_people, e.g. "person:…".'),
		permission: z.enum(["view", "edit"]).default("view").describe('"edit" also adds files to a folder.'),
		can_delete: z.boolean().default(false).describe("true lets them delete in the folder."),
		can_reshare: z.boolean().default(false).describe("true lets them share it on."),
		expires_on: dateArg("Last day of access, YYYY-MM-DD.").optional(),
		note: z.string().max(LIMITS.shareNoteChars).optional().describe("Note shown to them."),
	})
	.strict();

/**
 * The shape of structuredContent. Not published as outputSchema: tools/list must stay small (60 KB
 * for every tool together); the same JSON is in the framed text block, and the tests hold every
 * result to this schema.
 */
export const sharingShareWithOutput = z.object({
	share_id: z.string(),
	path: z.string(),
	type: z.enum(["file", "folder"]),
	shared_with: z.object({ id: z.string(), kind: z.enum(["person", "group", "team"]), display_name: z.string().nullable() }),
	permission: z.enum(["view", "edit", "upload_only", "view_and_upload"]),
	can_delete: z.boolean(),
	can_reshare: z.boolean(),
	expires_on: z.string().nullable(),
	web_url: z.string().nullable(),
	undo: Undo.optional(),
	warnings: z.array(z.string()).optional(),
});

export const sharingShareWith = defineTool({
	name: "sharing_share_with",
	title: "Share with someone",
	description:
		"Shares a NoDrive file or folder with a person, group or team in Nourax Workspace, using an id from sharing_find_people. Access is view (default) or edit; deleting and resharing stay off unless asked for. An expiry date and a note are optional. No email is sent; they see it in NoDrive. Public links are made with sharing_create_link.",
	input,
	async run(ctx, args) {
		const path = normalizePath(args.path, { allowRoot: false });
		const target = parseTypedId(args.share_with, ["person", "group", "team"], "share_with");
		if (target.kind === "person" && target.id === ctx.uid) throw new ToolError("invalid_input", "That is the person themself; share with someone else.", { field: "share_with" });
		const expires = args.expires_on !== undefined ? checkExpiry(ctx, args.expires_on, "expires_on", PEOPLE_MAX_DAYS).date : null;
		const note = args.note !== undefined ? cleanText(args.note, true) : undefined;

		const item = await ctx.nc.files.stat(path);
		if (!item.permissions.can_share) {
			throw new ToolError("permission_denied", `The person isn't allowed to share ${path}.`, { hint: "The owner of a shared item decides whether it can be shared on." });
		}
		// A fresh search as this person: only someone they may see can be shared with.
		const verified = await ctx.nc.sharees.verify(args.share_with, ["person", "group", "team"]);
		if (!verified) {
			throw new ToolError(
				"not_found",
				`Nobody with the id ${args.share_with} can be shared with: only people and groups the workspace lets this person see can be, which with privacy between organisations on means their own organisation and teams. sharing_find_people lists them.`,
				{ field: "share_with" },
			);
		}
		const found = classify(verified);
		const folder = item.type === "folder";
		const warnings: string[] = [];
		const permissions = peopleBits(args.permission, args.can_delete, args.can_reshare, folder);
		if (args.can_delete && !folder) warnings.push("can_delete applies only to folders; a single file can't be deleted through a share.");
		const shareType = target.kind === "person" ? TYPE.person : target.kind === "group" ? TYPE.group : TYPE.team;

		// NC 35 doesn't refuse an identical share: it hands back the existing one, unchanged
		// (Share20\Manager::createShare reuses it on AlreadySharedException). So look first, and say
		// so plainly; otherwise the result would show the old access and its undo would stop a share
		// made earlier.
		let before: RawShare[];
		try {
			before = await sharesOn(ctx, path);
		} catch (e) {
			throw shareError(e, path);
		}
		const same = sameRecipient(before, shareType, target.id);
		if (same) {
			const msg =
				same.uid_owner === ctx.uid
					? `${path} is already shared with them (share_id ${String(same.id)}). sharing_update changes that share.`
					: `They already have access to ${path} through a share someone else made (share_id ${String(same.id)}).`;
			throw new ToolError("already_exists", msg, { field: "share_with" });
		}

		const body: Record<string, unknown> = { path, shareType, shareWith: target.id, permissions, sendMail: "false" };
		if (expires) body.expireDate = expires;
		if (note) body.note = note;
		let raw: RawShare;
		try {
			raw = await ctx.nc.ocs.post<RawShare>(SHARES, body, { what: path });
		} catch (e) {
			throw shareError(e, path);
		}
		// A share made in between by someone else, or access they already have through someone's group
		// share, comes back as that share: nothing new was made. (Left: an identical share this same
		// person makes in the instant between the look-ahead and this call reads as new; its undo
		// would then stop that identical share.)
		if (before.some((s) => String(s.id) === String(raw.id)) || raw.share_type !== shareType || (raw.share_with ?? "") !== target.id || raw.uid_owner !== ctx.uid) {
			throw new ToolError("already_exists", `They already have access to ${path} through share ${String(raw.id)}; nothing new was made. sharing_list shows it.`, {
				field: "share_with",
			});
		}
		const view = shareView(ctx, raw);
		if (args.can_reshare) warnings.push("They can share this on with other people.");
		return {
			data: {
				share_id: view.share_id,
				path,
				type: item.type,
				shared_with: { id: found.id, kind: found.kind, display_name: view.shared_with?.display_name ?? found.display_name },
				permission: view.permission,
				can_delete: view.can_delete,
				can_reshare: view.can_reshare,
				expires_on: view.expires_on,
				web_url: item.web_url,
			},
			summary: `Shared ${path} (${view.permission}).`,
			undo: { tool: "sharing_delete", arguments: { share_id: view.share_id } },
			warnings,
		};
	},
});
