/**
 * File primitives (DESIGN 18.3): stat, read, writeNew, overwrite, fileIdOf, and the FileItem shape
 * built from a PROPFIND answer. Every path is a UserPath from the normaliser, and every URL is built
 * under /remote.php/dav/files/{uid}/.
 */
import { ToolError } from "../core/errors";
import { LIMITS } from "../core/limits";
import { basenameOf, davFilesPath, hrefToUserPath, joinPath, numberedName, parentOf, type UserPath } from "../core/paths";
import { type FileItem, type Permissions, permissionsFrom } from "../core/shapes";
import { rawXml, type XmlFragment } from "../core/xml";
import type { NcClient } from "./client";
import { type DavResponse, isCollection, NS, propEl, propText, XMLNS } from "./multistatus";

/** The props every file listing asks for (verified on NC 35.0.2). */
export const FILE_PROPS = rawXml(
	"<d:displayname/><d:getcontenttype/><d:getcontentlength/><d:getlastmodified/><d:getetag/><d:resourcetype/>" +
		"<oc:fileid/><oc:size/><oc:permissions/><oc:favorite/><oc:owner-id/><oc:owner-display-name/><oc:share-types/>" +
		"<nc:has-preview/><nc:mount-type/><nc:creation_time/><nc:hidden/>",
);

export function propfindBody(props: XmlFragment = FILE_PROPS, extra = ""): string {
	return `<?xml version="1.0" encoding="UTF-8"?><d:propfind ${XMLNS}><d:prop>${props.xml}${extra}</d:prop></d:propfind>`;
}

export interface FileDetails extends FileItem {
	created: string | null;
	owner: { user_id: string | null; display_name: string | null };
	permissions: Permissions;
	share_types: string[];
	shared_with_me: boolean;
	has_preview: boolean;
	hidden: boolean;
}

const SHARE_TYPE_NAMES: Record<string, string> = { "0": "person", "1": "group", "3": "link", "4": "email", "6": "federated", "7": "team" };

