/**
 * Fix round 3: names that start or end with a space are NoDrive's own (desktop clients, shared
 * folders and public uploads make them), so an item listed with such a name can also be read, moved,
 * copied and shared. New names a tool chooses still may not start or end with one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QA } from "../../helpers/index";
import { code, sc, setup } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("existing names with a space at either end", () => {
	it("are listed, then work in files_get_info, files_read_text, files_move and files_copy", async () => {
		const e = await setup();
		e.files.write(QA.a, "/Team / Plan .docx", "x");
		e.files.write(QA.a, "/Team /Trail .txt", "hello");
		e.files.mkdir(QA.a, "/Archive");
		const listed = sc<{ items: { path: string }[] }>(await e.call("files_list_folder", { path: "/Team " }));
		expect(listed.items.map((i) => i.path).sort()).toEqual(["/Team / Plan .docx", "/Team /Trail .txt"]);
		const info = await e.call("files_get_info", { path: "/Team / Plan .docx" });
		expect(info.isError).toBeFalsy();
		const read = await e.call("files_read_text", { path: "/Team /Trail .txt" });
		expect(read.isError).toBeFalsy();
		const moved = await e.call("files_move", { path: "/Team / Plan .docx", to_folder: "/Archive" });
		expect(moved.isError).toBeFalsy();
		expect(sc<{ item: { path: string } }>(moved).item.path).toBe("/Archive/ Plan .docx");
		const copied = await e.call("files_copy", { path: "/Team /Trail .txt", to_folder: "/Archive" });
		expect(copied.isError).toBeFalsy();
		expect(e.files.get(QA.a, "/Archive/Trail .txt")).toBeDefined();
	});
	it("a new name a tool chooses still may not start or end with a space", async () => {
		const e = await setup();
		e.files.write(QA.a, "/a.txt", "x");
		expect(code(await e.call("files_create_file", { path: "/new.txt ", content: "x" }))).toBe("invalid_input");
		expect(code(await e.call("files_rename", { path: "/a.txt", new_name: " a.txt" }))).toBe("invalid_input");
		expect(code(await e.call("files_create_folder", { path: "/Folder " }))).toBe("invalid_input");
	});
});
