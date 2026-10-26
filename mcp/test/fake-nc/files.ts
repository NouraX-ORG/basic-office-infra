/**
 * Lane A's part of the fake NoDrive (DESIGN 17.3): WebDAV files, DAV SEARCH, the trash, versions,
 * favourites and the "fulltextsearch" unified-search provider, in memory. Behaviour copies what was
 * checked on NC 35.0.2 on 2026-10-25 (see src/tools/files/common.ts):
 * - SEARCH scope hrefs are raw paths; LIKE is case-insensitive with "\" escapes; oc:favorite = "yes";
 * - trash names "<name>.d<time>", original location without "/", file ids kept, "(restored)" names;
 * - the trash and versions restore collections answer 412 to "Overwrite: F" and 201 to "T";
 * - the version list holds the current content with the file's mtime as its id;
 * - removing the top of a received share ends every share on it for the person: a person share
 *   (type 0) for good, the others into "Deleted shares"; GET shares?shared_with_me=true&path= lists
 *   the shares made to the person on that node (see receive()).
 * - when the move to the trash fails (trashFails), a DELETE still answers 204 and removes the item
 *   for good (files_trashbin Storage::doDelete's fallback); failTrashReads makes trash reads fail.
 * - team folders (groupfolders 23.0.1, checked live 2026-10-25 in "QA t1 A Team" as two members):
 *   one tree seen by every member at /<mount point>, nc:mount-type "group", oc:owner-id the member
 *   who asks, the top's Depth 0 permissions "RMGDNVCK" but a DELETE of it answers 403
 *   (View::removeMount); a DELETE inside removes the item for every member and puts it in the team's
 *   one trash, which every member's DAV trash lists (same "<name>.d<time>" id, same file id,
 *   original location "<mount point>/<path inside>"), and any member can restore it (see team()).
 * Use: `const files = installFiles(fake)` after fakeWithQa().
 */
import { parseXml, type XmlEl } from "../../src/core/xml";
import { DRIVE, type FakeNc, ocs, type Recorded } from "./index";

export interface FNode {
	type: "file" | "folder";
	id: number;
	content: Uint8Array;
	mime: string;
	mtime: number;
	ctime: number;
	etag: string;
	favorite: boolean;
	permissions: string;
	/** nc:mount-type: "" own storage, "shared" a received share, "group" a team folder. */
	mountType: "" | "shared" | "group";
	shareTypes: number[];
	owner: string;
	ownerName: string;
	versions: { id: number; content: Uint8Array; author: string; label: string | null }[];
}

/** A share someone else made to the person, as GET shares?shared_with_me=true shows it. */
export interface ReceivedShare {
	id: number;
	/** 0 person, 1 group, 7 team, 12 Deck. */
	shareType: number;
	/** The person it was shared with. */
	uid: string;
	owner: string;
	/** The share's top as the person sees it (file_target). */
	target: string;
	fileId: number;
}

export interface TrashEntry {
	id: string;
	name: string;
	location: string;
	time: number;
	/** The subtree, keyed by path relative to the deleted item ("" is the item itself). */
	nodes: Map<string, FNode>;
}

