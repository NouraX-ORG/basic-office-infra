/**
 * Shared helpers for lane A's files tools (DESIGN 11.2): path arguments, stat with plain errors,
 * the trash and versions DAV paths, offset paging that respects the result budget, type filters,
 * upload content checks, and the DAV SEARCH request builder.
 *
 * Facts checked on the server (NC 35.0.2, 2026-10-25, as qa-t1-22):
 * - DAV SEARCH: the scope href is the raw path ("/files/<uid>/My Folder"), never percent-encoded
 *   (SearchDAV's PathHelper uses it as is; checked again in its source). LIKE on d:displayname is
 *   case-insensitive, and "\" escapes "%" and "_". oc:favorite matches the literal "yes".
 *   d:getlastmodified takes unix seconds. Paging is d:nresults (no upper cap) plus firstresult in the
 *   SearchDAV namespace. oc:fileid is searchable; no path property is (FileSearchBackend), so a
 *   folder whose name the egress check can't pass as a scope is searched from its deepest parent
 *   that it can, and the results are filtered here (searchScopeFor).
 * - The trash and versions "restore" collections answer 412 to MOVE with "Overwrite: F" (Sabre finds
 *   a null child there) and 201 with "Overwrite: T". The null child also means nothing is ever
 *   overwritten or deleted there, so "T" is safe on exactly those two destinations.
 * - nc:mount-type (dav FilesPlugin: the item's mount point's getMountType()) is "" for the person's
 *   own storage, "shared" for a share someone else made and everything inside it (SharedMount, and
 *   federated shares), and "group" for a team folder and everything inside it (groupfolders 23.0.1,
 *   GroupMountPoint::getMountType). Core's FileDetails keeps only shared_with_me, so lane A's own
 *   stat reads the mount type too (LaneDetails.mount).
 *
 * The lane's rule for texts outside the data frame (DESIGN 10.4, fix round 3): a summary or an error
 * text never repeats a path, a name or other text from the call or from NoDrive. Names can be chosen
 * by other people (in a shared or team folder, through a public upload link, in a saved attachment),
 * and only the framed data is marked as written by people. Errors name the argument instead
 * ("that path", "the path in to_folder"); paths go in the framed data and its warnings. define.ts
 * also checks every error, because core's NoDrive client builds some messages from a request's
 * `what` (so lane A doesn't pass one).
 */
