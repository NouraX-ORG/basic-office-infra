/**
 * Who else can see a folder a tool is about to write into (fix round 3). "workspace.write" must not
 * get round the share choice on the consent page: copying /HR/salaries.xlsx into a folder that has
 * a public link makes it public just as sharing_create_link would. So every tool that puts data into
 * a folder (files_copy, files_move, files_create_file, files_overwrite_file, the docs_* writers, and
 * since fix round 4 files_restore_from_trash, which also checks the restored item's own shares in
 * trash.ts) first looks at that folder and every folder above it:
 *
 * - a link (share type 3), an email share (4) or a share with another server (6) on any of them,
 *   while the connection lacks workspace.share: refused with not_available, nothing is written;
 * - the same with workspace.share: written, with a warning that people outside can see it;
 * - shared only inside the workspace (people, groups, teams), a share someone else made, or a team
 *   folder: written, with a warning that those people can see it.
 *
 * Facts (NC 35.0.2, SharesPlugin, read on the server 2026-10-26): oc:share-types lists the shares on
 * the item itself, made by the person or received by them, never those on a folder above, so each
 * level is asked (Depth 0). The owner's own links on a folder shared with the person can't be seen
 * by the person: a "shared" mount gets the inside warning, which says the owner decides who else
 * sees it. A move or copy inside a folder whose link already covers the item adds nobody, so those
 * shares are left out. NoMail's mail_save_attachment_to_drive writes through NoMail and is outside
 * this check (DESIGN 22, docs/mcp.md section 8).
 */
import { ToolError, isToolError } from "../../core/errors";
import { davFilesPath, isWithin, parentOf, type UserPath } from "../../core/paths";
import type { ToolCtx } from "../../core/tool";
import { rawXml } from "../../core/xml";
import { NS, propEl, propfindBody } from "../../nc/index";
import { mountKindOf } from "./common";

/** Share types that reach people outside the workspace: link, email, another server. */
const OUTSIDE = new Set(["3", "4", "6"]);
/** Folders deeper than this aren't walked; without the share scope they are refused (fail closed). */
const MAX_LEVELS = 40;

const BODY = propfindBody(rawXml("<oc:share-types/><nc:mount-type/>"));

type Level = { path: UserPath; outside: boolean; inside: boolean };

/** The target and every folder above it, nearest first, without "/" (which can't be shared). */
function chainOf(target: UserPath): UserPath[] {
	const out: UserPath[] = [];
	for (let p = target; p !== "/"; p = parentOf(p)) out.push(p);
	return out;
}

async function levelOf(ctx: ToolCtx, path: UserPath): Promise<Level | null> {
	let rs: Awaited<ReturnType<ToolCtx["nc"]["dav"]["propfind"]>>;
	try {
		rs = await ctx.nc.dav.propfind(davFilesPath(ctx.uid, path), 0, BODY);
	} catch (e) {
		// A folder that isn't there yet holds nothing anyone can see; the write itself says so.
		if (isToolError(e) && e.code === "not_found") return null;
		throw e;
	}
	const r = rs[0];
	if (!r) return null;
	const types = (propEl(r, NS.oc, "share-types")?.children ?? []).map((c) => c.text.trim()).filter(Boolean);
	const mount = mountKindOf(r);
	return { path, outside: types.some((t) => OUTSIDE.has(t)), inside: types.some((t) => !OUTSIDE.has(t)) || mount === "shared" || mount === "team" };
}

export interface ExposureOptions {
	/** The argument that names the target, for the error. */
	field: string;
	/** What the tool does, for the plain refusal. */
	what: "copy" | "move" | "new" | "replace" | "restore";
	/** For a move or copy: the item's own path. Shares that already cover it add nobody new. */
	source?: UserPath;
}

const REFUSED: Readonly<Record<ExposureOptions["what"], string>> = {
	copy: "That folder is shared outside the workspace (by link, by email or with another server), and this connection can't share, so nothing was copied there.",
	move: "That folder is shared outside the workspace (by link, by email or with another server), and this connection can't share, so nothing was moved there.",
	new: "That folder is shared outside the workspace (by link, by email or with another server), and this connection can't share, so nothing was saved there.",
	replace: "That file or a folder it is in is shared outside the workspace (by link, by email or with another server), and this connection can't share, so its content wasn't replaced.",
	restore: "The folder it would go back to is shared outside the workspace (by link, by email or with another server), and this connection can't share, so nothing was restored.",
};

const HINT: Readonly<Record<ExposureOptions["what"], string>> = {
	copy: "Choose a folder that isn't shared outside the workspace, or reconnect with sharing allowed.",
	move: "Choose a folder that isn't shared outside the workspace, or reconnect with sharing allowed.",
	new: "Choose a folder that isn't shared outside the workspace, or reconnect with sharing allowed.",
	replace: "Choose a folder that isn't shared outside the workspace, or reconnect with sharing allowed.",
	restore: "Reconnect with sharing allowed, or restore it in NoDrive.",
};

/**
 * Checks `target` (a folder to write into, or for "replace" the file itself) and every folder above
 * it. Throws not_available when people outside the workspace could see what is written and the
 * connection can't share; otherwise adds a warning (ctx.warn) when other people can see it.
 */
export async function guardExposure(ctx: ToolCtx, target: UserPath, o: ExposureOptions): Promise<void> {
	const canShare = ctx.connection.scopes.includes("workspace.share");
	const chain = chainOf(target);
	if (chain.length === 0) return;
	if (chain.length > MAX_LEVELS) {
		if (canShare) return;
		throw new ToolError("invalid_input", `That folder is nested too deeply (more than ${MAX_LEVELS} levels) to check who can see it, so nothing was written there.`, { field: o.field });
	}
	const levels = (await Promise.all(chain.map((p) => levelOf(ctx, p)))).filter((l): l is Level => l !== null);
	// A share on a folder that already holds the item covers it where it is now.
	const adds = (l: Level) => !(o.source && isWithin(o.source, l.path));
	const outside = levels.some((l) => l.outside && adds(l));
	const inside = levels.some((l) => l.inside && adds(l));
	if (outside && !canShare) throw new ToolError("not_available", REFUSED[o.what], { field: o.field, hint: HINT[o.what] });
	const item = o.what === "replace" ? "the new content" : "it";
	if (outside) ctx.warn(`That place is shared outside the workspace (by link, by email or with another server), so people outside can see ${item}.`);
	else if (inside) ctx.warn(`That place is shared with other people in the workspace, or is a team folder or a folder someone shared with this person, so those people can see ${item}.`);
}
