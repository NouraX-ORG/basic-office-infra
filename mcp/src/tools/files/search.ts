/**
 * files_search (DESIGN 11.2): names through DAV SEARCH, words inside files through the unified
 * search provider "fulltextsearch" when it is listed (Task 5 installed it; checked 2026-10-25).
 *
 * Content results carry no path, but their resourceUrl is "/f/<fileid>" (files_open_result_directly
 * is on) and their subline is the path without its leading "/". Ids are resolved with one DAV
 * SEARCH on oc:fileid inside the person's own root, so a result always maps to something the person
 * can reach; anything that doesn't resolve is dropped.
 *
 * match "auto" pages two streams under one cursor {n, c, s}: n is the position in NoDrive's own
 * name-match answer for the search scope (the folder, or its deepest parent that can be a scope
 * when the folder's name can't, common.ts; results outside the folder are then skipped), c the
 * provider's own offset (pages of a fixed size, so it is always a multiple of that size) and
 * s how many raw content results of page c were already shown when a page was cut to fit the result
 * budget. A content result whose name also matches belongs to the name stream: it is marked "both"
 * when it is on the same page and otherwise shown once, as a name match.
 */
import { z } from "zod";
import { ToolError, isToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import { isWithin, type UserPath } from "../../core/paths";
import { FileItem, Paging, pathArg } from "../../core/shapes";
import type { ToolCtx } from "../../core/tool";
import type { FileDetails } from "../../nc/index";
import { dateFilterSec, escapeLike, FILE_TYPES, item, matchesType, nextCursor, runSearch, searchRows, searchScopeFor, statFolder, toUserPath, typeWhere, where } from "./common";
import { filesTool } from "./define";

const SearchItem = z.object({ ...FileItem.shape, match: z.enum(["name", "content", "both"]), excerpt: z.string().nullable() });
type SearchItem = z.infer<typeof SearchItem>;

const output = z.object({
	items: z.array(SearchItem),
	content_search_available: z.boolean(),
	note: z.string().nullable(),
	...Paging,
});

const PROVIDER = "fulltextsearch";
const MAX_FALLBACK_STATS = 5;
/** Name matches read per step, and steps per call, when a folder is searched from a parent. */
const NAME_SCAN_BATCH = 100;
const NAME_SCAN_STEPS = 3;

interface Position {
	n: number | null;
	c: number | null;
	s: number;
}

interface ContentHit {
	d: FileDetails;
	excerpt: string | null;
	raw: number;
}

function cleanExcerpt(title: unknown, subline: unknown): string | null {
	if (typeof title !== "string" || typeof subline !== "string" || subline.trim() === "") return null;
	const t = title
		.replace(/^\([^)]{1,40}\)\s*/, "")
		.replace(/<[^<>]{0,40}>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!t) return null;
	return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

function fileIdOf(url: unknown): number | null {
	if (typeof url !== "string") return null;
	const m = /\/f\/(\d{1,15})(?:[/?#]|$)/.exec(url) ?? /[?&]fileid=(\d{1,15})(?:&|$)/.exec(url);
	return m ? Number(m[1]) : null;
}

function validPosition(p: unknown): Position | null {
	if (!p || typeof p !== "object") return null;
	const o = p as Record<string, unknown>;
	const okNum = (v: unknown) => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
	if (!okNum(o.n) || !okNum(o.c) || typeof o.s !== "number" || !Number.isSafeInteger(o.s) || o.s < 0) return null;
	return { n: o.n as number | null, c: o.c as number | null, s: o.s };
}

async function resolveIds(ctx: ToolCtx, ids: number[]): Promise<Map<number, FileDetails>> {
	const out = new Map<number, FileDetails>();
	if (ids.length === 0) return out;
	const found = await runSearch(ctx, { scope: "/" as UserPath, where: where.or(...ids.map((id) => where.eq("fileid", id))), limit: ids.length });
	for (const d of found) if (d.file_id !== null) out.set(d.file_id, d);
	return out;
}

export const filesSearch = filesTool({
	name: "files_search",
	title: "Search files",
	description:
		'Finds NoDrive files and folders by name, newest first, and by words inside documents when search inside files is available (workspace_overview says). match "auto" does both; each item says what matched, with an excerpt for content matches. Filters: folder, type and modified dates.',
	input: z
		.object({
			query: z.string().min(1).max(200).describe("Part of a name, or words inside files."),
			match: z.enum(["auto", "name", "content"]).default("auto").describe('"auto": names and contents; "content": inside files only.'),
			folder: pathArg("Only inside this folder and its subfolders.").optional(),
			type: z
				.enum(["any", ...FILE_TYPES, "folder"])
				.default("any")
				.describe("Only items of this kind."),
			modified_after: z.string().max(40).optional().describe("Changed at or after this ISO 8601 date or time."),
			modified_before: z.string().max(40).optional().describe("Changed before this ISO 8601 date or time."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(LIMITS.searchMax)
				.default(20)
				.describe("Name matches per call; content matches add up to the same number again (25 at most)."),
			cursor: nextCursor(),
		})
		.strict(),
	output,
	async run(ctx, args) {
		// NFC like every name and path (NoDrive stores names in NFC): a query typed with combining
		// accents (macOS, pasted text) still matches "café" (DESIGN 29.9).
		const q = args.query.normalize("NFC").trim();
		if (!q) throw new ToolError("invalid_input", "query is empty.", { field: "query" });
		const folder = args.folder !== undefined ? toUserPath(args.folder, "folder") : ("/" as UserPath);
		if (folder !== "/") await statFolder(ctx, folder, "folder");
		const after = dateFilterSec(ctx, args.modified_after, "modified_after");
		const before = dateFilterSec(ctx, args.modified_before, "modified_before");
		if (after !== undefined && before !== undefined && after >= before) {
			throw new ToolError("invalid_input", "modified_after must be earlier than modified_before.", { field: "modified_after" });
		}

		let contentAvailable = false;
		const notes: string[] = [];
		try {
			contentAvailable = (await ctx.nc.providers()).includes(PROVIDER);
		} catch (e) {
			if (isToolError(e) && e.code === "reconnect_required") throw e;
			contentAvailable = false;
		}
		const wantsName = args.match !== "content";
		const wantsContent = args.match !== "name";
		if (wantsContent && !contentAvailable) {
			notes.push(
				args.match === "content"
					? 'Search inside files isn\'t available right now; match "name" searches names.'
					: "Search inside files isn't available right now, so only names were searched.",
			);
		}

		const decoded = await ctx.page.decode<unknown>();
		const pos: Position = decoded === null ? { n: wantsName ? 0 : null, c: wantsContent && contentAvailable ? 0 : null, s: 0 } : (validPosition(decoded) ?? { n: null, c: null, s: 0 });
		if (decoded !== null && !validPosition(decoded)) {
			throw new ToolError("invalid_input", "This cursor isn't valid. Start again without cursor.", { field: "cursor" });
		}
		if (!contentAvailable) pos.c = null;

		const passes = (d: FileDetails): boolean => {
			if (!isWithin(d.path as UserPath, folder) || d.path === folder) return false;
			if (!matchesType(d, args.type)) return false;
			const t = d.modified ? Math.floor(Date.parse(d.modified) / 1000) : null;
			if (after !== undefined && (t === null || t < after)) return false;
			if (before !== undefined && (t === null || t >= before)) return false;
			return true;
		};

		// Name stream. pos.n counts positions in NoDrive's own SEARCH answer for `scope`, so a page
		// continues exactly where the last one stopped even when results are filtered here.
		const pn = args.limit;
		let nameItems: { d: FileDetails; raw: number }[] = [];
		let nameNext: number | null = null;
		if (pos.n !== null) {
			const conds = [where.like("displayname", `%${escapeLike(q)}%`)];
			if (args.type !== "any") conds.push(typeWhere(args.type));
			if (after !== undefined) conds.push(where.gte("getlastmodified", after));
			if (before !== undefined) conds.push(where.lt("getlastmodified", before));
			// A folder whose name can't be a search scope is searched from its deepest parent that can
			// (common.ts), in a few larger steps, keeping only what is inside the folder.
			const scope = searchScopeFor(folder);
			const exact = scope === folder;
			const batch = exact ? pn + 1 : NAME_SCAN_BATCH;
			const steps = exact ? 1 : NAME_SCAN_STEPS;
			const got: { d: FileDetails; raw: number }[] = [];
			let at = pos.n;
			let end = false;
			for (let i = 0; i < steps && got.length <= pn && !end; i++) {
				const rows = await searchRows(ctx, {
					scope,
					where: where.and(...conds),
					order: [{ prop: "getlastmodified", dir: "desc" }],
					limit: batch,
					offset: at,
				});
				rows.forEach((d, k) => {
					if (d && d.path !== folder && isWithin(d.path as UserPath, folder)) got.push({ d, raw: at + k });
				});
				if (rows.length < batch) end = true;
				at += rows.length;
			}
			nameItems = got.slice(0, pn);
			nameNext = got.length > pn ? (got[pn] as { raw: number }).raw : end ? null : at;
			if (!exact && nameNext !== null && got.length <= pn) notes.push("Names inside this folder are searched in steps; next_cursor continues.");
		}

		// Content stream.
		const pc = Math.min(LIMITS.unifiedSearchPerCall, args.limit);
		const hits: ContentHit[] = [];
		const both = new Map<number, string | null>();
		let contentMore = false;
		let contentFailed = false;
		let rawCount = 0;
		if (pos.c !== null) {
			try {
				await ctx.charge("heavy", 1);
			} catch (e) {
				// With names to show, a used-up limit for searching inside files only narrows the search.
				if (!wantsName) throw e;
				pos.c = null;
				contentFailed = true;
				notes.push("Searching inside files reached this connection's limit for now, so only names were searched.");
			}
		}
		if (pos.c !== null) {
			ctx.log.note("content_search");
			try {
				const res = await ctx.nc.ocs.get<{ entries?: unknown; isPaginated?: unknown }>(`/ocs/v2.php/search/providers/${PROVIDER}/search`, {
					term: q,
					limit: pc,
					...(pos.c > 0 ? { cursor: pos.c } : {}),
				});
				const entries = Array.isArray(res?.entries) ? (res.entries as Record<string, unknown>[]) : [];
				rawCount = entries.length;
				contentMore = entries.length >= pc && res?.isPaginated !== false;
				const fresh = entries.slice(pos.s);
				const ids = fresh.map((e) => fileIdOf(e?.resourceUrl)).filter((x): x is number => x !== null);
				const byId = await resolveIds(ctx, [...new Set(ids)]);
				let fallbackStats = 0;
				const seen = new Set<number>();
				const namePage = new Set(nameItems.map((n) => n.d.file_id));
				for (let i = 0; i < fresh.length; i++) {
					const e = fresh[i] ?? {};
					const id = fileIdOf(e.resourceUrl);
					let d: FileDetails | undefined = id !== null ? byId.get(id) : undefined;
					if (!d && id === null && typeof e.subline === "string" && e.subline.trim() && fallbackStats < MAX_FALLBACK_STATS) {
						fallbackStats++;
						try {
							d = await ctx.nc.files.stat(toUserPath(`/${e.subline.trim()}`));
						} catch {
							d = undefined;
						}
					}
					if (!d || d.file_id === null || seen.has(d.file_id) || !passes(d)) continue;
					seen.add(d.file_id);
					const excerpt = cleanExcerpt(e.title, e.subline);
					if (namePage.has(d.file_id)) {
						both.set(d.file_id, excerpt);
						continue;
					}
					if (args.match === "auto" && d.name.toLocaleLowerCase().includes(q.toLocaleLowerCase())) continue;
					hits.push({ d, excerpt, raw: pos.s + i });
				}
				if (entries.length === 0 && pos.c === 0) notes.push("Search inside files found nothing; the index can lag behind recent changes.");
			} catch (e) {
				if (isToolError(e) && (e.code === "reconnect_required" || e.code === "rate_limited" || e.code === "daily_limit")) throw e;
				contentFailed = true;
				notes.push(args.match === "content" ? "Search inside files didn't answer. Try again in a minute." : "Search inside files didn't answer, so only names were searched this time.");
			}
		}

		const merged: SearchItem[] = [
			...nameItems.map(({ d }) => {
				const id = d.file_id;
				const isBoth = id !== null && both.has(id);
				return { ...item(d), match: isBoth ? ("both" as const) : ("name" as const), excerpt: isBoth ? (both.get(id as number) ?? null) : null };
			}),
			...hits.map((h) => ({ ...item(h.d), match: "content" as const, excerpt: h.excerpt })),
		];
		const note = notes.length ? notes.join(" ") : null;
		const render = (page: SearchItem[]) => ({ items: page, content_search_available: contentAvailable, note, next_cursor: "x".repeat(400), has_more: true });
		const fitted = ctx.page.fit(merged, render);
		let shown = fitted.items;
		if (shown.length === 0 && merged.length > 0) shown = merged.slice(0, 1);
		if (fitted.cut) ctx.log.note("fit_cut");

		// Where the next page starts.
		const next: Position = { n: null, c: null, s: 0 };
		const keptNames = Math.min(shown.length, nameItems.length);
		if (pos.n !== null) next.n = keptNames < nameItems.length ? (nameItems[keptNames] as { raw: number }).raw : nameNext;
		if (pos.c !== null && !contentFailed) {
			const keptHits = shown.length - keptNames;
			if (keptNames < nameItems.length) {
				next.c = pos.c;
				next.s = pos.s;
			} else if (keptHits < hits.length) {
				next.c = pos.c;
				next.s = (hits[keptHits] as ContentHit).raw;
			} else if (contentMore && rawCount > 0) {
				next.c = pos.c + pc;
			}
		}
		const has_more = next.n !== null || next.c !== null;
		const data = { items: shown, content_search_available: contentAvailable, note, next_cursor: has_more ? await ctx.page.encode(next) : null, has_more };
		const byName = shown.filter((s) => s.match !== "content").length;
		const byContent = shown.length - byName;
		const summary =
			shown.length === 0
				? has_more
					? "Nothing matched on this page; next_cursor continues the search."
					: "Nothing matched the search."
				: `Found ${shown.length} item${shown.length === 1 ? "" : "s"}${contentAvailable && wantsContent && wantsName ? ` (${byName} by name, ${byContent} by content only)` : ""}.`;
		return { data, summary };
	},
});
