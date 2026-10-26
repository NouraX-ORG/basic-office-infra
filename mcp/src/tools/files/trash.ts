/**
 * files_move_to_trash, files_list_trash and files_restore_from_trash (DESIGN 11.2). The only DELETE
 * is on a NoDrive item while the trash is on, and there is never a DELETE under /trashbin/ (the
 * egress allowlist refuses it too). The one step that can't be undone, ending a share made to the
 * person alone, needs end_share true (below).
 *
 * Facts read in the installed source and checked live (NC 35.0.2, 2026-10-25):
 * - a trash item's name is "<name>.d<deletion time>"; nc:trashbin-original-location is the old path
 *   without its leading "/"; oc:fileid stays the same through trash and restore;
 * - restoring when the name is taken again gives "name (restored).ext" (in the person's language);
 *   when the old folder is gone it lands in the top folder;
 * - the restore MOVE needs "Overwrite: T" (see common.ts);
 * - how long the trash keeps things: trashbin_retention_obligation isn't set, so "auto" applies
 *   (Expiration::parseRetentionObligation): nothing expires by age, but once the trash takes more
 *   than half of a person's free quota, Trashbin::deleteFiles empties the oldest items at any age.
 *   So the texts say "usually 30 days or more", never a promise;
 * - removing the top item of a share someone else made ends only the person's access; the owner
 *   keeps the item (SharedStorage::unshareStorage calls deleteFromSelf for every share on that
 *   mount). Nothing reaches the person's DAV trash (source and live checks), so the trash isn't
 *   looked at for it: any entry there with the same old place is another, older item. What happens
 *   to each share depends on its type, read first from GET shares?shared_with_me=true&path=
 *   (ShareAPIController::getSharedWithMe):
 *   - group, team, room and Deck shares get a per-person row with permissions 0, which the person's
 *     "Deleted shares" in NoDrive lists and can restore (DeletedShareAPIController::index);
 *   - a share made to the person alone (type 0) is deleted for good (DefaultShareProvider::
 *     deleteFromSelf, "We can just delete user and link shares"; checked live: the owner's share id
 *     answers 404 and Deleted shares doesn't list it). Only the owner can share it again, so this
 *     is refused unless end_share is true. The same when the type can't be read, and when a person
 *     share sits next to a group-like one ("mixed"): restoring the group-like one brings back only
 *     that share's rights, which can be fewer;
 * - removing an item inside a folder someone else shared removes it for everyone who has that
 *   folder: Trashbin::move2trash moves the owner's original into the owner's own trash, and
 *   copyFilesToUser adds a copy to the person's trash (with a new file id, and only when the person
 *   has the space). The copy is found as the newest trash entry with that old place that wasn't
 *   there before the DELETE. Restoring it puts the item back into the shared folder;
 * - when the move to the trash fails, NoDrive deletes the item outright (files_trashbin Storage::
 *   doDelete falls back to the plain unlink or rmdir when Trashbin::move2trash returns false, for
 *   example over trashbin_size or on a MoveToTrashEvent veto). So the result tells three cases apart:
 *   the trash shows the item, the trash was read and doesn't have it (it may be gone for good), and
 *   the trash couldn't be read;
 * - the person's own shared item, while in the trash, can't be opened by the people and links it
 *   was shared with: DefaultShareProvider::isAccessibleResult hides shares whose file sits outside
 *   "files/" on a home or object::user storage. The share rows are kept, so a restore (same file id)
 *   brings them back; DeleteOrphanedSharesJob removes only shares whose file is gone for good.
 *
 * Team folders (groupfolders 23.0.1, read in its source; nc:mount-type "group", common.ts):
 * - removing an item inside one removes it for the whole team: TrashBackend::moveToTrash moves it
 *   into the team folder's own trash ("<name>.d<time>", same file id, original location = the folder's
 *   mount point + the path inside it, which is the person's own path). listTrashRoot shows that trash
 *   to every member, through each one's own DAV trash (with advanced permissions on, to those who may
 *   read that place), and any of them can restore it or delete it for good;
 * - the top of a team folder can't be removed by a member: GroupMountPoint isn't an IMovableMount, so
 *   View::removeMount returns false and NoDrive answers 403. The tool says so before trying.
 *
 * A big trash (fix round 4): each entry is about 650 characters of PROPFIND answer, and nothing
 * expires by age, so a busy account's trash can be far over the 8 MiB a buffered read takes. The
 * trash is read as a stream (stream.ts), never whole: files_move_to_trash stops at the item's own
 * entry (its file id) and reads the rest only for an item from someone else's folder, whose copy has
 * a new id; files_list_trash keeps the newest 2,000 (matching) entries of what it reads and says so
 * when there are more.
 *
 * Restoring brings back the item's links (fix round 4): the share rows were kept (see above), so a
 * restore can make a file public again that the person trashed to cut its link off, and the old
 * folder may have a link today. Without workspace.share, files_restore_from_trash checks the folder
 * it goes back to first (exposure.ts), and after the restore reads the item's own shares (for a
 * folder, those of everything in it); a link, email or federated share puts it straight back in the
 * trash and the answer says why. With workspace.share it is restored with a warning.
 */
