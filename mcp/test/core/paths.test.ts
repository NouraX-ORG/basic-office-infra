import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { config } from "../../src/env";
import { checkEgress } from "../../src/core/egress";
import { ToolError } from "../../src/core/errors";
import { davFilesPath, davFilesRoot, hrefToUserPath, joinPath, normalizePath, numberedName, parentOf, splitExt } from "../../src/core/paths";
import { env } from "../helpers/index";

const UID = "5224252b-4938-4a86-a276-54bbae5d5b49";

function refused(input: unknown): boolean {
	try {
		normalizePath(input);
		return false;
	} catch (e) {
		return e instanceof ToolError && e.code === "invalid_input";
	}
}

describe("normalizePath", () => {
	it("normalises", () => {
		expect(normalizePath("Documents/a.docx")).toBe("/Documents/a.docx");
		expect(normalizePath("//Documents//a.docx/")).toBe("/Documents/a.docx");
		expect(normalizePath("/")).toBe("/");
		expect(normalizePath("")).toBe("/");
		expect(normalizePath("/Cafe\u0301")).toBe("/Caf\u00e9");
	});
	it("refuses dot segments, controls, backslashes and forbidden names", () => {
		for (const bad of ["/a/../b", "/..", "/./a", "..", "/a\u0000b", "/a\\b", "/a\nb", "/ ", "/a/  /b", "/ .. /x", "/.htaccess", "/x.part", "/X.PART", "/x.filepart", "/a\u2028b", "/\u007f"]) {
			expect(refused(bad), bad).toBe(true);
		}
		expect(refused("/".repeat(1) + "a".repeat(251))).toBe(true);
		expect(refused(`/${"a/".repeat(600)}`)).toBe(true);
		expect(refused(42)).toBe(true);
	});
	it("lets existing names start or end with a space, as NoDrive does; a name a tool creates may not (fix round 3)", () => {
		// NC 35.0.2 accepts " Plan .docx", "Trail " and a folder "Team " (checked live by the review).
		expect(normalizePath("/ Plan .docx")).toBe("/ Plan .docx");
		expect(normalizePath("/Team /a.docx")).toBe("/Team /a.docx");
		expect(normalizePath("/Trail ")).toBe("/Trail ");
		expect(hrefToUserPath(`/remote.php/dav/files/${UID}/Team%20/%20Plan%20.docx`, UID)).toBe("/Team / Plan .docx");
		expect(joinPath(normalizePath("/Archive"), " Plan .docx")).toBe("/Archive/ Plan .docx");
		// A path a tool creates: the parents may have spaces at the ends, the new name may not.
		expect(normalizePath("/Team /new.txt", { newName: true })).toBe("/Team /new.txt");
		for (const bad of ["/new ", "/ new", "/Team / new.txt"]) expect(() => normalizePath(bad, { newName: true }), bad).toThrow(ToolError);
	});
	it("treats percent sequences literally", () => {
		expect(normalizePath("/%2e%2e/x")).toBe("/%2e%2e/x");
		expect(davFilesPath(UID, normalizePath("/%2e%2e/x"))).toBe(`/remote.php/dav/files/${UID}/%252e%252e/x`);
	});
	it("refuses the root when asked", () => {
		expect(() => normalizePath("/", { allowRoot: false })).toThrow(ToolError);
	});
	it("helpers", () => {
		expect(parentOf(normalizePath("/a/b/c.txt"))).toBe("/a/b");
		expect(parentOf(normalizePath("/c.txt"))).toBe("/");
		expect(joinPath(normalizePath("/a"), "b c.txt")).toBe("/a/b c.txt");
		expect(() => joinPath(normalizePath("/a"), "x/y")).toThrow(ToolError);
		expect(numberedName("Q4 report.xlsx", 2)).toBe("Q4 report (2).xlsx");
		expect(splitExt(".bashrc")).toEqual({ stem: ".bashrc", ext: "" });
		expect(davFilesPath(UID, normalizePath("/"))).toBe(`${davFilesRoot(UID)}/`);
	});
	it("maps hrefs back and drops anything outside the person's root", () => {
		expect(hrefToUserPath(`/remote.php/dav/files/${UID}/Projects/Plan%20A.docx`, UID)).toBe("/Projects/Plan A.docx");
		expect(hrefToUserPath(`/remote.php/dav/files/${UID}/`, UID)).toBe("/");
		expect(hrefToUserPath("/remote.php/dav/files/someone-else/x", UID)).toBeNull();
		expect(hrefToUserPath(`/remote.php/dav/files/${UID}/%2e%2e/x`, UID)).toBeNull();
		expect(hrefToUserPath(`/remote.php/dav/trashbin/${UID}/trash/x`, UID)).toBeNull();
		expect(hrefToUserPath(`https://drive.nourax.org/remote.php/dav/files/${UID}/a`, UID)).toBe("/a");
	});
});

describe("property: no input escapes the person's root", () => {
	const cfg = () => config(env);
	const tricky = fc.oneof(
		fc.string({ maxLength: 60 }),
		fc.constantFrom("..", ".", "%2e%2e", "%2E%2E", "%2f", "..%2f", "\uff0e\uff0e", "\u2215", "http://evil.test/x", "//evil.test", "\\..\\", "%c0%ae%c0%ae", "~", "@", "?", "#", ";"),
	);
	it("every accepted path builds a DAV URL inside /remote.php/dav/files/{uid}/ that egress accepts", () => {
		fc.assert(
			fc.property(fc.array(tricky, { maxLength: 6 }), (parts) => {
				const raw = parts.join("/");
				let p: ReturnType<typeof normalizePath>;
				try {
					p = normalizePath(raw);
				} catch (e) {
					return e instanceof ToolError;
				}
				const url = new URL(`https://drive.nourax.org${davFilesPath(UID, p)}`);
				if (!url.pathname.startsWith(`/remote.php/dav/files/${UID}/`)) return false;
				if (url.search || url.hash) return false;
				checkEgress(cfg(), url.toString(), { method: "PROPFIND" }, UID);
				return hrefToUserPath(url.pathname, UID) === p;
			}),
			{ numRuns: 600 },
		);
	});
});