/** A team folder: one tree for every member at /<mount>, and one trash for all of them. */
export interface FakeTeam {
	mount: string;
	members: string[];
	trash: TrashEntry[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const SEARCH_NS = "https://github.com/icewind1991/SearchDAV/ns";

const MIME: Record<string, string> = {
	txt: "text/plain",
	md: "text/markdown",
	csv: "text/csv",
	json: "application/json",
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/jpeg",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function mimeOf(name: string): string {
	const i = name.lastIndexOf(".");
	return (i > 0 && MIME[name.slice(i + 1).toLowerCase()]) || "application/octet-stream";
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function hrefPath(segments: string[]): string {
	return segments.map((s) => encodeURIComponent(s)).join("/");
}

function parentOf(p: string): string {
	if (p === "/") return "/";
	const i = p.lastIndexOf("/");
	return i <= 0 ? "/" : p.slice(0, i);
}

function nameOf(p: string): string {
	return p === "/" ? "" : p.slice(p.lastIndexOf("/") + 1);
}

function join(parent: string, name: string): string {
	return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function within(p: string, root: string): boolean {
	return root === "/" || p === root || p.startsWith(`${root}/`);
}

function multistatus(inner: string): Response {
	return new Response(
		`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">${inner}</d:multistatus>`,
		{ status: 207, headers: { "content-type": "application/xml; charset=utf-8" } },
	);
}

function davError(status: number, exception: string, message = ""): Response {
	return new Response(
		`<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><s:exception>Sabre\\DAV\\Exception\\${exception}</s:exception><s:message>${esc(message)}</s:message></d:error>`,
		{ status, headers: { "content-type": "application/xml; charset=utf-8" } },
	);
}

function httpDate(sec: number): string {
	return new Date(sec * 1000).toUTCString();
}

function likeToRegex(pattern: string): RegExp {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i] as string;
		if (ch === "\\" && i + 1 < pattern.length) {
			re += (pattern[++i] as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		} else if (ch === "%") re += ".*";
		else if (ch === "_") re += ".";
		else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, "is");
}

export class FakeFiles {
	trees = new Map<string, Map<string, FNode>>();
	trash = new Map<string, TrashEntry[]>();
	/** Paths answering 423. Key "uid:path". */
	locked = new Set<string>();
	/** Free bytes per uid; a PUT that needs more answers 507. */
	free = new Map<string, number>();
	/** Content-search outage: the provider answers 500. */
	ftsDown = false;
	/** Shares made to the person by others (see receive()). */
	received: ReceivedShare[] = [];
	/**
	 * Received shares the person removed that NoDrive's "Deleted shares" lists (group-like types).
	 * A removed person share (type 0) is deleted for good and lands nowhere (NC 35.0.2,
	 * DefaultShareProvider::deleteFromSelf).
	 */
	deletedShares: ReceivedShare[] = [];
	/** The sharing API answers 500 (the share type can't be read). */
	sharesDown = false;
	/** How many of the next PROPFINDs of the trash answer 500 (Infinity: all of them). */
	failTrashReads = 0;
	/** Team folders (see team()). */
	teams: FakeTeam[] = [];
	/**
	 * The move to the trash fails, so a DELETE removes the item for good, as NoDrive's
	 * files_trashbin Storage::doDelete does when Trashbin::move2trash returns false.
	 */
	trashFails = false;
	private nextShareId = 200;
	/** Fixed clock (unix seconds); advanced by every write so mtimes and versions differ. */
	now = 1_792_900_000;
	private nextId = 1000;

	constructor(readonly fake: FakeNc) {}

	tick(): number {
		this.now += 7;
		return this.now;
	}

	tree(uid: string): Map<string, FNode> {
		let t = this.trees.get(uid);
		if (!t) {
			t = new Map();
			t.set("/", this.node("folder", uid, new Uint8Array(0), "httpd/unix-directory"));
			this.trees.set(uid, t);
		}
		return t;
	}

	node(type: "file" | "folder", owner: string, content: Uint8Array, mime: string): FNode {
		const t = this.tick();
		const id = this.nextId++;
		return {
			type,
			id,
			content,
			mime,
			mtime: t,
			ctime: t,
			etag: `etag${id}x${t}`,
			favorite: false,
			permissions: type === "folder" ? "RGDNVCK" : "RGDNVW",
			mountType: "",
			shareTypes: [],
			owner,
			ownerName: this.fake.users.get(owner)?.displayName ?? owner,
			versions: [],
		};
	}

	/** Test setup: makes a folder and its parents. */
	mkdir(uid: string, path: string): FNode {
		const t = this.tree(uid);
		let cur = "/";
		for (const seg of path.split("/").filter(Boolean)) {
			cur = join(cur, seg);
			if (!t.has(cur)) t.set(cur, this.node("folder", uid, new Uint8Array(0), "httpd/unix-directory"));
		}
		return t.get(cur) as FNode;
	}

	/** Test setup: writes a file (parents made as needed). */
	write(uid: string, path: string, content: string | Uint8Array, opts: Partial<FNode> = {}): FNode {
		this.mkdir(uid, parentOf(path));
		const bytes = typeof content === "string" ? enc.encode(content) : content;
		const n = { ...this.node("file", uid, bytes, mimeOf(nameOf(path))), ...opts };
		this.tree(uid).set(path, n);
		return n;
	}

	get(uid: string, path: string): FNode | undefined {
		return this.tree(uid).get(path);
	}

	/**
	 * Test setup: `owner` shares an item with the person, with these share types (several make one
	 * mount, as NoDrive groups them). The top lands at `path` in the person's tree, mount-type shared.
	 */
	receive(uid: string, path: string, opts: { owner: string; types: number[]; folder?: boolean; content?: string; permissions?: string }): FNode {
		const n = opts.folder ? this.mkdir(uid, path) : this.write(uid, path, opts.content ?? "shared");
		Object.assign(n, { mountType: "shared", owner: opts.owner, ownerName: this.fake.users.get(opts.owner)?.displayName ?? opts.owner });
		if (opts.permissions) n.permissions = opts.permissions;
		for (const shareType of opts.types) this.received.push({ id: this.nextShareId++, shareType, uid, owner: opts.owner, target: path, fileId: n.id });
		return n;
	}

	/**
	 * Test setup: a team folder at /<mount> for these members. Its nodes are the same objects in every
	 * member's tree, so a write by one is seen by all.
	 */
	team(mount: string, members: string[]): FakeTeam {
		const team: FakeTeam = { mount, members, trash: [] };
		this.teams.push(team);
		const root = this.node("folder", "", new Uint8Array(0), "httpd/unix-directory");
		Object.assign(root, { mountType: "group", permissions: "RMGDNVCK" });
		for (const m of members) this.tree(m).set(`/${mount}`, root);
		return team;
	}

	/** Test setup: a file in a team folder, `rel` starting with "/" (parent folders made as needed). */
	teamWrite(team: FakeTeam, rel: string, content: string): FNode {
		let cur = `/${team.mount}`;
		const segs = rel.split("/").filter(Boolean);
		for (const seg of segs.slice(0, -1)) {
			cur = join(cur, seg);
			const have = this.tree(team.members[0] as string).get(cur);
			const dir = have ?? Object.assign(this.node("folder", "", new Uint8Array(0), "httpd/unix-directory"), { mountType: "group" as const, permissions: "RMGDNVCK" });
			for (const m of team.members) this.tree(m).set(cur, dir);
		}
		const n = Object.assign(this.node("file", "", enc.encode(content), mimeOf(segs[segs.length - 1] ?? "")), { mountType: "group" as const, permissions: "RMGDNVW" });
		for (const m of team.members) this.tree(m).set(join(cur, segs[segs.length - 1] as string), n);
		return n;
	}

	/** The team folder that holds this path for this member, if any. */
	teamOf(uid: string, path: string): FakeTeam | undefined {
		return this.teams.find((t) => t.members.includes(uid) && within(path, `/${t.mount}`));
	}

	/** Moves an item inside a team folder to the team's trash: gone for every member, same file ids. */
	toTeamTrash(team: FakeTeam, path: string): TrashEntry {
		const time = this.tick();
		const nodes = new Map<string, FNode>();
		for (const m of team.members) {
			const t = this.tree(m);
			for (const [p, n] of [...t]) {
				if (!within(p, path)) continue;
				nodes.set(p.slice(path.length), n);
				t.delete(p);
			}
		}
		const entry: TrashEntry = { id: `${nameOf(path)}.d${time}`, name: nameOf(path), location: path.slice(1), time, nodes };
		team.trash.push(entry);
		return entry;
	}

	/** Every trash entry the person sees: their own and those of their team folders. */
	trashOf(uid: string): TrashEntry[] {
		return [...(this.trash.get(uid) ?? []), ...this.teams.filter((t) => t.members.includes(uid)).flatMap((t) => t.trash)];
	}

	text(uid: string, path: string): string | undefined {
		const n = this.get(uid, path);
		return n ? dec.decode(n.content) : undefined;
	}

	sizeOf(uid: string, path: string): number {
		const t = this.tree(uid);
		const n = t.get(path);
		if (!n) return 0;
		if (n.type === "file") return n.content.byteLength;
		let s = 0;
		for (const [p, c] of t) if (c.type === "file" && within(p, path) && p !== path) s += c.content.byteLength;
		return s;
	}

	children(uid: string, path: string): string[] {
		return [...this.tree(uid).keys()].filter((p) => p !== "/" && parentOf(p) === path && p !== path);
	}

	propXml(uid: string, path: string, n: FNode): string {
		const segs = path.split("/").filter(Boolean);
		const href = `/remote.php/dav/files/${encodeURIComponent(uid)}${segs.length ? `/${hrefPath(segs)}` : ""}${n.type === "folder" ? "/" : ""}`;
		const size = this.sizeOf(uid, path);
		const fileOnly =
			n.type === "file"
				? `<d:getcontenttype>${esc(n.mime)}</d:getcontenttype><d:getcontentlength>${n.content.byteLength}</d:getcontentlength><d:resourcetype/>`
				: `<d:resourcetype><d:collection/></d:resourcetype>`;
		const shares = n.shareTypes.map((s) => `<oc:share-type>${s}</oc:share-type>`).join("");
		// In a team folder NoDrive names the member who asks as the owner (checked live).
		const owner = n.mountType === "group" ? uid : n.owner;
		const ownerName = n.mountType === "group" ? (this.fake.users.get(uid)?.displayName ?? uid) : n.ownerName;
		return `<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop><d:displayname>${esc(path === "/" ? uid : nameOf(path))}</d:displayname>${fileOnly}<d:getlastmodified>${httpDate(n.mtime)}</d:getlastmodified><d:getetag>&quot;${n.etag}&quot;</d:getetag><oc:fileid>${n.id}</oc:fileid><oc:size>${size}</oc:size><oc:permissions>${n.permissions}</oc:permissions><oc:favorite>${n.favorite ? 1 : 0}</oc:favorite><oc:owner-id>${esc(owner)}</oc:owner-id><oc:owner-display-name>${esc(ownerName)}</oc:owner-display-name><oc:share-types>${shares}</oc:share-types><nc:has-preview>${n.type === "file" && n.mime.startsWith("image/") ? "true" : "false"}</nc:has-preview><nc:mount-type>${n.mountType}</nc:mount-type><nc:creation_time>${n.ctime}</nc:creation_time><nc:hidden>false</nc:hidden></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
	}

	/** Moves an item (and everything under it) to the trash. */
	toTrash(uid: string, path: string): TrashEntry {
		const t = this.tree(uid);
		const time = this.tick();
		const nodes = new Map<string, FNode>();
		for (const [p, n] of [...t]) {
			if (within(p, path)) {
				nodes.set(p.slice(path.length), n);
				t.delete(p);
			}
		}
		const entry: TrashEntry = { id: `${nameOf(path)}.d${time}`, name: nameOf(path), location: path.slice(1), time, nodes };
		const list = this.trash.get(uid) ?? [];
		list.push(entry);
		this.trash.set(uid, list);
		return entry;
	}
}

/** The decoded user path from a /remote.php/dav/files/{uid}/... pathname, or null. */
function filesPath(pathname: string): { uid: string; path: string } | null {
	const m = /^\/remote\.php\/dav\/files\/([^/]+)(\/.*)?$/.exec(pathname);
	if (!m) return null;
	try {
		const uid = decodeURIComponent(m[1] as string);
		const segs = (m[2] ?? "/").split("/").filter(Boolean).map(decodeURIComponent);
		return { uid, path: segs.length ? `/${segs.join("/")}` : "/" };
	} catch {
		return null;
	}
}

function destination(req: Recorded): string | null {
	const d = req.headers.get("destination");
	if (!d) return null;
	try {
		const u = new URL(d);
		if (u.origin !== DRIVE) return null;
		return u.pathname;
	} catch {
		return null;
	}
}

function depthOf(req: Recorded): number {
	return req.headers.get("depth") === "0" ? 0 : 1;
}

function el(root: XmlEl, local: string): XmlEl | undefined {
	return root.children.find((c) => c.local === local);
}

function propName(e: XmlEl | undefined): string {
	const p = e?.children.find((c) => c.local === "prop")?.children[0];
	return p ? `${p.ns === "DAV:" ? "d" : p.ns.includes("owncloud") ? "oc" : "nc"}:${p.local}` : "";
}

export function installFiles(fake: FakeNc): FakeFiles {
	const files = new FakeFiles(fake);
	const unauthorized = () => new Response("", { status: 401 });

	function authFor(req: Recorded, uid: string): Response | null {
		if (!req.auth) return unauthorized();
		if (req.auth !== uid) return davError(404, "NotFound", "Principal not found");
		return null;
	}

	// PROPFIND on files.
	fake.on("PROPFIND", /^\/remote\.php\/dav\/files\//, (req) => {
		const fp = filesPath(req.url.pathname);
		if (!fp) return davError(400, "BadRequest");
		const bad = authFor(req, fp.uid);
		if (bad) return bad;
		const t = files.tree(fp.uid);
		const n = t.get(fp.path);
		if (!n) return davError(404, "NotFound", `File with name ${fp.path} could not be located`);
		let out = files.propXml(fp.uid, fp.path, n);
		if (depthOf(req) === 1 && n.type === "folder") for (const c of files.children(fp.uid, fp.path)) out += files.propXml(fp.uid, c, t.get(c) as FNode);
		return multistatus(out);
	});

	fake.on("GET", /^\/remote\.php\/dav\/files\//, (req) => {
		const fp = filesPath(req.url.pathname);
		if (!fp) return davError(400, "BadRequest");
		const bad = authFor(req, fp.uid);
		if (bad) return bad;
		const n = files.get(fp.uid, fp.path);
		if (!n) return davError(404, "NotFound");
		if (n.type === "folder") return davError(405, "MethodNotAllowed");
		const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
		const total = n.content.byteLength;
		if (range) {
			const from = Number(range[1]);
			const to = Math.min(Number(range[2]), total - 1);
			return new Response(n.content.slice(from, to + 1), {
				status: 206,
				headers: { "content-type": n.mime, etag: `"${n.etag}"`, "content-range": `bytes ${from}-${to}/${total}` },
			});
		}
		return new Response(n.content, { status: 200, headers: { "content-type": n.mime, etag: `"${n.etag}"`, "content-length": String(total) } });
	});

	fake.on("PUT", /^\/remote\.php\/dav\/files\//, (req) => {
		const fp = filesPath(req.url.pathname);
		if (!fp) return davError(400, "BadRequest");
		const bad = authFor(req, fp.uid);
		if (bad) return bad;
		const t = files.tree(fp.uid);
		const parent = t.get(parentOf(fp.path));
		// NC 35.0.2 answers 404 (not 409) when the folder is missing or is a file (checked live 2026-10-25).
		if (!parent || parent.type !== "folder") return davError(404, "NotFound", `File with name ${parentOf(fp.path)} could not be located`);
		if (files.locked.has(`${fp.uid}:${fp.path}`)) return davError(423, "Locked");
		const existing = t.get(fp.path);
		const inm = req.headers.get("if-none-match");
		const im = req.headers.get("if-match");
		if (inm === "*" && existing) return davError(412, "PreconditionFailed", "An If-None-Match header was specified, but the ETag matched");
		if (im && (!existing || im.replace(/"/g, "") !== existing.etag)) return davError(412, "PreconditionFailed", "An If-Match header was specified, but none of the specified ETags matched.");
		if (existing?.type === "folder") return davError(409, "Conflict");
		const bytes = enc.encode(req.body);
		const free = files.free.get(fp.uid);
		if (free !== undefined && bytes.byteLength > free) return davError(507, "InsufficientStorage");
		if (existing) {
			existing.versions.push({ id: existing.mtime, content: existing.content, author: fp.uid, label: null });
			existing.content = bytes;
			existing.mtime = files.tick();
			existing.etag = `etag${existing.id}x${existing.mtime}`;
			return new Response(null, { status: 204, headers: { etag: `"${existing.etag}"` } });
		}
		const n = files.node("file", fp.uid, bytes, mimeOf(nameOf(fp.path)));
		t.set(fp.path, n);
		return new Response(null, { status: 201, headers: { etag: `"${n.etag}"` } });
	});

	fake.on("MKCOL", /^\/remote\.php\/dav\/files\//, (req) => {
		const fp = filesPath(req.url.pathname);
		if (!fp) return davError(400, "BadRequest");
		const bad = authFor(req, fp.uid);
		if (bad) return bad;
		const t = files.tree(fp.uid);
		if (t.has(fp.path)) return davError(405, "MethodNotAllowed", "The resource you tried to create already exists");
		const parent = t.get(parentOf(fp.path));
		if (!parent || parent.type !== "folder") return davError(409, "Conflict", "Parent node does not exist");
		t.set(fp.path, files.node("folder", fp.uid, new Uint8Array(0), "httpd/unix-directory"));
		return new Response(null, { status: 201 });
	});

	const transfer = (copy: boolean) => (req: Recorded) => {
		const fp = filesPath(req.url.pathname);
		const destPath = destination(req);
		const dp = destPath ? filesPath(destPath) : null;
		if (!fp || !dp) return davError(400, "BadRequest", "The destination header was not supplied");
		const bad = authFor(req, fp.uid) ?? authFor(req, dp.uid);
		if (bad) return bad;
		const t = files.tree(fp.uid);
		const src = t.get(fp.path);
		if (!src) return davError(404, "NotFound");
		// Sabre's order: destination parent, destination exists (412 with Overwrite F), identical, subtree.
		const destParent = t.get(parentOf(dp.path));
		if (!destParent || destParent.type !== "folder") return davError(409, "Conflict", "The destination node is not found");
		const exists = t.has(dp.path);
		if (exists && req.headers.get("overwrite") !== "T") return davError(412, "PreconditionFailed", "The destination node already exists, and the overwrite header is set to false");
		if (dp.path === fp.path) return davError(403, "Forbidden", "Source and destination uri are identical.");
		if (within(dp.path, fp.path)) return davError(409, "Conflict", "The destination may not be part of the same subtree as the source path.");
		if (files.locked.has(`${fp.uid}:${fp.path}`)) return davError(423, "Locked");
		for (const [p, n] of [...t]) {
			if (!within(p, fp.path)) continue;
			const np = dp.path + p.slice(fp.path.length);
			if (copy) t.set(np, { ...files.node(n.type, fp.uid, n.content, n.mime), mime: n.mime });
			else {
				t.delete(p);
				t.set(np, n);
			}
		}
		return new Response(null, { status: exists ? 204 : 201 });
	};
	fake.on("MOVE", /^\/remote\.php\/dav\/files\//, transfer(false));
	fake.on("COPY", /^\/remote\.php\/dav\/files\//, transfer(true));

	fake.on("DELETE", /^\/remote\.php\/dav\/files\//, (req) => {
		const fp = filesPath(req.url.pathname);
		if (!fp) return davError(400, "BadRequest");
		const bad = authFor(req, fp.uid);
		if (bad) return bad;
		if (fp.path === "/") return davError(403, "Forbidden");
		const t = files.tree(fp.uid);
		const n = t.get(fp.path);
		if (!n) return davError(404, "NotFound");
		if (files.locked.has(`${fp.uid}:${fp.path}`)) return davError(423, "Locked");
		const parent = t.get(parentOf(fp.path));
		if (n.mountType === "group") {
			const team = files.teamOf(fp.uid, fp.path);
			if (!team) return new Response("Internal Server Error", { status: 500 });
			// The top of a team folder: View::removeMount returns false, so Sabre answers 403.
			if (parent?.mountType !== "group") return davError(403, "Forbidden");
			if (files.trashFails) {
				for (const m of team.members) for (const p of [...files.tree(m).keys()]) if (within(p, fp.path)) files.tree(m).delete(p);
			} else files.toTeamTrash(team, fp.path);
			return new Response(null, { status: 204 });
		}
		if (n.mountType === "shared" && parent?.mountType !== "shared") {
			// The top of a received share: every share on that mount ends for the person
			// (SharedStorage::unshareStorage). Person shares go for good; the others go to Deleted shares.
			for (const p of [...t.keys()]) if (within(p, fp.path)) t.delete(p);
			const mine = files.received.filter((s) => s.uid === fp.uid && s.fileId === n.id);
			files.received = files.received.filter((s) => !mine.includes(s));
			files.deletedShares.push(...mine.filter((s) => s.shareType !== 0));
		} else if (files.trashFails) {
			for (const p of [...t.keys()]) if (within(p, fp.path)) t.delete(p);
		} else files.toTrash(fp.uid, fp.path);
		return new Response(null, { status: 204 });
	});

	fake.on("PROPPATCH", /^\/remote\.php\/dav\/files\//, (req) => {
		const fp = filesPath(req.url.pathname);
		if (!fp) return davError(400, "BadRequest");
		const bad = authFor(req, fp.uid);
		if (bad) return bad;
		const n = files.get(fp.uid, fp.path);
		if (!n) return davError(404, "NotFound");
		const root = parseXml(req.body);
		const fav = (function find(e: XmlEl): XmlEl | undefined {
			if (e.local === "favorite") return e;
			for (const c of e.children) {
				const f = find(c);
				if (f) return f;
			}
			return undefined;
		})(root);
		if (fav) n.favorite = fav.text.trim() === "1";
		const href = `/remote.php/dav/files/${encodeURIComponent(fp.uid)}/${hrefPath(fp.path.split("/").filter(Boolean))}`;
		return multistatus(`<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop><oc:favorite/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
	});

	// DAV SEARCH (basicsearch).
	fake.on("SEARCH", /^\/remote\.php\/dav\/?$/, (req) => {
		if (!req.auth) return unauthorized();
		const uid = req.auth;
		let root: XmlEl;
		try {
			root = parseXml(req.body);
		} catch {
			return davError(400, "BadRequest", "Invalid XML");
		}
		const bs = el(root, "basicsearch");
		if (!bs) return davError(400, "BadRequest");
		const scopeHref = el(el(el(bs, "from") as XmlEl, "scope") as XmlEl, "href")?.text.trim() ?? "";
		const base = `/files/${uid}`;
		if (!(scopeHref === base || scopeHref.startsWith(`${base}/`))) return davError(400, "BadRequest", "invalid scope");
		const scope = scopeHref.slice(base.length) || "/";
		const t = files.tree(uid);
		const scopeNode = t.get(scope);
		if (!scopeNode || scopeNode.type !== "folder") return davError(404, "NotFound", `File with name ${scope} could not be located`);
		let ops = 0;
		const evalOp = (e: XmlEl, p: string, n: FNode): boolean => {
			ops++;
			const kids = e.children;
			switch (e.local) {
				case "and":
					return kids.every((k) => evalOp(k, p, n));
				case "or":
					return kids.some((k) => evalOp(k, p, n));
				case "not":
					return !evalOp(kids[0] as XmlEl, p, n);
				case "is-collection":
					return n.type === "folder";
				default: {
					const prop = propName(e);
					const lit = el(e, "literal")?.text ?? "";
					const value: string | number | boolean =
						prop === "d:displayname"
							? nameOf(p)
							: prop === "d:getcontenttype"
								? n.type === "folder"
									? "httpd/unix-directory"
									: n.mime
								: prop === "d:getlastmodified"
									? n.mtime
									: prop === "oc:favorite"
										? n.favorite
										: prop === "oc:fileid"
											? n.id
											: "";
					const lv = prop === "oc:favorite" ? lit === "yes" : typeof value === "number" ? Number(lit) : lit;
					switch (e.local) {
						case "eq":
							return value === lv;
						case "gt":
							return value > lv;
						case "gte":
							return value >= lv;
						case "lt":
							return value < lv;
						case "lte":
							return value <= lv;
						case "like":
							return likeToRegex(lit).test(String(value));
						default:
							throw new Error(`fake SEARCH: unsupported ${e.local}`);
					}
				}
			}
		};
		const whereEl = el(bs, "where")?.children[0];
		const matches = [...t].filter(([p, n]) => p !== scope && within(p, scope) && (!whereEl || evalOp(whereEl, p, n)));
		if (ops > 100 * Math.max(1, t.size)) return davError(400, "BadRequest", "too many operators");
		const orders = (el(bs, "orderby")?.children ?? []).map((o) => ({ prop: propName(o), desc: o.children.some((c) => c.local === "descending") }));
		matches.sort(([pa, a], [pb, b]) => {
			for (const o of orders) {
				const va = o.prop === "d:getlastmodified" ? a.mtime : nameOf(pa).toLowerCase();
				const vb = o.prop === "d:getlastmodified" ? b.mtime : nameOf(pb).toLowerCase();
				if (va !== vb) return (va < vb ? -1 : 1) * (o.desc ? -1 : 1);
			}
			return 0;
		});
		const limit = el(bs, "limit");
		const n = Number(limit?.children.find((c) => c.local === "nresults")?.text ?? "100") || 100;
		const first = Number(limit?.children.find((c) => c.local === "firstresult" && c.ns === SEARCH_NS)?.text ?? "0") || 0;
		return multistatus(
			matches
				.slice(first, first + n)
				.map(([p, nd]) => files.propXml(uid, p, nd))
				.join(""),
		);
	});

	// Trash.
	const trashProps = (uid: string, e: TrashEntry) => {
		const item = e.nodes.get("") as FNode;
		const href = `/remote.php/dav/trashbin/${encodeURIComponent(uid)}/trash/${encodeURIComponent(e.id)}${item.type === "folder" ? "/" : ""}`;
		const size = [...e.nodes.values()].filter((n) => n.type === "file").reduce((s, n) => s + n.content.byteLength, 0);
		const type = item.type === "folder" ? "<d:resourcetype><d:collection/></d:resourcetype>" : `<d:resourcetype/><d:getcontentlength>${size}</d:getcontentlength><d:getcontenttype>${esc(item.mime)}</d:getcontenttype>`;
		return `<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop>${type}<oc:size>${size}</oc:size><oc:fileid>${item.id}</oc:fileid><nc:trashbin-filename>${esc(e.name)}</nc:trashbin-filename><nc:trashbin-original-location>${esc(e.location)}</nc:trashbin-original-location><nc:trashbin-deletion-time>${e.time}</nc:trashbin-deletion-time></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
	};
	const trashMatch = (pathname: string) => {
		const m = /^\/remote\.php\/dav\/trashbin\/([^/]+)\/trash(?:\/([^/]+))?\/?$/.exec(pathname);
		return m ? { uid: decodeURIComponent(m[1] as string), id: m[2] ? decodeURIComponent(m[2]) : null } : null;
	};
	fake.on("PROPFIND", /^\/remote\.php\/dav\/trashbin\//, (req) => {
		const m = trashMatch(req.url.pathname);
		if (!m) return davError(404, "NotFound");
		const bad = authFor(req, m.uid);
		if (bad) return bad;
		if (files.failTrashReads > 0) {
			files.failTrashReads--;
			return new Response("Internal Server Error", { status: 500 });
		}
		const list = files.trashOf(m.uid);
		if (m.id) {
			const e = list.find((x) => x.id === m.id);
			return e ? multistatus(trashProps(m.uid, e)) : davError(404, "NotFound");
		}
		const self = `<d:response><d:href>/remote.php/dav/trashbin/${encodeURIComponent(m.uid)}/trash/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
		return multistatus(self + (depthOf(req) === 1 ? list.map((e) => trashProps(m.uid, e)).join("") : ""));
	});
	fake.on("MOVE", /^\/remote\.php\/dav\/trashbin\//, (req) => {
		const m = trashMatch(req.url.pathname);
		const dest = destination(req) ?? "";
		if (!m?.id) return davError(404, "NotFound");
		const bad = authFor(req, m.uid);
		if (bad) return bad;
		if (!new RegExp(`^/remote\\.php/dav/trashbin/${encodeURIComponent(m.uid)}/restore/[^/]+$`).test(dest)) return davError(403, "Forbidden");
		const list = files.trash.get(m.uid) ?? [];
		const team = files.teams.find((x) => x.members.includes(m.uid) && x.trash.some((y) => y.id === m.id));
		const e = list.find((x) => x.id === m.id) ?? team?.trash.find((x) => x.id === m.id);
		if (!e) return davError(404, "NotFound");
		if (req.headers.get("overwrite") !== "T") return davError(412, "PreconditionFailed", "The destination node already exists, and the overwrite header is set to false");
		if (team && team.trash.includes(e)) {
			// Back into the team folder, for every member (the old place is inside it).
			const target = `/${e.location}`;
			for (const mem of team.members) for (const [rel, n] of e.nodes) files.tree(mem).set(target + rel, n);
			team.trash = team.trash.filter((x) => x !== e);
			return new Response(null, { status: 201 });
		}
		const t = files.tree(m.uid);
		let location = parentOf(`/${e.location}`);
		if (!t.get(location) || t.get(location)?.type !== "folder") location = "/";
		let name = e.name;
		if (t.has(join(location, name))) {
			const i = name.lastIndexOf(".");
			const stem = i > 0 ? name.slice(0, i) : name;
			const ext = i > 0 ? name.slice(i) : "";
			name = `${stem} (restored)${ext}`;
			for (let k = 2; t.has(join(location, name)); k++) name = `${stem} (restored ${k})${ext}`;
		}
		const target = join(location, name);
		for (const [rel, n] of e.nodes) t.set(target + rel, n);
		files.trash.set(
			m.uid,
			list.filter((x) => x !== e),
		);
		return new Response(null, { status: 201 });
	});