function httpDateToIso(s: string | null): string | null {
	if (!s) return null;
	const t = Date.parse(s);
	return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Builds a FileItem (and details) from one PROPFIND response. Returns null for hrefs outside the person's root. */
export function toFileDetails(r: DavResponse, uid: string, driveOrigin: string): FileDetails | null {
	const path = hrefToUserPath(r.href, uid);
	if (path === null) return null;
	const folder = isCollection(r);
	const fileIdText = propText(r, NS.oc, "fileid");
	const fileId = fileIdText && /^\d+$/.test(fileIdText) ? Number(fileIdText) : null;
	const sizeText = folder ? (propText(r, NS.oc, "size") ?? propText(r, NS.d, "getcontentlength")) : (propText(r, NS.d, "getcontentlength") ?? propText(r, NS.oc, "size"));
	const size = sizeText && /^-?\d+$/.test(sizeText) ? Math.max(0, Number(sizeText)) : 0;
	const shareTypes = (propEl(r, NS.oc, "share-types")?.children ?? []).map((c) => c.text.trim()).filter(Boolean);
	const created = propText(r, NS.nc, "creation_time");
	const name = path === "/" ? "/" : basenameOf(path);
	const etag = propText(r, NS.d, "getetag");
	return {
		path,
		name,
		type: folder ? "folder" : "file",
		mime: folder ? null : propText(r, NS.d, "getcontenttype"),
		size,
		modified: httpDateToIso(propText(r, NS.d, "getlastmodified")),
		etag: etag ? etag.replace(/^"(.*)"$/, "$1") : null,
		file_id: fileId,
		favorite: propText(r, NS.oc, "favorite") === "1",
		shared: shareTypes.length > 0,
		web_url: fileId !== null ? `${driveOrigin}/f/${fileId}` : null,
		created: created && /^\d+$/.test(created) && created !== "0" ? new Date(Number(created) * 1000).toISOString() : null,
		owner: { user_id: propText(r, NS.oc, "owner-id"), display_name: propText(r, NS.oc, "owner-display-name") },
		permissions: permissionsFrom(propText(r, NS.oc, "permissions"), folder),
		share_types: shareTypes.map((t) => SHARE_TYPE_NAMES[t] ?? "other"),
		shared_with_me: propText(r, NS.nc, "mount-type") === "shared",
		has_preview: propText(r, NS.nc, "has-preview") === "true",
		hidden: propText(r, NS.nc, "hidden") === "true",
	};
}

/** Just the FileItem fields. */
export function toFileItem(d: FileDetails): FileItem {
	return {
		path: d.path,
		name: d.name,
		type: d.type,
		mime: d.mime,
		size: d.size,
		modified: d.modified,
		etag: d.etag,
		file_id: d.file_id,
		favorite: d.favorite,
		shared: d.shared,
		web_url: d.web_url,
	};
}

export interface FilesApi {
	/** PROPFIND Depth 0. Throws not_found when missing. */
	stat(path: UserPath): Promise<FileDetails>;
	/** GET with an optional byte range. */
	read(path: UserPath, opts?: { maxBytes?: number; range?: [number, number] }): Promise<{ bytes: Uint8Array; mime: string | null; etag: string | null; truncated: boolean; size: number | null }>;
	/** PUT with If-None-Match: *. "rename" tries "name (2)" up to "name (20)". */
	writeNew(path: UserPath, bytes: Uint8Array | string, mime: string, ifExists: "fail" | "rename"): Promise<{ item: FileDetails; path: UserPath; renamed: boolean }>;
	/** PUT with If-Match: <etag>. A 412 becomes conflict. */
	overwrite(path: UserPath, bytes: Uint8Array | string, etag: string, mime?: string): Promise<{ item: FileDetails; previousEtag: string }>;
	fileIdOf(path: UserPath): Promise<number>;
}

export function filesApi(nc: NcClient, driveOrigin: string): FilesApi {
	const uid = nc.uid;
	async function stat(path: UserPath): Promise<FileDetails> {
		const rs = await nc.dav.propfind(davFilesPath(uid, path), 0, propfindBody(), { what: path });
		const first = rs[0];
		const d = first ? toFileDetails(first, uid, driveOrigin) : null;
		if (!d) throw new ToolError("not_found", `There's no file or folder at ${path}.`, { hint: "files_search can find it by name." });
		return d;
	}
	return {
		stat,
		async read(path, opts = {}) {
			const maxBytes = opts.maxBytes ?? LIMITS.readTextSourceBytes;
			const headers: Record<string, string> = {};
			if (opts.range) headers.range = `bytes=${opts.range[0]}-${opts.range[1]}`;
			else headers.range = `bytes=0-${maxBytes - 1}`;
			const res = await nc.dav.get(davFilesPath(uid, path), { headers, what: path, allow: [206] });
			const total = (() => {
				const cr = res.headers.get("content-range");
				const m = cr ? /\/(\d+)$/.exec(cr) : null;
				if (m) return Number(m[1]);
				const cl = res.headers.get("content-length");
				return cl && /^\d+$/.test(cl) && res.status === 200 ? Number(cl) : null;
			})();
			const bytes = await nc.readBytes(res, maxBytes);
			const etag = res.headers.get("etag");
			return {
				bytes,
				mime: res.headers.get("content-type"),
				etag: etag ? etag.replace(/^"(.*)"$/, "$1") : null,
				size: total,
				truncated: total !== null ? total > bytes.length : false,
			};
		},
		async writeNew(path, bytes, mime, ifExists) {
			const parent = parentOf(path);
			const name = basenameOf(path);
			for (let n = 1; n <= 20; n++) {
				const target = n === 1 ? path : joinPath(parent, numberedName(name, n));
				const res = await nc.dav.put(davFilesPath(uid, target), bytes, {
					headers: { "content-type": mime, "if-none-match": "*" },
					allow: [412],
					what: target,
					precondition: "if-none-match",
				});
				if (res.status === 412) {
					await res.body?.cancel();
					if (ifExists === "fail") {
						throw new ToolError("already_exists", `${target} already exists.`, { hint: 'Use if_exists "rename", or files_overwrite_file to replace it.' });
					}
					continue;
				}
				await res.body?.cancel();
				return { item: await stat(target), path: target, renamed: n > 1 };
			}
			throw new ToolError("already_exists", `${path} and 19 numbered copies of it already exist.`);
		},
		async overwrite(path, bytes, etag, mime) {
			const quoted = etag.startsWith('"') ? etag : `"${etag}"`;
			const res = await nc.dav.put(davFilesPath(uid, path), bytes, {
				headers: { "if-match": quoted, ...(mime ? { "content-type": mime } : {}) },
				what: path,
				precondition: "if-match",
			});
			await res.body?.cancel();
			return { item: await stat(path), previousEtag: etag.replace(/^"(.*)"$/, "$1") };
		},
		async fileIdOf(path) {
			const d = await stat(path);
			if (d.file_id === null) throw new ToolError("upstream_unavailable", "NoDrive didn't return a file id.");
			return d.file_id;
		},
	};
}
