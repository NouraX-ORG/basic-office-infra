/**
 * Second system review, files side:
 * - DESIGN 29.7: files_list_favorites counts NoDrive's own positions, so a row it drops (here a name
 *   with U+FEFF, which NoDrive accepts and the path rules refuse) neither ends the listing early nor
 *   repeats items;
 * - DESIGN 29.9: files_search takes the query in NFC, like every name, so combining accents match;
 * - DESIGN 29.10: the parents files_create_folder makes with create_parents follow the new-name rule.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QA } from "../../helpers/index";
import { code, sc, setup } from "./helpers";

afterEach(() => vi.restoreAllMocks());

type Page = { items: { path: string }[]; next_cursor: string | null; has_more: boolean };

describe("files_list_favorites pages by NoDrive's positions", () => {
	it("a dropped row still uses its place: nothing is lost at the end of a page and nothing repeats", async () => {
		const e = await setup();
		for (const p of ["/a.txt", "/a﻿.txt", "/b.txt", "/c.txt", "/d.txt"]) e.files.write(QA.a, p, "x", { favorite: true });
		expect(e.files.get(QA.a, "/a﻿.txt")).toBeDefined();
		const pages: string[][] = [];
		let cursor: string | undefined;
		for (let i = 0; i < 10; i++) {
			const page = sc<Page>(await e.call("files_list_favorites", { limit: 2, ...(cursor ? { cursor } : {}) }));
			pages.push(page.items.map((x) => x.path));
			if (!page.has_more) break;
			cursor = page.next_cursor as string;
		}
		// The first page read NoDrive's rows 0 and 1 (a.txt and the dropped one) and row 2 to see more
		// is there. Before the fix it kept a.txt and b.txt, said has_more false, and c and d were lost.
		expect(pages).toEqual([["/a.txt"], ["/b.txt", "/c.txt"], ["/d.txt"]]);
	});
	it("a full page of good rows still continues exactly after the last one shown", async () => {
		const e = await setup();
		for (const p of ["/a.txt", "/b.txt", "/c.txt"]) e.files.write(QA.a, p, "x", { favorite: true });
		const first = sc<Page>(await e.call("files_list_favorites", { limit: 2 }));
		expect(first.items.map((x) => x.path)).toEqual(["/a.txt", "/b.txt"]);
		expect(first.has_more).toBe(true);
		const second = sc<Page>(await e.call("files_list_favorites", { limit: 2, cursor: first.next_cursor }));
		expect(second.items.map((x) => x.path)).toEqual(["/c.txt"]);
		expect(second.has_more).toBe(false);
	});
});

describe("files_search with combining accents (NFD)", () => {
	it("finds the NFC name", async () => {
		const e = await setup();
		e.files.write(QA.a, "/Docs/café notes.txt", "x");
		const r = sc<{ items: { path: string; match: string }[] }>(await e.call("files_search", { query: "café", match: "name" }));
		expect(r.items.map((x) => x.path)).toEqual(["/Docs/café notes.txt"]);
		const s = e.davCalls().find((c) => c.method === "SEARCH");
		expect(s?.body).toContain("%café%");
	});
});

describe("files_create_folder: new parents follow the new-name rule", () => {
	it("a missing parent with a space at either end is refused before any folder is made", async () => {
		const e = await setup();
		for (const path of ["/Top /Sub", "/ Lead/Sub", "/Fine/ Inner/Leaf"]) {
			const r = await e.call("files_create_folder", { path });
			expect(code(r), path).toBe("invalid_input");
		}
		expect(e.files.get(QA.a, "/Top ")).toBeUndefined();
		expect(e.files.get(QA.a, "/ Lead")).toBeUndefined();
		// Nothing above the bad one was made either: all are checked before the first MKCOL that creates.
		expect(e.files.get(QA.a, "/Fine")).toBeUndefined();
	});
	it("an existing parent may keep its space (NoDrive's own name); the new ones below it are made", async () => {
		const e = await setup();
		e.files.mkdir(QA.a, "/Team ");
		const r = sc<{ created_folders: number }>(await e.call("files_create_folder", { path: "/Team /New/Deeper" }));
		expect(r.created_folders).toBe(2);
		expect(e.files.get(QA.a, "/Team /New/Deeper")?.type).toBe("folder");
	});
});
