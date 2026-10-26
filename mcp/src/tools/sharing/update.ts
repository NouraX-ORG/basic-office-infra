/**
 * sharing_update (DESIGN 11.3): GET /shares/{id} to check that the person made it, then PUT only
 * the fields that change. Links always keep an expiry date, MAX_LINK_DAYS away at most; passwords,
 * labels and the hidden download button belong to links only. An empty update is refused locally.
 * On a share with people, can_delete or can_reshare without permission set or clear only that
 * right and keep every other bit (fix round 3): a share made in the web page may hold access our
 * levels don't name, and building it again from a level would add or drop rights nobody asked for.
 * The undo puts every changed field back. It is left out (with a warning) when it couldn't be
 * exact or couldn't run: a password change (the old one can't be known), an access level our
 * tools can't express, or an earlier value this tool would refuse or change (a link that had no
 * expiry date or one beyond the link limit, a label or note longer than our input allows or with
 * characters our clean-up would change). sharing_delete follows the same rule (fix round 2).
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import { Undo } from "../../core/shapes";
import { defineTool } from "../../core/tool";
import { cleanText } from "../../pim/vcard";
import {
	accessOf,
	BIT,
	checkExpiry,
	dateOnly,
	expiryRestorable,
	getShare,
	isLinkLike,
	linkBits,
	PEOPLE_MAX_DAYS,
	type PeopleChange,
	peopleTarget,
	type RawShare,
	requireMine,
	SHARES,
	ShareOut,
	shareError,
	shareIdArg,
	shareIdOf,
	shareView,
	textRestorable,
} from "./shares";

const input = z
	.object({
		share_id: shareIdArg(),
		permission: z.enum(["view", "edit", "upload_only"]).optional().describe('"upload_only" is for folder links.'),
		can_delete: z.boolean().optional().describe("Shares with people: may delete in the folder."),
		can_reshare: z.boolean().optional().describe("Shares with people: may share it on."),
		expires_on: z.string().max(10).nullable().optional().describe("Last day, YYYY-MM-DD; null removes it (not for links)."),
		password: z.string().min(12).max(200).nullable().optional().describe("Links: new password; null removes it."),
		hide_download: z.boolean().optional().describe("Links: true hides the download button."),
		label: z.string().max(LIMITS.shareLabelChars).optional().describe("Links: short name."),
		note: z.string().max(LIMITS.shareNoteChars).optional().describe("Note for the people it is shared with."),
	})
	.strict();

/**
 * The shape of structuredContent. Not published as outputSchema: tools/list must stay small (60 KB
 * for every tool together); the same JSON is in the framed text block, and the tests hold every
 * result to this schema.
 */
export const sharingUpdateOutput = z.object({
	share: ShareOut,
	changed: z.array(z.string()),
	undo: Undo.optional(),
	warnings: z.array(z.string()).optional(),
});

function linkOnly(field: string): never {
	throw new ToolError("invalid_input", `${field} applies only to links.`, { field });
}

function peopleOnly(field: string): never {
	throw new ToolError("invalid_input", `${field} applies only to shares with people, groups and teams, not to links.`, { field });
}

