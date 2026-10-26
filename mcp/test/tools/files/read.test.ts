/** Contract tests: files_list_folder, files_get_info, files_list_recent, favourites (DESIGN 17.3). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QA } from "../../helpers/index";
import { clean, code, field, payload, sc, setup, text } from "./helpers";

afterEach(() => vi.restoreAllMocks());

type Item = { path: string; name: string; type: string; size: number; etag: string; file_id: number; favorite: boolean; web_url: string; mime: string | null };

describe("files_list_folder", () => {
	it("lists folders first, sorted by name, with links; sends one PROPFIND Depth 1 as the person", async () => {
		const e = await setup();
		e.files.write(QA.a, "/Projects/b.txt", "bb");
		e.files.write(QA.a, "/Projects/a 10.txt", "a");
		e.files.write(QA.a, "/Projects/a 9.txt", "aaa");
		e.files.mkdir(QA.a, "/Projects/Zeta");
		e.fake.requests.length = 0;
		const r = await e.call("files_list_folder", { path: "/Projects" });
		const out = sc<{ folder: Item; items: Item[]; total: number; has_more: boolean; next_cursor: string | null }>(r);
		expect(out.items.map((i) => i.name)).toEqual(["Zeta", "a 9.txt", "a 10.txt", "b.txt"]);
		expect(out.total).toBe(4);
		expect(out.has_more).toBe(false);
		expect(out.next_cursor).toBeNull();
		expect(out.folder.path).toBe("/Projects");
		expect(out.items[1]).toMatchObject({ path: "/Projects/a 9.txt", type: "file", size: 3, mime: "text/plain", favorite: false });
		expect(out.items[1]?.web_url).toBe(`https://drive.nourax.org/f/${out.items[1]?.file_id}`);
		const calls = e.davCalls();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("PROPFIND");
		expect(calls[0]?.url.pathname).toBe("/remote.php/dav/files/qa-t1-91/Projects/");
		expect(calls[0]?.headers.get("depth")).toBe("1");
		expect(calls[0]?.auth).toBe(QA.a);
		expect(calls[0]?.headers.get("cookie")).toBeNull();
		expect(text(r).split("\n")[0]).toBe("Listed 4 items in the folder.");
		expect(payload(r).total).toBe(4);
	});
	it("defaults to the top folder, filters kind, sorts by size descending", async () => {
		const e = await setup();
		e.files.write(QA.a, "/small.txt", "1");
		e.files.write(QA.a, "/big.txt", "12345");
		e.files.mkdir(QA.a, "/Docs");
		const r = await e.call("files_list_folder", { kind: "files", sort: "size", order: "desc" });
		expect(sc<{ items: Item[] }>(r).items.map((i) => i.name)).toEqual(["big.txt", "small.txt"]);
		const f = await e.call("files_list_folder", { kind: "folders" });
		expect(sc<{ items: Item[] }>(f).items.map((i) => i.name)).toEqual(["Docs"]);
		expect(sc<{ folder: Item }>(f).folder.path).toBe("/");
	});
	it("pages with a cursor bound to its arguments", async () => {
		const e = await setup();
		for (let i = 0; i < 5; i++) e.files.write(QA.a, `/P/f${i}.txt`, "x");
		const p1 = sc<{ items: Item[]; next_cursor: string; has_more: boolean }>(await e.call("files_list_folder", { path: "/P", limit: 2 }));
		expect(p1.items.map((i) => i.name)).toEqual(["f0.txt", "f1.txt"]);
		expect(p1.has_more).toBe(true);
		const p2 = sc<{ items: Item[]; next_cursor: string | null }>(await e.call("files_list_folder", { path: "/P", limit: 2, cursor: p1.next_cursor }));
		expect(p2.items.map((i) => i.name)).toEqual(["f2.txt", "f3.txt"]);
		const p3 = sc<{ items: Item[]; next_cursor: string | null; has_more: boolean }>(await e.call("files_list_folder", { path: "/P", limit: 2, cursor: p2.next_cursor }));
		expect(p3.items.map((i) => i.name)).toEqual(["f4.txt"]);
		expect(p3.next_cursor).toBeNull();
		const wrong = await e.call("files_list_folder", { path: "/P", limit: 3, cursor: p1.next_cursor });
		expect(code(wrong)).toBe("invalid_input");
		expect(text(wrong)).toContain("different search");
	});
	it("explains a missing folder, a file, and bad input in plain words", async () => {
		const e = await setup();
		e.files.write(QA.a, "/a.txt", "x");
		const missing = await e.call("files_list_folder", { path: "/Nope" });
		expect(code(missing)).toBe("not_found");
		expect(text(missing)).toBe("There's no folder at that path. files_search can find it by name.");
		const file = await e.call("files_list_folder", { path: "/a.txt" });
		expect(code(file)).toBe("invalid_input");
		expect(text(file)).toContain("is a file");
		const bad = await e.call("files_list_folder", { path: "/x/../y" });
		expect(code(bad)).toBe("invalid_input");
		expect(field(bad)).toBe("path");
		const unknown = await e.call("files_list_folder", { path: "/", surprise: true });
		expect(code(unknown)).toBe("invalid_input");
		expect(e.davCalls()).toHaveLength(2);
	});
	it("maps permission, server errors and timeouts without leaking server text", async () => {
		const e = await setup();
		e.fake.on("PROPFIND", /^\/remote\.php\/dav\/files\/qa-t1-91\/Locked\/$/, () => new Response("<s:exception>Sabre\\DAV\\Exception\\Forbidden</s:exception>", { status: 403 }));
		const denied = await e.call("files_list_folder", { path: "/Locked" });
		expect(code(denied)).toBe("permission_denied");
		expect(clean(denied)).toBe(true);
		e.fake.on("PROPFIND", /^\/remote\.php\/dav\/files\/qa-t1-91\/Broken\/$/, () => new Response("Fatal error in /var/www/html/lib/x.php", { status: 500 }));
		const broken = await e.call("files_list_folder", { path: "/Broken" });
		expect(code(broken)).toBe("upstream_unavailable");
		expect(clean(broken)).toBe(true);
		e.fake.on("PROPFIND", /^\/remote\.php\/dav\/files\/qa-t1-91\/Slow\/$/, () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		});
		const slow = await e.call("files_list_folder", { path: "/Slow" });
		expect(code(slow)).toBe("timeout");
	});
	it("retries a read once on 503", async () => {
		const e = await setup();
		e.files.mkdir(QA.a, "/R");
		let n = 0;
		const real = e.fake.routes.find((r) => r.method === "PROPFIND" && r.path.source.includes("files"));
		e.fake.on("PROPFIND", /^\/remote\.php\/dav\/files\/qa-t1-91\/R\/$/, (req, f, m) => {
			n++;
			if (n === 1) return new Response("busy", { status: 503 });
			return real?.handler(req, f, m) as Response;
		});
		const r = await e.call("files_list_folder", { path: "/R" });
		expect(r.isError).toBeFalsy();
		expect(n).toBe(2);
	});
});

describe("files_get_info", () => {
	it("returns details, permissions and ownership", async () => {
		const e = await setup();
		e.files.write(QA.a, "/Shared/Budget.xlsx", "x", { permissions: "SGD", mountType: "shared", owner: QA.b, ownerName: "QA t1 92", shareTypes: [0] });
		const r = await e.call("files_get_info", { path: "/Shared/Budget.xlsx" });
		const out = sc<Record<string, unknown>>(r);
		expect(out).toMatchObject({
			path: "/Shared/Budget.xlsx",
			name: "Budget.xlsx",
			type: "file",
			shared: true,
			shared_with_me: true,
			owner: { user_id: QA.b, display_name: "QA t1 92" },
			permissions: { can_edit: false, can_delete: true, can_rename: false, can_share: false, can_create_inside: false },
			share_types: ["person"],
			has_preview: false,
		});
		expect(typeof out.etag).toBe("string");
		expect(out.created).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(Object.keys(out)).not.toContain("hidden");
		const call = e.davCalls()[0];
		expect(call?.headers.get("depth")).toBe("0");
		expect(call?.body).toContain("<oc:permissions/>");
	});
	it("says plainly when nothing is there, and refuses web addresses", async () => {
		const e = await setup();
		const r = await e.call("files_get_info", { path: "/missing.txt" });
		expect(code(r)).toBe("not_found");
		expect(text(r)).toBe("There's no file or folder at that path. files_search can find it by name.");
		const url = await e.call("files_get_info", { path: "https://drive.nourax.org/remote.php/dav/files/qa-t1-92/secret.txt" });
		expect(code(url)).toBe("invalid_input");
		expect(text(url)).toContain("not a web address");
		expect(e.davCalls()).toHaveLength(1);
	});
});

describe("files_list_recent", () => {
	it("sends a SEARCH for files changed after now minus days, newest first", async () => {
		const e = await setup();
		e.files.write(QA.a, "/old.txt", "x", { mtime: 1_000_000 });
		e.files.write(QA.a, "/A/new.md", "y");
		e.files.write(QA.a, "/A/newer.txt", "z");
		e.files.mkdir(QA.a, "/A/Folder");
		const now = Math.floor(Date.now() / 1000);
		for (const p of ["/A/new.md", "/A/newer.txt", "/A/Folder"]) {
			const n = e.files.get(QA.a, p);
			if (n) n.mtime = now - (p.includes("newer") ? 10 : 20);
		}
		const r = await e.call("files_list_recent", { days: 3 });
		const out = sc<{ items: Item[]; has_more: boolean; note: string | null }>(r);
		expect(out.items.map((i) => i.path)).toEqual(["/A/newer.txt", "/A/new.md"]);
		expect(out.has_more).toBe(false);
		expect(out.note).toBeNull();
		const s = e.davCalls().find((c) => c.method === "SEARCH");
		expect(s?.url.pathname).toBe("/remote.php/dav/");
		expect(s?.body).toContain("<d:href>/files/qa-t1-91</d:href>");
		expect(s?.body).toMatch(/<d:gt><d:prop><d:getlastmodified\/><\/d:prop><d:literal>\d{10}<\/d:literal><\/d:gt>/);
		expect(s?.body).toContain("<d:not><d:is-collection/></d:not>");
		expect(s?.body).toContain("<d:descending/>");
		const bad = await e.call("files_list_recent", { days: 91 });
		expect(code(bad)).toBe("invalid_input");
		expect(e.davCalls().some((c) => c.url.pathname.includes("/api/v1/recent"))).toBe(false);
	});
	it("when there are more, has_more comes with a note on how to narrow the list (there is no cursor)", async () => {
		const e = await setup();
		const now = Math.floor(Date.now() / 1000);
		for (const p of ["/A/a.md", "/A/b.md", "/A/c.txt"]) e.files.write(QA.a, p, "x", { mtime: now - 60 });
		const md = sc<{ items: Item[]; has_more: boolean; note: string | null }>(await e.call("files_list_recent", { days: 3, type: "text", limit: 1 }));
		expect(md.items).toHaveLength(1);
		expect(md.has_more).toBe(true);
		expect(md.note).toBe("More files changed in that time than are listed; a smaller days or a type narrows the list.");
	});
	it("falls back to NoDrive's own recent list when the SEARCH fails, with a note", async () => {
		const e = await setup();
		const now = Math.floor(Date.now() / 1000);
		e.files.write(QA.a, "/old.txt", "x", { mtime: now - 40 * 86400 });
		const a = e.files.write(QA.a, "/Docs/a.md", "x", { mtime: now - 50, shareTypes: [3] });
		e.files.write(QA.a, "/b.png", "x", { mtime: now - 30 });
		e.files.mkdir(QA.a, "/Docs/Empty");
		const empty = e.files.get(QA.a, "/Docs/Empty");
		if (empty) empty.mtime = now - 10;
		e.fake.on("SEARCH", /^\/remote\.php\/dav\/?$/, () => new Response("", { status: 500 }));
		const r = await e.call("files_list_recent", { days: 14 });
		const out = sc<{ items: Item[]; has_more: boolean; note: string }>(r);
		expect(out.items.map((i) => i.path)).toEqual(["/b.png", "/Docs/a.md"]);
		expect(out.items[1]).toMatchObject({ file_id: a.id, type: "file", mime: "text/markdown", web_url: `https://drive.nourax.org/f/${a.id}`, favorite: false, shared: true });
		expect(out.note).toContain("NoDrive's file search didn't answer");
		const call = e.davCalls().find((c) => c.url.pathname === "/index.php/apps/files/api/v1/recent/");
		expect(call?.headers.get("ocs-apirequest")).toBe("true");
		expect(call?.auth).toBe(QA.a);
		const text2 = sc<{ items: Item[] }>(await e.call("files_list_recent", { days: 14, type: "image" }));
		expect(text2.items.map((i) => i.path)).toEqual(["/b.png"]);
	});
	it("falls back when the SEARCH never answers: it has its own 15 s timeout, so the fallback still fits (section 30.6)", async () => {
		const e = await setup();
		const now = Math.floor(Date.now() / 1000);
		e.files.write(QA.a, "/late.txt", "x", { mtime: now - 30 });
		// A SEARCH that hangs; the 15 s timeout is shortened here so the test doesn't wait for it.
		const timeout = AbortSignal.timeout.bind(AbortSignal);
		const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => timeout(ms === 15_000 ? 30 : ms));
		e.fake.on("SEARCH", /^\/remote\.php\/dav\/?$/, () => new Promise<Response>(() => undefined));
		const r = await e.call("files_list_recent", { days: 14 });
		const out = sc<{ items: Item[]; note: string }>(r);
		expect(out.items.map((i) => i.path)).toEqual(["/late.txt"]);
		expect(out.note).toContain("NoDrive's file search didn't answer");
		expect(spy.mock.calls.some(([ms]) => ms === 15_000)).toBe(true);
		// One SEARCH only: the fallback is its retry.
		expect(e.davCalls().filter((c) => c.method === "SEARCH")).toHaveLength(1);
	});
	it.each([
		["the request's own timeout (TimeoutError)", () => new DOMException("The operation was aborted due to timeout", "TimeoutError")],
		["a dropped connection (TypeError)", () => new TypeError("Network connection lost.")],
	])("falls back after %s", async (_name, error) => {
		const e = await setup();
		const now = Math.floor(Date.now() / 1000);
		e.files.write(QA.a, "/a.txt", "x", { mtime: now - 30 });
		e.fake.on("SEARCH", /^\/remote\.php\/dav\/?$/, () => {
			throw error();
		});
		const r = await e.call("files_list_recent", {});
		expect(r.isError).toBeFalsy();
		const out = sc<{ items: Item[]; note: string }>(r);
		expect(out.items.map((i) => i.path)).toEqual(["/a.txt"]);
		expect(out.note).toContain("NoDrive's file search didn't answer");
	});
	it("a 503 from the SEARCH isn't tried again before the fallback", async () => {
		const e = await setup();
		e.fake.on("SEARCH", /^\/remote\.php\/dav\/?$/, () => new Response("", { status: 503 }));
		const r = await e.call("files_list_recent", {});
		expect(r.isError).toBeFalsy();
		expect(e.davCalls().filter((c) => c.method === "SEARCH")).toHaveLength(1);
		expect(e.davCalls().some((c) => c.url.pathname === "/index.php/apps/files/api/v1/recent/")).toBe(true);
	});
	it("never falls back for a sign-in that ended or a refusal", async () => {
		const e = await setup();
		e.fake.on("SEARCH", /^\/remote\.php\/dav\/?$/, () => new Response("", { status: 403 }));
		const r = await e.call("files_list_recent", {});
		expect(code(r)).toBe("permission_denied");
		expect(e.davCalls().some((c) => c.url.pathname.includes("/api/v1/recent"))).toBe(false);
	});
	it("drops entries of the recent list whose path the normaliser refuses", async () => {
		const e = await setup();
		const now = Date.now();
		e.fake.on("SEARCH", /^\/remote\.php\/dav\/?$/, () => new Response("", { status: 503 }));
		e.fake.on("GET", /^\/index\.php\/apps\/files\/api\/v1\/recent\/?$/, () =>
			Response.json({
				files: [
					{ id: 7, mtime: now, name: "ok.txt", mimetype: "text/plain", size: 3, type: "file", etag: "e", path: "/" },
					{ id: 8, mtime: now, name: "x.txt", mimetype: "text/plain", size: 3, type: "file", etag: "e", path: "/../qa-t1-92" },
					{ id: 9, mtime: now, name: "a/b.txt", mimetype: "text/plain", size: 3, type: "file", etag: "e", path: "/" },
					{ id: 10, mtime: now, name: "dir", mimetype: "httpd/unix-directory", size: 0, type: "dir", etag: "e", path: "/" },
				],
			}),
		);
		const out = sc<{ items: Item[] }>(await e.call("files_list_recent", {}));
		expect(out.items.map((i) => i.path)).toEqual(["/ok.txt"]);
	});
});

describe("favourites", () => {
	it("marks, lists and unmarks with PROPPATCH and SEARCH", async () => {
		const e = await setup();
		e.files.write(QA.a, "/b.txt", "x");
		e.files.mkdir(QA.a, "/A folder");
		const set = await e.call("files_set_favorite", { path: "/b.txt", favorite: true });
		expect(sc<{ item: Item }>(set).item.favorite).toBe(true);
		const pp = e.davCalls().find((c) => c.method === "PROPPATCH");
		expect(pp?.body).toContain("<oc:favorite>1</oc:favorite>");
		await e.call("files_set_favorite", { path: "/A folder", favorite: true });
		const list = await e.call("files_list_favorites", {});
		expect(sc<{ items: Item[] }>(list).items.map((i) => i.path)).toEqual(["/A folder", "/b.txt"]);
		const s = e.davCalls().filter((c) => c.method === "SEARCH").pop();
		expect(s?.body).toContain("<d:eq><d:prop><oc:favorite/></d:prop><d:literal>yes</d:literal></d:eq>");
		const unset = await e.call("files_set_favorite", { path: "/b.txt", favorite: false });
		expect(sc<{ item: Item }>(unset).item.favorite).toBe(false);
		expect(e.files.get(QA.a, "/b.txt")?.favorite).toBe(false);
		const again = sc<{ items: Item[] }>(await e.call("files_list_favorites", {}));
		expect(again.items.map((i) => i.path)).toEqual(["/A folder"]);
	});
	it("a change gives the undo that puts the mark back; no change sends nothing and gives no undo", async () => {
		const e = await setup();
		e.files.write(QA.a, "/u.txt", "x");
		type Out = { item: Item; changed: boolean; undo: { tool: string; arguments: Record<string, unknown> } | null };
		const set = await e.call("files_set_favorite", { path: "/u.txt", favorite: true });
		const out = sc<Out>(set);
		expect(out).toMatchObject({ changed: true, undo: { tool: "files_set_favorite", arguments: { path: "/u.txt", favorite: false } } });
		expect(text(set).split("\n")[0]).toBe("Marked the file as a favourite.");
		// Running the undo restores the mark as it was.
		const undone = sc<Out>(await e.call(out.undo?.tool as string, out.undo?.arguments));
		expect(e.files.get(QA.a, "/u.txt")?.favorite).toBe(false);
		expect(undone.undo).toEqual({ tool: "files_set_favorite", arguments: { path: "/u.txt", favorite: true } });
		const before = e.davCalls().filter((c) => c.method === "PROPPATCH").length;
		const same = await e.call("files_set_favorite", { path: "/u.txt", favorite: false });
		expect(sc<Out>(same)).toMatchObject({ changed: false, undo: null, item: { favorite: false } });
		expect(text(same).split("\n")[0]).toBe("The file wasn't marked as a favourite; nothing changed.");
		e.files.write(QA.a, "/f.txt", "x", { favorite: true });
		const already = await e.call("files_set_favorite", { path: "/f.txt", favorite: true });
		expect(sc<Out>(already)).toMatchObject({ changed: false, undo: null });
		expect(text(already).split("\n")[0]).toBe("The file was already a favourite; nothing changed.");
		expect(e.davCalls().filter((c) => c.method === "PROPPATCH")).toHaveLength(before);
	});
	it("pages favourites and refuses the top folder and missing items", async () => {
		const e = await setup();
		for (const n of ["a", "b", "c"]) e.files.write(QA.a, `/${n}.txt`, "x", { favorite: true });
		const p1 = sc<{ items: Item[]; next_cursor: string }>(await e.call("files_list_favorites", { limit: 2 }));
		expect(p1.items.map((i) => i.name)).toEqual(["a.txt", "b.txt"]);
		const p2 = sc<{ items: Item[]; next_cursor: string | null; has_more: boolean }>(await e.call("files_list_favorites", { limit: 2, cursor: p1.next_cursor }));
		expect(p2.items.map((i) => i.name)).toEqual(["c.txt"]);
		expect(p2.has_more).toBe(false);
		expect(code(await e.call("files_set_favorite", { path: "/", favorite: true }))).toBe("invalid_input");
		expect(code(await e.call("files_set_favorite", { path: "/none.txt", favorite: true }))).toBe("not_found");
	});
	it("reports a refused favourite change", async () => {
		const e = await setup();
		e.files.write(QA.a, "/r.txt", "x");
		e.fake.on("PROPPATCH", /^\/remote\.php\/dav\/files\//, () =>
			new Response(
				'<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:href>/remote.php/dav/files/qa-t1-91/r.txt</d:href><d:propstat><d:prop><oc:favorite/></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response></d:multistatus>',
				{ status: 207 },
			),
		);
		const r = await e.call("files_set_favorite", { path: "/r.txt", favorite: true });
		expect(code(r)).toBe("permission_denied");
	});
});

