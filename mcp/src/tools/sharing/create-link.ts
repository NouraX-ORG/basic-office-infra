/**
 * sharing_create_link (DESIGN 11.3): POST /shares with shareType 3.
 * - Least privilege: view 1; edit 3 for a file, 7 for a folder (read, update, create, never
 *   delete); upload_only 4, folders only.
 * - expireDate is always sent as YYYY-MM-DD (the server has no default): 30 days unless given,
 *   MAX_LINK_DAYS at most (90 unless the owner changed it; workspace_overview shows it).
 * - hide_download can't be set at creation, so a PUT follows; if that fails the new link is
 *   stopped again (our own just-made link), so no link exists that shows more than was asked.
 *
 * Repeated calls (DESIGN 10.7; changed in lane B's fix round 1). Core's duplicate guard stores a
 * whole result for 10 minutes and replays it. For this tool that kept a generated password in the
 * vault and showed it again, and it handed back links that had been stopped in between. So this
 * tool turns that guard off for itself (the ToolDef at the bottom) and looks at the live shares
 * instead: a call without a password, made within 10 minutes of a link with exactly the same
 * settings on the same item, returns that link (reused: true) when it still exists. A stopped link
 * is never handed out again. A link with a password is never matched: a generated password is
 * shown once and kept nowhere, and a given one can't be compared (the server only says
 * "redacted"). allow_duplicate always makes a new link.
 */
