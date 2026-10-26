/**
 * Lane B's part of the fake: the OCS sharing API (shares, sharees) and a small file tree answering
 * PROPFIND Depth 0, with the response shapes of NC 35.0.2's ShareAPIController and
 * ShareesAPIController (read on the server). Privacy between organisations is modelled as on the
 * live server: people and groups are found and shared with only when they share a group with the
 * caller (admin never counts), and only the caller's own groups. Server refusal texts are the real
 * ones, so the tools' own wording is what the tests see.
 */
import { DRIVE, type FakeNc, ocs, type Recorded } from "./index";

export interface FakeNode {
	type: "file" | "folder";
	fileId: number;
	/** oc:permissions letters, e.g. "RGDNVW" for an own file. */
	perms: string;
}

export interface FakeShare {
	id: number;
	share_type: number;
	uid_owner: string;
	/** The owner's path. */
	path: string;
	item_type: "file" | "folder";
	file_source: number;
	share_with: string | null;
	permissions: number;
	expiration: string | null;
	token: string | null;
	password: string | null;
	hide_download: boolean;
	label: string;
	note: string;
	stime: number;
	mail_send: boolean;
}

export interface FakeSharing {
	trees: Map<string, Map<string, FakeNode>>;
	groups: Map<string, { displayName: string; members: Set<string> }>;
	shares: FakeShare[];
	/** Privacy between organisations (default on, as on the live server). */
	privacy: boolean;
	/** Password policy minimum length (the server default is 10). */
	minPasswordLength: number;
	/** Makes the hide-download PUT fail (to test the roll-back). */
	failHideDownload: boolean;
	addNode(uid: string, path: string, type: "file" | "folder", perms?: string): FakeNode;
	addGroup(gid: string, displayName: string, members: string[]): void;
	nextId: number;
}

function err(status: number, message: string): Response {
	return ocs([], status, message);
}

function encPath(p: string): string {
	return p
		.split("/")
		.map((s) => encodeURIComponent(s))
		.join("/");
}

