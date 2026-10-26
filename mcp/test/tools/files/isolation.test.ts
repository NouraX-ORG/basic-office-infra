/**
 * Isolation (DESIGN 17.6, contract side): no input to a files tool reaches a DAV path outside the
 * person's own root. Traversal, encoded tricks and web addresses are refused locally, before any
 * call; and a property test feeds arbitrary paths and checks every request that is made.
 */
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QA } from "../../helpers/index";
import { code, setup } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const OWN = /^\/remote\.php\/dav\/(?:files\/qa-t1-91(?:\/|$)|trashbin\/qa-t1-91\/|versions\/qa-t1-91\/|principals\/users\/qa-t1-91\/$|$)/;

const TRICKS = [
	"/../qa-t1-92/secret.txt",
	"/a/../../qa-t1-92",
	"..",
	"/./x",
	"/x/..",
	"\\..\\qa-t1-92",
	"/x\u0000y",
	"https://drive.nourax.org/remote.php/dav/files/qa-t1-92/secret.txt",
	"http://evil.example/x",
	"/x\u2028y",
	"/.htaccess",
	"/a.part",
];

describe("isolation", () => {
	it("refuses traversal, control characters and web addresses before any call", async () => {
		const e = await setup();
		e.files.write(QA.b, "/secret.txt", "theirs");
		for (const p of TRICKS) {
			const before = e.davCalls().length;
			for (const [tool, args] of [
				["files_get_info", { path: p }],
				["files_list_folder", { path: p }],
				["files_move_to_trash", { path: p }],
				["files_create_file", { path: `${p}/new.txt`, content: "x" }],
				["files_move", { path: "/ok.txt", to_folder: p }],
			] as const) {
				const r = await e.call(tool, args);
				expect(code(r), `${tool} ${JSON.stringify(p)}`).toBe("invalid_input");
			}
			expect(e.davCalls().length, JSON.stringify(p)).toBe(before);
		}
		expect(e.files.text(QA.b, "/secret.txt")).toBe("theirs");
	});
	it("takes percent signs literally: %2e%2e is a name, never a parent folder", async () => {
		const e = await setup();
		await e.call("files_get_info", { path: "/%2e%2e/qa-t1-92/secret.txt" });
		await e.call("files_create_folder", { path: "/%2F" });
		for (const c of e.davCalls()) expect(c.url.pathname, c.url.pathname).toMatch(OWN);
		expect(e.davCalls().map((c) => c.url.pathname)).toContain("/remote.php/dav/files/qa-t1-91/%252e%252e/qa-t1-92/secret.txt");
		expect(e.files.get(QA.a, "/%2F")?.type).toBe("folder");
	});
	it("ids for the trash and versions can't name a path", async () => {
		const e = await setup();
		for (const id of ["../../files/qa-t1-92/x.d1", "x.d1/../../y.d2", "..\\x.d1"]) {
			expect(code(await e.call("files_restore_from_trash", { trash_item_id: id })), id).toBe("invalid_input");
		}
		// Percent signs are literal: this is a (missing) item with an odd name, inside the own trash.
		expect(code(await e.call("files_restore_from_trash", { trash_item_id: "..%2f..%2fx.d1" }))).toBe("not_found");
		expect(e.davCalls().map((c) => c.url.pathname)).toContain("/remote.php/dav/trashbin/qa-t1-91/trash/..%252f..%252fx.d1");
		expect(code(await e.call("files_restore_version", { path: "/a.txt", version_id: "1/../2" }))).toBe("invalid_input");
		for (const c of e.davCalls()) expect(c.url.pathname).toMatch(OWN);
	});
	it("property: any path string only ever reaches the person's own DAV root", async () => {
		const e = await setup();
		e.files.write(QA.b, "/secret.txt", "theirs");
		const seg = fc.oneof(
			fc.constantFrom("..", ".", "%2e%2e", "%2F", "qa-t1-92", "files", "remote.php", "dav", "．．", "∕", "a b", "é", "~", "%00"),
			fc.string({ maxLength: 12 }),
		);
		const path = fc.array(seg, { maxLength: 6 }).map((s) => s.join("/"));
		await fc.assert(
			fc.asyncProperty(fc.oneof(path, path.map((p) => `/${p}`), fc.string({ maxLength: 40 })), async (p) => {
				const before = e.fake.requests.length;
				await e.call("files_get_info", { path: p });
				for (const r of e.fake.requests.slice(before)) {
					if (r.url.pathname.startsWith("/remote.php/")) expect(r.url.pathname).toMatch(OWN);
					expect(r.url.host).toBe("drive.nourax.org");
				}
			}),
			{ numRuns: 60 },
		);
		expect(e.files.text(QA.b, "/secret.txt")).toBe("theirs");
	});
});