import { z } from "zod";
import { ToolError, isToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import { basenameOf, davFilesPath, joinPath, parentOf, type UserPath } from "../../core/paths";
import { FileItem, pathArg, Undo } from "../../core/shapes";
import type { ToolCtx } from "../../core/tool";
import { type DavResponse, isCollection, NS, propText, XMLNS } from "../../nc/index";
import {
	item,
	type LaneDetails,
	nextCursor,
	offsetPage,
	perCall,
	runSearch,
	statOrNull,
	statPath,
	toUserPath,
	trashItemIdArg,
	trashItemPath,
	trashRestorePath,
	trashRoot,
	where,
} from "./common";
import { filesTool } from "./define";
import { guardExposure } from "./exposure";
import { streamPropfind } from "./stream";

const TRASH_PROPS = `<?xml version="1.0" encoding="UTF-8"?><d:propfind ${XMLNS}><d:prop><d:resourcetype/><d:getcontentlength/><d:getcontenttype/><oc:size/><oc:fileid/><nc:trashbin-filename/><nc:trashbin-original-location/><nc:trashbin-deletion-time/></d:prop></d:propfind>`;

/** Share types (as FileDetails names them) that reach people outside the workspace. */
const OUTSIDE_SHARES = new Set(["link", "email", "federated"]);

const SHARES = "/ocs/v2.php/apps/files_sharing/api/v1/shares";
/** Share types whose per-person removal NoDrive's "Deleted shares" lists: group, team, room, Deck. */
const RESTORABLE_SHARE_TYPES = new Set([1, 7, 10, 12]);
/** A share made to one person. Removing it as that person deletes it for good. */
const PERSON_SHARE = 0;

/**
 * What removing the top of a received share does to it: "restorable" (Deleted shares has it),
 * "mixed" (a person share and a group-like share on the same item: the first ends for good, the
 * second can be restored with its own rights only), "for_good" (person shares only) or "unknown".
 * Every kind but "restorable" ends something for good, so it needs end_share true.
 */
type ShareEnd = "restorable" | "mixed" | "for_good" | "unknown";

/** How the top of a share someone else made was shared with the person (ShareAPIController::getSharedWithMe). */
async function receivedShare(ctx: ToolCtx, path: UserPath, fileId: number | null): Promise<{ end: ShareEnd; owner: string | null }> {
	let rows: Record<string, unknown>[];
	try {
		const data = await ctx.nc.ocs.get<unknown>(SHARES, { shared_with_me: "true", path });
		rows = Array.isArray(data) ? data.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r)) : [];
	} catch (e) {
		if (isToolError(e) && e.code === "reconnect_required") throw e;
		return { end: "unknown", owner: null };
	}
	// The shares whose target is this very path; else those of the same file id (a moved share).
	let mine = rows.filter((r) => typeof r.file_target === "string" && r.file_target.normalize("NFC") === path);
	if (mine.length === 0 && fileId !== null) mine = rows.filter((r) => Number(r.file_source ?? r.item_source) === fileId);
	const types = new Set(mine.map((r) => Number(r.share_type)).filter((t) => Number.isInteger(t)));
	const name = mine.map((r) => r.displayname_owner).find((s): s is string => typeof s === "string" && s.trim() !== "");
	const owner = name ?? null;
	if ([...types].some((t) => RESTORABLE_SHARE_TYPES.has(t))) return { end: types.has(PERSON_SHARE) ? "mixed" : "restorable", owner };
	if (types.size > 0 && [...types].every((t) => t === PERSON_SHARE)) return { end: "for_good", owner };
	return { end: "unknown", owner };
}