	// Versions.
	const versionMatch = (pathname: string) => {
		const m = /^\/remote\.php\/dav\/versions\/([^/]+)\/versions\/(\d+)(?:\/(\d+))?\/?$/.exec(pathname);
		return m ? { uid: decodeURIComponent(m[1] as string), fileId: Number(m[2]), vid: m[3] ? Number(m[3]) : null } : null;
	};
	const byId = (uid: string, id: number): [string, FNode] | undefined => [...files.tree(uid)].find(([, n]) => n.id === id);
	fake.on("PROPFIND", /^\/remote\.php\/dav\/versions\//, (req) => {
		const m = versionMatch(req.url.pathname);
		if (!m) return davError(404, "NotFound");
		const bad = authFor(req, m.uid);
		if (bad) return bad;
		const hit = byId(m.uid, m.fileId);
		if (!hit || hit[1].type !== "file") return davError(404, "NotFound");
		const n = hit[1];
		const base = `/remote.php/dav/versions/${encodeURIComponent(m.uid)}/versions/${m.fileId}`;
		const v = (id: number, content: Uint8Array, author: string, label: string | null) =>
			`<d:response><d:href>${base}/${id}</d:href><d:propstat><d:prop><d:getlastmodified>${httpDate(id)}</d:getlastmodified><d:getcontentlength>${content.byteLength}</d:getcontentlength><d:getcontenttype>${esc(n.mime)}</d:getcontenttype><nc:version-author>${esc(author)}</nc:version-author>${label ? `<nc:version-label>${esc(label)}</nc:version-label>` : ""}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>${label ? "" : "<d:propstat><d:prop><nc:version-label/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>"}</d:response>`;
		const self = `<d:response><d:href>${base}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
		return multistatus(self + n.versions.map((x) => v(x.id, x.content, x.author, x.label)).join("") + v(n.mtime, n.content, n.owner, null));
	});
	fake.on("MOVE", /^\/remote\.php\/dav\/versions\//, (req) => {
		const m = versionMatch(req.url.pathname);
		if (!m || m.vid === null) return davError(404, "NotFound");
		const bad = authFor(req, m.uid);
		if (bad) return bad;
		if (destination(req) !== `/remote.php/dav/versions/${encodeURIComponent(m.uid)}/restore/target`) return davError(403, "Forbidden");
		const hit = byId(m.uid, m.fileId);
		if (!hit) return davError(404, "NotFound");
		const n = hit[1];
		const v = n.versions.find((x) => x.id === m.vid);
		if (!v) return davError(404, "NotFound");
		if (req.headers.get("overwrite") !== "T") return davError(412, "PreconditionFailed", "The destination node already exists, and the overwrite header is set to false");
		n.versions = n.versions.filter((x) => x !== v);
		n.versions.push({ id: n.mtime, content: n.content, author: m.uid, label: null });
		n.content = v.content;
		n.mtime = v.id;
		n.etag = `etag${n.id}x${n.mtime}r`;
		return new Response(null, { status: 201 });
	});

	// Unified search: words inside files (fulltextsearch).
	fake.on("GET", /^\/ocs\/v2\.php\/search\/providers\/fulltextsearch\/search$/, (req) => {
		if (!req.auth) return unauthorized();
		if (files.ftsDown) return new Response("Internal Server Error", { status: 500 });
		const term = (req.url.searchParams.get("term") ?? "").toLowerCase();
		const limit = Number(req.url.searchParams.get("limit") ?? "5");
		const cursor = Number(req.url.searchParams.get("cursor") ?? "0") || 0;
		const page = Math.floor(cursor / limit);
		const hits = [...files.tree(req.auth)]
			.filter(([, n]) => n.type === "file" && dec.decode(n.content).toLowerCase().includes(term))
			.sort(([a], [b]) => a.localeCompare(b));
		const entries = hits.slice(page * limit, page * limit + limit).map(([p, n]) => ({
			thumbnailUrl: "",
			title: `(files) ${dec.decode(n.content).slice(0, 80)}`,
			subline: p.slice(1),
			resourceUrl: `/f/${n.id}`,
			icon: "",
			rounded: false,
			attributes: [],
		}));
		return ocs({ name: "Full Text Search", isPaginated: true, entries, cursor: cursor + limit });
	});

	// Shares made to the person (ShareAPIController::getShares with shared_with_me=true, NC 35.0.2):
	// path must exist in the person's own view (else 404), and picks the shares of that node.
	fake.on("GET", /^\/ocs\/v2\.php\/apps\/files_sharing\/api\/v1\/shares$/, (req) => {
		if (!req.auth) return unauthorized();
		if (files.sharesDown) return new Response("Internal Server Error", { status: 500 });
		const viewer = req.auth;
		const q = req.url.searchParams;
		if (q.get("shared_with_me") !== "true") return ocs([]);
		const path = q.get("path");
		let node: FNode | undefined;
		if (path !== null) {
			node = files.get(viewer, path);
			if (!node) return ocs([], 404, "Wrong path, file/folder does not exist");
		}
		const rows = files.received
			.filter((s) => s.uid === viewer && (!node || s.fileId === node.id))
			.map((s) => {
				const n = files.get(viewer, s.target);
				const ownerName = fake.users.get(s.owner)?.displayName ?? s.owner;
				return {
					id: String(s.id),
					share_type: s.shareType,
					uid_owner: s.owner,
					displayname_owner: ownerName,
					uid_file_owner: s.owner,
					displayname_file_owner: ownerName,
					path: s.target,
					item_type: n?.type === "folder" ? "folder" : "file",
					item_source: s.fileId,
					file_source: s.fileId,
					file_target: s.target,
					share_with: s.shareType === 0 ? viewer : "qa-group",
					permissions: 19,
				};
			});
		return ocs(rows);
	});

	// The Files app's recent list (ApiController::getRecentFiles, NC 35.0.2): plain JSON, the 100
	// newest items, mtime in milliseconds, path = the parent folder. Without OCS-APIRequest the CSRF
	// check fails (412).
	fake.on("GET", /^\/index\.php\/apps\/files\/api\/v1\/recent\/?$/, (req) => {
		if (!req.auth) return unauthorized();
		if (req.headers.get("ocs-apirequest") !== "true") return Response.json({ message: "CSRF check failed" }, { status: 412 });
		const rows = [...files.tree(req.auth)]
			.filter(([p]) => p !== "/")
			.sort(([, a], [, b]) => b.mtime - a.mtime)
			.slice(0, 100)
			.map(([p, n]) => ({
				id: n.id,
				parentId: 1,
				mtime: n.mtime * 1000,
				name: nameOf(p),
				permissions: 27,
				mimetype: n.type === "folder" ? "httpd/unix-directory" : n.mime,
				size: n.type === "folder" ? 0 : n.content.byteLength,
				type: n.type === "folder" ? "dir" : "file",
				etag: n.etag,
				hasPreview: false,
				path: parentOf(p),
				...(n.shareTypes.length ? { shareTypes: n.shareTypes } : {}),
			}));
		return Response.json({ files: rows });
	});

	return files;
}
