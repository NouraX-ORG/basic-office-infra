/**
 * Fix round 4 for the trash:
 * - a trash over the 8 MiB a buffered read takes is read as a stream: files_list_trash lists the
 *   newest 2,000 with a note, and files_move_to_trash still finds the item's own entry (its undo);
 * - files_restore_from_trash (workspace.write) must not make anything public again without
 *   workspace.share: not into a folder with a link, and not an item whose own link (or one inside a
 *   restored folder) comes back with it. Such an item goes straight back to the trash.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../../src/core/limits";
import { QA } from "../../helpers/index";
import { code, sc, setup, text } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const NO_SHARE = ["workspace.read", "workspace.write", "workspace.remove"];
type TrashItem = { trash_item_id: string; name: string; original_path: string; deleted_at: string };
type Listed = { items: TrashItem[]; total: number; note: string | null; has_more: boolean };

/** Fills the person's trash with `n` old files whose names are `len` characters long. */
function bigTrash(e: Awaited<ReturnType<typeof setup>>, n: number, len: number): number {
	const list = e.files.trash.get(QA.a) ?? [];
	let chars = 0;
	for (let i = 0; i < n; i++) {
		const name = `${String(i).padStart(6, "0")}-${"x".repeat(len - 11)}.txt`;
		const node = e.files.node("file", QA.a, new Uint8Array(1), "text/plain");
		const time = 1_700_000_000 + i;
		list.push({ id: `${name}.d${time}`, name, location: `Old/${name}`, time, nodes: new Map([["", node]]) });
		// About what the fake writes for each entry: the href, the name twice, the place and the props.
		chars += 3 * len + 560;
	}
	e.files.trash.set(QA.a, list);
	return chars;
}

describe("a trash bigger than one buffered read", () => {
	it("files_list_trash lists the newest 2,000 of it, with a note, and a query still finds old items", async () => {
		const e = await setup();
		const chars = bigTrash(e, 12_000, 120);
		expect(chars).toBeGreaterThan(LIMITS.davXmlBytes);
		const r = await e.call("files_list_trash", { limit: 5 });
		expect(r.isError).toBeFalsy();
		const out = sc<Listed>(r);
		expect(out.total).toBe(12_000);
		expect(out.items).toHaveLength(5);
		expect(out.items[0]?.name.startsWith("011999-")).toBe(true);
		expect(out.note).toBe("The trash holds 12,000 items; only the newest 2,000 are listed. A query finds older ones.");
		const q = await e.call("files_list_trash", { query: "000007-" });
		const found = sc<Listed>(q);
		expect(found.total).toBe(1);
		expect(found.note).toBeNull();
		expect(found.items[0]?.name.startsWith("000007-")).toBe(true);
	});

	it("files_move_to_trash still finds the item's own entry and gives the undo", async () => {
		const e = await setup();
		bigTrash(e, 12_000, 120);
		e.files.write(QA.a, "/P/plan.md", "x");
		const r = await e.call("files_move_to_trash", { path: "/P/plan.md" });
		expect(r.isError).toBeFalsy();
		const out = sc<{ trash_item_id: string | null; in_trash: boolean | null; undo: unknown }>(r);
		expect(out.trash_item_id).toMatch(/^plan\.md\.d\d+$/);
		expect(out.in_trash).toBe(true);
		expect(out.undo).toEqual({ tool: "files_restore_from_trash", arguments: { trash_item_id: out.trash_item_id } });
		// One read of the trash, after the DELETE: an own item's entry is found by its file id.
		const reads = e.davCalls().filter((c) => c.method === "PROPFIND" && c.url.pathname.includes("/trashbin/"));
		expect(reads).toHaveLength(1);
	});

	it("an item from someone else's folder: the entries from the same place are noted before, so the new copy is found", async () => {
		const e = await setup();
		bigTrash(e, 3_000, 40);
		e.files.write(QA.a, "/Shared/doc.md", "x", { mountType: "shared", owner: QA.b, ownerName: "B" });
		e.files.mkdir(QA.a, "/Shared");
		const folder = e.files.get(QA.a, "/Shared");
		if (folder) Object.assign(folder, { mountType: "shared", owner: QA.b });
		const r = await e.call("files_move_to_trash", { path: "/Shared/doc.md" });
		expect(r.isError, text(r)).toBeFalsy();
		const reads = e.davCalls().filter((c) => c.method === "PROPFIND" && c.url.pathname.includes("/trashbin/"));
		expect(reads).toHaveLength(2);
	});
});