interface TrashEntry {
	trash_item_id: string;
	name: string;
	original_path: string;
	type: "file" | "folder";
	size: number;
	deleted_at: string | null;
	file_id: number | null;
	deleted: number;
}

const TrashItem = z.object({
	trash_item_id: z.string(),
	name: z.string(),
	original_path: z.string(),
	type: z.enum(["file", "folder"]),
	size: z.number(),
	deleted_at: z.string().nullable(),
});

function lastSegment(href: string): string | null {
	const segs = href.replace(/\/+$/, "").split("/");
	const raw = segs[segs.length - 1] ?? "";
	try {
		return decodeURIComponent(raw);
	} catch {
		return null;
	}
}

/** The trash item id of one response in the person's trash, or null for anything else. */
function trashIdOf(r: DavResponse, uid: string): string | null {
	const prefix = `/remote.php/dav/trashbin/${encodeURIComponent(uid)}/trash/`;
	let path = r.href;
	try {
		if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
	} catch {
		return null;
	}
	if (!path.startsWith(prefix) || path.length <= prefix.length) return null;
	const id = lastSegment(path);
	if (!id || id.includes("/") || !/\.d\d{1,12}$/.test(id)) return null;
	return id;
}

function trashEntry(r: DavResponse, uid: string): TrashEntry | null {
	const id = trashIdOf(r, uid);
	if (!id) return null;
	const folder = isCollection(r);
	const name = propText(r, NS.nc, "trashbin-filename") ?? id.replace(/\.d\d+$/, "");
	const loc = propText(r, NS.nc, "trashbin-original-location") ?? name;
	const delText = propText(r, NS.nc, "trashbin-deletion-time");
	const deleted = delText && /^\d{1,12}$/.test(delText) ? Number(delText) : Number(/\.d(\d+)$/.exec(id)?.[1] ?? 0);
	const sizeText = propText(r, NS.oc, "size") ?? propText(r, NS.d, "getcontentlength");
	const idText = propText(r, NS.oc, "fileid");
	return {
		trash_item_id: id,
		name,
		original_path: `/${loc.replace(/^\/+/, "")}`,
		type: folder ? "folder" : "file",
		size: sizeText && /^\d+$/.test(sizeText) ? Number(sizeText) : 0,
		deleted_at: deleted > 0 ? new Date(deleted * 1000).toISOString() : null,
		file_id: idText && /^\d+$/.test(idText) ? Number(idText) : null,
		deleted,
	};
}

/** Newest first; the same deletion time by name. */
function newestFirst(a: TrashEntry, b: TrashEntry): number {
	return b.deleted - a.deleted || a.name.localeCompare(b.name);
}

/**
 * Reads the person's trash as a stream (stream.ts), handing each entry to `each` until it returns
 * false. `complete` is true only when the whole trash was read. Throws when NoDrive refuses the read.
 */
async function scanTrash(ctx: ToolCtx, each: (e: TrashEntry) => boolean | undefined, timeoutMs: number = LIMITS.trashReadTimeoutMs): Promise<{ complete: boolean }> {
	let stopped = false;
	const r = await streamPropfind(
		ctx,
		`${trashRoot(ctx.uid)}/`,
		TRASH_PROPS,
		(rs) => {
			for (const resp of rs) {
				const e = trashEntry(resp, ctx.uid);
				if (e && each(e) === false) {
					stopped = true;
					return false;
				}
			}
			return undefined;
		},
		{ maxChars: LIMITS.trashReadChars, timeoutMs },
	);
	return { complete: r.complete && !stopped };
}

/**
 * The trash ids of the entries that came from `path`, before a DELETE of an item whose trash copy
 * gets a new file id (see the top), or null when the trash couldn't be read whole.
 */
async function idsFromPlace(ctx: ToolCtx, path: UserPath): Promise<Set<string> | null> {
	try {
		const ids = new Set<string>();
		const { complete } = await scanTrash(ctx, (t) => {
			if (t.original_path.normalize("NFC") === path) ids.add(t.trash_item_id);
			return undefined;
		});
		return complete ? ids : null;
	} catch (e) {
		if (isToolError(e) && e.code === "reconnect_required") throw e;
		return null;
	}
}

