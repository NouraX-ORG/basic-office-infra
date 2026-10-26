/**
 * Fix round 3: workspace.write can't get round the share choice. A write into a folder shared
 * outside the workspace (link 3, email 4, another server 6), or into a folder below one, is refused
 * without workspace.share and warned about with it; a folder shared only inside the workspace, a team
 * folder or a folder someone shared with the person gets a warning (src/tools/files/exposure.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QA } from "../../helpers/index";
import { code, field, sc, setup, text } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const NO_SHARE = ["workspace.read", "workspace.write", "workspace.remove"];
const OUTSIDE_WARNING = "That place is shared outside the workspace (by link, by email or with another server), so people outside can see it.";

describe("writes into a folder shared outside the workspace", () => {
	it.each([[3], [4], [6]])("files_copy into a folder below one with share type %i is refused without workspace.share, and nothing is copied", async (type) => {
		const e = await setup({ scopes: NO_SHARE });
		e.files.write(QA.a, "/HR/salaries.xlsx", "secret");
		e.files.mkdir(QA.a, "/Public").shareTypes = [type];
		e.files.mkdir(QA.a, "/Public/Inbox");
		const r = await e.call("files_copy", { path: "/HR/salaries.xlsx", to_folder: "/Public/Inbox" });
		expect(code(r)).toBe("not_available");
		expect(field(r)).toBe("to_folder");
		expect(text(r)).toBe(
			"That folder is shared outside the workspace (by link, by email or with another server), and this connection can't share, so nothing was copied there. Choose a folder that isn't shared outside the workspace, or reconnect with sharing allowed.",
		);
		expect(e.files.get(QA.a, "/Public/Inbox/salaries.xlsx")).toBeUndefined();
		expect(e.davCalls().filter((c) => c.method === "COPY")).toHaveLength(0);
	});
	it("files_move, files_create_file, files_overwrite_file and docs_create_document are refused the same way", async () => {
		const e = await setup({ scopes: NO_SHARE });
		e.files.write(QA.a, "/HR/salaries.xlsx", "secret");
		e.files.mkdir(QA.a, "/Public").shareTypes = [3];
		const moved = await e.call("files_move", { path: "/HR/salaries.xlsx", to_folder: "/Public" });
		expect(code(moved)).toBe("not_available");
		expect(e.files.get(QA.a, "/HR/salaries.xlsx")).toBeDefined();
		const made = await e.call("files_create_file", { path: "/Public/notes.txt", content: "secret" });
		expect(code(made)).toBe("not_available");
		expect(e.files.get(QA.a, "/Public/notes.txt")).toBeUndefined();
		const linked = e.files.write(QA.a, "/Linked.txt", "old");
		linked.shareTypes = [3];
		const replaced = await e.call("files_overwrite_file", { path: "/Linked.txt", content: "secret", expected_etag: linked.etag });
		expect(code(replaced)).toBe("not_available");
		expect(text(replaced)).toContain("so its content wasn't replaced");
		expect(e.files.text(QA.a, "/Linked.txt")).toBe("old");
		const doc = await e.call("docs_create_document", { path: "/Public/Plan.docx", markdown: "# Secret" });
		expect(code(doc)).toBe("not_available");
		expect(e.davCalls().filter((c) => c.method === "PUT" || c.method === "MOVE")).toHaveLength(0);
	});
	it("with workspace.share the copy goes ahead and says that people outside can see it", async () => {
		const e = await setup();
		e.files.write(QA.a, "/HR/plan.txt", "x");
		e.files.mkdir(QA.a, "/Public").shareTypes = [3];
		const r = await e.call("files_copy", { path: "/HR/plan.txt", to_folder: "/Public" });
		expect(r.isError).toBeFalsy();
		expect(sc<{ warnings?: string[] }>(r).warnings).toEqual([OUTSIDE_WARNING]);
		expect(e.files.get(QA.a, "/Public/plan.txt")).toBeDefined();
	});
	it("a move or copy inside the linked folder itself adds nobody, so it isn't refused", async () => {
		const e = await setup({ scopes: NO_SHARE });
		e.files.mkdir(QA.a, "/Public").shareTypes = [3];
		e.files.write(QA.a, "/Public/a.txt", "x");
		e.files.mkdir(QA.a, "/Public/Sub");
		const moved = await e.call("files_move", { path: "/Public/a.txt", to_folder: "/Public/Sub" });
		expect(moved.isError).toBeFalsy();
		expect(sc<{ warnings?: string[] }>(moved).warnings).toBeUndefined();
		const copied = await e.call("files_copy", { path: "/Public/Sub/a.txt", to_folder: "/Public" });
		expect(copied.isError).toBeFalsy();
	});
});

describe("writes into a folder other people in the workspace can see", () => {
	it("a folder shared with a person, a team folder and a folder shared with this person: written, with a warning", async () => {
		const e = await setup({ scopes: NO_SHARE });
		e.files.mkdir(QA.a, "/Team notes").shareTypes = [0];
		const r = await e.call("files_create_file", { path: "/Team notes/a.txt", content: "x" });
		expect(r.isError).toBeFalsy();
		expect(sc<{ warnings?: string[] }>(r).warnings?.[0]).toContain("shared with other people in the workspace");
		e.files.team("Projects", [QA.a, QA.b]);
		const t = await e.call("files_create_file", { path: "/Projects/b.txt", content: "x" });
		expect(t.isError).toBeFalsy();
		expect(sc<{ warnings?: string[] }>(t).warnings?.[0]).toContain("team folder");
		// A folder nobody else sees: no check result at all.
		e.files.mkdir(QA.a, "/Mine");
		const own = await e.call("files_create_file", { path: "/Mine/c.txt", content: "x" });
		expect(sc<{ warnings?: string[] }>(own).warnings).toBeUndefined();
	});
});
