/**
 * The path normaliser (DESIGN 10.6). Input paths are relative to the person's NoDrive root, for
 * example "/Documents/a.docx". Unsafe input is refused, never "fixed": no "." or ".." segments, no
 * control characters, no backslashes. Input is literal and never percent-decoded. Every DAV URL and
 * Destination header is built here, under /remote.php/dav/files/{uid}/.
 *
 * Two rules for names (fix round 3). A name that refers to an item that may already exist (any
 * segment of a path, a name kept by a move or copy) follows what NoDrive itself refuses (NC 35.0.2
 * FilenameValidator, read on the server): empty, "." or ".." once trimmed, "/", "\", control
 * characters, .htaccess, and the .part and .filepart endings it always forbids. NoDrive accepts names
 * that start or end with a space (desktop and mobile clients, other people in shared folders and
 * public uploads make them), so those can be listed, read, moved and shared. A new name a tool
 * chooses (new_name, the last part of a path a tool creates) keeps the stricter rule: no space at
 * either end, which also keeps names safe for the Windows desktop client.
 */
import { ToolError } from "./errors";

declare const userPathBrand: unique symbol;
/** A normalised path inside the person's NoDrive: starts with "/", no trailing "/", "/" is the root. */
export type UserPath = string & { readonly [userPathBrand]: true };

const MAX_PATH_CHARS = 1024;
const MAX_PATH_BYTES = 1024;
const MAX_SEGMENT_BYTES = 250;
const enc = new TextEncoder();

/** C0 and C1 controls, DEL, line and paragraph separators, and the byte-order mark. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the point
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff\\]/;

function bad(message: string, field: string): never {
	throw new ToolError("invalid_input", message, { field });
}

/**
 * Checks one name (a single path segment) as a new name a tool chooses: the existing-item rules
 * plus no space at either end. Returns it NFC-normalised.
 */
export function checkName(raw: string, field = "name"): string {
	const name = existingName(raw, field);
	if (name !== name.trim()) bad(`${field} can't start or end with a space.`, field);
	return name;
}

/** Checks one name of an item that may already exist: only what NoDrive itself refuses (see the top). */
export function existingName(raw: string, field = "name"): string {
	if (typeof raw !== "string") bad(`${field} must be text.`, field);
	const name = raw.normalize("NFC");
	if (name.length === 0) bad(`${field} is empty.`, field);
	if (name.includes("/")) bad(`${field} must be one name, not a path (it has a "/").`, field);
	if (FORBIDDEN_CHARS.test(name)) bad(`${field} has a character that isn't allowed in names.`, field);
	const trimmed = name.trim();
	if (trimmed === "") bad(`${field} can't be only spaces.`, field);
	if (trimmed === "." || trimmed === "..") bad(`${field} can't be "." or "..".`, field);
	if (enc.encode(name).length > MAX_SEGMENT_BYTES) bad(`${field} is too long (250 bytes at most per name).`, field);
	const lower = name.toLowerCase();
	if (lower === ".htaccess" || lower.endsWith(".part") || lower.endsWith(".filepart")) {
		bad(`NoDrive doesn't allow a name like "${name}".`, field);
	}
	return name;
}

/**
 * Normalises a path. A missing leading "/" is added, "//" collapses and a trailing "/" is dropped.
 * `allowRoot: false` refuses "/" itself (for example for moving to the trash). Every segment follows
 * the existing-item rule; `newName: true` holds the last one to checkName's rule (a path a tool is
 * about to create).
 */
export function normalizePath(raw: unknown, opts: { field?: string; allowRoot?: boolean; newName?: boolean } = {}): UserPath {
	const field = opts.field ?? "path";
	if (typeof raw !== "string") bad(`${field} must be text.`, field);
	const s = raw.normalize("NFC");
	if (s.length > MAX_PATH_CHARS || enc.encode(s).length > MAX_PATH_BYTES) bad(`${field} is too long (1,024 characters at most).`, field);
	if (FORBIDDEN_CHARS.test(s)) {
		bad(`${field} has a character that isn't allowed in paths (control characters and "\\" are refused).`, field);
	}
	const segments = s.split("/").filter((x) => x.length > 0);
	for (const seg of segments) existingName(seg, field);
	const last = segments[segments.length - 1];
	if (opts.newName && last !== undefined) checkName(last, field);
	if (segments.length === 0) {
		if (opts.allowRoot === false) bad(`${field} can't be the top folder "/".`, field);
		return "/" as UserPath;
	}
	return `/${segments.join("/")}` as UserPath;
}