/**
 * What the person's trash shows after the DELETE: "found" (the item's own entry), "absent" (the
 * trash was read and has no entry for it: NoDrive may have deleted it outright) or "unread" (the
 * trash couldn't be read, or its entry couldn't be told apart from older ones).
 */
type TrashCheck = { state: "found"; entry: TrashEntry } | { state: "absent" } | { state: "unread" };

/**
 * `keepsId`: the item is in the person's own storage, where the trash entry always has the item's
 * file id, so a missing id means it isn't there. Anywhere else (a shared or team folder) only the
 * earlier list of entries from the same place (`before`) can tell. The trash is read only until the
 * entry with the item's file id comes by (fix round 4).
 */
async function checkTrash(ctx: ToolCtx, path: UserPath, fileId: number | null, before: Set<string> | null, keepsId: boolean): Promise<TrashCheck> {
	const hit: { byId: TrashEntry | null; fresh: TrashEntry | null } = { byId: null, fresh: null };
	let complete: boolean;
	try {
		({ complete } = await scanTrash(ctx, (t) => {
			// The same file id is this very item (an item is in one place only; own items keep their id).
			if (fileId !== null && t.file_id === fileId) {
				hit.byId = t;
				return false;
			}
			// A copy with a new id (an item from someone else's folder): the newest entry with this old
			// place that wasn't in the trash before the DELETE. Older entries with that place are other items.
			if (before && !before.has(t.trash_item_id) && t.original_path.normalize("NFC") === path && (hit.fresh === null || newestFirst(t, hit.fresh) < 0)) hit.fresh = t;
			return undefined;
		}));
	} catch (e) {
		if (isToolError(e) && e.code === "reconnect_required") throw e;
		return { state: "unread" };
	}
	if (hit.byId) return { state: "found", entry: hit.byId };
	// Part of the trash wasn't read: the entry may be in that part.
	if (!complete) return { state: "unread" };
	if (before) return hit.fresh ? { state: "found", entry: hit.fresh } : { state: "absent" };
	// Without the earlier list only the file id can be trusted, and a copy never has it.
	return keepsId && fileId !== null ? { state: "absent" } : { state: "unread" };
}

/** True for the top of a team folder (its parent isn't in the same kind of mount). */
async function isTeamFolderTop(ctx: ToolCtx, path: UserPath): Promise<boolean> {
	const parent = parentOf(path);
	if (parent === "/") return true;
	const p = await statOrNull(ctx, parent);
	return p !== null && p.mount !== "team";
}

const NOT_IN_TRASH = "That item isn't in the trash (any more).";

const SHARED_OUT_IN_TRASH = "It was shared with other people or by link. While it is in the trash they can't open it; restoring it brings their access back.";

const SHARED_BACK = "It was shared with other people in the workspace; they can open it again now that it is restored.";

/**
 * Whether a restored item, or anything inside a restored folder, has a share that reaches people
 * outside the workspace (link, email, another server): "outside", "none", or "unknown" when a
 * folder holds more than LIMITS.restoreScanItems items or couldn't be searched. A folder's items are
 * read with one SEARCH, whose answers carry oc:share-types (NC 35.0.2: SearchDAV's SearchHandler
 * fills each result through the same propFind handlers as a PROPFIND, SharesPlugin included).
 */
async function outsideSharesOf(ctx: ToolCtx, restored: { path: string; type: "file" | "folder"; share_types: string[] }): Promise<"outside" | "none" | "unknown"> {
	if (restored.share_types.some((t) => OUTSIDE_SHARES.has(t))) return "outside";
	if (restored.type !== "folder") return "none";
	let inside: { share_types: string[] }[];
	try {
		inside = await runSearch(ctx, {
			scope: restored.path as UserPath,
			where: where.or(where.isCollection(), where.not(where.isCollection())),
			limit: LIMITS.restoreScanItems + 1,
		});
	} catch (e) {
		if (isToolError(e) && e.code === "reconnect_required") throw e;
		return "unknown";
	}
	if (inside.some((d) => d.share_types.some((t) => OUTSIDE_SHARES.has(t)))) return "outside";
	return inside.length > LIMITS.restoreScanItems ? "unknown" : "none";
}

const TEAM_GONE = "This was in a team folder, so it was removed for everyone in the team.";
const TEAM_TRASH =
	"Team folders share one trash: every member who can see that place finds it in their own trash and can restore it or delete it for good, so the undo works only while it is still there.";

