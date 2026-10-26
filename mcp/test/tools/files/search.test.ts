/** Contract tests: files_search, names through DAV SEARCH and words through fulltextsearch (DESIGN 17.3). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ocs } from "../../fake-nc/index";
import { QA } from "../../helpers/index";
import { code, sc, setup, text } from "./helpers";

afterEach(() => vi.restoreAllMocks());

type Hit = { path: string; name: string; type: string; match: "name" | "content" | "both"; excerpt: string | null };
type Out = { items: Hit[]; content_search_available: boolean; note: string | null; next_cursor: string | null; has_more: boolean };

describe("files_search: names", () => {
	it("sends a scoped, escaped, case-insensitive LIKE and returns name matches newest first", async () => {
		const e = await setup();
		e.files.write(QA.a, "/Q/a_b.txt", "one");
		e.files.write(QA.a, "/Q/aXb.txt", "two");
		e.files.write(QA.a, "/Q/Sub Folder/A_B notes.md", "three");
		const r = await e.call("files_search", { query: "a_b", match: "name" });
		const out = sc<Out>(r);
		expect(out.items.map((i) => i.path)).toEqual(["/Q/Sub Folder/A_B notes.md", "/Q/a_b.txt"]);
		expect(out.items.every((i) => i.match === "name" && i.excerpt === null)).toBe(true);
		const s = e.davCalls().find((c) => c.method === "SEARCH");
		expect(s?.body).toContain("<d:like><d:prop><d:displayname/></d:prop><d:literal>%a\\_b%</d:literal></d:like>");
		expect(s?.body).toContain("<d:href>/files/qa-t1-91</d:href>");
		expect(s?.body).toContain('xmlns:ns="https://github.com/icewind1991/SearchDAV/ns"');
		expect(s?.body).toContain("<ns:firstresult>0</ns:firstresult>");
		expect(e.davCalls().some((c) => c.url.pathname.includes("/search/providers/fulltextsearch"))).toBe(false);
	});
	it("limits to a folder with a raw (not percent-encoded) scope, and filters type and dates", async () => {
		const e = await setup();
		e.files.write(QA.a, "/My Work/report.docx", "x");
		e.files.write(QA.a, "/My Work/report.txt", "x");
		e.files.write(QA.a, "/Other/report.docx", "x");
		const r = await e.call("files_search", { query: "REPORT", match: "name", folder: "/My Work", type: "document", modified_after: "2020-01-01", modified_before: "2099-01-01T00:00:00Z" });
		expect(sc<Out>(r).items.map((i) => i.path)).toEqual(["/My Work/report.docx"]);
		const s = e.davCalls().find((c) => c.method === "SEARCH");
		expect(s?.body).toContain("<d:href>/files/qa-t1-91/My Work</d:href>");
		expect(s?.body).toContain("<d:literal>application/vnd.openxmlformats-officedocument.wordprocessingml.document</d:literal>");
		expect(s?.body).toMatch(/<d:gte><d:prop><d:getlastmodified\/><\/d:prop><d:literal>157783680\d<\/d:literal><\/d:gte>/);
		expect(s?.body).toContain("<d:lt><d:prop><d:getlastmodified/></d:prop><d:literal>4070908800</d:literal></d:lt>");
		const folders = await e.call("files_search", { query: "o", match: "name", type: "folder" });
		expect(sc<Out>(folders).items.map((i) => i.path).sort()).toEqual(["/My Work", "/Other"]);
	});
	it("pages name matches with the cursor", async () => {
		const e = await setup();
		for (let i = 0; i < 5; i++) e.files.write(QA.a, `/plan${i}.txt`, "x");
		const p1 = sc<Out>(await e.call("files_search", { query: "plan", match: "name", limit: 2 }));
		expect(p1.items).toHaveLength(2);
		expect(p1.has_more).toBe(true);
		const p2 = sc<Out>(await e.call("files_search", { query: "plan", match: "name", limit: 2, cursor: p1.next_cursor }));
		const p3 = sc<Out>(await e.call("files_search", { query: "plan", match: "name", limit: 2, cursor: p2.next_cursor }));
		expect(p3.has_more).toBe(false);
		const all = [...p1.items, ...p2.items, ...p3.items].map((i) => i.name).sort();
		expect(all).toEqual(["plan0.txt", "plan1.txt", "plan2.txt", "plan3.txt", "plan4.txt"]);
		expect(e.davCalls().filter((c) => c.method === "SEARCH").map((c) => /<ns:firstresult>(\d+)</.exec(c.body)?.[1])).toEqual(["0", "2", "4"]);
		const other = await e.call("files_search", { query: "other", match: "name", limit: 2, cursor: p1.next_cursor });
		expect(code(other)).toBe("invalid_input");
	});
	it("refuses bad input locally", async () => {
		const e = await setup();
		e.files.write(QA.a, "/f.txt", "x");
		expect(code(await e.call("files_search", { query: "" }))).toBe("invalid_input");
		expect(code(await e.call("files_search", { query: "   " }))).toBe("invalid_input");
		expect(code(await e.call("files_search", { query: "x", limit: 51 }))).toBe("invalid_input");
		expect(code(await e.call("files_search", { query: "x", modified_after: "yesterday" }))).toBe("invalid_input");
		expect(code(await e.call("files_search", { query: "x", modified_after: "2026-02-01", modified_before: "2026-01-01" }))).toBe("invalid_input");
		const notFolder = await e.call("files_search", { query: "x", folder: "/f.txt" });
		expect(code(notFolder)).toBe("invalid_input");
		const missing = await e.call("files_search", { query: "x", folder: "/Nope" });
		expect(code(missing)).toBe("not_found");
		expect(e.davCalls().filter((c) => c.method === "SEARCH")).toHaveLength(0);
	});
	it("a folder whose name can't be a search scope is searched from its parent and filtered to the folder", async () => {
		const e = await setup();
		e.files.write(QA.a, "/Work/Odd 100% #1 & ?/odd one.txt", "x");
		e.files.write(QA.a, "/Work/Odd 100% #1 & ?/Deeper/odd two.txt", "x");
		e.files.write(QA.a, "/Work/Odd 100% #1 & ?.txt", "x");
		e.files.write(QA.a, "/Work/Other/odd three.txt", "x");
		e.files.write(QA.a, "/odd top.txt", "x");
		const r = await e.call("files_search", { query: "odd", match: "name", folder: "/Work/Odd 100% #1 & ?" });
		const out = sc<Out>(r);
		expect(out.items.map((i) => i.path).sort()).toEqual(["/Work/Odd 100% #1 & ?/Deeper/odd two.txt", "/Work/Odd 100% #1 & ?/odd one.txt"]);
		expect(out).toMatchObject({ has_more: false, next_cursor: null, note: null });
		// The scope is the deepest parent that passes the egress check, sent raw (not the folder itself).
		const s = e.davCalls().filter((c) => c.method === "SEARCH");
		expect(s).toHaveLength(1);
		expect(s[0]?.body).toContain("<d:href>/files/qa-t1-91/Work</d:href>");
		expect(s[0]?.body).toContain("<d:nresults>100</d:nresults>");
		// A folder whose own name decodes to "/" (a literal "%2F") is handled the same way.
		e.files.write(QA.a, "/a%2Fb/odd four.txt", "x");
		const slash = sc<Out>(await e.call("files_search", { query: "odd", match: "name", folder: "/a%2Fb" }));
		expect(slash.items.map((i) => i.path)).toEqual(["/a%2Fb/odd four.txt"]);
		expect(e.davCalls().filter((c) => c.method === "SEARCH").pop()?.body).toContain("<d:href>/files/qa-t1-91</d:href>");
		// A name that decodes to something harmless ("%20") travels as it is.
		e.files.write(QA.a, "/x%20y/odd five.txt", "x");
		const fine = sc<Out>(await e.call("files_search", { query: "odd", match: "name", folder: "/x%20y" }));
		expect(fine.items.map((i) => i.path)).toEqual(["/x%20y/odd five.txt"]);
		expect(e.davCalls().filter((c) => c.method === "SEARCH").pop()?.body).toContain("<d:href>/files/qa-t1-91/x%20y</d:href>");
	});
	it("searching such a folder from its parent goes in steps and pages without gaps or repeats", async () => {
		const e = await setup();
		// Newest first: 1 match inside the folder, then 400 outside it, then 3 more inside (older).
		for (let i = 0; i < 3; i++) e.files.write(QA.a, `/P/Odd 50%/kiwi in ${i}.txt`, "x");
		for (let i = 0; i < 400; i++) e.files.write(QA.a, `/P/Elsewhere/kiwi out ${String(i).padStart(3, "0")}.txt`, "x");
		e.files.write(QA.a, "/P/Odd 50%/kiwi in 3.txt", "x");
		const seen: string[] = [];
		let cursor: string | null = null;
		const pages: Out[] = [];
		do {
			const p: Out = sc<Out>(await e.call("files_search", { query: "kiwi", match: "name", folder: "/P/Odd 50%", limit: 2, ...(cursor ? { cursor } : {}) }));
			pages.push(p);
			seen.push(...p.items.map((i) => i.path));
			cursor = p.next_cursor;
		} while (cursor && pages.length < 10);
		expect(seen).toEqual([3, 2, 1, 0].map((i) => `/P/Odd 50%/kiwi in ${i}.txt`));
		expect(pages.map((p) => p.items.length)).toEqual([1, 2, 1]);
		expect(pages.map((p) => p.has_more)).toEqual([true, true, false]);
		// A call reads at most 3 steps of 100; the page cut short by that says so and continues there.
		expect(pages[0]?.note).toBe("Names inside this folder are searched in steps; next_cursor continues.");
		expect(pages[1]?.note).toBeNull();
		const firsts = e.davCalls()
			.filter((c) => c.method === "SEARCH")
			.map((c) => Number(/<ns:firstresult>(\d+)</.exec(c.body)?.[1]));
		expect(firsts).toEqual([0, 100, 200, 300, 400, 403]);
	});
});

describe("files_search: inside files", () => {
	it("auto merges names and contents, marks both, resolves ids inside the person's root", async () => {
		const e = await setup();
		e.files.write(QA.a, "/Notes/budget.md", "the budget for unicorn travel");
		e.files.write(QA.a, "/Notes/plan.md", "unicorn plan details");
		e.files.write(QA.a, "/unicorn.txt", "nothing here");
		e.files.write(QA.a, "/Other/unicorn-notes.md", "unicorn again");
		const r = await e.call("files_search", { query: "unicorn" });
		const out = sc<Out>(r);
		expect(out.content_search_available).toBe(true);
		const byPath = Object.fromEntries(out.items.map((i) => [i.path, i]));
		expect(byPath["/unicorn.txt"]?.match).toBe("name");
		expect(byPath["/Other/unicorn-notes.md"]?.match).toBe("both");
		expect(byPath["/Other/unicorn-notes.md"]?.excerpt).toBe("unicorn again");
		expect(byPath["/Notes/budget.md"]).toMatchObject({ match: "content", excerpt: "the budget for unicorn travel" });
		expect(byPath["/Notes/plan.md"]?.match).toBe("content");
		expect(out.items).toHaveLength(4);
		expect(out.items.slice(0, 2).every((i) => i.match !== "content")).toBe(true);
		const fts = e.davCalls().find((c) => c.url.pathname === "/ocs/v2.php/search/providers/fulltextsearch/search");
		expect(fts?.url.searchParams.get("term")).toBe("unicorn");
		expect(fts?.url.searchParams.get("limit")).toBe("20");
		expect(fts?.url.searchParams.has("cursor")).toBe(false);
		expect(fts?.headers.get("ocs-apirequest")).toBe("true");
		const resolve = e.davCalls().filter((c) => c.method === "SEARCH").pop();
		expect(resolve?.body).toContain("<oc:fileid/>");
		expect(resolve?.body).toContain("<d:href>/files/qa-t1-91</d:href>");
		expect(text(r).split("\n")[0]).toBe("Found 4 items (2 by name, 2 by content only).");
	});
	it("content mode pages through the provider by its own page size", async () => {
		const e = await setup();
		for (let i = 0; i < 5; i++) e.files.write(QA.a, `/c/doc${i}.txt`, `zebra ${i}`);
		const p1 = sc<Out>(await e.call("files_search", { query: "zebra", match: "content", limit: 2 }));
		expect(p1.items.map((i) => i.path)).toEqual(["/c/doc0.txt", "/c/doc1.txt"]);
		const p2 = sc<Out>(await e.call("files_search", { query: "zebra", match: "content", limit: 2, cursor: p1.next_cursor }));
		const p3 = sc<Out>(await e.call("files_search", { query: "zebra", match: "content", limit: 2, cursor: p2.next_cursor }));
		expect([...p2.items, ...p3.items].map((i) => i.path)).toEqual(["/c/doc2.txt", "/c/doc3.txt", "/c/doc4.txt"]);
		const cursors = e.davCalls()
			.filter((c) => c.url.pathname.endsWith("/fulltextsearch/search"))
			.map((c) => c.url.searchParams.get("cursor"));
		expect(cursors.slice(0, 3)).toEqual([null, "2", "4"]);
		expect(p3.items.every((i) => i.match === "content")).toBe(true);
	});
	it("drops results that don't resolve, are outside the folder or of another type", async () => {
		const e = await setup();
		e.files.write(QA.a, "/In/a.txt", "kiwi");
		e.files.write(QA.a, "/Out/b.txt", "kiwi");
		e.files.write(QA.a, "/In/c.pdf", "kiwi");
		e.fake.on("GET", /^\/ocs\/v2\.php\/search\/providers\/fulltextsearch\/search$/, () =>
			ocs({
				isPaginated: true,
				entries: [
					...["/In/a.txt", "/Out/b.txt", "/In/c.pdf"].map((p) => ({ title: "(files) kiwi", subline: p.slice(1), resourceUrl: `/f/${e.files.get(QA.a, p)?.id}` })),
					{ title: "(files) kiwi", subline: "Elsewhere/x.txt", resourceUrl: "/f/999999" },
					{ title: "(calendar) kiwi", subline: "", resourceUrl: "/apps/calendar" },
				],
			}),
		);
		const r = sc<Out>(await e.call("files_search", { query: "kiwi", match: "content", folder: "/In", type: "text" }));
		expect(r.items.map((i) => i.path)).toEqual(["/In/a.txt"]);
	});
	it("an outage of search inside files leaves the name results, with a note", async () => {
		const e = await setup();
		e.files.write(QA.a, "/kiwi.txt", "x");
		e.files.ftsDown = true;
		const r = sc<Out>(await e.call("files_search", { query: "kiwi" }));
		expect(r.items.map((i) => i.path)).toEqual(["/kiwi.txt"]);
		expect(r.note).toContain("only names were searched");
		expect(r.has_more).toBe(false);
		const only = await e.call("files_search", { query: "kiwi", match: "content" });
		expect(sc<Out>(only).note).toContain("didn't answer");
	});
	it("without the provider listed, says so and searches names only; never calls an unlisted provider", async () => {
		const e = await setup();
		e.fake.providers = e.fake.providers.filter((p) => p.id !== "fulltextsearch");
		e.files.write(QA.a, "/kiwi.txt", "kiwi");
		const r = sc<Out>(await e.call("files_search", { query: "kiwi", match: "auto" }));
		expect(r.content_search_available).toBe(false);
		expect(r.note).toContain("isn't available");
		expect(r.items.map((i) => i.path)).toEqual(["/kiwi.txt"]);
		expect(e.davCalls().some((c) => c.url.pathname.endsWith("/fulltextsearch/search"))).toBe(false);
	});
	it("an empty content search notes that the index can lag", async () => {
		const e = await setup();
		const r = sc<Out>(await e.call("files_search", { query: "nothinghere", match: "content" }));
		expect(r.items).toEqual([]);
		expect(r.note).toContain("index can lag");
		expect(r.has_more).toBe(false);
	});
});