export const sharingUpdate = defineTool({
	name: "sharing_update",
	title: "Change a share",
	description:
		"Changes one of the person's own shares: access, expiry date, password, the hidden download button, label or note. Only the fields given change; can_delete or can_reshare alone change only that right. Links always keep an expiry date within the workspace's link limit (90 days unless changed; workspace_overview shows it). Shares made by other people can't be changed.",
	input,
	async run(ctx, args) {
		const id = shareIdOf(args.share_id);
		const raw = await getShare(ctx, id);
		requireMine(ctx, raw);
		const link = isLinkLike(raw);
		const folder = raw.item_type === "folder";
		const now = accessOf(raw);
		const body: Record<string, unknown> = {};
		const undoArgs: Record<string, unknown> = { share_id: id };
		const changed: string[] = [];
		const warnings: string[] = [];
		let exactUndo = true;

		// Access
		if (args.permission !== undefined || args.can_delete !== undefined || args.can_reshare !== undefined) {
			let bits: number;
			if (link) {
				if (args.can_delete !== undefined) peopleOnly("can_delete");
				if (args.can_reshare !== undefined) peopleOnly("can_reshare");
				const p = args.permission ?? (now.permission === "view_and_upload" ? "view" : now.permission);
				if (p === "upload_only" && !folder) throw new ToolError("invalid_input", "upload_only works only for folder links.", { field: "permission" });
				bits = linkBits(p, folder);
			} else {
				if (args.permission === "upload_only") throw new ToolError("invalid_input", "upload_only is only for folder links.", { field: "permission" });
				if (args.can_delete && !folder) warnings.push("can_delete applies only to folders; a single file can't be deleted through a share.");
				// Only what is given changes (fix round 3): without permission the current bits are kept
				// exactly and only the flags given are set or cleared (peopleTarget).
				bits = peopleTarget(raw.permissions, { permission: args.permission, can_delete: args.can_delete, can_reshare: args.can_reshare }, folder);
			}
			const current = link ? raw.permissions & ~BIT.share : raw.permissions;
			if (bits !== current) {
				body.permissions = bits;
				changed.push("permission");
				// The undo is exact only when running it on the new bits gives back the very same old
				// bits (a share made elsewhere can hold, say, read and create without update).
				if (link) {
					const back = now.permission === "view_and_upload" ? "view" : now.permission;
					undoArgs.permission = back;
					if (now.permission === "view_and_upload" || (back === "upload_only" && !folder) || linkBits(back, folder) !== current) exactUndo = false;
				} else {
					// With a level given, the undo names the old level and both flags; with only flags
					// given, it sets just those flags back and the bits it doesn't name stay as they are.
					const back: PeopleChange = {};
					if (args.permission !== undefined) {
						back.permission = now.permission === "edit" ? "edit" : "view";
						back.can_delete = now.can_delete;
						back.can_reshare = now.can_reshare;
					} else {
						if (args.can_delete !== undefined) back.can_delete = now.can_delete;
						if (args.can_reshare !== undefined) back.can_reshare = now.can_reshare;
					}
					Object.assign(undoArgs, back);
					if (peopleTarget(bits, back, folder) !== current) exactUndo = false;
				}
			}
		}

		// Expiry. The undo sets the earlier date again, so it is exact only when this tool would
		// accept that date now: never "no date" on a link, never a past date or one beyond the limit.
		if (args.expires_on !== undefined) {
			const before = dateOnly(raw.expiration);
			let change = false;
			if (args.expires_on === null) {
				if (link) throw new ToolError("invalid_input", "Links always keep an expiry date; give a new date instead.", { field: "expires_on" });
				if (before !== null) {
					body.expireDate = "";
					change = true;
				}
			} else {
				const d = checkExpiry(ctx, args.expires_on, "expires_on", link ? ctx.cfg.maxLinkDays : PEOPLE_MAX_DAYS).date;
				if (d !== before) {
					body.expireDate = d;
					change = true;
				}
			}
			if (change) {
				changed.push("expires_on");
				undoArgs.expires_on = before;
				if (!expiryRestorable(ctx, before, link)) exactUndo = false;
			}
		}

		// Link-only fields
		if (args.password !== undefined) {
			if (!link) linkOnly("password");
			if (args.password === null && !raw.password) {
				// Nothing to remove.
			} else {
				body.password = args.password ?? "";
				changed.push("password");
				exactUndo = false;
				warnings.push(args.password === null ? "The link no longer needs a password." : "The old password stops working now.");
			}
		}
		if (args.hide_download !== undefined) {
			if (!link) linkOnly("hide_download");
			const was = raw.hide_download === 1 || raw.hide_download === true;
			if (was !== args.hide_download) {
				body.hideDownload = args.hide_download ? "true" : "false";
				changed.push("hide_download");
				undoArgs.hide_download = was;
			}
		}
		if (args.label !== undefined) {
			if (!link) linkOnly("label");
			const l = cleanText(args.label);
			if (l !== (raw.label ?? "")) {
				body.label = l;
				changed.push("label");
				undoArgs.label = raw.label ?? "";
				// The undo goes through the same clean-up: a label made elsewhere with, say, a line
				// break or outer spaces would come back changed.
				if (!textRestorable(raw.label ?? "", LIMITS.shareLabelChars, false)) exactUndo = false;
			}
		}
		if (args.note !== undefined) {
			const n = cleanText(args.note, true);
			if (n !== (raw.note ?? "")) {
				body.note = n;
				changed.push("note");
				undoArgs.note = raw.note ?? "";
				if (!textRestorable(raw.note ?? "", LIMITS.shareNoteChars, true)) exactUndo = false;
			}
		}

		const given = ["permission", "can_delete", "can_reshare", "expires_on", "password", "hide_download", "label", "note"].filter((k) => (args as Record<string, unknown>)[k] !== undefined);
		if (given.length === 0) throw new ToolError("invalid_input", "Nothing to change: give at least one field to change.");
		if (changed.length === 0) {
			throw new ToolError("invalid_input", `Nothing to change: the share already has those values.${warnings.length ? ` ${warnings.join(" ")}` : ""}`);
		}
		// An undo must pass this tool's own input check (a label or note made elsewhere may be longer).
		if (exactUndo && !input.safeParse(undoArgs).success) exactUndo = false;

		let updated: RawShare;
		try {
			// Error texts are not framed, so they name the share, never its (people-written) path.
			updated = await ctx.nc.ocs.put<RawShare>(`${SHARES}/${id}`, body, { what: "the shared item" });
		} catch (e) {
			throw shareError(e, "the shared item", { shareId: id });
		}
		if (!exactUndo) warnings.push("This change can't be undone automatically.");
		return {
			data: { share: shareView(ctx, updated), changed },
			summary: `Changed ${changed.join(", ")} on share ${id}.`,
			undo: exactUndo ? { tool: "sharing_update", arguments: undoArgs } : null,
			warnings,
		};
	},
});