/** The one-line summaries. None names the item: its path is in the framed data (common.ts, at the top). */
function trashSummary(d: LaneDetails, check: TrashCheck): string {
	const t = d.type;
	if (d.mount === "team") {
		if (check.state === "found") return `Moved the ${t} to the team folder's trash. It is gone for everyone in the team until someone restores it.`;
		if (check.state === "absent") return `NoDrive removed the ${t} from the team folder, but it isn't in the person's trash, so it may be gone for good, for everyone in the team.`;
		return `Moved the ${t} to the team folder's trash, but the trash couldn't be checked afterwards to confirm it.`;
	}
	if (check.state === "found") return `Moved the ${t} to the trash. It can usually be restored for at least 30 days.`;
	if (check.state === "absent") return `NoDrive removed the ${t}, but it isn't in the person's trash, so it may be gone for good.`;
	return `Moved the ${t} to the trash, but the trash couldn't be checked afterwards to confirm it.`;
}

function publicEntry(e: TrashEntry): z.infer<typeof TrashItem> {
	return { trash_item_id: e.trash_item_id, name: e.name, original_path: e.original_path, type: e.type, size: e.size, deleted_at: e.deleted_at };
}

export const filesMoveToTrash = filesTool({
	name: "files_move_to_trash",
	title: "Move to trash",
	description:
		"Moves a NoDrive file or folder to the trash, where its shares and links stop working until files_restore_from_trash brings it back. The trash usually keeps items 30 days or more, less when storage is nearly full. An item in a folder someone shared, or in a team folder, is removed for everyone. Removing the top of a share only ends the person's access; a share made to the person alone then ends for good and needs end_share true.",
	input: z
		.object({
			path: pathArg('The file or folder (never "/").'),
			end_share: z.boolean().default(false).describe("true confirms ending a share made to the person alone; that can't be undone."),
		})
		.strict(),
	output: z.object({
		trashed: z.object({ path: z.string(), name: z.string(), type: z.enum(["file", "folder"]) }),
		trash_item_id: z.string().nullable(),
		/** true: the person's trash has it; false: it doesn't (checked, or the top of a share); null: unknown. */
		in_trash: z.boolean().nullable(),
		undo: Undo,
		warnings: z.array(z.string()).optional(),
	}),
	async run(ctx, args) {
		const path = toUserPath(args.path, "path", false);
		const caps = await ctx.nc.capabilities();
		if (!caps.trash) {
			throw new ToolError("not_available", "The NoDrive trash is switched off, so this couldn't be undone. Nothing was moved.");
		}
		const d = await statPath(ctx, path);
		// The top of a team folder belongs to the team: NoDrive never removes it for a member (see the top).
		if (d.mount === "team" && (await isTeamFolderTop(ctx, path))) {
			throw new ToolError("permission_denied", "That is a team folder itself, which belongs to the whole team, so its members can't remove it. Nothing was changed.", {
				hint: "The items inside it can be moved to the trash.",
			});
		}
		if (!d.permissions.can_delete) throw new ToolError("permission_denied", "The person isn't allowed to remove that item.");
		// The top of a folder or file shared with the person: removing it only ends their access.
		let sharedRoot = false;
		if (d.shared_with_me) {
			const parent = parentOf(path);
			const p = parent === "/" ? null : await statOrNull(ctx, parent);
			sharedRoot = parent === "/" || (p !== null && !p.shared_with_me);
		}
		// Before anything changes: a share made to the person alone can't come back (see the top).
		const share = sharedRoot ? await receivedShare(ctx, path, d.file_id) : null;
		if (share && share.end !== "restorable" && !args.end_share) {
			const message =
				share.end === "for_good"
					? "Nothing was changed. This was shared with the person alone, so removing it ends that share for good: it can't come back from the trash or from Deleted shares, and only its owner can share it again."
					: share.end === "mixed"
						? "Nothing was changed. This was shared with the person alone and also through a group, team or board. Removing it ends the first share for good; the other can come back from Deleted shares, with only its own rights."
						: "Nothing was changed. NoDrive didn't say how this was shared with the person, so removing it may end the share for good.";
			// No path here: the error text is capped at 300 characters, and the hint must survive.
			throw new ToolError("invalid_input", message, { field: "end_share", hint: "end_share true goes ahead; files_get_info shows the owner." });
		}
		const trashed = { path, name: d.name, type: d.type };
		// Paths, names and display names are workspace data: they go in the data and its warnings
		// (inside the frame), never in the summary or an error (common.ts, at the top).
		const warnings: string[] = [];
		const done = (summary: string, check: TrashCheck | null) => {
			const entry = check?.state === "found" ? check.entry : null;
			return {
				data: {
					trashed,
					trash_item_id: entry?.trash_item_id ?? null,
					in_trash: check === null ? false : check.state === "unread" ? null : check.state === "found",
					undo: entry ? { tool: "files_restore_from_trash", arguments: { trash_item_id: entry.trash_item_id } } : null,
					...(warnings.length ? { warnings } : {}),
				},
				summary,
			};
		};

		if (share) {
			// The top of a share: nothing reaches the person's trash (see the top), so it isn't read.
			const res = await ctx.nc.dav.delete(davFilesPath(ctx.uid, path));
			await res.body?.cancel();
			const owner = share.owner ?? "its owner";
			if (share.end === "restorable") {
				warnings.push("The share is removed from the person's NoDrive; the owner keeps the item. The person can bring it back from Deleted shares in NoDrive.");
			} else if (share.end === "mixed") {
				warnings.push(
					"The share is removed from the person's NoDrive; the owner keeps the item. The share made to the person alone has ended for good. The group, team or board share can be brought back from Deleted shares in NoDrive, with that share's own rights.",
				);
			} else if (share.end === "for_good") {
				warnings.push(`The share from ${owner} has ended for good: it can't be brought back from the trash or from Deleted shares, and only the owner can share it again. The owner keeps the item.`);
			} else {
				warnings.push("NoDrive didn't say how this was shared, so the person may not be able to get it back. The owner keeps the item and can share it again.");
			}
			return done(
				share.end === "for_good"
					? `Ended the share of this ${d.type}: it is gone from the person's NoDrive for good. Its owner keeps it.`
					: `Removed the shared ${d.type} from the person's NoDrive. Its owner keeps it.`,
				null,
			);
		}

		// An own item keeps its file id in the trash, so its entry is found by id afterwards. Anything
		// else may get a copy with a new id: the entries already there from the same place are noted
		// first, so the new one can be told apart from older ones (fix round 4: only then is the whole
		// trash read before the DELETE).
		const keepsId = d.mount === "own" && d.file_id !== null;
		const before = keepsId ? null : await idsFromPlace(ctx, path);
		const res = await ctx.nc.dav.delete(davFilesPath(ctx.uid, path));
		await res.body?.cancel();
		const check = await checkTrash(ctx, path, d.file_id, before, d.mount === "own");

		if (d.shared_with_me) {
			// Inside a folder someone else shared (the top of a share took the branch above).
			const owner = d.owner.display_name ?? d.owner.user_id ?? "someone else";
			warnings.push(`This was inside a folder shared by ${owner}. It was removed for everyone who has that folder; its owner can also restore it from their own trash.`);
			if (check.state === "found") {
				return done(`Moved the ${d.type} to the trash. It was in a shared folder, so it is gone for everyone who has that folder.`, check);
			}
			warnings.push(
				check.state === "absent"
					? "The person's trash didn't get a copy (NoDrive skips it when the person's storage is too full), so no undo is given."
					: "The person's trash couldn't be checked for a copy, so no undo is given. files_list_trash may list one.",
			);
			return done(`Removed the ${d.type} from a shared folder, so it is gone for everyone who has that folder.`, check);
		}

		// In a team folder, it is gone for the whole team, and the team shares the trash (see the top).
		if (d.mount === "team") warnings.push(check.state === "absent" ? TEAM_GONE : `${TEAM_GONE} ${TEAM_TRASH}`);
		if (check.state === "absent") {
			warnings.push(
				"The person's trash was read after removing it and doesn't have it, so no undo is given. NoDrive deletes an item outright when it can't move it to the trash.",
			);
			if (d.shared) warnings.push("It was shared with other people or by link; they can't open it any more.");
		} else {
			if (check.state === "unread") warnings.push("The person's trash couldn't be checked for it, so no undo is given. files_list_trash may list it.");
			if (d.shared) warnings.push(SHARED_OUT_IN_TRASH);
		}
		return done(trashSummary(d, check), check);
	},
});

