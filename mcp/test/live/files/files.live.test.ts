/**
 * Lane A's live cases (DESIGN 17.6): every files tool, for real, under `wrangler dev --env dev`, as
 * QA account qa-t1-a-files-1 against drive.nourax.org, from this PC (the owner's IP). A second QA
 * account, qa-t1-a-files-2 in the same QA group (privacy between organisations is on), shares a
 * folder with that group and a file with the first account alone, through the Worker's own sharing
 * tools, for the received-share cases. test/live/files/qa-accounts.sh makes both accounts.
 *
 * Everything happens inside new items named after this run: /MCP-QA-A-<run>/ for the person,
 * /MCP-QA-A2-<run>/ and one file for the sharer, and one top-folder file that the restore case puts
 * there. The last step moves each to its owner's trash (the rule-3 exception: only what these cases
 * made). Isolation cases try qa-t1-30's paths with traversal, encoded tricks and web addresses; each
 * is refused locally.
 *
 * Base URL: NX_LIVE_BASE (default http://localhost:8787, the shared runner). Lane A runs its own dev
 * server on :8800 with test/live/files/vitest.lane-a.config.ts. QA accounts: NX_LIVE_UID_A and
 * NX_LIVE_SHARER_A, in the QA group NX_LIVE_GROUP_A.
 *
 * The received-share case also checks NoDrive directly, not only through the Worker: the person's
 * "Deleted shares" list and the owner's share ids, over OCS. Those requests need the two accounts'
 * app passwords, read from a netrc file in the scratchpad (NX_LIVE_NETRC_A; never in the repo or
 * printed). Without it that case fails, because the warning text alone proves nothing.
 *
 * Both accounts are members of the team folder "QA t1 A Team" (NX_LIVE_TEAM_A; qa-accounts.sh makes
 * it like the admin API does: every permission, advanced permissions on). The team-folder case puts
 * one file there, checks that removing it removes it for the other member too and that the other
 * member's own trash lists it, and moves it to the trash again at the end.
 *
 * Fix round 3: no files_ summary or error text may repeat a path or a name (src/tools/files/common.ts),
 * and every path here holds the run id, so call() checks each one for it.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brandScan } from "../_shared/client";

const BASE = process.env.NX_LIVE_BASE ?? "http://localhost:8787";
const UID = process.env.NX_LIVE_UID_A ?? "qa-t1-a-files-1";
const SHARER = process.env.NX_LIVE_SHARER_A ?? "qa-t1-a-files-2";
const GROUP = process.env.NX_LIVE_GROUP_A ?? "qa-t1-a-org";
const NETRC = process.env.NX_LIVE_NETRC_A;
const DRIVE = "https://drive.nourax.org";
const TARGET = process.env.NX_LIVE_ISOLATION_UID ?? "qa-t1-30";
const RUN = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
const ROOT = `/MCP-QA-A-${RUN}`;
const SHARED_DIR = `MCP-QA-A2-${RUN}`;
const SHARED_FILE = `MCP-QA-A2-${RUN}.txt`;
const ORPHAN = `orphan-${RUN}.txt`;
const MIXED_FILE = `MCP-QA-A2m-${RUN}.txt`;
const WORD = `zqx${RUN}kiwi`;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const TEAM = process.env.NX_LIVE_TEAM_A ?? "QA t1 A Team";
const TEAM_FILE = `/${TEAM}/team ${RUN}.txt`;

interface Result {
	isError?: boolean;
	content: { type: string; text: string }[];
	structuredContent?: Record<string, unknown>;
	_meta?: Record<string, { code?: string }>;
}

const tokens: Record<string, string> = {};
let rid = 1;
/** Top-level items outside ROOT that a case made and the clean-up must trash: [token owner, path]. */
const extraCleanup: [string, string][] = [];

async function devToken(uid: string, scopes: string[]): Promise<string> {
	const res = await fetch(`${BASE}/dev/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ uid, scopes }),
	});
	if (!res.ok) throw new Error(`dev token for ${uid}: ${res.status}`);
	return ((await res.json()) as { access_token: string }).access_token;
}

async function rpc(method: string, params: unknown, as = UID): Promise<{ status: number; json: Record<string, unknown>; raw: string }> {
	const res = await fetch(`${BASE}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${tokens[as]}` },
		body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params }),
	});
	const raw = await res.text();
	let json: Record<string, unknown> = {};
	try {
		if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
			for (const line of raw.split(/\r?\n/)) {
				if (!line.startsWith("data:")) continue;
				const j = JSON.parse(line.slice(5)) as Record<string, unknown>;
				if ("result" in j || "error" in j) json = j;
			}
		} else if (raw) json = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		throw new Error(`${method} answered ${res.status} with something that isn't JSON: ${raw.slice(0, 400)}`);
	}
	return { status: res.status, json, raw };
}

async function call(name: string, args: Record<string, unknown> = {}, as = UID): Promise<Result> {
	const r = await rpc("tools/call", { name, arguments: args }, as);
	expect(r.status, name).toBe(200);
	brandScan(name, r.raw);
	const result = r.json.result as Result | undefined;
	if (!result) throw new Error(`${name}: no result (${r.raw.slice(0, 300)})`);
	// Lane A's rule: the summary (or the whole error) never repeats a path or a name, and every path
	// in this run holds RUN. Other lanes' tools (sharing_) keep their own rules.
	if (name.startsWith("files_")) {
		const t = result.content[0]?.text ?? "";
		expect(result.isError ? t : t.split("\n")[0], `${name} repeats a path outside the data frame`).not.toContain(RUN);
	}
	return result;
}

async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}, as = UID): Promise<T> {
	const r = await call(name, args, as);
	if (r.isError) throw new Error(`${name} failed: ${r.content[0]?.text}`);
	return r.structuredContent as T;
}