export function installSharing(fake: FakeNc): FakeSharing {
	let fileIds = 1000;
	const sh: FakeSharing = {
		trees: new Map(),
		groups: new Map(),
		shares: [],
		privacy: true,
		minPasswordLength: 10,
		failHideDownload: false,
		nextId: 500,
		addNode(uid, path, type, perms) {
			let t = sh.trees.get(uid);
			if (!t) {
				t = new Map([["/", { type: "folder", fileId: fileIds++, perms: "RGDNVCK" }]]);
				sh.trees.set(uid, t);
			}
			const n: FakeNode = { type, fileId: fileIds++, perms: perms ?? (type === "folder" ? "RGDNVCK" : "RGDNVW") };
			t.set(path, n);
			return n;
		},
		addGroup(gid, displayName, members) {
			sh.groups.set(gid, { displayName, members: new Set(members) });
		},
	};

	const groupsOf = (uid: string) => [...sh.groups.entries()].filter(([, g]) => g.members.has(uid)).map(([gid]) => gid);
	const shareGroup = (a: string, b: string) => groupsOf(a).some((g) => g !== "admin" && sh.groups.get(g)?.members.has(b));
	const mayFindUser = (caller: string, uid: string) => !sh.privacy || shareGroup(caller, uid);
	const mayUseGroup = (caller: string, gid: string) => !sh.privacy || (gid !== "admin" && (sh.groups.get(gid)?.members.has(caller) ?? false));
	const displayName = (uid: string) => fake.users.get(uid)?.displayName ?? uid;
	const nodeOf = (uid: string, path: string) => sh.trees.get(uid)?.get(path === "" ? "/" : path);

	function format(viewer: string, s: FakeShare): Record<string, unknown> {
		const own = s.uid_owner === viewer;
		const out: Record<string, unknown> = {
			id: String(s.id),
			share_type: s.share_type,
			uid_owner: s.uid_owner,
			displayname_owner: displayName(s.uid_owner),
			permissions: s.permissions,
			can_edit: own,
			can_delete: own,
			stime: s.stime,
			parent: null,
			expiration: s.expiration ? `${s.expiration} 00:00:00` : null,
			token: s.token,
			uid_file_owner: s.uid_owner,
			note: s.note,
			label: s.label,
			displayname_file_owner: displayName(s.uid_owner),
			path: own ? s.path : `/${s.path.split("/").pop()}`,
			item_type: s.item_type,
			mimetype: s.item_type === "folder" ? "httpd/unix-directory" : "application/octet-stream",
			has_preview: false,
			storage_id: `home::${s.uid_owner}`,
			storage: 3,
			item_source: s.file_source,
			file_source: s.file_source,
			file_parent: 1,
			file_target: `/${s.path.split("/").pop()}`,
			item_size: 10,
			item_mtime: s.stime,
			mail_send: s.mail_send ? 1 : 0,
			hide_download: s.hide_download ? 1 : 0,
			attributes: null,
		};
		if (s.share_type === 0) {
			out.share_with = s.share_with;
			out.share_with_displayname = displayName(s.share_with ?? "");
			out.share_with_displayname_unique = fake.users.get(s.share_with ?? "")?.email ?? s.share_with;
		} else if (s.share_type === 1) {
			out.share_with = s.share_with;
			out.share_with_displayname = sh.groups.get(s.share_with ?? "")?.displayName ?? s.share_with;
		} else if (s.share_type === 3) {
			out.share_with = s.password ? "redacted" : null;
			out.share_with_displayname = "(Shared link)";
			out.password = s.password ? "redacted" : null;
			out.send_password_by_talk = false;
			out.url = own && s.token ? `${DRIVE}/s/${s.token}` : null;
		}
		return out;
	}

	const visibleTo = (viewer: string, s: FakeShare) =>
		s.uid_owner === viewer || (s.share_type === 0 && s.share_with === viewer) || (s.share_type === 1 && sh.groups.get(s.share_with ?? "")?.members.has(viewer));

	async function body(req: Recorded): Promise<Record<string, unknown>> {
		if (!req.body) return {};
		const ct = req.headers.get("content-type") ?? "";
		if (ct.includes("json")) return JSON.parse(req.body) as Record<string, unknown>;
		return Object.fromEntries(new URLSearchParams(req.body));
	}

	const today = () => new Date().toISOString().slice(0, 10);
	const unauthorized = () => err(401, "Current user is not logged in");

	// PROPFIND Depth 0 of one item (what files.stat asks for).
	fake.on("PROPFIND", /^\/remote\.php\/dav\/files\/([^/]+)(\/.*)?$/, (req, _f, m) => {
		if (!req.auth) return new Response("", { status: 401 });
		const uid = decodeURIComponent(m[1] as string);
		if (uid !== req.auth) return new Response("", { status: 403 });
		const path = decodeURIComponent((m[2] ?? "/").replace(/\/$/, "")) || "/";
		const n = nodeOf(uid, path);
		if (!n) return new Response("<d:error xmlns:d=\"DAV:\"/>", { status: 404 });
		const href = `/remote.php/dav/files/${encodeURIComponent(uid)}${path === "/" ? "/" : encPath(path)}${n.type === "folder" && path !== "/" ? "/" : ""}`;
		const rt = n.type === "folder" ? "<d:collection/>" : "";
		const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${rt}</d:resourcetype><d:getetag>"e${n.fileId}"</d:getetag><d:getlastmodified>Sat, 24 Oct 2026 10:00:00 GMT</d:getlastmodified>${n.type === "file" ? "<d:getcontenttype>application/octet-stream</d:getcontenttype><d:getcontentlength>10</d:getcontentlength>" : ""}<oc:fileid>${n.fileId}</oc:fileid><oc:size>10</oc:size><oc:permissions>${n.perms}</oc:permissions><oc:favorite>0</oc:favorite><oc:owner-id>${uid}</oc:owner-id><oc:share-types/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
		return new Response(xml, { status: 207, headers: { "content-type": "application/xml; charset=utf-8" } });
	});

	fake.on("GET", /^\/ocs\/v2\.php\/apps\/files_sharing\/api\/v1\/sharees$/, (req) => {
		if (!req.auth) return unauthorized();
		const q = req.url.searchParams;
		const search = (q.get("search") ?? "").toLowerCase();
		const types = q.getAll("shareType[]").map(Number);
		const perPage = Number(q.get("perPage") ?? "200");
		const users: unknown[] = [];
		const exactUsers: unknown[] = [];
		const groups: unknown[] = [];
		const exactGroups: unknown[] = [];
		if (types.length === 0 || types.includes(0)) {
			for (const u of fake.users.values()) {
				if (!mayFindUser(req.auth, u.uid)) continue;
				const hit = u.uid.toLowerCase().includes(search) || u.displayName.toLowerCase().includes(search);
				if (!hit) continue;
				const entry = { label: u.displayName, subline: "", icon: "icon-user", value: { shareType: 0, shareWith: u.uid }, shareWithDisplayNameUnique: u.email ?? u.uid, status: [] };
				if (u.uid.toLowerCase() === search || u.displayName.toLowerCase() === search) exactUsers.push(entry);
				else users.push(entry);
			}
		}
		if (types.length === 0 || types.includes(1)) {
			for (const [gid, g] of sh.groups) {
				if (!mayUseGroup(req.auth, gid)) continue;
				if (!gid.toLowerCase().includes(search) && !g.displayName.toLowerCase().includes(search)) continue;
				const entry = { label: g.displayName, value: { shareType: 1, shareWith: gid } };
				if (gid.toLowerCase() === search || g.displayName.toLowerCase() === search) exactGroups.push(entry);
				else groups.push(entry);
			}
		}
		return ocs({
			exact: { users: exactUsers, groups: exactGroups, remotes: [], remote_groups: [], emails: [], circles: [], rooms: [] },
			users: users.slice(0, perPage),
			groups: groups.slice(0, perPage),
			remotes: [],
			remote_groups: [],
			emails: [],
			lookup: [],
			circles: [],
			rooms: [],
			lookupEnabled: false,
		});
	});

	fake.on("POST", /^\/ocs\/v2\.php\/apps\/files_sharing\/api\/v1\/shares$/, async (req) => {
		if (!req.auth) return unauthorized();
		const b = await body(req);
		const path = String(b.path ?? "");
		const node = nodeOf(req.auth, path);
		if (!node) return err(404, "Wrong path, file/folder does not exist");
		if (path === "/") return err(403, "You cannot share your root folder");
		const type = Number(b.shareType);
		let perms = b.permissions === undefined ? 31 : Number(b.permissions);
		if (type !== 3) perms |= 1;
		if (node.type === "file") perms &= ~(8 | 4);
		if (perms === 0) return err(403, "Valid permissions are required for sharing");
		const withId = b.shareWith === undefined ? null : String(b.shareWith);
		if (type === 0) {
			if (!withId || !fake.users.has(withId)) return err(404, "Please specify a valid account to share with");
			if (withId === req.auth) return err(403, "Cannot share with yourself");
			if (!mayFindUser(req.auth, withId)) return err(403, "Sharing is only allowed with group members");
			// NC 35 hands back an identical existing share (Manager::createShare reuses it).
			const dup = sh.shares.find((s) => s.share_type === 0 && s.share_with === withId && s.path === path);
			if (dup) return ocs(format(req.auth, dup));
		} else if (type === 1) {
			if (!withId || !sh.groups.has(withId)) return err(404, "Please specify a valid group");
			if (!mayUseGroup(req.auth, withId)) return err(403, "Sharing is only allowed within your own groups");
			const dup = sh.shares.find((s) => s.share_type === 1 && s.share_with === withId && s.path === path);
			if (dup) return ocs(format(req.auth, dup));
		} else if (type === 3) {
			if (!(perms & 1) && !(perms & 4)) return err(400, "Share must at least have READ or CREATE permissions");
			const pw = typeof b.password === "string" ? b.password : "";
			if (pw && pw.length < sh.minPasswordLength) return err(403, `Password needs to be at least ${sh.minPasswordLength} characters long.`);
			if (pw && /^(password|123456)/i.test(pw)) return err(403, "Password is among the 1,000,000 most common ones. Please make it unique.");
		} else if (type === 7) {
			return err(404, "You cannot share to a Team if the app is not enabled");
		} else {
			return err(400, "Unknown share type");
		}
		const exp = typeof b.expireDate === "string" && b.expireDate ? b.expireDate : null;
		if (exp && exp <= today()) return err(403, "Expiration date is in the past");
		const s: FakeShare = {
			id: sh.nextId++,
			share_type: type,
			uid_owner: req.auth,
			path,
			item_type: node.type,
			file_source: node.fileId,
			share_with: type === 3 ? null : withId,
			permissions: perms,
			expiration: exp,
			token: type === 3 ? `tok${sh.nextId}abcdefghij` : null,
			password: type === 3 && typeof b.password === "string" && b.password ? b.password : null,
			hide_download: false,
			label: typeof b.label === "string" ? b.label : "",
			note: typeof b.note === "string" ? b.note : "",
			// The share time in Unix seconds, from the clock the test runs on (as the server stamps it).
			stime: Math.floor(Date.now() / 1000),
			mail_send: b.sendMail === "true",
		};
		sh.shares.push(s);
		return ocs(format(req.auth, s));
	});

	fake.on("GET", /^\/ocs\/v2\.php\/apps\/files_sharing\/api\/v1\/shares$/, (req) => {
		if (!req.auth) return unauthorized();
		const viewer = req.auth;
		const q = req.url.searchParams;
		if (q.get("shared_with_me") === "true") {
			return ocs(sh.shares.filter((s) => s.uid_owner !== viewer && visibleTo(viewer, s)).map((s) => format(viewer, s)));
		}
		const path = q.get("path");
		if (path !== null) {
			const node = nodeOf(viewer, path);
			if (!node) return err(404, "Wrong path, file/folder does not exist");
			// reshares=true adds other people's shares of the same file (their reshares), by file id.
			const reshares = q.get("reshares") === "true";
			return ocs(
				sh.shares.filter((s) => (s.uid_owner === viewer && s.path === path) || (reshares && s.uid_owner !== viewer && s.file_source === node.fileId)).map((s) => format(viewer, s)),
			);
		}
		return ocs(sh.shares.filter((s) => s.uid_owner === viewer).map((s) => format(viewer, s)));
	});

	fake.on("GET", /^\/ocs\/v2\.php\/apps\/files_sharing\/api\/v1\/shares\/(\d+)$/, (req, _f, m) => {
		if (!req.auth) return unauthorized();
		const s = sh.shares.find((x) => x.id === Number(m[1]));
		if (!s || !visibleTo(req.auth, s)) return err(404, "Wrong share ID, share does not exist");
		return ocs([format(req.auth, s)]);
	});

	fake.on("PUT", /^\/ocs\/v2\.php\/apps\/files_sharing\/api\/v1\/shares\/(\d+)$/, async (req, _f, m) => {
		if (!req.auth) return unauthorized();
		const s = sh.shares.find((x) => x.id === Number(m[1]));
		if (!s || !visibleTo(req.auth, s)) return err(404, "Wrong share ID, share does not exist");
		if (s.uid_owner !== req.auth) return err(403, "You are not allowed to edit incoming shares");
		const b = await body(req);
		if (Object.keys(b).length === 0) return err(400, "Wrong or no update parameter given");
		if (b.hideDownload !== undefined && sh.failHideDownload) return new Response("Internal Server Error", { status: 500 });
		if (b.permissions !== undefined) s.permissions = Number(b.permissions);
		if (b.password !== undefined) {
			const pw = String(b.password);
			if (pw && pw.length < sh.minPasswordLength) return err(403, `Password needs to be at least ${sh.minPasswordLength} characters long.`);
			s.password = pw || null;
		}
		if (b.expireDate !== undefined) {
			const e = String(b.expireDate);
			if (e && e <= today()) return err(400, "Expiration date is in the past");
			s.expiration = e || null;
		}
		if (b.note !== undefined) s.note = String(b.note);
		if (b.label !== undefined && s.share_type === 3) s.label = String(b.label);
		if (b.hideDownload !== undefined && s.share_type === 3) s.hide_download = b.hideDownload === "true";
		return ocs(format(req.auth, s));
	});

	fake.on("DELETE", /^\/ocs\/v2\.php\/apps\/files_sharing\/api\/v1\/shares\/(\d+)$/, (req, _f, m) => {
		if (!req.auth) return unauthorized();
		const i = sh.shares.findIndex((x) => x.id === Number(m[1]));
		const s = sh.shares[i];
		if (!s || !visibleTo(req.auth, s)) return err(404, "Wrong share ID, share does not exist");
		if (s.uid_owner !== req.auth) return err(403, "Could not delete share");
		sh.shares.splice(i, 1);
		return ocs([]);
	});

	return sh;
}