export const filesListTrash = filesTool({
	name: "files_list_trash",
	title: "List trash",
	description:
		"Lists the person's NoDrive trash, newest first: each item's name, where it came from, size, deletion time and the trash_item_id that files_restore_from_trash takes. Items removed from a team folder are in every team member's trash. At most the newest 2,000 (matching) items are listed.",
	input: z
		.object({
			query: z.string().min(1).max(200).optional().describe("Only items whose name or original location contains this."),
			limit: perCall(200, 50),
			cursor: nextCursor(),
		})
		.strict(),
	output: z.object({ items: z.array(TrashItem), total: z.number(), note: z.string().nullable(), next_cursor: z.string().nullable(), has_more: z.boolean() }),
	async run(ctx, args) {
		// NFC like the names it is compared with (DESIGN 29.9).
		const q = args.query?.normalize("NFC").trim().toLocaleLowerCase();
		const cap = LIMITS.folderReadEntries;
		// Read as a stream; only the newest `cap` matching entries are kept (see the top).
		let kept: TrashEntry[] = [];
		let seen = 0;
		let read = 0;
		const { complete } = await scanTrash(
			ctx,
			(e) => {
				read++;
				if (q && !(e.name.normalize("NFC").toLocaleLowerCase().includes(q) || e.original_path.normalize("NFC").toLocaleLowerCase().includes(q))) return undefined;
				seen++;
				kept.push(e);
				if (kept.length >= 2 * cap) kept = kept.sort(newestFirst).slice(0, cap);
				return undefined;
			},
			// Listing is all this tool does, so it may read for longer than the checks around a DELETE.
			2 * LIMITS.trashReadTimeoutMs,
		);
		if (!complete && read === 0) {
			throw new ToolError("upstream_unavailable", "The trash couldn't be read. Try again in a minute.", { hint: "NoDrive's own trash page lists it too." });
		}
		const all = kept.sort(newestFirst).slice(0, cap).map(publicEntry);
		const capText = cap.toLocaleString("en-GB");
		let note: string | null = null;
		if (!complete) {
			note = `The trash is too big to read in full here, so only part of it was read and newer items may be missing. ${q ? "A narrower query" : "A query"} or NoDrive's own trash page finds the rest.`;
		} else if (seen > cap) {
			note = `The trash holds ${seen.toLocaleString("en-GB")} ${q ? "matching items" : "items"}; only the newest ${capText} are listed. ${q ? "A narrower query" : "A query"} finds older ones.`;
		}
		const total = complete ? seen : all.length;
		const page = await offsetPage(ctx, all, args.limit, (items) => ({ items, total, note, next_cursor: "x".repeat(200), has_more: true }));
		return {
			data: { items: page.items, total, note, next_cursor: page.next_cursor, has_more: page.has_more },
			summary: total === 0 ? (q ? "Nothing in the trash matches." : "The trash is empty.") : `Listed ${page.items.length} of ${total.toLocaleString("en-GB")} item${total === 1 ? "" : "s"} in the trash, newest first.`,
		};
	},
});

