/**
 * sharing_delete (DESIGN 11.3): GET /shares/{id} to check that the person made it, then
 * DELETE /shares/{id}. This removes access, never files. Shares received from someone else are
 * refused (the server would only hide them for this person). A stopped link can't come back with
 * the same address, so it has no undo.
 *
 * The undo of a share with people is sharing_share_with, offered only when running it would make
 * the very same share again (fix round 2; the rule sharing_update follows since fix round 1):
 * - its access level gives back exactly the share's permission bits (a folder shared in the web UI
 *   for "read and update" without "create" reads as edit, but edit means read, update and create);
 * - the end date is one sharing_share_with accepts now (after today), or there is none;
 * - the note fits sharing_share_with's input unchanged (500 characters, nothing it would clean);
 * - the arguments pass sharing_share_with's input schema and its path check;
 * - a fresh sharees search as this person still finds the recipient (a local or demo account, or
 *   someone outside the person's reach, would be refused), and the person may still share the item;
 * - no other share on the item gives the same recipient access already (someone's reshare of it):
 *   sharing_share_with looks for one first and refuses, because the server would hand that one back.
 *   NC 35 itself allows only one share per item, kind and recipient (Share20\Manager's
 *   userCreateChecks and groupCreateChecks, read on the server), so this normally finds nothing; it
 *   is the partner tool's own look-ahead, kept so the undo stays one that tool accepts.
 * Otherwise the undo is null and the result says so. The checks that ask the server run alongside
 * the DELETE and are given a short grace afterwards, so they never block or hold up stopping the
 * share: when they fail or are slow, there is simply no undo.
 */
import { z } from "zod";
import { LIMITS } from "../../core/limits";
import { normalizePath, type UserPath } from "../../core/paths";
import { Undo } from "../../core/shapes";
import { defineTool, type ToolCtx } from "../../core/tool";
import { sharingShareWith } from "./share-with";
import {
	accessOf,
	expiryRestorable,
	getShare,
	peopleBits,
	type RawShare,
	requireMine,
	SHARES,
	type ShareOut,
	sameRecipient,
	shareError,
	shareIdArg,
	shareIdOf,
	sharesOn,
	shareView,
	TYPE,
	textRestorable,
} from "./shares";

const input = z.object({ share_id: shareIdArg() }).strict();

/** The warning of every share with people that has no undo (the same words as sharing_update's). */
export const NO_UNDO = "This change can't be undone automatically.";

/** How long the undo checks may still run once the DELETE has answered. */
export const UNDO_CHECK_GRACE_MS = 3000;

/**
 * The shape of structuredContent. Not published as outputSchema: tools/list must stay small (60 KB
 * for every tool together); the same JSON is in the framed text block, and the tests hold every
 * result to this schema.
 */
export const sharingDeleteOutput = z.object({
	stopped: z.object({
		share_id: z.string(),
		kind: z.enum(["link", "person", "group", "team", "email", "other"]),
		path: z.string().nullable(),
		shared_with: z.object({ id: z.string().nullable(), display_name: z.string().nullable() }).nullable(),
	}),
	undo: Undo.optional(),
	warnings: z.array(z.string()).optional(),
});

interface Candidate {
	args: Record<string, unknown>;
	path: UserPath;
	/** The typed id ("person:…", "group:…", "team:…"). */
	shareWith: string;
	folder: boolean;
	/** The share being stopped, and the server's own type and recipient id, for the look-ahead. */
	id: string;
	shareType: number;
	recipient: string;
}