export function isRoot(p: UserPath): boolean {
	return p === "/";
}

export function segmentsOf(p: UserPath): string[] {
	return p === "/" ? [] : p.slice(1).split("/");
}

export function parentOf(p: UserPath): UserPath {
	const segs = segmentsOf(p);
	segs.pop();
	return (segs.length ? `/${segs.join("/")}` : "/") as UserPath;
}

export function basenameOf(p: UserPath): string {
	const segs = segmentsOf(p);
	return segs[segs.length - 1] ?? "";
}

/** `name` may be an existing item's name (a move or copy keeps it); new names are checked by the caller. */
export function joinPath(parent: UserPath, name: string): UserPath {
	const n = existingName(name);
	return (parent === "/" ? `/${n}` : `${parent}/${n}`) as UserPath;
}

/** True when `inner` is `outer` or inside it. */
export function isWithin(inner: UserPath, outer: UserPath): boolean {
	if (outer === "/") return true;
	return inner === outer || inner.startsWith(`${outer}/`);
}

/** Splits "report.final.docx" into "report.final" and ".docx". Names starting with "." have no extension. */
export function splitExt(name: string): { stem: string; ext: string } {
	const i = name.lastIndexOf(".");
	if (i <= 0) return { stem: name, ext: "" };
	return { stem: name.slice(0, i), ext: name.slice(i) };
}

/** "name (2).ext" for n = 2. */
export function numberedName(name: string, n: number): string {
	const { stem, ext } = splitExt(name);
	return `${stem} (${n})${ext}`;
}

/** Percent-encodes one segment for a URL path. */
export function encodeSegment(s: string): string {
	return encodeURIComponent(s);
}

/** "/remote.php/dav/files/{uid}" (no trailing slash). */
export function davFilesRoot(uid: string): string {
	return `/remote.php/dav/files/${encodeSegment(uid)}`;
}

/** The DAV path of a NoDrive item. Folders may take a trailing slash. */
export function davFilesPath(uid: string, p: UserPath, opts: { trailingSlash?: boolean } = {}): string {
	const segs = segmentsOf(p).map(encodeSegment);
	const tail = segs.length ? `/${segs.join("/")}` : "";
	const slash = opts.trailingSlash || segs.length === 0 ? "/" : "";
	return `${davFilesRoot(uid)}${tail}${slash}`;
}

/** Builds a DAV path from already-checked segments under a fixed prefix (calendars, trash, versions). */
export function davPath(prefix: string, ...segments: string[]): string {
	for (const s of segments) {
		if (s.length === 0 || s === "." || s === ".." || s.includes("/") || FORBIDDEN_CHARS.test(s)) {
			throw new ToolError("invalid_input", "An id in the request isn't valid.");
		}
	}
	const tail = segments.map(encodeSegment).join("/");
	return tail ? `${prefix.replace(/\/+$/, "")}/${tail}` : prefix;
}

/**
 * Turns a multistatus href back into a UserPath. Returns null for anything outside the person's
 * prefix (the caller logs `href_outside` and drops it).
 */
export function hrefToUserPath(href: string, uid: string): UserPath | null {
	let path = href;
	try {
		if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
	} catch {
		return null;
	}
	const raw = path.split("/").filter((x) => x.length > 0);
	const decoded: string[] = [];
	for (const r of raw) {
		let seg: string;
		try {
			seg = decodeURIComponent(r);
		} catch {
			return null;
		}
		if (seg === "." || seg === ".." || seg.includes("/") || FORBIDDEN_CHARS.test(seg)) return null;
		decoded.push(seg.normalize("NFC"));
	}
	// Expect: remote.php / dav / files / {uid} / ...rest
	if (decoded.length < 4 || decoded[0] !== "remote.php" || decoded[1] !== "dav" || decoded[2] !== "files") return null;
	if (decoded[3] !== uid) return null;
	const rest = decoded.slice(4);
	return (rest.length ? `/${rest.join("/")}` : "/") as UserPath;
}