import { z } from "zod";
import { isToolError, ToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import { normalizePath } from "../../core/paths";
import { allowDuplicateArg, type FileItem, pathArg, Undo } from "../../core/shapes";
import { defineTool, type ToolCtx, type ToolDef } from "../../core/tool";
import { cleanText } from "../../pim/vcard";
import { BIT, checkExpiry, dateArg, dateOnly, expiryInDays, generatePassword, linkBits, type RawShare, SHARES, shareError, shareView, TYPE } from "./shares";

/** The highest MAX_LINK_DAYS that src/env.ts accepts; the real limit is checked at run time. */
const LINK_DAYS_CEILING = 365;
/** How far the server's clock may run ahead of ours when a share time is compared. */
const CLOCK_SKEW_SEC = 120;

const input = z
	.object({
		path: pathArg("File or folder, e.g. \"/Projects/Plan.docx\"."),
		permission: z
			.enum(["view", "edit", "upload_only"])
			.default("view")
			.describe('"edit" changes and adds, never deletes; "upload_only" is for folders.'),
		expires_in_days: z
			.number()
			.int()
			.min(1)
			.max(LINK_DAYS_CEILING)
			.optional()
			.describe("Days it works (default 30; at most the workspace's link limit, 90 unless changed)."),
		expires_on: dateArg("Last day it works, YYYY-MM-DD.").optional(),
		password: z.string().min(12).max(200).optional().describe("Password to open the link."),
		generate_password: z.boolean().default(false).describe("true makes a strong password, shown only in this result."),
		hide_download: z.boolean().default(false).describe("true hides the download button."),
		label: z.string().max(LIMITS.shareLabelChars).optional().describe("Short name for the link."),
		allow_duplicate: allowDuplicateArg(),
	})
	.strict();

/**
 * The shape of structuredContent. Not published as outputSchema: tools/list must stay small (60 KB
 * for every tool together); the same JSON is in the framed text block, and the tests hold every
 * result to this schema.
 */
export const sharingCreateLinkOutput = z.object({
	share_id: z.string(),
	url: z.string().nullable(),
	path: z.string(),
	type: z.enum(["file", "folder"]),
	permission: z.enum(["view", "edit", "upload_only", "view_and_upload"]),
	expires_on: z.string().nullable(),
	password_protected: z.boolean(),
	generated_password: z.string().nullable(),
	hide_download: z.boolean(),
	label: z.string().nullable(),
	web_url: z.string().nullable(),
	/** true when an identical link made in the last 10 minutes was returned instead of a new one. */
	reused: z.boolean(),
	undo: Undo.optional(),
	warnings: z.array(z.string()).optional(),
});

interface Wanted {
	permissions: number;
	expires: string;
	label: string;
	hideDownload: boolean;
}

/**
 * The newest link this person made to `path` in the last 10 minutes with exactly these settings
 * and no password, or null. One GET of the item's shares; a failed look-up never blocks making the
 * link, but a dead credential, a limit or the time limit still stops the call.
 */
async function recentSameLink(ctx: ToolCtx, path: string, want: Wanted): Promise<RawShare | null> {
	let data: unknown;
	try {
		data = await ctx.nc.ocs.get<unknown>(SHARES, { path }, { what: path });
	} catch (e) {
		if (!isToolError(e) || e.deadCredential || e.code === "reconnect_required" || e.code === "rate_limited" || e.code === "timeout") throw e;
		ctx.log.note("link_repeat_check_failed");
		return null;
	}
	if (!Array.isArray(data)) return null;
	const nowSec = Math.floor(Date.now() / 1000);
	let best: RawShare | null = null;
	for (const r of data as RawShare[]) {
		if (!r || typeof r !== "object") continue;
		if (r.share_type !== TYPE.link || r.uid_owner !== ctx.uid) continue;
		// The server sends "redacted" for a link with a password and null for one without.
		if (r.password) continue;
		if (typeof r.permissions !== "number" || (r.permissions & ~BIT.share) !== want.permissions) continue;
		if (dateOnly(r.expiration) !== want.expires) continue;
		if ((r.label ?? "") !== want.label) continue;
		if ((r.hide_download === 1 || r.hide_download === true) !== want.hideDownload) continue;
		if (typeof r.stime !== "number" || nowSec - r.stime > LIMITS.dedupeSec || r.stime - nowSec > CLOCK_SKEW_SEC) continue;
		// The newest one; share times have whole seconds, so a higher id breaks a tie.
		const bt = best?.stime ?? 0;
		if (!best || r.stime > bt || (r.stime === bt && Number(r.id) > Number(best.id))) best = r;
	}
	return best;
}

function ago(stime: number | undefined): string {
	const sec = Math.floor(Date.now() / 1000) - (stime ?? 0);
	if (sec < 60) return "less than a minute ago";
	const mins = Math.round(sec / 60);
	return `${mins} minute${mins === 1 ? "" : "s"} ago`;
}

function linkData(
	view: ReturnType<typeof shareView>,
	path: string,
	item: Pick<FileItem, "type" | "web_url">,
	expires: string,
	passwordProtected: boolean,
	generated: string | null,
	reused: boolean,
) {
	return {
		share_id: view.share_id,
		url: view.url,
		path,
		type: item.type,
		permission: view.permission,
		expires_on: view.expires_on ?? expires,
		password_protected: passwordProtected,
		generated_password: generated,
		hide_download: view.hide_download,
		label: view.label,
		web_url: item.web_url,
		reused,
	};
}

function accessWarnings(permission: "view" | "edit" | "upload_only", folder: boolean, url: string | null): string[] {
	const warnings: string[] = [];
	if (permission === "edit") warnings.push(folder ? "Anyone with this link can change and add files in this folder." : "Anyone with this link can change this file.");
	if (permission === "upload_only") warnings.push("Anyone with this link can upload files into this folder.");
	if (!url) warnings.push("NoDrive didn't return the link's address; sharing_list shows it.");
	return warnings;
}

const tool = defineTool({
	name: "sharing_create_link",
	title: "Create a share link",
	description:
		"Creates a public link to a NoDrive file or folder: anyone who has the link can open it. It expires after 30 days unless another expiry is given, within the workspace's link limit (90 days unless changed). Access is view (default), edit (without deleting) or upload_only for folders. A password can be given or generated (shown only once), and the download button hidden. The same call without a password within 10 minutes returns the link made then.",
	input,
	async run(ctx, args) {
		const path = normalizePath(args.path, { allowRoot: false });
		const maxDays = ctx.cfg.maxLinkDays;
		if (args.expires_in_days !== undefined && args.expires_on !== undefined) {
			throw new ToolError("invalid_input", "Give expires_in_days or expires_on, not both.", { field: "expires_on" });
		}
		if (args.password !== undefined && args.generate_password) {
			throw new ToolError("invalid_input", "Give password or generate_password, not both.", { field: "password" });
		}
		let expires: string;
		if (args.expires_on !== undefined) expires = checkExpiry(ctx, args.expires_on, "expires_on", maxDays).date;
		else {
			const days = args.expires_in_days ?? Math.min(LIMITS.linkDaysDefault, maxDays);
			if (days > maxDays) throw new ToolError("invalid_input", `expires_in_days can be ${maxDays} at most here (the workspace's link limit).`, { field: "expires_in_days" });
			expires = expiryInDays(ctx, days);
		}
		const label = args.label !== undefined ? cleanText(args.label) : "";

		const item = await ctx.nc.files.stat(path);
		if (!item.permissions.can_share) {
			throw new ToolError("permission_denied", `The person isn't allowed to share ${path}.`, { hint: "The owner of a shared item decides whether it can be shared on." });
		}
		const folder = item.type === "folder";
		if (args.permission === "upload_only" && !folder) {
			throw new ToolError("invalid_input", "upload_only works only for folders; use view or edit for a file.", { field: "permission" });
		}
		const permissions = linkBits(args.permission, folder);

		// A repeat of a call without a password returns the link it made, if that link still exists.
		if (args.password === undefined && !args.generate_password && !args.allow_duplicate) {
			const prior = await recentSameLink(ctx, path, { permissions, expires, label, hideDownload: args.hide_download });
			if (prior) {
				ctx.log.note("link_reused");
				const view = shareView(ctx, prior);
				return {
					data: linkData(view, path, item, expires, false, null, true),
					summary: `This matches a link to ${path} made ${ago(prior.stime)} with the same settings; that link is returned and no new one was made. allow_duplicate makes a second one.`,
					undo: { tool: "sharing_delete", arguments: { share_id: view.share_id } },
					warnings: accessWarnings(args.permission, folder, view.url),
				};
			}
		}

		const generated = args.generate_password ? generatePassword() : null;
		const password = args.password ?? generated ?? undefined;
		const body: Record<string, unknown> = { path, shareType: TYPE.link, permissions, expireDate: expires, sendMail: "false" };
		if (password !== undefined) body.password = password;
		if (label) body.label = label;
		let raw: RawShare;
		try {
			raw = await ctx.nc.ocs.post<RawShare>(SHARES, body, { what: path });
		} catch (e) {
			throw shareError(e, path, { passwordHint: "generate_password makes one that fits." });
		}
		const id = String(raw.id);
		if (args.hide_download) {
			try {
				raw = await ctx.nc.ocs.put<RawShare>(`${SHARES}/${id}`, { hideDownload: "true" }, { what: path });
			} catch (e) {
				if (isToolError(e) && e.deadCredential) throw e;
				try {
					await ctx.nc.ocs.delete(`${SHARES}/${id}`);
				} catch {
					throw new ToolError(
						"upstream_unavailable",
						`The link to ${path} was made, but the download button couldn't be hidden and the link couldn't be stopped. sharing_delete with share_id ${id} stops it.`,
						// The outcome is known: the link exists. Trying again would make a second one.
						{ retryable: false },
					);
				}
				ctx.log.note("link_rolled_back");
				// The outcome is known (the new link was stopped again), so "try again" holds.
				throw new ToolError("upstream_unavailable", "The link wasn't made: hiding the download button failed, so the new link was stopped again. Try again in a minute.", { retryable: true });
			}
		}
		const view = shareView(ctx, raw);
		const warnings = accessWarnings(args.permission, folder, view.url);
		if (generated) warnings.push("The generated password is shown only in this result; it can't be read again later.");
		return {
			data: linkData(view, path, item, expires, password !== undefined || view.password_protected, generated, false),
			summary: `Made a ${args.permission === "view" ? "view" : args.permission === "edit" ? "edit" : "upload"} link to ${path} that works until ${view.expires_on ?? expires}.`,
			undo: { tool: "sharing_delete", arguments: { share_id: view.share_id } },
			warnings,
		};
	},
});

/**
 * Core's stored-result duplicate guard (src/mcp/register.ts) runs for every tool whose entry has
 * dedupe. This tool does its own check against the live shares (above), so the guard is off for
 * it: nothing of its result, a generated password least of all, is kept in the vault. Asked of
 * core in lane B's fix-round-1 result: dedupe off for sharing_create_link in src/mcp/catalog.ts,
 * test/core/catalog.test.ts and DESIGN 10.7; this line then changes nothing.
 */
export const sharingCreateLink: ToolDef = { ...tool, entry: { ...tool.entry, dedupe: false } };