/** The sharing_share_with call that would make this share again, when the local checks hold; else null. */
export function undoCandidate(ctx: ToolCtx, raw: RawShare, view: ShareOut): Candidate | null {
	if (raw.share_type !== TYPE.person && raw.share_type !== TYPE.group && raw.share_type !== TYPE.team) return null;
	const shareWith = view.shared_with?.id ?? null;
	const recipient = typeof raw.share_with === "string" ? raw.share_with : "";
	// The server's own path, never the shown one (display text, cut to a limit; fix round 3).
	const rawPath = typeof raw.path === "string" && raw.path.length > 0 ? raw.path : null;
	if (!shareWith || !recipient || !rawPath) return null;
	const a = accessOf(raw);
	if (a.permission !== "view" && a.permission !== "edit") return null;
	const folder = raw.item_type === "folder";
	if (peopleBits(a.permission, a.can_delete, a.can_reshare, folder) !== raw.permissions) return null;
	if (!expiryRestorable(ctx, view.expires_on, false)) return null;
	const note = typeof raw.note === "string" ? raw.note : "";
	if (!textRestorable(note, LIMITS.shareNoteChars, true)) return null;
	let path: UserPath;
	try {
		path = normalizePath(rawPath, { allowRoot: false });
	} catch {
		return null;
	}
	if (path !== rawPath) return null;
	const args: Record<string, unknown> = { path, share_with: shareWith, permission: a.permission };
	if (a.can_delete) args.can_delete = true;
	if (a.can_reshare) args.can_reshare = true;
	if (view.expires_on) args.expires_on = view.expires_on;
	if (note) args.note = note;
	if (!sharingShareWith.input.safeParse(args).success) return null;
	return { args, path, shareWith, folder, id: view.share_id, shareType: raw.share_type, recipient };
}

/**
 * The checks sharing_share_with makes against the server, as this person: the recipient, the
 * item, and its look-ahead for a share that already gives them access. That look-ahead runs while
 * the DELETE does, so the share being stopped may or may not still be listed; it is left out by
 * id. Never throws.
 */
async function stillShareable(ctx: ToolCtx, c: Candidate): Promise<boolean> {
	try {
		const [who, item, onItem] = await Promise.all([ctx.nc.sharees.verify(c.shareWith, ["person", "group", "team"]), ctx.nc.files.stat(c.path), sharesOn(ctx, c.path)]);
		const others = onItem.filter((s) => String(s.id) !== c.id);
		return who !== null && item.permissions.can_share && (item.type === "folder") === c.folder && sameRecipient(others, c.shareType, c.recipient) === undefined;
	} catch {
		return false;
	}
}

/** `p`, or `fallback` when it hasn't settled `ms` milliseconds from now. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<T>((res) => {
		timer = setTimeout(() => res(fallback), ms);
	});
	return Promise.race([p, late]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

export const sharingDelete = defineTool({
	name: "sharing_delete",
	title: "Stop sharing",
	description:
		"Ends one of the person's own shares: the people lose access at once, or the link stops working. The file or folder itself is not touched. A stopped link can't be brought back; a new link gets a new address. Shares made by other people can't be stopped here.",
	input,
	async run(ctx, args) {
		const id = shareIdOf(args.share_id);
		const raw = await getShare(ctx, id);
		requireMine(ctx, raw);
		const view = shareView(ctx, raw);
		const candidate = undoCandidate(ctx, raw, view);
		// Started before the DELETE so they run alongside it; they never throw.
		const checks = candidate ? stillShareable(ctx, candidate) : Promise.resolve(false);
		try {
			await ctx.nc.ocs.delete(`${SHARES}/${id}`, undefined, { what: "the share" });
		} catch (e) {
			throw shareError(e, "the shared item", { shareId: id });
		}
		const warnings: string[] = [];
		let undo: { tool: string; arguments: Record<string, unknown> } | null = null;
		if (candidate && (await within(checks, UNDO_CHECK_GRACE_MS, false))) {
			undo = { tool: "sharing_share_with", arguments: candidate.args };
		} else if (raw.share_type === TYPE.link) {
			warnings.push("A stopped link can't be brought back; sharing_create_link makes a new one with a new address.");
		} else {
			warnings.push(NO_UNDO);
		}
		return {
			data: { stopped: { share_id: view.share_id, kind: view.kind, path: view.path, shared_with: view.shared_with } },
			summary: view.kind === "link" ? `Stopped link ${id}; it no longer works.` : `Stopped share ${id}; they no longer have access.`,
			undo,
			warnings,
		};
	},
});