function codeOf(r: Result): string | undefined {
	return r._meta?.["nourax/error"]?.code;
}

function summary(r: Result): string {
	return r.content[0]?.text.split("\n")[0] ?? "";
}

function fieldOf(r: Result): string | undefined {
	return (r._meta?.["nourax/error"] as { field?: string } | undefined)?.field;
}

/** Basic auth for a QA account, from the netrc file (the value is never printed). */
function basicAuth(uid: string): string {
	if (!NETRC) throw new Error("NX_LIVE_NETRC_A isn't set: the received-share case checks NoDrive directly and needs it.");
	const words = readFileSync(NETRC, "utf8").split(/\s+/).filter(Boolean);
	for (let i = 0; i < words.length; i++) {
		if (words[i] !== "machine" || words[i + 1] !== "drive.nourax.org") continue;
		let login: string | undefined;
		let password: string | undefined;
		for (let j = i + 2; j < words.length && words[j] !== "machine"; j += 2) {
			if (words[j] === "login") login = words[j + 1];
			if (words[j] === "password") password = words[j + 1];
		}
		if (login === uid && password) return `Basic ${btoa(`${uid}:${password}`)}`;
	}
	throw new Error(`the netrc file has no drive.nourax.org entry for ${uid}`);
}

/** An OCS GET straight to NoDrive as a QA account: the HTTP status and the OCS data. */
async function ocsGet(uid: string, path: string): Promise<{ status: number; data: unknown }> {
	const res = await fetch(`${DRIVE}${path}${path.includes("?") ? "&" : "?"}format=json`, {
		headers: { authorization: basicAuth(uid), "ocs-apirequest": "true", accept: "application/json" },
	});
	const body = (await res.json().catch(() => null)) as { ocs?: { data?: unknown } } | null;
	return { status: res.status, data: body?.ocs?.data ?? null };
}

const SHARES_API = "/ocs/v2.php/apps/files_sharing/api/v1";

type Item = { path: string; name: string; type: string; size: number; etag: string; file_id: number; favorite: boolean; mime: string | null; web_url: string; modified: string };
type Undo = { tool: string; arguments: Record<string, unknown> };

const NOTES = `${ROOT}/notes_${RUN}.md`;
const ORIGINAL = `# Notes\n${WORD} hello from lane A\n`;

