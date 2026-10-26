/** Contract tests: files_move, files_copy, files_rename (DESIGN 17.3). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QA } from "../../helpers/index";
import { code, field, sc, setup, text } from "./helpers";

afterEach(() => vi.restoreAllMocks());

type Item = { path: string; name: string; type: string; file_id: number };
type Undo = { tool: string; arguments: Record<string, unknown> };

describe("files_move", () => {
	it("MOVEs with Overwrite: F and a normalised Destination, keeps the id, and gives the undo", async () => {
		const e = await setup();
		const n = e.files.write(QA.a, "/In/Plan é.docx", "x");
		e.files.mkdir(QA.a, "/Archive 2026");
		const r = await e.call("files_move", { path: "/In/Plan é.docx", to_folder: "/Archive 2026" });
		const out = sc<{ item: Item; from: string; renamed: boolean; undo: Undo }>(r);
		expect(out.item).toMatchObject({ path: "/Archive 2026/Plan é.docx", file_id: n.id });
		expect(out).toMatchObject({ from: "/In/Plan é.docx", renamed: false });
		expect(out.undo).toEqual({ tool: "files_move", arguments: { path: "/Archive 2026/Plan é.docx", to_folder: "/In" } });
		const mv = e.davCalls().find((c) => c.method === "MOVE");
		expect(mv?.url.pathname).toBe("/remote.php/dav/files/qa-t1-91/In/Plan%20%C3%A9.docx");
		expect(mv?.headers.get("destination")).toBe("https://drive.nourax.org/remote.php/dav/files/qa-t1-91/Archive%202026/Plan%20%C3%A9.docx");
		expect(mv?.headers.get("overwrite")).toBe("F");
		expect(e.files.get(QA.a, "/In/Plan é.docx")).toBeUndefined();
	});
	it("never replaces: fail stops, rename adds a number and warns", async () => {
		const e = await setup();
		e.files.write(QA.a, "/a.txt", "mine");
		e.files.write(QA.a, "/B/a.txt", "theirs");
		const fail = await e.call("files_move", { path: "/a.txt", to_folder: "/B" });
		expect(code(fail)).toBe("already_exists");
		expect(e.files.text(QA.a, "/B/a.txt")).toBe("theirs");
		const res = await e.call("files_move", { path: "/a.txt", to_folder: "/B", if_exists: "rename" });
		const ren = sc<{ item: Item; renamed: boolean; warnings: string[]; undo: Undo | null }>(res);
		expect(ren.item.path).toBe("/B/a (2).txt");
		expect(ren.renamed).toBe(true);
		expect(e.files.text(QA.a, "/B/a.txt")).toBe("theirs");
		// One files_move back would keep "a (2).txt", so there is no one-call undo; the warning names both steps.
		expect(ren.undo).toBeNull();
		expect(ren.warnings).toEqual([
			'A file named "a.txt" was already in /B, so this one was saved as "a (2).txt". To undo the move, files_move it back to /, then files_rename it to "a.txt".',
		]);
		expect(text(res).split("\n")[0]).toBe("Moved the file to the new folder under a numbered name, because its name was taken there.");
		// Following the two steps really does put it back as it was.
		sc(await e.call("files_move", { path: "/B/a (2).txt", to_folder: "/" }));
		sc(await e.call("files_rename", { path: "/a (2).txt", new_name: "a.txt" }));
		expect(e.files.text(QA.a, "/a.txt")).toBe("mine");
		expect(e.files.text(QA.a, "/B/a.txt")).toBe("theirs");
	});
	it("a move without a rename has a one-call undo that really reverses it", async () => {
		const e = await setup();
		e.files.write(QA.a, "/X/doc.md", "x");
		e.files.mkdir(QA.a, "/Y");
		const out = sc<{ undo: Undo; warnings?: string[] }>(await e.call("files_move", { path: "/X/doc.md", to_folder: "/Y" }));
		expect(out.warnings).toBeUndefined();
		sc(await e.call(out.undo.tool, out.undo.arguments));
		expect(e.files.text(QA.a, "/X/doc.md")).toBe("x");
		expect(e.files.get(QA.a, "/Y/doc.md")).toBeUndefined();
	});
	it("refuses moves into itself, to the same folder, of the top folder, and to a missing or non-folder target", async () => {
		const e = await setup();
		e.files.mkdir(QA.a, "/A/B");
		e.files.write(QA.a, "/f.txt", "x");
		expect(code(await e.call("files_move", { path: "/A", to_folder: "/A/B" }))).toBe("invalid_input");
		expect(code(await e.call("files_move", { path: "/A", to_folder: "/A" }))).toBe("invalid_input");
		const same = await e.call("files_move", { path: "/A/B", to_folder: "/A" });
		expect(code(same)).toBe("invalid_input");
		expect(text(same)).toContain("files_rename");
		expect(code(await e.call("files_move", { path: "/", to_folder: "/A" }))).toBe("invalid_input");
		const missing = await e.call("files_move", { path: "/f.txt", to_folder: "/Nope" });
		expect(code(missing)).toBe("not_found");
		expect(field(missing)).toBe("to_folder");
		expect(code(await e.call("files_move", { path: "/f.txt", to_folder: "/f.txt" }))).toBe("invalid_input");
		expect(code(await e.call("files_move", { path: "/gone.txt", to_folder: "/A" }))).toBe("not_found");
		expect(e.davCalls().filter((c) => c.method === "MOVE")).toHaveLength(0);
	});
	it("maps a lock and a vanished target folder", async () => {
		const e = await setup();
		e.files.write(QA.a, "/l.txt", "x");
		e.files.mkdir(QA.a, "/T");
		e.files.locked.add(`${QA.a}:/l.txt`);
		expect(code(await e.call("files_move", { path: "/l.txt", to_folder: "/T" }))).toBe("locked");
		e.fake.on("MOVE", /^\/remote\.php\/dav\/files\//, () => new Response("", { status: 409 }));
		const gone = await e.call("files_move", { path: "/l.txt", to_folder: "/T" });
		expect(code(gone)).toBe("parent_missing");
		expect(text(gone)).toBe("The folder it should go in doesn't exist. files_create_folder can make it.");
	});
});

describe("files_copy", () => {
	it("COPYs with Overwrite: F, optionally under a new name, into the same folder", async () => {
		const e = await setup();
		const n = e.files.write(QA.a, "/R/q.txt", "data");
		const r = sc<{ item: Item; renamed: boolean }>(await e.call("files_copy", { path: "/R/q.txt", to_folder: "/R", new_name: "q copy.txt" }));
		expect(r.item.path).toBe("/R/q copy.txt");
		expect(r.item.file_id).not.toBe(n.id);
		expect(e.files.text(QA.a, "/R/q copy.txt")).toBe("data");
		const cp = e.davCalls().find((c) => c.method === "COPY");
		expect(cp?.headers.get("overwrite")).toBe("F");
		expect(cp?.headers.get("destination")).toBe("https://drive.nourax.org/remote.php/dav/files/qa-t1-91/R/q%20copy.txt");
		const same = await e.call("files_copy", { path: "/R/q.txt", to_folder: "/R" });
		expect(code(same)).toBe("already_exists");
		const ren = sc<{ item: Item; renamed: boolean }>(await e.call("files_copy", { path: "/R/q.txt", to_folder: "/R", if_exists: "rename" }));
		expect(ren).toMatchObject({ renamed: true, item: { path: "/R/q (2).txt" } });
	});
	it("copies folders, but never into themselves; checks new_name", async () => {
		const e = await setup();
		e.files.write(QA.a, "/F/inner.txt", "x");
		e.files.mkdir(QA.a, "/G");
		const r = sc<{ item: Item }>(await e.call("files_copy", { path: "/F", to_folder: "/G" }));
		expect(r.item).toMatchObject({ path: "/G/F", type: "folder" });
		expect(e.files.text(QA.a, "/G/F/inner.txt")).toBe("x");
		expect(code(await e.call("files_copy", { path: "/F", to_folder: "/F" }))).toBe("invalid_input");
		expect(code(await e.call("files_copy", { path: "/F/inner.txt", to_folder: "/G", new_name: "a/b" }))).toBe("invalid_input");
		expect(code(await e.call("files_copy", { path: "/F/inner.txt", to_folder: "/G", new_name: ".." }))).toBe("invalid_input");
	});
});

describe("files_rename", () => {
	it("renames in place with Overwrite: F and gives the undo", async () => {
		const e = await setup();
		const n = e.files.write(QA.a, "/D/old.txt", "x");
		const r = sc<{ item: Item; old_path: string; undo: Undo }>(await e.call("files_rename", { path: "/D/old.txt", new_name: "New Name.txt" }));
		expect(r.item).toMatchObject({ path: "/D/New Name.txt", file_id: n.id });
		expect(r.old_path).toBe("/D/old.txt");
		expect(r.undo).toEqual({ tool: "files_rename", arguments: { path: "/D/New Name.txt", new_name: "old.txt" } });
		const mv = e.davCalls().find((c) => c.method === "MOVE");
		expect(mv?.headers.get("overwrite")).toBe("F");
		expect(mv?.headers.get("destination")).toBe("https://drive.nourax.org/remote.php/dav/files/qa-t1-91/D/New%20Name.txt");
	});
	it("refuses a taken name, the same name, a path as name, and the top folder", async () => {
		const e = await setup();
		e.files.write(QA.a, "/a.txt", "1");
		e.files.write(QA.a, "/b.txt", "2");
		const taken = await e.call("files_rename", { path: "/a.txt", new_name: "b.txt" });
		expect(code(taken)).toBe("already_exists");
		expect(e.files.text(QA.a, "/b.txt")).toBe("2");
		expect(code(await e.call("files_rename", { path: "/a.txt", new_name: "a.txt" }))).toBe("invalid_input");
		expect(code(await e.call("files_rename", { path: "/a.txt", new_name: "../a.txt" }))).toBe("invalid_input");
		expect(code(await e.call("files_rename", { path: "/a.txt", new_name: " lead.txt" }))).toBe("invalid_input");
		expect(code(await e.call("files_rename", { path: "/", new_name: "x" }))).toBe("invalid_input");
		expect(code(await e.call("files_rename", { path: "/zzz.txt", new_name: "y.txt" }))).toBe("not_found");
	});
});
