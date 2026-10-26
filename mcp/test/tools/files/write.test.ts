/** Contract tests: files_create_file, files_overwrite_file, files_create_folder (DESIGN 17.3). */
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Vault, vaultFor } from "../../../src/vault/vault";
import { env as nxEnv, QA } from "../../helpers/index";
import { clean, code, field, sc, setup, text } from "./helpers";

afterEach(() => vi.restoreAllMocks());

/** Bytes counted toward today's upload cap for the person (the vault's d:bytes counter). */
async function uploadedToday(uid: string): Promise<number> {
	return runInDurableObject(vaultFor(nxEnv, uid), async (_i: Vault, state) => {
		const rows = state.storage.sql.exec<{ n: number }>("SELECT n FROM counters WHERE k LIKE 'd:bytes:%'").toArray();
		return rows.reduce((s, r) => s + Number(r.n), 0);
	});
}

type Item = { path: string; name: string; type: string; size: number; etag: string; file_id: number; mime: string | null };

describe("files_create_file", () => {
	it("PUTs text with If-None-Match: * and returns the new item", async () => {
		const e = await setup();
		e.files.mkdir(QA.a, "/Notes");
		const r = await e.call("files_create_file", { path: "/Notes/today.md", content: "# Today\nhéllo" });
		const out = sc<{ file: Item; renamed: boolean }>(r);
		expect(out.renamed).toBe(false);
		expect(out.file).toMatchObject({ path: "/Notes/today.md", name: "today.md", type: "file", size: 14, mime: "text/markdown" });
		expect(e.files.text(QA.a, "/Notes/today.md")).toBe("# Today\nhéllo");
		const put = e.davCalls().find((c) => c.method === "PUT");
		expect(put?.url.pathname).toBe("/remote.php/dav/files/qa-t1-91/Notes/today.md");
		expect(put?.headers.get("if-none-match")).toBe("*");
		expect(put?.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
		expect(put?.auth).toBe(QA.a);
		expect(text(r).split("\n")[0]).toBe("Created the file.");
	});
	it("never replaces: fail stops, rename adds a number", async () => {
		const e = await setup();
		e.files.write(QA.a, "/a.txt", "old");
		const fail = await e.call("files_create_file", { path: "/a.txt", content: "new" });
		expect(code(fail)).toBe("already_exists");
		expect(text(fail)).toContain("files_overwrite_file");
		expect(e.files.text(QA.a, "/a.txt")).toBe("old");
		const ren = sc<{ file: Item; renamed: boolean }>(await e.call("files_create_file", { path: "/a.txt", content: "new", if_exists: "rename" }));
		expect(ren).toMatchObject({ renamed: true, file: { path: "/a (2).txt" } });
		expect(e.files.text(QA.a, "/a (2).txt")).toBe("new");
	});
	it("rename looks at each numbered name first, so the body goes only to a free one; every upload counts toward the daily cap", async () => {
		const e = await setup();
		for (const p of ["/a.txt", "/a (2).txt", "/a (3).txt", "/a (4).txt"]) e.files.write(QA.a, p, "old");
		const before = await uploadedToday(e.uid);
		const r = await e.call("files_create_file", { path: "/a.txt", content: "12345", if_exists: "rename" });
		expect(sc<{ file: Item; renamed: boolean }>(r)).toMatchObject({ renamed: true, file: { path: "/a (5).txt", size: 5 } });
		expect(text(r).split("\n")[0]).toBe("Created the file under a numbered name, because the name was taken.");
		const puts = e.davCalls().filter((c) => c.method === "PUT");
		// One body to the name asked for (412: taken), then one to the first free numbered name.
		expect(puts.map((c) => decodeURIComponent(c.url.pathname))).toEqual(["/remote.php/dav/files/qa-t1-91/a.txt", "/remote.php/dav/files/qa-t1-91/a (5).txt"]);
		expect(puts.every((c) => c.headers.get("if-none-match") === "*")).toBe(true);
		const looks = e.davCalls().filter((c) => c.method === "PROPFIND").map((c) => decodeURIComponent(c.url.pathname).replace("/remote.php/dav/files/qa-t1-91", ""));
		expect(looks.slice(0, 4)).toEqual(["/a (2).txt", "/a (3).txt", "/a (4).txt", "/a (5).txt"]);
		// Both bodies count, the refused one too.
		expect((await uploadedToday(e.uid)) - before).toBe(10);
		for (const p of ["/a.txt", "/a (2).txt", "/a (3).txt", "/a (4).txt"]) expect(e.files.text(QA.a, p)).toBe("old");
	});
	it("rename: a name taken between the look and the upload moves on to the next one, and that upload counts too", async () => {
		const e = await setup();
		e.files.write(QA.a, "/r.txt", "old");
		e.files.write(QA.a, "/r (2).txt", "old");
		// The look at "r (2).txt" comes back empty, as if someone took the name just after it.
		e.fake.on("PROPFIND", /\/r%20\(2\)\.txt$/, () => new Response("", { status: 404 }));
		const before = await uploadedToday(e.uid);
		const out = sc<{ file: Item }>(await e.call("files_create_file", { path: "/r.txt", content: "abc", if_exists: "rename" }));
		expect(out.file.path).toBe("/r (3).txt");
		expect(e.davCalls().filter((c) => c.method === "PUT")).toHaveLength(3);
		expect((await uploadedToday(e.uid)) - before).toBe(9);
		expect(e.files.text(QA.a, "/r (2).txt")).toBe("old");
	});
	it("fail: the hint fits what has the name (a folder can't be overwritten), with one upload only", async () => {
		const e = await setup();
		e.files.mkdir(QA.a, "/Taken");
		const r = await e.call("files_create_file", { path: "/Taken", content: "x" });
		expect(code(r)).toBe("already_exists");
		expect(field(r)).toBe("path");
		expect(text(r)).toBe('There\'s a folder with that name there, so a file can\'t have it. Use if_exists "rename", or choose another name.');
		expect(text(r)).not.toContain("files_overwrite_file");
		e.files.write(QA.a, "/f.txt", "old");
		const f = await e.call("files_create_file", { path: "/f.txt", content: "x" });
		expect(text(f)).toBe('A file with that name already exists there. Use if_exists "rename", or files_overwrite_file to replace it.');
		expect(e.davCalls().filter((c) => c.method === "PUT")).toHaveLength(2);
	});
	it("rename gives up plainly after 20 names, without uploading to any taken one", async () => {
		const e = await setup();
		e.files.write(QA.a, "/n.txt", "old");
		for (let i = 2; i <= 20; i++) e.files.write(QA.a, `/n (${i}).txt`, "old");
		const r = await e.call("files_create_file", { path: "/n.txt", content: "x", if_exists: "rename" });
		expect(code(r)).toBe("already_exists");
		expect(text(r)).toBe("That name and 19 numbered copies of it are all taken there. Choose another name.");
		expect(e.davCalls().filter((c) => c.method === "PUT")).toHaveLength(1);
	});
	it("decodes base64 and refuses bad or oversized data before any upload", async () => {
		const e = await setup();
		const png = btoa("PNGDATA-0123456789");
		const r = sc<{ file: Item }>(await e.call("files_create_file", { path: "/img.png", content: png, encoding: "base64" }));
		expect(r.file).toMatchObject({ size: 18, mime: "image/png" });
		expect(e.davCalls().find((c) => c.method === "PUT")?.headers.get("content-type")).toBe("image/png");
		// base64url ("-" and "_") is accepted too: "Pj4-Pz8_" is ">>>???".
		const urlSafe = sc<{ file: Item }>(await e.call("files_create_file", { path: "/u.bin", content: "Pj4-Pz8_", encoding: "base64" }));
		expect(urlSafe.file.size).toBe(6);
		expect(e.files.text(QA.a, "/u.bin")).toBe(">>>???");
		const before = e.davCalls().filter((c) => c.method === "PUT").length;
		const bad = await e.call("files_create_file", { path: "/x.bin", content: "not base64!!", encoding: "base64" });
		expect(code(bad)).toBe("invalid_input");
		expect(field(bad)).toBe("content");
		const big = await e.call("files_create_file", { path: "/big.bin", content: "A".repeat(2_796_204), encoding: "base64" });
		expect(code(big)).toBe("too_large");
		expect(text(big)).toContain("2 MB");
		expect(text(big)).toContain("NoDrive app or website");
		const long = await e.call("files_create_file", { path: "/long.txt", content: "x".repeat(1_000_001) });
		expect(code(long)).toBe("too_large");
		expect(text(long)).toContain("1,000,000 characters");
		expect(e.davCalls().filter((c) => c.method === "PUT").length).toBe(before);
	});
	it("names the missing folder (NoDrive answers 404 to the PUT), refuses forbidden names and the top folder", async () => {
		const e = await setup();
		e.files.mkdir(QA.a, "/R");
		const r = await e.call("files_create_file", { path: "/R/nofolder/a.txt", content: "x" });
		expect(code(r)).toBe("parent_missing");
		expect(field(r)).toBe("path");
		expect(text(r)).toBe("The folder it should go in doesn't exist. files_create_folder can make it.");
		const put = e.davCalls().find((c) => c.method === "PUT");
		expect(put?.url.pathname).toBe("/remote.php/dav/files/qa-t1-91/R/nofolder/a.txt");
		// Then one PROPFIND of the folder decides the message (the ones before the PUT are the check of
		// who can see that folder, files/exposure.ts: the folder and each folder above it).
		const calls = e.davCalls();
		const afterPut = calls.slice(calls.findIndex((c) => c.method === "PUT") + 1);
		expect(afterPut.filter((c) => c.method === "PROPFIND").map((c) => c.url.pathname)).toEqual(["/remote.php/dav/files/qa-t1-91/R/nofolder"]);
		expect(calls.slice(0, calls.findIndex((c) => c.method === "PUT")).filter((c) => c.method === "PROPFIND").map((c) => c.url.pathname).sort()).toEqual(["/remote.php/dav/files/qa-t1-91/R", "/remote.php/dav/files/qa-t1-91/R/nofolder"]);
		const deep = await e.call("files_create_file", { path: "/Missing/More/f.txt", content: "x", if_exists: "rename" });
		expect(code(deep)).toBe("parent_missing");
		expect(text(deep)).toBe("The folder it should go in doesn't exist. files_create_folder can make it.");
		e.files.write(QA.a, "/plain.txt", "x");
		const inFile = await e.call("files_create_file", { path: "/plain.txt/a.txt", content: "x" });
		expect(code(inFile)).toBe("invalid_input");
		expect(text(inFile)).toBe("The folder in that path is a file, so nothing can be created inside it.");
		// A server that answers 409 instead (WebDAV's own code) gets the same plain message.
		e.fake.on("PUT", /^\/remote\.php\/dav\/files\//, () => new Response("", { status: 409 }));
		const c409 = await e.call("files_create_file", { path: "/Elsewhere/f.txt", content: "x" });
		expect(code(c409)).toBe("parent_missing");
		expect(text(c409)).toBe("The folder it should go in doesn't exist. files_create_folder can make it.");
		for (const path of ["/.htaccess", "/a.part", "/", "/a/../b.txt", "/x\u0000y"]) {
			const bad = await e.call("files_create_file", { path, content: "x" });
			expect(code(bad), path).toBe("invalid_input");
		}
		const mime = await e.call("files_create_file", { path: "/m.txt", content: "x", mime: "Text Plain" });
		expect(code(mime)).toBe("invalid_input");
	});
	it("maps quota, lock and server errors plainly", async () => {
		const e = await setup();
		e.files.free.set(QA.a, 2);
		const full = await e.call("files_create_file", { path: "/f.txt", content: "12345" });
		expect(code(full)).toBe("quota_exceeded");
		expect(clean(full)).toBe(true);
		e.files.free.delete(QA.a);
		e.files.locked.add(`${QA.a}:/lock.txt`);
		expect(code(await e.call("files_create_file", { path: "/lock.txt", content: "x" }))).toBe("locked");
		e.fake.on("PUT", /^\/remote\.php\/dav\/files\//, () => new Response("Sabre\\DAV\\Exception\\ServiceUnavailable", { status: 503 }));
		const down = await e.call("files_create_file", { path: "/down.txt", content: "x" });
		expect(code(down)).toBe("upstream_unavailable");
		expect(clean(down)).toBe(true);
		// A PUT is never retried automatically.
		expect(e.davCalls().filter((c) => c.method === "PUT" && c.url.pathname.endsWith("/down.txt"))).toHaveLength(1);
	});
	it("needs the write scope", async () => {
		const e = await setup({ scopes: ["workspace.read"] });
		const res = await e.call("files_list_folder", {});
		expect(res.isError).toBeFalsy();
		await expect(e.call("files_create_file", { path: "/f.txt", content: "x" })).rejects.toThrow();
	});
});

describe("files_overwrite_file", () => {
	it("replaces with If-Match and points the undo at the replaced content's version", async () => {
		const e = await setup();
		const n = e.files.write(QA.a, "/doc.md", "first");
		const oldMtime = n.mtime;
		const oldEtag = n.etag;
		const r = await e.call("files_overwrite_file", { path: "/doc.md", content: "second", expected_etag: `"${oldEtag}"` });
		const out = sc<{ file: Item; previous_etag: string; undo: { tool: string; arguments: Record<string, unknown> } }>(r);
		expect(out.previous_etag).toBe(oldEtag);
		expect(out.file.etag).not.toBe(oldEtag);
		expect(out.undo).toEqual({ tool: "files_restore_version", arguments: { path: "/doc.md", version_id: String(oldMtime) } });
		expect(e.files.text(QA.a, "/doc.md")).toBe("second");
		const put = e.davCalls().find((c) => c.method === "PUT");
		expect(put?.headers.get("if-match")).toBe(`"${oldEtag}"`);
		expect(put?.headers.get("if-none-match")).toBeNull();
		expect(text(r).split("\n")[0]).toContain("kept as a version");
	});
	it("refuses a stale etag with the current one, without writing", async () => {
		const e = await setup();
		const n = e.files.write(QA.a, "/doc.md", "first");
		const r = await e.call("files_overwrite_file", { path: "/doc.md", content: "x", expected_etag: "stale" });
		expect(code(r)).toBe("conflict");
		expect(text(r)).toContain(`etag now "${n.etag}"`);
		expect(field(r)).toBe("expected_etag");
		expect(e.davCalls().filter((c) => c.method === "PUT")).toHaveLength(0);
	});
	it("turns a race (412 on PUT) into conflict too", async () => {
		const e = await setup();
		const n = e.files.write(QA.a, "/doc.md", "first");
		e.fake.on("PUT", /^\/remote\.php\/dav\/files\//, () => new Response("", { status: 412 }));
		const r = await e.call("files_overwrite_file", { path: "/doc.md", content: "x", expected_etag: n.etag });
		expect(code(r)).toBe("conflict");
	});
	it("refuses folders, missing files, and works only while versions are on", async () => {
		const e = await setup();
		e.files.mkdir(QA.a, "/Dir");
		expect(code(await e.call("files_overwrite_file", { path: "/Dir", content: "x", expected_etag: "e" }))).toBe("invalid_input");
		expect(code(await e.call("files_overwrite_file", { path: "/none.txt", content: "x", expected_etag: "e" }))).toBe("not_found");
		expect(code(await e.call("files_overwrite_file", { path: "/none.txt", content: "x" }))).toBe("invalid_input");
		e.fake.capabilities = { ...e.fake.capabilities, files: { undelete: true, versioning: false } };
		const { clearCapabilityCache } = await import("../../../src/nc/capabilities");
		clearCapabilityCache();
		const n = e.files.write(QA.a, "/v.txt", "x");
		const off = await e.call("files_overwrite_file", { path: "/v.txt", content: "y", expected_etag: n.etag });
		expect(code(off)).toBe("not_available");
		expect(e.files.text(QA.a, "/v.txt")).toBe("x");
	});
	it("needs the remove scope", async () => {
		const e = await setup({ scopes: ["workspace.read", "workspace.write"] });
		await expect(e.call("files_overwrite_file", { path: "/f.txt", content: "x", expected_etag: "e" })).rejects.toThrow();
	});
});

describe("files_create_folder", () => {
	it("creates one folder with MKCOL", async () => {
		const e = await setup();
		const r = sc<{ folder: Item; created: boolean; created_folders: number }>(await e.call("files_create_folder", { path: "/New" }));
		expect(r).toMatchObject({ created: true, created_folders: 1, folder: { path: "/New", type: "folder" } });
		const mk = e.davCalls().filter((c) => c.method === "MKCOL");
		expect(mk.map((c) => c.url.pathname)).toEqual(["/remote.php/dav/files/qa-t1-91/New"]);
	});
	it("creates missing parents top-down, and reports an existing folder unchanged", async () => {
		const e = await setup();
		e.files.mkdir(QA.a, "/A");
		const r = sc<{ created_folders: number }>(await e.call("files_create_folder", { path: "/A/B/C/D" }));
		expect(r.created_folders).toBe(3);
		expect(e.files.get(QA.a, "/A/B/C/D")?.type).toBe("folder");
		const again = await e.call("files_create_folder", { path: "/A/B/C/D" });
		expect(sc<{ created: boolean }>(again).created).toBe(false);
		expect(text(again).split("\n")[0]).toBe("The folder already exists.");
	});
	it("refuses without create_parents, past 10 new levels, inside a file, and over a file", async () => {
		const e = await setup();
		const no = await e.call("files_create_folder", { path: "/X/Y", create_parents: false });
		expect(code(no)).toBe("parent_missing");
		const deep = await e.call("files_create_folder", { path: `/${Array.from({ length: 11 }, (_, i) => `L${i}`).join("/")}` });
		expect(code(deep)).toBe("invalid_input");
		expect(e.files.get(QA.a, "/L0")).toBeUndefined();
		e.files.write(QA.a, "/file.txt", "x");
		expect(code(await e.call("files_create_folder", { path: "/file.txt/sub" }))).toBe("invalid_input");
		expect(code(await e.call("files_create_folder", { path: "/file.txt" }))).toBe("already_exists");
	});
});
