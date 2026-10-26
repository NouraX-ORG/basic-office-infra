/**
 * A tool's ctx.log.note codes reach its log line, and "href_outside" is an auth event of its own
 * (DESIGN 15; third system review, section 30.5). Before, the notes were collected and never written.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitize } from "../../src/core/log";
import { QA } from "../helpers/index";
import { sc, setup } from "../tools/files/helpers";

afterEach(() => vi.restoreAllMocks());

function capture(): Record<string, unknown>[] {
	const lines: Record<string, unknown>[] = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		try {
			lines.push(JSON.parse(a.map(String).join(" ")) as Record<string, unknown>);
		} catch {
			// not one of our JSON lines
		}
	});
	return lines;
}

const response = (href: string) =>
	`<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getlastmodified>${new Date().toUTCString()}</d:getlastmodified><d:getcontenttype>text/plain</d:getcontenttype><d:getcontentlength>3</d:getcontentlength><oc:fileid>${Math.floor(Math.random() * 1e6)}</oc:fileid><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

describe("tool notes in the log", () => {
	it("a multistatus with an href outside the person's files: dropped, noted on the tool line, and an href_outside auth event once", async () => {
		const e = await setup();
		e.fake.on("SEARCH", /^\/remote\.php\/dav\/?$/, () =>
			new Response(
				`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${response(`/remote.php/dav/files/${QA.a}/mine.txt`)}${response(`/remote.php/dav/files/${QA.b}/secret.txt`)}${response(`/remote.php/dav/files/${QA.b}/other.txt`)}</d:multistatus>`,
				{ status: 207, headers: { "content-type": "application/xml; charset=utf-8" } },
			),
		);
		const lines = capture();
		const r = await e.call("files_list_recent", {});
		const out = sc<{ items: { path: string }[] }>(r);
		expect(out.items.map((i) => i.path)).toEqual(["/mine.txt"]);
		const tool = lines.filter((l) => l.t === "tool" && l.tool === "files_list_recent");
		expect(tool).toHaveLength(1);
		// Two outside hrefs, one code: each note is logged once.
		expect(tool[0]?.notes).toEqual(["href_outside"]);
		const outside = lines.filter((l) => l.t === "auth" && l.ev === "href_outside");
		expect(outside).toHaveLength(1);
		expect(outside[0]?.who).toBe(tool[0]?.who);
		expect(outside[0]?.rid).toBe(tool[0]?.rid);
		// Metadata only: no path or account of the other person.
		for (const l of lines) expect(JSON.stringify(l)).not.toMatch(/secret\.txt|other\.txt|qa-t1-92|mine\.txt/);
	});
	it("other notes reach the line too (the recent list's fallback), and a call without notes has no notes key", async () => {
		const e = await setup();
		const lines = capture();
		await e.call("files_list_recent", {});
		const plain = lines.filter((l) => l.t === "tool" && l.tool === "files_list_recent");
		expect(plain).toHaveLength(1);
		expect("notes" in (plain[0] as object)).toBe(false);
		e.fake.on("SEARCH", /^\/remote\.php\/dav\/?$/, () => new Response("", { status: 500 }));
		await e.call("files_list_recent", {});
		const fell = lines.filter((l) => l.t === "tool" && l.tool === "files_list_recent");
		expect(fell[1]?.notes).toEqual(["recent_fallback"]);
		expect(lines.some((l) => l.t === "auth" && l.ev === "href_outside")).toBe(false);
	});
	it("sanitize keeps only short lower-case codes in notes, each once, at most 10", () => {
		const many = Array.from({ length: 14 }, (_, i) => `code_${i}`);
		const out = sanitize({ t: "tool", rid: "r", tool: "x", ok: true, notes: ["fit_cut", "fit_cut", "/Projects/Secret plan.docx", "hammad@example.com", ...many] });
		const notes = out.notes as string[];
		expect(notes[0]).toBe("fit_cut");
		expect(notes[1]).toBe("redacted");
		expect(notes).toHaveLength(10);
		expect(new Set(notes).size).toBe(notes.length);
		expect(JSON.stringify(out)).not.toMatch(/Secret|hammad/);
		// Lists are taken only for the tool line's notes.
		expect(sanitize({ t: "auth", ev: "consent_ok", reason: ["a"] as unknown as string })).toEqual({ t: "auth", ev: "consent_ok" });
		expect(sanitize({ t: "tool", rid: "r", notes: [] })).toEqual({ t: "tool", rid: "r" });
	});
});