import { z } from "zod";
import { type ErrorCode, ToolError, isToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import { davFilesPath, davPath, encodeSegment, normalizePath, segmentsOf, type UserPath } from "../../core/paths";
import { cursorArg, ifExistsArg, limitArg } from "../../core/shapes";
import type { ToolCtx } from "../../core/tool";
import { rawXml, xml, type XmlFragment } from "../../core/xml";
import { type DavResponse, FILE_PROPS, type FileDetails, NS, propEl, propfindBody, propText, toFileDetails, toFileItem, XMLNS } from "../../nc/index";

// ---------------------------------------------------------------------------------------------
// Short argument variants. Bounds and defaults are in the published JSON Schema already, so the
// descriptions don't repeat them (DESIGN 10.8: the whole own tools/list stays small).

export const ifExists = (dflt: "fail" | "rename" = "fail") => ifExistsArg(dflt).describe('When the name is taken: "fail" stops, "rename" adds a number.');

export const perCall = (max: number, dflt: number) => limitArg(max, dflt).describe("Most items per call.");

export const nextCursor = () => cursorArg().describe("next_cursor from the previous call.");

// ---------------------------------------------------------------------------------------------
// Paths and items

const URL_LIKE = /^\s*[a-z][a-z0-9+.-]*:\/\//i;

/**
 * A path argument: a web address is refused plainly, everything else goes through the normaliser.
 * `newName` holds the last name to the rule for names a tool creates (core/paths.ts, at the top).
 */
export function toUserPath(raw: unknown, field = "path", allowRoot = true, newName = false): UserPath {
	if (typeof raw === "string" && URL_LIKE.test(raw)) {
		throw new ToolError("invalid_input", `${field} must be a path in the person's NoDrive, such as /Projects/Plan.docx, not a web address.`, { field });
	}
	return normalizePath(raw, { field, allowRoot, newName });
}

export function isNotFound(e: unknown): boolean {
	return isToolError(e) && e.code === "not_found";
}

/**
 * How an error names a path argument without repeating it (the rule at the top): "that path" for
 * `path`, "the path in to_folder" for any other argument.
 */
export function argPath(field: string): string {
	return field === "path" ? "that path" : `the path in ${field}`;
}

/** The same, at the start of a sentence. */
export function ArgPath(field: string): string {
	const s = argPath(field);
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Where an item lives (nc:mount-type, see the top): the person's own storage, a share someone else
 * made, a team folder, or anything else (also when NoDrive didn't say).
 */
export type MountKind = "own" | "shared" | "team" | "other";

/** Core's FileDetails plus the mount kind. */
export interface LaneDetails extends FileDetails {
	mount: MountKind;
}

export function mountKindOf(r: DavResponse): MountKind {
	// The person's own storage answers the property empty (NC 35.0.2 FilesPlugin: the home mount's
	// type is ""), which propText reads as null, the same as a missing property; so the element itself
	// is looked at (fix round 4: before, own items came out as "other").
	const el = propEl(r, NS.nc, "mount-type");
	if (el === undefined) return "other";
	const v = (el.text ?? "").trim();
	if (v === "") return "own";
	if (v === "shared") return "shared";
	if (v === "group") return "team";
	return "other";
}

/**
 * PROPFIND Depth 0 for one item, or null when nothing is there. The same request as core's
 * ctx.nc.files.stat, but it keeps the mount type and sends no `what`, so no NoDrive status turns into
 * a message that repeats the path (the rule at the top).
 */
async function statRaw(ctx: ToolCtx, path: UserPath): Promise<LaneDetails | null> {
	let rs: DavResponse[];
	try {
		rs = await ctx.nc.dav.propfind(davFilesPath(ctx.uid, path), 0, propfindBody());
	} catch (e) {
		if (isNotFound(e)) return null;
		throw e;
	}
	const first = rs[0];
	const d = first ? toFileDetails(first, ctx.uid, ctx.cfg.driveOrigin) : null;
	if (!first || !d) return null;
	return { ...d, mount: mountKindOf(first) };
}

/** The item at a path, with a plain not_found that names the argument, not the path. */
export async function statPath(ctx: ToolCtx, path: UserPath, field = "path"): Promise<LaneDetails> {
	const d = await statRaw(ctx, path);
	if (!d) throw new ToolError("not_found", `There's no file or folder at ${argPath(field)}.`, { hint: "files_search can find it by name.", field });
	return d;
}

/** The item at a path, or null when nothing is there. */
export async function statOrNull(ctx: ToolCtx, path: UserPath): Promise<LaneDetails | null> {
	return statRaw(ctx, path);
}

export async function statFolder(ctx: ToolCtx, path: UserPath, field = "path"): Promise<LaneDetails> {
	const d = await statRaw(ctx, path);
	if (!d) throw new ToolError("not_found", `There's no folder at ${argPath(field)}.`, { hint: "files_create_folder can make it.", field });
	if (d.type !== "folder") throw new ToolError("invalid_input", `${ArgPath(field)} is a file, not a folder.`, { field });
	return d;
}

export async function statFile(ctx: ToolCtx, path: UserPath, what: string): Promise<LaneDetails> {
	const d = await statPath(ctx, path);
	if (d.type !== "file") throw new ToolError("invalid_input", `That path is a folder. ${what}`, { field: "path" });
	return d;
}

/**
 * Core's file primitives (ctx.nc.files.writeNew and overwrite) build some messages from the path
 * they wrote to, which for if_exists "rename" is a numbered name define.ts can't match. These say
 * the same without it; every other error passes through as it is.
 */
const PLAIN_FILE_MESSAGES: Partial<Record<ErrorCode, string>> = {
	permission_denied: "The person isn't allowed to do that with this file.",
	not_found: "That item doesn't exist, or this person can't see it.",
	already_exists: "A file with that name already exists there.",
	conflict: "The file changed since it was read. Read it again first.",
	parent_missing: "The folder it should go in doesn't exist.",
	locked: "The file is locked because someone has it open. Try again later.",
};

export function plainFileError(e: unknown): unknown {
	if (!isToolError(e)) return e;
	const message = PLAIN_FILE_MESSAGES[e.code];
	if (message === undefined || e.message === message) return e;
	return new ToolError(e.code, message, {
		hint: e.hint,
		field: e.field,
		retryAfterSec: e.retryAfterSec,
		deadCredential: e.deadCredential,
		upstreamStatus: e.upstreamStatus,
		detail: e.detail,
	});
}

/** A 409 from NoDrive means the folder it should go in is missing. */
export function parentMissing(e: unknown): never {
	if (isToolError(e) && e.code === "parent_missing") {
		throw new ToolError("parent_missing", "The folder it should go in doesn't exist.", { hint: "files_create_folder can make it." });
	}
	throw e;
}

/**
 * One multistatus response as an item, or null when it failed or lies outside the person's root. The
 * second case is passed to ctx.log.note("href_outside"); core writes it in the tool's log line and as
 * the auth event href_outside (src/mcp/register.ts logTool, section 30.5).
 */
function detailOrNull(ctx: ToolCtx, r: DavResponse): FileDetails | null {
	if (r.status !== undefined && (r.status < 200 || r.status >= 300)) return null;
	const d = toFileDetails(r, ctx.uid, ctx.cfg.driveOrigin);
	if (!d) ctx.log.note("href_outside");
	return d;
}

/** Turns multistatus responses into items, dropping anything outside the person's root (noted, above). */
export function detailsOf(ctx: ToolCtx, rs: readonly DavResponse[]): FileDetails[] {
	const out: FileDetails[] = [];
	for (const r of rs) {
		const d = detailOrNull(ctx, r);
		if (d) out.push(d);
	}
	return out;
}

export const item = toFileItem;

/** Seconds since 1970 of an item's last change (the id of its current version), or null. */
export function mtimeSec(d: { modified: string | null }): number | null {
	if (!d.modified) return null;
	const t = Date.parse(d.modified);
	return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

// ---------------------------------------------------------------------------------------------
// Trash and versions (DESIGN 8.4: never DELETE under either)

export function trashRoot(uid: string): string {
	return `/remote.php/dav/trashbin/${encodeSegment(uid)}/trash`;
}

export function trashItemPath(uid: string, trashItemId: string): string {
	return davPath(trashRoot(uid), trashItemId);
}

export function trashRestorePath(uid: string, trashItemId: string): string {
	return davPath(`/remote.php/dav/trashbin/${encodeSegment(uid)}/restore`, trashItemId);
}

export function versionsPath(uid: string, fileId: number, versionId?: string): string {
	const base = `/remote.php/dav/versions/${encodeSegment(uid)}/versions`;
	return versionId === undefined ? `${davPath(base, String(fileId))}/` : davPath(base, String(fileId), versionId);
}

export function versionRestoreTarget(uid: string): string {
	return `/remote.php/dav/versions/${encodeSegment(uid)}/restore/target`;
}

/** Trash item ids are the trash's own names: "<name>.d<unix seconds>". */
export const trashItemIdArg = () =>
	z
		.string()
		.min(4)
		.max(300)
		.regex(/^[^/\\\u0000-\u001f]+\.d\d{1,12}$/, 'must be a trash_item_id from files_list_trash, such as "Plan.docx.d1792926751"')
		.describe('From files_list_trash, such as "Plan.docx.d1792926751".');

export const versionIdArg = () =>
	z
		.string()
		.min(1)
		.max(20)
		.regex(/^\d{1,20}$/, "must be a version_id from files_list_versions")
		.describe("From files_list_versions.");

// ---------------------------------------------------------------------------------------------
// Paging inside the result budget

export interface OffsetPage<T> {
	items: T[];
	offset: number;
	next_cursor: string | null;
	has_more: boolean;
	cut: boolean;
}

/**
 * Offset paging over a full list. `render` builds the whole structuredContent for a candidate
 * page, so the 60,000-character budget is respected; anything that doesn't fit is the next page.
 */
export async function offsetPage<T>(ctx: ToolCtx, all: readonly T[], limit: number, render: (items: T[]) => unknown): Promise<OffsetPage<T>> {
	const raw = await ctx.page.decode<number>();
	const offset = typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
	const window = all.slice(offset, offset + limit);
	const fitted = ctx.page.fit(window, render);
	let items = fitted.items;
	if (items.length === 0 && window.length > 0) items = window.slice(0, 1);
	const next = offset + items.length;
	const has_more = next < all.length;
	if (fitted.cut) ctx.log.note("fit_cut");
	return { items, offset, has_more, next_cursor: has_more ? await ctx.page.encode(next) : null, cut: fitted.cut };
}

// ---------------------------------------------------------------------------------------------
// Type filters

export const FILE_TYPES = ["document", "spreadsheet", "presentation", "pdf", "image", "text"] as const;
export type FileType = (typeof FILE_TYPES)[number];

const TYPE_MIMES: Readonly<Record<FileType, { exact: readonly string[]; prefix?: string }>> = {
	document: {
		exact: [
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.template",
			"application/msword",
			"application/vnd.oasis.opendocument.text",
			"application/rtf",
			"text/rtf",
		],
	},
	spreadsheet: {
		exact: [
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.template",
			"application/vnd.ms-excel",
			"application/vnd.oasis.opendocument.spreadsheet",
			"text/csv",
		],
	},
	presentation: {
		exact: [
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			"application/vnd.openxmlformats-officedocument.presentationml.template",
			"application/vnd.ms-powerpoint",
			"application/vnd.oasis.opendocument.presentation",
		],
	},
	pdf: { exact: ["application/pdf"] },
	image: { exact: [], prefix: "image/" },
	text: { exact: [], prefix: "text/" },
};

export function matchesType(d: { type: "file" | "folder"; mime: string | null }, type: FileType | "folder" | "any"): boolean {
	if (type === "any") return true;
	if (type === "folder") return d.type === "folder";
	if (d.type !== "file" || !d.mime) return false;
	const mime = d.mime.toLowerCase().split(";")[0]?.trim() ?? "";
	const t = TYPE_MIMES[type];
	return t.exact.includes(mime) || (t.prefix !== undefined && mime.startsWith(t.prefix));
}

/** The SEARCH condition for a type filter. */
export function typeWhere(type: FileType | "folder"): XmlFragment {
	if (type === "folder") return rawXml("<d:is-collection/>");
	const t = TYPE_MIMES[type];
	const ops: XmlFragment[] = t.exact.map((m) => where.eq("getcontenttype", m));
	if (t.prefix) ops.push(where.like("getcontenttype", `${t.prefix}%`));
	return where.or(...ops);
}

// ---------------------------------------------------------------------------------------------
// Upload content (DESIGN 14: text 1,000,000 characters, binary 2 MiB after decoding)

const EXT_MIME: Readonly<Record<string, string>> = {
	txt: "text/plain",
	log: "text/plain",
	md: "text/markdown",
	markdown: "text/markdown",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	json: "application/json",
	xml: "application/xml",
	html: "text/html",
	htm: "text/html",
	css: "text/css",
	js: "text/javascript",
	yaml: "application/yaml",
	yml: "application/yaml",
	ics: "text/calendar",
	vcf: "text/vcard",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	pdf: "application/pdf",
	zip: "application/zip",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	odt: "application/vnd.oasis.opendocument.text",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	odp: "application/vnd.oasis.opendocument.presentation",
};

export const mimeArg = () =>
	z
		.string()
		.max(100)
		.regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/, 'must look like "text/plain"')
		.optional()
		.describe('Content type such as "text/csv". Default: from the file name.');

export function mimeFor(name: string, encoding: "text" | "base64", given?: string): string {
	const ext = name.includes(".") ? (name.slice(name.lastIndexOf(".") + 1).toLowerCase() ?? "") : "";
	const mime = given ?? EXT_MIME[ext] ?? (encoding === "text" ? "text/plain" : "application/octet-stream");
	const textual = mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || mime === "application/yaml" || mime === "image/svg+xml";
	return encoding === "text" && textual ? `${mime}; charset=utf-8` : mime;
}

export function sizeWords(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

const BIG_HINT = "the NoDrive app or website handles big files.";

/** The largest base64 string that can decode to at most 2 MiB. */
export const BASE64_MAX_CHARS = Math.ceil(LIMITS.binaryUploadBytes / 3) * 4 + 1024;

export const contentArg = () =>
	z
		.string()
		.max(BASE64_MAX_CHARS)
		.describe('Text, or base64 when encoding is "base64".');

export const encodingArg = () =>
	z.enum(["text", "base64"]).default("text").describe('"base64" for data that isn\'t text.');

/** Checks the size limits and returns the bytes to upload. */
export function uploadBytes(content: string, encoding: "text" | "base64"): Uint8Array {
	if (encoding === "text") {
		if (content.length > LIMITS.textUploadChars) {
			throw new ToolError(
				"too_large",
				`This text is ${content.length.toLocaleString("en-GB")} characters. Text uploads here are limited to 1,000,000 characters; ${BIG_HINT}`,
				{ field: "content" },
			);
		}
		return new TextEncoder().encode(content);
	}
	const s = content.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new ToolError("invalid_input", "content isn't valid base64.", { field: "content" });
	const body = s.replace(/=+$/, "");
	if (body.length % 4 === 1) throw new ToolError("invalid_input", "content isn't valid base64 (its length is wrong).", { field: "content" });
	const decoded = Math.floor((body.length * 3) / 4);
	if (decoded > LIMITS.binaryUploadBytes) {
		throw new ToolError("too_large", `This is ${sizeWords(decoded)}. Uploads here are limited to 2 MB; ${BIG_HINT}`, { field: "content" });
	}
	let bin: string;
	try {
		bin = atob(body + "===".slice((body.length + 3) % 4));
	} catch {
		throw new ToolError("invalid_input", "content isn't valid base64.", { field: "content" });
	}
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

// ---------------------------------------------------------------------------------------------
// DAV SEARCH (verified grammar, see the top of this file)

const PROP = {
	displayname: "<d:displayname/>",
	getcontenttype: "<d:getcontenttype/>",
	getlastmodified: "<d:getlastmodified/>",
	favorite: "<oc:favorite/>",
	fileid: "<oc:fileid/>",
} as const;
type SearchProp = keyof typeof PROP;

const cmp = (op: string, p: SearchProp, v: string | number) => xml`<d:${rawXml(op)}><d:prop>${rawXml(PROP[p])}</d:prop><d:literal>${String(v)}</d:literal></d:${rawXml(op)}>`;

export const where = {
	eq: (p: SearchProp, v: string | number) => cmp("eq", p, v),
	gt: (p: SearchProp, v: string | number) => cmp("gt", p, v),
	gte: (p: SearchProp, v: string | number) => cmp("gte", p, v),
	lt: (p: SearchProp, v: string | number) => cmp("lt", p, v),
	like: (p: SearchProp, v: string) => cmp("like", p, v),
	and: (...ops: XmlFragment[]): XmlFragment => (ops.length === 1 ? (ops[0] as XmlFragment) : xml`<d:and>${ops}</d:and>`),
	or: (...ops: XmlFragment[]): XmlFragment => (ops.length === 1 ? (ops[0] as XmlFragment) : xml`<d:or>${ops}</d:or>`),
	not: (op: XmlFragment): XmlFragment => xml`<d:not>${op}</d:not>`,
	isCollection: (): XmlFragment => rawXml("<d:is-collection/>"),
};

/** "%" and "_" are LIKE wildcards; "\" escapes them (verified). */
export function escapeLike(s: string): string {
	return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export interface SearchSpec {
	scope: UserPath;
	where: XmlFragment;
	order?: { prop: "getlastmodified" | "displayname"; dir: "asc" | "desc" }[];
	limit: number;
	offset?: number;
	/** The SEARCH's own timeout (NoDrive's 20 s by default), for a caller with a fallback to fit in. */
	timeoutMs?: number;
	/** No second try on 502/503/504: for a caller whose fallback is its retry. */
	noRetry?: boolean;
}

/**
 * True when the egress check (core/egress.ts, segmentsSafe) lets this raw path segment through in a
 * SEARCH scope: it percent-decodes every segment and refuses one that doesn't decode, or that
 * decodes to ".", "..", or to something holding "/", "\" or NUL. NoDrive itself takes the scope raw,
 * so such a folder (a name like "100% #1" or "a%2Fb") is fine for NoDrive but can't be sent as one.
 */
function scopeSegmentSafe(seg: string): boolean {
	let dec: string;
	try {
		dec = decodeURIComponent(seg);
	} catch {
		return false;
	}
	return !(dec === "." || dec === ".." || dec.includes("/") || dec.includes("\\") || dec.includes("\u0000"));
}

/**
 * The SEARCH scope for a folder: the folder itself, or, when a segment of it can't travel as a
 * scope (above), its deepest parent that can. A caller given a wider scope filters the results to
 * the folder itself (files_search does).
 */
export function searchScopeFor(folder: UserPath): UserPath {
	let scope = "/" as UserPath;
	for (const seg of segmentsOf(folder)) {
		if (!scopeSegmentSafe(seg)) break;
		scope = (scope === "/" ? `/${seg}` : `${scope}/${seg}`) as UserPath;
	}
	return scope;
}

/** A last check before sending: every scope comes from searchScopeFor() or is "/". */
function checkSearchScope(scope: UserPath): void {
	if (searchScopeFor(scope) !== scope) {
		throw new ToolError("upstream_unavailable", "This search couldn't be sent to NoDrive. Leaving out folder searches everywhere.");
	}
}

export function searchBody(uid: string, s: SearchSpec): string {
	checkSearchScope(s.scope);
	const href = `/files/${encodeSegment(uid)}${s.scope === "/" ? "" : s.scope}`;
	const orders = (s.order ?? []).map(
		(o) => xml`<d:order><d:prop>${rawXml(PROP[o.prop])}</d:prop>${rawXml(o.dir === "asc" ? "<d:ascending/>" : "<d:descending/>")}</d:order>`,
	);
	const body = xml`<d:searchrequest ${rawXml(XMLNS)} xmlns:ns="https://github.com/icewind1991/SearchDAV/ns"><d:basicsearch><d:select><d:prop>${FILE_PROPS}</d:prop></d:select><d:from><d:scope><d:href>${href}</d:href><d:depth>infinity</d:depth></d:scope></d:from><d:where>${s.where}</d:where>${orders.length ? xml`<d:orderby>${orders}</d:orderby>` : null}<d:limit><d:nresults>${s.limit}</d:nresults><ns:firstresult>${s.offset ?? 0}</ns:firstresult></d:limit></d:basicsearch></d:searchrequest>`;
	return `<?xml version="1.0" encoding="UTF-8"?>${body.xml}`;
}

export async function runSearch(ctx: ToolCtx, s: SearchSpec): Promise<FileDetails[]> {
	return (await searchRows(ctx, s)).filter((d): d is FileDetails => d !== null);
}

/**
 * The SEARCH results one to one with NoDrive's answer (null where a response failed or lies outside
 * the person's root), so a caller that filters can still count positions in NoDrive's own order.
 */
export async function searchRows(ctx: ToolCtx, s: SearchSpec): Promise<(FileDetails | null)[]> {
	const opts = { ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}), ...(s.noRetry ? { noRetry: true } : {}) };
	const rs = await ctx.nc.dav.search(searchBody(ctx.uid, s), opts);
	return rs.map((r) => detailOrNull(ctx, r));
}

/** Unix seconds for a date filter: a date means the start of that day in the person's zone. */
export function dateFilterSec(ctx: ToolCtx, raw: string | undefined, field: string): number | undefined {
	if (raw === undefined) return undefined;
	// Core's parse errors quote the text given; this lane's errors never repeat call text (fix round 5).
	try {
		const p = ctx.time.parse(raw, field);
		if (p.kind === "instant") return Math.floor(p.utcMs / 1000);
		const midnight = ctx.time.parse(`${raw}T00:00:00`, field);
		return midnight.kind === "instant" ? Math.floor(midnight.utcMs / 1000) : undefined;
	} catch (e) {
		if (isToolError(e) && e.code === "invalid_input") {
			throw new ToolError("invalid_input", `${field} must be a real date that looks like 2026-11-03 or 2026-11-03T14:30.`, { field });
		}
		throw e;
	}
}


/** True when NoDrive still keeps the version with this id (so an undo can restore it). */
export async function versionKept(ctx: ToolCtx, fileId: number | null, versionId: number | null): Promise<boolean> {
	if (fileId === null || versionId === null) return false;
	try {
		const rs = await ctx.nc.dav.propfind(versionsPath(ctx.uid, fileId), 1, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/></d:prop></d:propfind>');
		return rs.some((r) => {
			const last = r.href.replace(/\/+$/, "").split("/").pop() ?? "";
			return last === String(versionId);
		});
	} catch (e) {
		if (isToolError(e) && e.code === "reconnect_required") throw e;
		return false;
	}
}