describe("files_restore_from_trash and public links", () => {
	async function trashed(e: Awaited<ReturnType<typeof setup>>, path: string): Promise<string> {
		const r = await e.call("files_move_to_trash", { path });
		const id = sc<{ trash_item_id: string | null }>(r).trash_item_id;
		if (!id) throw new Error(`not trashed: ${text(r)}`);
		return id;
	}

	it("without workspace.share, a file whose own link would come back is put straight back in the trash", async () => {
		const e = await setup({ scopes: NO_SHARE });
		const n = e.files.write(QA.a, "/HR/salaries.xlsx", "x", { shareTypes: [3] });
		const id = await trashed(e, "/HR/salaries.xlsx");
		const r = await e.call("files_restore_from_trash", { trash_item_id: id });
		expect(code(r)).toBe("not_available");
		expect(text(r)).toBe(
			"Restoring it would turn its public link (or a share by email or with another server) back on, and this connection can't share, so it was put back in the trash. Reconnect with sharing allowed, or restore it in NoDrive. files_list_trash shows it again.",
		);
		expect(e.files.get(QA.a, "/HR/salaries.xlsx")).toBeUndefined();
		expect(e.files.trash.get(QA.a)?.some((t) => t.nodes.get("")?.id === n.id)).toBe(true);
	});

	it("with workspace.share it is restored, with a warning that its link works again", async () => {
		const e = await setup();
		e.files.write(QA.a, "/HR/salaries.xlsx", "x", { shareTypes: [3] });
		const id = await trashed(e, "/HR/salaries.xlsx");
		const r = await e.call("files_restore_from_trash", { trash_item_id: id });
		expect(r.isError, text(r)).toBeFalsy();
		expect(e.files.get(QA.a, "/HR/salaries.xlsx")).toBeDefined();
		expect(sc<{ warnings?: string[] }>(r).warnings).toContain("Its public link (or a share by email or with another server), or one on an item inside it, works again now that it is restored.");
	});

	it("without workspace.share, nothing is restored into a folder that has a link today", async () => {
		const e = await setup({ scopes: NO_SHARE });
		e.files.write(QA.a, "/Pub/a.txt", "x");
		const id = await trashed(e, "/Pub/a.txt");
		const pub = e.files.get(QA.a, "/Pub");
		if (pub) pub.shareTypes = [3];
		e.fake.requests.length = 0;
		const r = await e.call("files_restore_from_trash", { trash_item_id: id });
		expect(code(r)).toBe("not_available");
		expect(text(r)).toContain("The folder it would go back to is shared outside the workspace");
		expect(e.davCalls().some((c) => c.method === "MOVE")).toBe(false);
		expect(e.files.get(QA.a, "/Pub/a.txt")).toBeUndefined();
	});

	it("without workspace.share, a folder with a linked item inside goes straight back too", async () => {
		const e = await setup({ scopes: NO_SHARE });
		e.files.write(QA.a, "/Team/notes.md", "x");
		e.files.write(QA.a, "/Team/deep/plan.md", "x", { shareTypes: [4] });
		const id = await trashed(e, "/Team");
		const r = await e.call("files_restore_from_trash", { trash_item_id: id });
		expect(code(r)).toBe("not_available");
		expect(e.files.get(QA.a, "/Team")).toBeUndefined();
		expect(e.files.get(QA.a, "/Team/deep/plan.md")).toBeUndefined();
	});

	it("an item shared only inside the workspace is restored without workspace.share, with a warning", async () => {
		const e = await setup({ scopes: NO_SHARE });
		e.files.write(QA.a, "/Plans/q4.md", "x", { shareTypes: [0] });
		const id = await trashed(e, "/Plans/q4.md");
		const r = await e.call("files_restore_from_trash", { trash_item_id: id });
		expect(r.isError, text(r)).toBeFalsy();
		expect(sc<{ warnings?: string[] }>(r).warnings).toContain("It was shared with other people in the workspace; they can open it again now that it is restored.");
	});
});