describe(`live: files as ${UID}`, () => {
	beforeAll(async () => {
		tokens[UID] = await devToken(UID, ["workspace.read", "workspace.write", "workspace.remove", "workspace.share"]);
		tokens[SHARER] = await devToken(SHARER, ["workspace.read", "workspace.write", "workspace.remove", "workspace.share"]);
	});

	afterAll(async () => {
		if (!tokens[UID]) return;
		const r = await call("files_move_to_trash", { path: ROOT });
		// A run filtered with -t may never make ROOT; anything but not_found is a failure.
		if (r.isError) expect(codeOf(r), r.content[0]?.text).toBe("not_found");
		for (const [as, path] of extraCleanup) {
			const x = await call("files_move_to_trash", { path }, as);
			// Items the case itself already removed answer not_found; anything else is a failure.
			if (x.isError) expect(codeOf(x), `${as} ${path}: ${x.content[0]?.text}`).toBe("not_found");
		}
	});

	it("lists the 17 lane A tools, without output schemas", async () => {
		const r = await rpc("tools/list", {});
		brandScan("tools/list", r.raw);
		const tools = (r.json.result as { tools: { name: string; outputSchema?: unknown }[] }).tools.filter((t) => t.name.startsWith("files_") && t.name !== "files_read_text");
		expect(tools).toHaveLength(17);
		for (const t of tools) expect(t.outputSchema, t.name).toBeUndefined();
	});

	it("creates folders and files, reads details, lists and pages", async () => {
		const folder = await ok<{ created_folders: number; folder: Item }>("files_create_folder", { path: `${ROOT}/Sub/Deep` });
		expect(folder.created_folders).toBe(3);
		expect(folder.folder.path).toBe(`${ROOT}/Sub/Deep`);
		const again = await ok<{ created: boolean }>("files_create_folder", { path: `${ROOT}/Sub` });
		expect(again.created).toBe(false);

		const made = await ok<{ file: Item; renamed: boolean }>("files_create_file", { path: NOTES, content: ORIGINAL });
		expect(made.file).toMatchObject({ path: NOTES, type: "file", size: new TextEncoder().encode(ORIGINAL).length });
		expect(made.file.web_url).toMatch(/^https:\/\/drive\.nourax\.org\/f\/\d+$/);
		const taken = await call("files_create_file", { path: NOTES, content: "x" });
		expect(codeOf(taken)).toBe("already_exists");
		expect(taken.content[0]?.text).toBe('A file with that name already exists there. Use if_exists "rename", or files_overwrite_file to replace it.');
		const second = await ok<{ file: Item; renamed: boolean }>("files_create_file", { path: NOTES, content: "second", if_exists: "rename" });
		expect(second).toMatchObject({ renamed: true, file: { name: `notes_${RUN} (2).md` } });
		// A folder has the name: the hint doesn't offer files_overwrite_file, which can't replace a folder.
		const onFolder = await call("files_create_file", { path: `${ROOT}/Sub`, content: "x" });
		expect(codeOf(onFolder)).toBe("already_exists");
		expect(onFolder.content[0]?.text).toBe('There\'s a folder with that name there, so a file can\'t have it. Use if_exists "rename", or choose another name.');
		await ok("files_create_file", { path: `${ROOT}/notesX${RUN}.md`, content: "underscore control" });
		const png = await ok<{ file: Item }>("files_create_file", { path: `${ROOT}/pixel.png`, content: PNG, encoding: "base64" });
		expect(png.file).toMatchObject({ size: 68, mime: "image/png" });

		const info = await ok<Item & { owner: { user_id: string }; permissions: { can_edit: boolean; can_delete: boolean }; shared_with_me: boolean }>("files_get_info", { path: NOTES });
		expect(info.owner.user_id).toBe(UID);
		expect(info.permissions).toMatchObject({ can_edit: true, can_delete: true });
		expect(info.shared_with_me).toBe(false);

		const list = await ok<{ items: Item[]; total: number }>("files_list_folder", { path: ROOT });
		expect(list.items[0]?.name).toBe("Sub");
		expect(list.total).toBe(5);
		const p1 = await ok<{ items: Item[]; next_cursor: string; has_more: boolean }>("files_list_folder", { path: ROOT, limit: 3 });
		const p2 = await ok<{ items: Item[]; has_more: boolean }>("files_list_folder", { path: ROOT, limit: 3, cursor: p1.next_cursor });
		expect(p1.has_more).toBe(true);
		expect(p2.has_more).toBe(false);
		expect(new Set([...p1.items, ...p2.items].map((i) => i.name)).size).toBe(5);
	});

	it("explains a file put into a missing folder, or into a file (NoDrive answers 404 to both)", async () => {
		const missing = await call("files_create_file", { path: `${ROOT}/nofolder/a.txt`, content: "x" });
		expect(codeOf(missing)).toBe("parent_missing");
		expect(missing.content[0]?.text).toBe("The folder it should go in doesn't exist. files_create_folder can make it.");
		const inFile = await call("files_create_file", { path: `${NOTES}/a.txt`, content: "x" });
		expect(codeOf(inFile)).toBe("invalid_input");
		expect(inFile.content[0]?.text).toBe("The folder in that path is a file, so nothing can be created inside it.");
	});

	it("overwrites with the etag, lists versions and restores through the undo hints", async () => {
		const before = await ok<Item>("files_get_info", { path: NOTES });
		const stale = await call("files_overwrite_file", { path: NOTES, content: "x", expected_etag: "not-the-etag" });
		expect(codeOf(stale)).toBe("conflict");
		// Versions are keyed by the second of the last change; make sure the change lands in a new one.
		await new Promise((r) => setTimeout(r, 1100));
		const ow = await ok<{ file: Item; previous_etag: string; undo: Undo }>("files_overwrite_file", { path: NOTES, content: "changed", expected_etag: before.etag });
		expect(ow.previous_etag).toBe(before.etag);
		expect(ow.file.size).toBe(7);
		expect(ow.undo.tool).toBe("files_restore_version");
		const versions = await ok<{ versions: { version_id: string; size: number }[] }>("files_list_versions", { path: NOTES });
		const old = versions.versions.find((v) => v.version_id === ow.undo.arguments.version_id);
		expect(old?.size).toBe(before.size);
		await new Promise((r) => setTimeout(r, 1100));
		const restored = await ok<{ file: Item; undo: Undo | null }>(ow.undo.tool, ow.undo.arguments);
		expect(restored.file.size).toBe(before.size);
		expect(restored.undo?.tool).toBe("files_restore_version");
		const current = await call("files_restore_version", { path: NOTES, version_id: String(Math.floor(Date.parse(restored.file.modified) / 1000)) });
		expect(codeOf(current)).toBe("invalid_input");

		// The list pages with next_cursor, so older versions are never out of reach. A fresh file gets
		// three earlier versions, 2.5 s apart: NoDrive's "auto" rule keeps one every 2 s in the first
		// 10 s (a restore, above, makes the restored version current again, so NOTES has fewer).
		const paged = `${ROOT}/versions_${RUN}.txt`;
		let etag = (await ok<{ file: Item }>("files_create_file", { path: paged, content: "v0" })).file.etag;
		for (const content of ["v1", "v2", "v3"]) {
			await new Promise((r) => setTimeout(r, 2500));
			etag = (await ok<{ file: Item }>("files_overwrite_file", { path: paged, content, expected_etag: etag })).file.etag;
		}
		type VPage = { versions: { version_id: string }[]; total: number; next_cursor: string | null; has_more: boolean };
		const all = await ok<VPage>("files_list_versions", { path: paged, limit: 100 });
		expect(all.total).toBe(3);
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let i = 0; i < all.total + 1; i++) {
			const page: VPage = await ok<VPage>("files_list_versions", { path: paged, limit: 1, ...(cursor ? { cursor } : {}) });
			seen.push(...page.versions.map((v) => v.version_id));
			if (!page.has_more) break;
			expect(page.next_cursor).toBeTruthy();
			cursor = page.next_cursor as string;
		}
		expect(seen).toEqual(all.versions.map((v) => v.version_id));
		expect(seen).toHaveLength(all.total);
	});

	it("moves, copies and renames, never replacing anything", async () => {
		const second = `${ROOT}/notes_${RUN} (2).md`;
		const mv = await ok<{ item: Item; undo: Undo }>("files_move", { path: second, to_folder: `${ROOT}/Sub` });
		expect(mv.item.path).toBe(`${ROOT}/Sub/notes_${RUN} (2).md`);
		const back = await ok<{ item: Item }>(mv.undo.tool, mv.undo.arguments);
		expect(back.item.path).toBe(second);
		const cp = await ok<{ item: Item }>("files_copy", { path: NOTES, to_folder: `${ROOT}/Sub`, new_name: "copy.md" });
		expect(cp.item.path).toBe(`${ROOT}/Sub/copy.md`);
		const dup = await call("files_copy", { path: NOTES, to_folder: `${ROOT}/Sub`, new_name: "copy.md" });
		expect(codeOf(dup)).toBe("already_exists");
		const self = await ok<{ item: Item; renamed: boolean }>("files_copy", { path: NOTES, to_folder: ROOT, if_exists: "rename" });
		expect(self.renamed).toBe(true);
		const rn = await ok<{ item: Item; undo: Undo }>("files_rename", { path: `${ROOT}/Sub/copy.md`, new_name: "renamed copy.md" });
		expect(rn.item.path).toBe(`${ROOT}/Sub/renamed copy.md`);
		const taken = await call("files_rename", { path: `${ROOT}/Sub/renamed copy.md`, new_name: "Deep" });
		expect(codeOf(taken)).toBe("already_exists");
		const into = await call("files_move", { path: `${ROOT}/Sub`, to_folder: `${ROOT}/Sub/Deep` });
		expect(codeOf(into)).toBe("invalid_input");
	});

	it("a move that had to rename gives no one-call undo, and the two steps it names really undo it", async () => {
		await ok("files_create_file", { path: `${ROOT}/dup.txt`, content: "mine" });
		await ok("files_create_file", { path: `${ROOT}/Sub/dup.txt`, content: "already there" });
		const r = await call("files_move", { path: `${ROOT}/dup.txt`, to_folder: `${ROOT}/Sub`, if_exists: "rename" });
		const out = r.structuredContent as { item: Item; renamed: boolean; undo: Undo | null; warnings: string[] };
		expect(out).toMatchObject({ renamed: true, undo: null, item: { path: `${ROOT}/Sub/dup (2).txt` } });
		expect(out.warnings).toEqual([
			`A file named "dup.txt" was already in ${ROOT}/Sub, so this one was saved as "dup (2).txt". To undo the move, files_move it back to ${ROOT}, then files_rename it to "dup.txt".`,
		]);
		await ok("files_move", { path: `${ROOT}/Sub/dup (2).txt`, to_folder: ROOT });
		const named = await ok<{ item: Item }>("files_rename", { path: `${ROOT}/dup (2).txt`, new_name: "dup.txt" });
		expect(named.item).toMatchObject({ path: `${ROOT}/dup.txt`, size: 4 });
		const there = await ok<Item>("files_get_info", { path: `${ROOT}/Sub/dup.txt` });
		expect(there.size).toBe(13);
	});

	it("marks favourites and lists recent files, with a note when there are more", async () => {
		type Fav = { item: Item; changed: boolean; undo: Undo | null };
		const fav = await ok<Fav>("files_set_favorite", { path: NOTES, favorite: true });
		expect(fav).toMatchObject({ changed: true, item: { favorite: true }, undo: { tool: "files_set_favorite", arguments: { path: NOTES, favorite: false } } });
		const favs = await ok<{ items: Item[] }>("files_list_favorites", { limit: 200 });
		expect(favs.items.map((i) => i.path)).toContain(NOTES);
		// The undo puts the mark back as it was; asking again for what is already so changes nothing.
		const unfav = await ok<Fav>((fav.undo as Undo).tool, (fav.undo as Undo).arguments);
		expect(unfav).toMatchObject({ changed: true, item: { favorite: false } });
		expect((await ok<Item>("files_get_info", { path: NOTES })).favorite).toBe(false);
		const same = await ok<Fav>("files_set_favorite", { path: NOTES, favorite: false });
		expect(same).toMatchObject({ changed: false, undo: null });
		const recent = await ok<{ items: Item[]; note: string | null }>("files_list_recent", { days: 1, limit: 50 });
		expect(recent.items.some((i) => i.path.startsWith(`${ROOT}/`))).toBe(true);
		expect(recent.items.every((i) => i.type === "file")).toBe(true);
		const images = await ok<{ items: Item[] }>("files_list_recent", { days: 1, type: "image" });
		expect(images.items.map((i) => i.path)).toContain(`${ROOT}/pixel.png`);
		const one = await ok<{ items: Item[]; has_more: boolean; note: string | null }>("files_list_recent", { days: 1, limit: 1 });
		expect(one).toMatchObject({ has_more: true, note: "More files changed in that time than are listed; a smaller days or a type narrows the list." });
	});

	it("searches names (a literal underscore) and, when indexed, inside files", async () => {
		const byName = await ok<{ items: Item[] }>("files_search", { query: `notes_${RUN}`, match: "name", folder: ROOT });
		const names = byName.items.map((i) => i.name);
		expect(names).toContain(`notes_${RUN}.md`);
		expect(names).not.toContain(`notesX${RUN}.md`);
		const typed = await ok<{ items: Item[] }>("files_search", { query: "pixel", match: "name", type: "image", folder: ROOT });
		expect(typed.items.map((i) => i.name)).toEqual(["pixel.png"]);
		// A folder whose name has a "%" (it can't travel as a search scope) is still a filter.
		const odd = `${ROOT}/Odd 100% #1 & ?`;
		await ok("files_create_folder", { path: `${odd}/Deeper` });
		await ok("files_create_folder", { path: `${ROOT}/Odd 100% #1 & ? sibling` });
		await ok("files_create_file", { path: `${odd}/odd ${RUN} one.txt`, content: "1" });
		await ok("files_create_file", { path: `${odd}/Deeper/odd ${RUN} two.txt`, content: "2" });
		await ok("files_create_file", { path: `${ROOT}/Odd 100% #1 & ? sibling/odd ${RUN} three.txt`, content: "3" });
		const inOdd = await ok<{ items: Item[] }>("files_search", { query: `odd ${RUN}`, match: "name", folder: odd });
		expect(inOdd.items.map((i) => i.path).sort()).toEqual([`${odd}/Deeper/odd ${RUN} two.txt`, `${odd}/odd ${RUN} one.txt`]);
		type ContentPage = { items: (Item & { match: string; excerpt: string | null })[]; content_search_available: boolean };
		const pages: ContentPage[] = [];
		for (let i = 0; i < 12; i++) {
			const page = await ok<ContentPage>("files_search", { query: WORD, match: "content" });
			pages.push(page);
			if (page.items.some((x) => x.path.startsWith(ROOT))) break;
			await new Promise((r) => setTimeout(r, 10_000));
		}
		const last = pages[pages.length - 1];
		expect(last?.content_search_available).toBe(true);
		const hit = last?.items.find((x) => x.path.startsWith(ROOT));
		expect.soft(hit, "search inside files found the new file (the index may lag)").toBeDefined();
		if (hit) expect(hit.match).toBe("content");
		const auto = await ok<{ items: (Item & { match: string })[] }>("files_search", { query: `notes_${RUN}` });
		expect(auto.items.length).toBeGreaterThan(0);
	});

	it("moves to the trash, lists it and restores it, also when the name is taken", async () => {
		const t1 = await ok<{ trash_item_id: string; in_trash: boolean | null; undo: Undo }>("files_move_to_trash", { path: `${ROOT}/Sub/renamed copy.md` });
		expect(t1.trash_item_id).toMatch(/\.d\d+$/);
		const listed = await ok<{ items: { trash_item_id: string; original_path: string }[] }>("files_list_trash", { query: ROOT.slice(1) });
		expect(listed.items.map((i) => i.trash_item_id)).toContain(t1.trash_item_id);
		const backRes = await call(t1.undo.tool, t1.undo.arguments);
		expect(backRes.structuredContent).toMatchObject({ renamed: false, item: { path: `${ROOT}/Sub/renamed copy.md` } });
		expect(summary(backRes)).toBe("Restored the item from the trash to its old place.");
		expect(t1).toMatchObject({ in_trash: true });

		const t2 = await ok<{ trash_item_id: string }>("files_move_to_trash", { path: `${ROOT}/pixel.png` });
		await ok("files_create_file", { path: `${ROOT}/pixel.png`, content: "new pixel" });
		const fail = await call("files_restore_from_trash", { trash_item_id: t2.trash_item_id, if_exists: "fail" });
		expect(codeOf(fail)).toBe("already_exists");
		expect(fail.content[0]?.text).not.toContain("pixel");
		const renamedRes = await call("files_restore_from_trash", { trash_item_id: t2.trash_item_id });
		expect(summary(renamedRes)).toBe("Restored the item to its old folder under a new name, because its name was taken there.");
		const renamed = renamedRes.structuredContent as { item: Item; renamed: boolean; warnings: string[] };
		expect(renamed.renamed).toBe(true);
		expect(renamed.warnings).toEqual([`It was restored as ${renamed.item.path}, because the name pixel.png was taken in its old folder.`]);
		expect(renamed.item.size).toBe(68);
		expect(renamed.item.path.startsWith(`${ROOT}/pixel`)).toBe(true);
		const gone = await call("files_restore_from_trash", { trash_item_id: t2.trash_item_id });
		expect(codeOf(gone)).toBe("not_found");
	});

	it("says so when an item comes back to the top folder because its old folder is gone", async () => {
		await ok("files_create_folder", { path: `${ROOT}/Gone` });
		await ok("files_create_file", { path: `${ROOT}/Gone/${ORPHAN}`, content: "orphan" });
		extraCleanup.push([UID, `/${ORPHAN}`]);
		const t = await ok<{ trash_item_id: string }>("files_move_to_trash", { path: `${ROOT}/Gone/${ORPHAN}` });
		await ok("files_move_to_trash", { path: `${ROOT}/Gone` });
		const r = await call("files_restore_from_trash", { trash_item_id: t.trash_item_id });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		const out = r.structuredContent as { item: Item; renamed: boolean; original_path: string; warnings: string[] };
		expect(out).toMatchObject({ item: { path: `/${ORPHAN}`, size: 6 }, renamed: false, original_path: `${ROOT}/Gone/${ORPHAN}` });
		expect(summary(r)).toBe("Restored the item to the top folder, because its old folder is no longer there.");
		expect(out.warnings).toEqual([`Its old folder ${ROOT}/Gone is no longer there, so it was restored to the top folder as /${ORPHAN}.`]);
	});

	it("received shares: a folder shared with a group and a file shared with the person alone", async () => {
		// The sharer makes a folder with a file, and a single file. The folder goes to the QA group
		// (both accounts are in it), the file to the person alone: the two kinds behave differently.
		extraCleanup.push([SHARER, `/${SHARED_DIR}`], [SHARER, `/${SHARED_FILE}`]);
		await ok("files_create_folder", { path: `/${SHARED_DIR}` }, SHARER);
		await ok("files_create_file", { path: `/${SHARED_DIR}/inside.txt`, content: "shared inside" }, SHARER);
		await ok("files_create_file", { path: `/${SHARED_FILE}`, content: "a shared file" }, SHARER);
		const people = await ok<{ results: { id: string }[] }>("sharing_find_people", { query: UID, kinds: ["person"] }, SHARER);
		expect(people.results.map((p) => p.id), "the sharer finds the person (same QA group)").toContain(`person:${UID}`);
		const groups = await ok<{ results: { id: string }[] }>("sharing_find_people", { query: GROUP, kinds: ["group"] }, SHARER);
		expect(groups.results.map((p) => p.id), "the sharer finds the QA group").toContain(`group:${GROUP}`);
		const groupShare = await ok<{ share_id: string }>("sharing_share_with", { path: `/${SHARED_DIR}`, share_with: `group:${GROUP}`, permission: "edit", can_delete: true }, SHARER);
		const personShare = await ok<{ share_id: string }>("sharing_share_with", { path: `/${SHARED_FILE}`, share_with: `person:${UID}`, permission: "edit" }, SHARER);

		// Where the shares landed in the person's NoDrive (the top folder by default).
		const top = await ok<{ items: Item[] }>("files_list_folder", { path: "/", limit: 200 });
		const dir = top.items.find((i) => i.name === SHARED_DIR) ?? (await ok<{ items: Item[] }>("files_search", { query: SHARED_DIR, match: "name", type: "folder" })).items[0];
		const file = top.items.find((i) => i.name === SHARED_FILE) ?? (await ok<{ items: Item[] }>("files_search", { query: SHARED_FILE, match: "name" })).items[0];
		if (!dir || !file) throw new Error("the received shares weren't found in the person's NoDrive");
		const dirInfo = await ok<Item & { shared_with_me: boolean; owner: { user_id: string; display_name: string | null } }>("files_get_info", { path: dir.path });
		expect(dirInfo).toMatchObject({ shared_with_me: true, owner: { user_id: SHARER }, type: "folder" });
		const ownerName = dirInfo.owner.display_name ?? SHARER;

		// 1. Inside the shared folder: the item goes for everyone who has the folder. The owner's
		// original goes to the owner's trash, and the person's trash gets a copy (a new file id).
		const innerPath = `${dir.path}/from-person.txt`;
		const ownerInner = `/${SHARED_DIR}/from-person.txt`;
		await ok("files_create_file", { path: innerPath, content: "added by the person" });
		expect((await ok<Item>("files_get_info", { path: ownerInner }, SHARER)).size).toBe(19);
		const inner = await call("files_move_to_trash", { path: innerPath });
		expect(inner.isError, inner.content[0]?.text).toBeFalsy();
		const innerOut = inner.structuredContent as { trash_item_id: string | null; in_trash: boolean | null; undo: Undo | null; warnings?: string[] };
		expect(innerOut.trash_item_id, "the person's trash copy was found").toMatch(/^from-person\.txt\.d\d+$/);
		expect(innerOut.in_trash).toBe(true);
		expect(innerOut.undo).toEqual({ tool: "files_restore_from_trash", arguments: { trash_item_id: innerOut.trash_item_id } });
		expect(innerOut.warnings).toEqual([
			`This was inside a folder shared by ${ownerName}. It was removed for everyone who has that folder; its owner can also restore it from their own trash.`,
		]);
		expect(summary(inner)).toBe("Moved the file to the trash. It was in a shared folder, so it is gone for everyone who has that folder.");
		// Checked as the owner: gone from the folder, and in the owner's own trash.
		expect(codeOf(await call("files_get_info", { path: ownerInner }, SHARER)), "the owner no longer has the file").toBe("not_found");
		const ownerTrash = await ok<{ items: { original_path: string }[] }>("files_list_trash", { query: "from-person.txt" }, SHARER);
		expect(ownerTrash.items.map((i) => i.original_path)).toContain(ownerInner);
		// The person's undo puts it back into the shared folder, for the owner too.
		const back = await call((innerOut.undo as Undo).tool, (innerOut.undo as Undo).arguments);
		expect(back.isError, back.content[0]?.text).toBeFalsy();
		expect((back.structuredContent as { item: Item }).item.path).toBe(innerPath);
		expect((await ok<Item>("files_get_info", { path: ownerInner }, SHARER)).size).toBe(19);

		// 2. The top of the group share: only the person's access ends, and Deleted shares has it.
		const g = await call("files_move_to_trash", { path: dir.path });
		expect(g.isError, g.content[0]?.text).toBeFalsy();
		expect(g.structuredContent).toMatchObject({ trash_item_id: null, in_trash: false, undo: null });
		expect((g.structuredContent as { warnings?: string[] }).warnings).toEqual([
			"The share is removed from the person's NoDrive; the owner keeps the item. The person can bring it back from Deleted shares in NoDrive.",
		]);
		expect(summary(g)).toBe("Removed the shared folder from the person's NoDrive. Its owner keeps it.");
		expect(codeOf(await call("files_get_info", { path: dir.path }))).toBe("not_found");
		// Checked over OCS: the owner's share is still there, and the person's Deleted shares lists it.
		expect((await ocsGet(SHARER, `${SHARES_API}/shares/${groupShare.share_id}`)).status, "the group share still exists").toBe(200);
		const deleted1 = await ocsGet(UID, `${SHARES_API}/deletedshares`);
		expect(deleted1.status).toBe(200);
		const ids1 = (deleted1.data as { id: string }[]).map((s) => s.id);
		expect(ids1, "Deleted shares lists the group share").toContain(`ocinternal:${groupShare.share_id}`);
		expect((await ok<Item>("files_get_info", { path: `/${SHARED_DIR}/inside.txt` }, SHARER)).size).toBe(13);

		// 3. The top of the share made to the person alone: refused without end_share, because
		// nothing can bring it back; nothing changes.
		const refused = await call("files_move_to_trash", { path: file.path });
		expect(codeOf(refused)).toBe("invalid_input");
		expect(fieldOf(refused)).toBe("end_share");
		expect(refused.content[0]?.text).toContain("Nothing was changed. This was shared with the person alone, so removing it ends that share for good");
		expect(refused.content[0]?.text).toContain("end_share true goes ahead");
		expect((await ok<Item>("files_get_info", { path: file.path })).size).toBe(13);
		expect((await ocsGet(SHARER, `${SHARES_API}/shares/${personShare.share_id}`)).status).toBe(200);
		// With end_share true it goes, and says so plainly.
		const p = await call("files_move_to_trash", { path: file.path, end_share: true });
		expect(p.isError, p.content[0]?.text).toBeFalsy();
		expect(p.structuredContent).toMatchObject({ trash_item_id: null, in_trash: false, undo: null });
		expect((p.structuredContent as { warnings?: string[] }).warnings).toEqual([
			`The share from ${ownerName} has ended for good: it can't be brought back from the trash or from Deleted shares, and only the owner can share it again. The owner keeps the item.`,
		]);
		expect(summary(p)).toBe("Ended the share of this file: it is gone from the person's NoDrive for good. Its owner keeps it.");
		expect(codeOf(await call("files_get_info", { path: file.path }))).toBe("not_found");
		// Checked over OCS: the owner's share is gone for good, and Deleted shares doesn't list it.
		expect((await ocsGet(SHARER, `${SHARES_API}/shares/${personShare.share_id}`)).status, "the person share was deleted").toBe(404);
		const deleted2 = await ocsGet(UID, `${SHARES_API}/deletedshares`);
		const ids2 = (deleted2.data as { id: string }[]).map((s) => s.id);
		expect(ids2).not.toContain(`ocinternal:${personShare.share_id}`);
		expect(ids2).toContain(`ocinternal:${groupShare.share_id}`);
		expect((await ok<Item>("files_get_info", { path: `/${SHARED_FILE}` }, SHARER)).size, "the owner keeps the file").toBe(13);
	});

	it("a person share next to a group share: refused without end_share, then the person share ends and the group one can come back", async () => {
		extraCleanup.push([SHARER, `/${MIXED_FILE}`]);
		await ok("files_create_file", { path: `/${MIXED_FILE}`, content: "shared twice" }, SHARER);
		const personShare = await ok<{ share_id: string }>("sharing_share_with", { path: `/${MIXED_FILE}`, share_with: `person:${UID}`, permission: "edit" }, SHARER);
		const groupShare = await ok<{ share_id: string }>("sharing_share_with", { path: `/${MIXED_FILE}`, share_with: `group:${GROUP}`, permission: "view" }, SHARER);
		const found = await ok<{ items: Item[] }>("files_search", { query: MIXED_FILE, match: "name" });
		const mine = found.items.find((i) => i.name === MIXED_FILE);
		if (!mine) throw new Error("the item shared twice wasn't found in the person's NoDrive");
		// NoDrive groups both shares into one item for the person.
		expect(found.items.filter((i) => i.name.startsWith(MIXED_FILE.replace(/\.txt$/, "")))).toHaveLength(1);

		const refused = await call("files_move_to_trash", { path: mine.path });
		expect(codeOf(refused)).toBe("invalid_input");
		expect(fieldOf(refused)).toBe("end_share");
		expect(refused.content[0]?.text).toBe(
			"Nothing was changed. This was shared with the person alone and also through a group, team or board. Removing it ends the first share for good; the other can come back from Deleted shares, with only its own rights. end_share true goes ahead; files_get_info shows the owner.",
		);
		expect((await ocsGet(SHARER, `${SHARES_API}/shares/${personShare.share_id}`)).status, "nothing changed: the person share is there").toBe(200);
		expect((await ok<Item>("files_get_info", { path: mine.path })).size).toBe(12);

		const r = await call("files_move_to_trash", { path: mine.path, end_share: true });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		expect(r.structuredContent).toMatchObject({ trash_item_id: null, in_trash: false, undo: null });
		expect((r.structuredContent as { warnings: string[] }).warnings).toEqual([
			"The share is removed from the person's NoDrive; the owner keeps the item. The share made to the person alone has ended for good. The group, team or board share can be brought back from Deleted shares in NoDrive, with that share's own rights.",
		]);
		// Checked over OCS: the person share is gone for good, the group share is still there and in
		// the person's Deleted shares.
		expect((await ocsGet(SHARER, `${SHARES_API}/shares/${personShare.share_id}`)).status, "the person share was deleted").toBe(404);
		expect((await ocsGet(SHARER, `${SHARES_API}/shares/${groupShare.share_id}`)).status, "the group share still exists").toBe(200);
		const deleted = await ocsGet(UID, `${SHARES_API}/deletedshares`);
		const ids = (deleted.data as { id: string }[]).map((s) => s.id);
		expect(ids).toContain(`ocinternal:${groupShare.share_id}`);
		expect(ids).not.toContain(`ocinternal:${personShare.share_id}`);
		expect((await ok<Item>("files_get_info", { path: `/${MIXED_FILE}` }, SHARER)).size, "the owner keeps the file").toBe(12);
	});

	it("an own item shared by link: the link stops working while it is in the trash and works again after the restore", async () => {
		const path = `${ROOT}/linked ${RUN}.txt`;
		await ok("files_create_file", { path, content: "linked content" });
		const link = await ok<{ share_id: string; url: string | null }>("sharing_create_link", { path, expires_in_days: 1 });
		expect(link.url).toMatch(/^https:\/\/drive\.nourax\.org\/s\/[A-Za-z0-9]+$/);
		const open = async () => (await fetch(link.url as string, { redirect: "manual" })).status;
		expect(await open(), "the link works before").toBe(200);
		const r = await call("files_move_to_trash", { path });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		const out = r.structuredContent as { in_trash: boolean | null; undo: Undo; warnings?: string[] };
		expect(out.in_trash).toBe(true);
		expect(out.warnings).toEqual(["It was shared with other people or by link. While it is in the trash they can't open it; restoring it brings their access back."]);
		expect(summary(r)).toBe("Moved the file to the trash. It can usually be restored for at least 30 days.");
		expect(await open(), "the link doesn't open while the file is in the trash").toBe(404);
		const back = await call(out.undo.tool, out.undo.arguments);
		expect(back.isError, back.content[0]?.text).toBeFalsy();
		expect(await open(), "the restore brings the link back").toBe(200);
		expect((await ocsGet(UID, `${SHARES_API}/shares/${link.share_id}`)).status).toBe(200);
	});

	it("a team folder: removing an item removes it for the other member too, whose own trash lists it; the top can't be removed", async () => {
		extraCleanup.push([UID, TEAM_FILE]);
		const TEAM_FOUND =
			"This was in a team folder, so it was removed for everyone in the team. Team folders share one trash: every member who can see that place finds it in their own trash and can restore it or delete it for good, so the undo works only while it is still there.";
		// The top of the team folder: refused before anything is sent, and still there for both.
		const top = await call("files_move_to_trash", { path: `/${TEAM}` });
		expect(codeOf(top)).toBe("permission_denied");
		expect(top.content[0]?.text).toBe(
			"That is a team folder itself, which belongs to the whole team, so its members can't remove it. Nothing was changed. The items inside it can be moved to the trash.",
		);
		expect((await ok<{ in_team_folder: boolean; type: string }>("files_get_info", { path: `/${TEAM}` }, SHARER)).type).toBe("folder");

		// One file, made by the person, seen by the other member in the same team folder.
		const made = await ok<{ file: Item }>("files_create_file", { path: TEAM_FILE, content: "team content" });
		const info = await ok<Item & { in_team_folder: boolean; shared_with_me: boolean }>("files_get_info", { path: TEAM_FILE });
		expect(info).toMatchObject({ in_team_folder: true, shared_with_me: false, file_id: made.file.file_id });
		expect((await ok<Item>("files_get_info", { path: TEAM_FILE }, SHARER)).file_id, "the other member sees the same file").toBe(made.file.file_id);

		// Removing it: the result says it is gone for the whole team, and gives the undo.
		const r = await call("files_move_to_trash", { path: TEAM_FILE });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		const out = r.structuredContent as { trash_item_id: string | null; in_trash: boolean | null; undo: Undo | null; warnings?: string[] };
		expect(out.in_trash).toBe(true);
		expect(out.trash_item_id).toMatch(new RegExp(`^team ${RUN}\\.txt\\.d\\d+$`));
		expect(out.undo).toEqual({ tool: "files_restore_from_trash", arguments: { trash_item_id: out.trash_item_id } });
		expect(out.warnings).toEqual([TEAM_FOUND]);
		expect(summary(r)).toBe("Moved the file to the team folder's trash. It is gone for everyone in the team until someone restores it.");
		// Checked as the other member: gone from the team folder, and in their own trash, same place.
		expect(codeOf(await call("files_get_info", { path: TEAM_FILE }, SHARER)), "gone for the other member too").toBe("not_found");
		const theirs = await ok<{ items: { trash_item_id: string; original_path: string }[] }>("files_list_trash", { query: `team ${RUN}` }, SHARER);
		expect(theirs.items, "the other member's own trash lists it").toEqual([expect.objectContaining({ trash_item_id: out.trash_item_id, original_path: TEAM_FILE })]);
		// Checked over DAV as the other member too, not only through the Worker.
		const dav = await fetch(`${DRIVE}/remote.php/dav/trashbin/${SHARER}/trash/`, {
			method: "PROPFIND",
			headers: { authorization: basicAuth(SHARER), depth: "1", "content-type": "application/xml" },
			body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:prop><nc:trashbin-deleted-by-id/></d:prop></d:propfind>',
		});
		const davText = await dav.text();
		expect(dav.status).toBe(207);
		expect(davText).toContain(encodeURIComponent(out.trash_item_id as string));
		expect(davText).toContain(`<nc:trashbin-deleted-by-id>${UID}</nc:trashbin-deleted-by-id>`);

		// The person's undo brings it back for everyone, with the same file id.
		const back = await call((out.undo as Undo).tool, (out.undo as Undo).arguments);
		expect(back.isError, back.content[0]?.text).toBeFalsy();
		expect((back.structuredContent as { item: Item }).item).toMatchObject({ path: TEAM_FILE, file_id: made.file.file_id });
		expect((await ok<Item>("files_get_info", { path: TEAM_FILE }, SHARER)).size, "back for the other member").toBe(12);

		// The other way round: the other member removes it, and the person's own trash lists it.
		const theirsGone = await ok<{ trash_item_id: string | null; warnings?: string[] }>("files_move_to_trash", { path: TEAM_FILE }, SHARER);
		expect(theirsGone.warnings).toEqual([TEAM_FOUND]);
		const mine = await ok<{ items: { trash_item_id: string; original_path: string }[] }>("files_list_trash", { query: `team ${RUN}` });
		expect(mine.items.map((i) => i.trash_item_id)).toContain(theirsGone.trash_item_id);
		// The person restores what the other member removed; the clean-up moves it to the trash again.
		const restored = await call("files_restore_from_trash", { trash_item_id: theirsGone.trash_item_id });
		expect(restored.isError, restored.content[0]?.text).toBeFalsy();
		expect((await ok<Item>("files_get_info", { path: TEAM_FILE }, SHARER)).size).toBe(12);
	});

	it(`refuses every way into ${TARGET}'s files, locally`, async () => {
		for (const path of [
			`/../${TARGET}/x.txt`,
			`/a/../../${TARGET}`,
			"..",
			`https://drive.nourax.org/remote.php/dav/files/${TARGET}/`,
			`\\..\\${TARGET}`,
			"/x\u0000y",
		]) {
			for (const tool of ["files_get_info", "files_list_folder", "files_move_to_trash"]) {
				const r = await call(tool, { path });
				expect(codeOf(r), `${tool} ${JSON.stringify(path)}`).toBe("invalid_input");
			}
		}
		// Encoded dots are a name inside the person's own NoDrive, never a parent folder.
		const enc = await call("files_get_info", { path: `/%2e%2e/${TARGET}/x.txt` });
		expect(codeOf(enc)).toBe("not_found");
		const trash = await call("files_restore_from_trash", { trash_item_id: `../../files/${TARGET}/x.d1` });
		expect(codeOf(trash)).toBe("invalid_input");
	});

	it("answers in both protocol eras through the SDK client", async () => {
		for (const mode of ["legacy", "auto"] as const) {
			const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens[UID]}` } } });
			const client = new Client({ name: "nourax-live-a", version: "1.0.0" }, { versionNegotiation: { mode } });
			await client.connect(transport);
			await client.listTools();
			const r = await client.callTool({ name: "files_list_folder", arguments: { path: ROOT } });
			expect(r.isError, mode).toBeFalsy();
			expect((r.structuredContent as { total: number }).total).toBeGreaterThan(0);
			await client.close();
		}
	});
});
