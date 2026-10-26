/**
 * files_list_recent (DESIGN 11.2): DAV SEARCH for d:getlastmodified after now minus `days` (unix
 * seconds, verified), files only, newest first.
 *
 * Fallback when the SEARCH fails (an error answer, its own 15 s timeout or a dropped connection;
 * section 30.6): NoDrive's own recent list, GET /index.php/apps/files/api/v1/recent/
 * (egress row "files-recent"; it needs OCS-APIRequest: true for the CSRF check). Read in the
 * installed source (NC 35.0.2, ApiController::getRecentFiles and Helper::formatFileInfo): it answers
 * {"files": [...]} with the 100 most recently changed items, each with id, mtime in milliseconds,
 * name, mimetype, size, type "file" or "dir", etag, the parent folder as path ("/" or "/a/b") and
 * shareTypes when shared. Favourite marks are not part of it.
 */
import { z } from "zod";
import { ToolError, isToolError } from "../../core/errors";
import { basenameOf, type UserPath } from "../../core/paths";
import { FileItem } from "../../core/shapes";
import type { ToolCtx } from "../../core/tool";
import { FILE_TYPES, type FileType, item, matchesType, perCall, runSearch, toUserPath, typeWhere, where } from "./common";
import { filesTool } from "./define";

const RECENT_API = "/index.php/apps/files/api/v1/recent/";
const RECENT_API_MAX = 100;
const RECENT_API_BYTES = 4 * 1024 * 1024;

/**
 * The SEARCH's own time: a slow SEARCH over a big account is the likeliest failure, and the fallback
 * GET (20 s, one retry on 502/503/504) must still fit in the tool's 60 s after it (section 30.6).
 */
const SEARCH_TIMEOUT_MS = 15_000;

/**
 * SEARCH failures that NoDrive's recent list can stand in for (third system review, section 30.6):
 * an upstream failure, a refusal of the query, and also the network failures the NoDrive client
 * passes on as they are: its per-request timeout (a DOMException named TimeoutError from
 * AbortSignal.timeout) and a dropped connection (a TypeError from fetch). Never once the tool's own
 * budget is over (its signal aborted: the fallback can't run then), nor for a dead sign-in, a
 * permission refusal or a limit.
 */
function canFallBack(e: unknown, signal: AbortSignal): boolean {
	if (signal.aborted) return false;
	if (isToolError(e)) return e.code === "upstream_unavailable" || e.code === "invalid_input" || e.code === "timeout";
	const name = e !== null && typeof e === "object" && "name" in e ? (e as { name?: unknown }).name : undefined;
	return name === "TimeoutError" || name === "TypeError";
}

/** Files changed after `since` (unix seconds) from NoDrive's recent list, newest first. */
async function fromRecentList(ctx: ToolCtx, since: number, type: FileType | "any"): Promise<FileItem[]> {
	const res = await ctx.nc.request("GET", RECENT_API, { headers: { "ocs-apirequest": "true", accept: "application/json" } });
	let json: unknown;
	try {
		json = JSON.parse(await ctx.nc.readText(res, RECENT_API_BYTES));
	} catch {
		throw new ToolError("upstream_unavailable", "NoDrive's list of recent files couldn't be read. Try again in a minute.");
	}
	const rows = json && typeof json === "object" && Array.isArray((json as { files?: unknown }).files) ? ((json as { files: unknown[] }).files as Record<string, unknown>[]) : [];
	const out: FileItem[] = [];
	for (const f of rows.slice(0, RECENT_API_MAX)) {
		if (!f || typeof f !== "object" || f.type !== "file") continue;
		if (typeof f.name !== "string" || typeof f.path !== "string" || f.name.includes("/")) continue;
		const mtimeMs = typeof f.mtime === "number" ? f.mtime : Number.NaN;
		if (!Number.isFinite(mtimeMs) || Math.floor(mtimeMs / 1000) <= since) continue;
		let path: UserPath;
		try {
			path = toUserPath(`${f.path.replace(/\/+$/, "")}/${f.name}`, "path", false);
		} catch {
			ctx.log.note("recent_path_refused");
			continue;
		}
		const mime = typeof f.mimetype === "string" ? f.mimetype : null;
		if (!matchesType({ type: "file", mime }, type)) continue;
		const id = typeof f.id === "number" && Number.isSafeInteger(f.id) && f.id > 0 ? f.id : null;
		out.push({
			path,
			name: basenameOf(path),
			type: "file",
			mime,
			size: typeof f.size === "number" && f.size >= 0 ? f.size : 0,
			modified: new Date(mtimeMs).toISOString(),
			etag: typeof f.etag === "string" ? f.etag : null,
			file_id: id,
			favorite: Array.isArray(f.tags) && f.tags.includes("_$!<Favorite>!$_"),
			shared: Array.isArray(f.shareTypes) && f.shareTypes.length > 0,
			web_url: id !== null ? `${ctx.cfg.driveOrigin}/f/${id}` : null,
		});
	}
	return out.sort((a, b) => Date.parse(b.modified ?? "") - Date.parse(a.modified ?? ""));
}

export const filesListRecent = filesTool({
	name: "files_list_recent",
	title: "Recent files",
	description:
		"Lists the NoDrive files changed in the last days, newest first; folders are not listed. type narrows it to documents, spreadsheets, presentations, PDFs, images or text files.",
	input: z
		.object({
			days: z.number().int().min(1).max(90).default(14).describe("How many days back to look."),
			type: z
				.enum(["any", ...FILE_TYPES])
				.default("any")
				.describe("Only files of this kind."),
			limit: perCall(50, 25),
		})
		.strict(),
	output: z.object({ items: z.array(FileItem), has_more: z.boolean(), note: z.string().nullable() }),
	async run(ctx, args) {
		const since = Math.floor(ctx.time.now() / 1000) - args.days * 86400;
		const notes: string[] = [];
		let files: FileItem[];
		try {
			const conds = [where.gt("getlastmodified", since), where.not(where.isCollection())];
			if (args.type !== "any") conds.push(typeWhere(args.type));
			const found = await runSearch(ctx, {
				scope: "/" as UserPath,
				where: where.and(...conds),
				order: [{ prop: "getlastmodified", dir: "desc" }],
				limit: args.limit + 1,
				// The fallback below is its retry, and it needs the time left.
				timeoutMs: SEARCH_TIMEOUT_MS,
				noRetry: true,
			});
			files = found.filter((d) => d.type === "file").map(item);
		} catch (e) {
			if (!canFallBack(e, ctx.signal)) throw e;
			ctx.log.note("recent_fallback");
			files = await fromRecentList(ctx, since, args.type);
			notes.push("NoDrive's file search didn't answer, so this comes from its list of the 100 most recently changed items, without favourite marks.");
		}
		const window = files.slice(0, args.limit);
		const fitted = ctx.page.fit(window, (page) => ({ items: page, has_more: true, note: "x".repeat(300) }));
		const items = fitted.items.length ? fitted.items : window.slice(0, 1);
		const has_more = files.length > items.length;
		if (has_more) notes.push("More files changed in that time than are listed; a smaller days or a type narrows the list.");
		const span = `${args.days} day${args.days === 1 ? "" : "s"}`;
		return {
			data: { items, has_more, note: notes.length ? notes.join(" ") : null },
			summary: items.length === 0 ? `No files changed in the last ${span}.` : `Listed ${items.length} file${items.length === 1 ? "" : "s"} changed in the last ${span}, newest first.`,
		};
	},
});