export const filesRestoreFromTrash = filesTool({
	name: "files_restore_from_trash",
	title: "Restore from trash",
	description:
		'Puts an item from the NoDrive trash back in its old folder, or in the top folder when that folder is gone. If the name is taken now, if_exists "rename" (default) restores it as "name (restored)" and "fail" stops. Restoring needs free storage space. Its shares come back with it; one that would make it public needs sharing allowed.',
	input: z
		.object({
			trash_item_id: trashItemIdArg(),
			if_exists: z.enum(["rename", "fail"]).default("rename").describe("What to do when the name is taken now."),
		})
		.strict(),
	output: z.object({ item: FileItem, original_path: z.string(), renamed: z.boolean(), warnings: z.array(z.string()).optional() }),
	async run(ctx, args) {
		const id = args.trash_item_id;
		let rs: DavResponse[];
		try {
			rs = await ctx.nc.dav.propfind(trashItemPath(ctx.uid, id), 0, TRASH_PROPS);
		} catch (e) {
			if (isToolError(e) && e.code === "not_found") {
				throw new ToolError("not_found", NOT_IN_TRASH, { hint: "files_list_trash lists what is there.", field: "trash_item_id" });
			}
			throw e;
		}
		const entry = rs.map((r) => trashEntry(r, ctx.uid)).find((e) => e?.trash_item_id === id);
		if (!entry) throw new ToolError("not_found", NOT_IN_TRASH, { hint: "files_list_trash lists what is there.", field: "trash_item_id" });

		let original: UserPath;
		try {
			original = toUserPath(entry.original_path, "original_path", false);
		} catch {
			original = joinPath("/" as UserPath, entry.name);
		}
		const oldFolder = parentOf(original);
		const folder = oldFolder === "/" ? null : await statOrNull(ctx, oldFolder);
		const target = oldFolder === "/" || (folder && folder.type === "folder") ? original : joinPath("/" as UserPath, entry.name);
		const taken = await statOrNull(ctx, target);
		if (taken && args.if_exists === "fail") {
			throw new ToolError("already_exists", "Its name is taken now in the folder it would go back to, so nothing was restored.", {
				hint: 'if_exists "rename" restores it under a new name; files_list_trash shows its old place.',
			});
		}

		// A link on the folder it goes back to (or one above) would show it to people outside: refused
		// without workspace.share, else a warning (fix round 4, exposure.ts).
		await guardExposure(ctx, parentOf(target), { field: "trash_item_id", what: "restore" });

		// "Overwrite: T" is required by the restore collection and replaces nothing there (common.ts).
		const res = await ctx.nc.dav.move(trashItemPath(ctx.uid, id), trashRestorePath(ctx.uid, id), { overwrite: true });
		await res.body?.cancel();

		let restored = entry.file_id !== null ? (await runSearch(ctx, { scope: "/" as UserPath, where: where.eq("fileid", entry.file_id), limit: 2 }))[0] : undefined;
		if (!restored && !taken) restored = (await statOrNull(ctx, target)) ?? undefined;
		if (!restored) throw new ToolError("upstream_unavailable", "NoDrive restored the item but didn't say where it is. files_search can find it by name.");

		// Its own shares came back with it (see the top). A link, email or federated share on it, or on
		// anything inside it, makes it public again: without workspace.share it goes straight back.
		const exposed = await outsideSharesOf(ctx, restored);
		if (exposed !== "none") {
			if (!ctx.connection.scopes.includes("workspace.share")) {
				const back = await ctx.nc.dav.delete(davFilesPath(ctx.uid, restored.path as UserPath));
				await back.body?.cancel();
				throw new ToolError(
					"not_available",
					exposed === "outside"
						? "Restoring it would turn its public link (or a share by email or with another server) back on, and this connection can't share, so it was put back in the trash."
						: "It holds too many items to check whether restoring it would turn a public link back on, and this connection can't share, so it was put back in the trash.",
					{ field: "trash_item_id", hint: "Reconnect with sharing allowed, or restore it in NoDrive. files_list_trash shows it again." },
				);
			}
			ctx.warn(
				exposed === "outside"
					? "Its public link (or a share by email or with another server), or one on an item inside it, works again now that it is restored."
					: "It holds too many items to check them all, so a public link on one of them may work again now that it is restored.",
			);
		} else if (restored.shared) {
			ctx.warn(SHARED_BACK);
		}

		// Describe where it really landed, not where it was expected to. Names and paths here come
		// from NoDrive (a trash copy of an item from someone else's folder has a name that person
		// chose), so they go in the data and warnings (inside the frame), never in the summary.
		const landed = parentOf(restored.path as UserPath);
		const renamed = basenameOf(restored.path as UserPath) !== entry.name;
		const elsewhere = landed !== oldFolder;
		const warnings: string[] = [];
		let summary: string;
		if (!elsewhere) {
			if (renamed) warnings.push(`It was restored as ${restored.path}, because the name ${entry.name} was taken in its old folder.`);
			summary = renamed ? "Restored the item to its old folder under a new name, because its name was taken there." : "Restored the item from the trash to its old place.";
		} else if (landed === "/") {
			warnings.push(`Its old folder ${oldFolder} is no longer there, so it was restored to the top folder as ${restored.path}.`);
			summary = "Restored the item to the top folder, because its old folder is no longer there.";
		} else {
			warnings.push(`It was restored to ${restored.path}, not to its old folder ${oldFolder}.`);
			summary = "Restored the item, but not to its old folder.";
		}
		return {
			data: { item: item(restored), original_path: original, renamed, ...(warnings.length ? { warnings } : {}) },
			summary,
		};
	},
});
