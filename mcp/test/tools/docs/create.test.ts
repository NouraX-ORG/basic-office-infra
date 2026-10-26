/**
 * Contract tests for docs_create_document, docs_create_spreadsheet and docs_create_presentation
 * (DESIGN 17.3): the exact outgoing requests, the file written, if_exists, invalid input, and
 * NoDrive's 403, 409, 412, 423, 507 and 5xx answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractText } from "../../../src/docs/extract/index";
import { type FakeNc } from "../../fake-nc/index";
import { installOffice, type OfficeFake } from "../../fake-nc/office";
import { fakeWithQa, QA } from "../../helpers/index";
import { checkPackage, fixture } from "../../docs/helpers";
import { callTool, calls, failed, freshDay, ok } from "./helpers";

let fake: FakeNc;
let office: OfficeFake;
beforeEach(() => {
	freshDay();
	fake = fakeWithQa();
	office = installOffice(fake);
	office.addFolder(QA.a, "/Reports");
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function textOf(bytes: Uint8Array, name: string): Promise<string> {
	const r = await extractText(bytes, { name, mime: null, offset: 0, maxChars: 50_000 });
	if (!("text" in r)) throw new Error("no text");
	return r.text;
}

describe("docs_create_document", () => {
	it("writes a new .docx with If-None-Match and returns the file", async () => {
		const r = await callTool("docs_create_document", { path: "/Reports/Plan Q4.docx", markdown: "# Plan\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |", title: "Plan" });
		const data = ok("docs_create_document", r);
		expect(data).toMatchObject({ renamed: false, file: { path: "/Reports/Plan Q4.docx", name: "Plan Q4.docx", type: "file", mime: DOCX } });
		expect((data.file as { web_url: string }).web_url).toMatch(/^https:\/\/drive\.nourax\.org\/f\/\d+$/);
		expect(r.content[0]?.text.split("\n")[0]).toBe("Created the Word document /Reports/Plan Q4.docx (" + `${(office.file(QA.a, "/Reports/Plan Q4.docx")?.bytes.length ?? 0) / 1024}`.replace(/(\.\d)\d*/, "$1") + " KB; 1 heading, 1 table, 1 list).");
		const put = calls(fake, "PUT", /\/remote\.php\/dav\/files\/qa-t1-91\/Reports\/Plan%20Q4\.docx$/)[0];
		expect(put?.headers.get("if-none-match")).toBe("*");
		expect(put?.headers.get("content-type")).toBe(DOCX);
		expect(put?.headers.get("authorization")).toMatch(/^Basic /);
		expect(put?.auth).toBe(QA.a);
		const stored = office.file(QA.a, "/Reports/Plan Q4.docx")?.bytes as Uint8Array;
		checkPackage(stored);
		expect(await textOf(stored, "x.docx")).toBe("# Plan\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |");
	});
	it("if_exists fail stops; rename saves a numbered copy", async () => {
		office.addFile(QA.a, "/Reports/A.docx", "old");
		failed(await callTool("docs_create_document", { path: "/Reports/A.docx", markdown: "x" }), "already_exists");
		expect(new TextDecoder().decode(office.file(QA.a, "/Reports/A.docx")?.bytes)).toBe("old");
		const r = await callTool("docs_create_document", { path: "/Reports/A.docx", markdown: "x", if_exists: "rename" });
		expect(ok("docs_create_document", r)).toMatchObject({ renamed: true, file: { path: "/Reports/A (2).docx" } });
		expect(r.content[0]?.text).toContain("The name was taken, so it was saved as /Reports/A (2).docx.");
	});
	it("refuses wrong extensions, macro formats, the root and traversal before any upload", async () => {
		fake.requests.length = 0;
		expect(failed(await callTool("docs_create_document", { path: "/Reports/A.doc", markdown: "x" }), "invalid_input", "path")).toContain('must end in ".docx"');
		expect(failed(await callTool("docs_create_document", { path: "/Reports/A.docm", markdown: "x" }), "invalid_input", "path")).toContain("macros");
		failed(await callTool("docs_create_document", { path: "/../qa-t1-92/A.docx", markdown: "x" }), "invalid_input", "path");
		failed(await callTool("docs_create_document", { path: "/", markdown: "x" }), "invalid_input", "path");
		failed(await callTool("docs_create_document", { path: "/a.docx", markdown: "x", surprise: 1 }), "invalid_input");
		failed(await callTool("docs_create_document", { path: "/a.docx", markdown: "x".repeat(400_001) }), "invalid_input", "markdown");
		expect(calls(fake, "PUT", /./)).toHaveLength(0);
	});
	it("fix round 2: the summary counts a bullet list and a numbered list as two lists", async () => {
		const r = await callTool("docs_create_document", { path: "/Reports/L.docx", markdown: "# T\n\n- a\n- b\n\n1. first\n2. second" });
		expect(r.content[0]?.text.split("\n")[0]).toMatch(/; 1 heading, 0 tables, 2 lists\)\.$/);
		const doc = checkPackage(office.file(QA.a, "/Reports/L.docx")?.bytes as Uint8Array).get("word/document.xml") ?? "";
		// The bullets and the numbers keep their own numbering.
		const ids = [...doc.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]);
		expect(ids).toHaveLength(4);
		expect(ids[0]).toBe(ids[1]);
		expect(ids[2]).toBe(ids[3]);
		expect(ids[0]).not.toBe(ids[2]);
	});
	it("maps NoDrive's answers to plain errors", async () => {
		// fix round 2: a missing folder is named as the folder, with what can make it.
		expect(failed(await callTool("docs_create_document", { path: "/Missing/A.docx", markdown: "x" }), "parent_missing", "path")).toBe("The folder /Missing doesn't exist. files_create_folder can make it.");
		for (const [status, code] of [
			[403, "permission_denied"],
			[423, "locked"],
			[507, "quota_exceeded"],
			[500, "upstream_unavailable"],
		] as const) {
			fake.on("PUT", /^\/remote\.php\/dav\/files\/qa-t1-91\/Reports\/Err\.docx$/, () => new Response("<s:exception>Sabre\\DAV\\Exception</s:exception>", { status }));
			failed(await callTool("docs_create_document", { path: "/Reports/Err.docx", markdown: "x" }), code);
		}
	});
	it("a read-only connection is asked to step up", async () => {
		const { devToken, mcpPost } = await import("../../helpers/index");
		const t = await devToken(QA.a, { scopes: ["workspace.read"] });
		const res = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "docs_create_document", arguments: { path: "/a.docx", markdown: "x" } } });
		expect(res.status).toBe(403);
		expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
	});
});

describe("docs_create_spreadsheet", () => {
	it("builds typed sheets and reports warnings", async () => {
		const r = await callTool("docs_create_spreadsheet", {
			path: "/Reports/Budget.xlsx",
			sheets: [
				{ name: "Costs", columns: [{ header: "Item" }, { header: "Cost", type: "currency" }, { header: "When", type: "date" }, { header: "Total", type: "formula" }], rows: [["Tea", 2.5, "2026-10-25", "=B2*2"], ["=evil()", "n/a", "2026-10-26", "=B3*2"]] },
				{ rows: [["a", "b"], [1, true]] },
			],
		});
		const data = ok("docs_create_spreadsheet", r);
		expect(data.sheets).toEqual([
			{ name: "Costs", rows: 2, columns: 4 },
			{ name: "Sheet2", rows: 1, columns: 2 },
		]);
		expect((data.warnings as string[])[0]).toMatch(/column "Cost": some values aren't valid for type currency/);
		const stored = office.file(QA.a, "/Reports/Budget.xlsx")?.bytes as Uint8Array;
		const parts = checkPackage(stored);
		expect(parts.get("xl/worksheets/sheet1.xml")?.match(/<f>/g)).toHaveLength(2);
		expect(await textOf(stored, "b.xlsx")).toContain("Tea,2.5,2026-10-25,=B2*2\n=evil(),n/a,2026-10-26,=B3*2");
	});
	it("builds from CSV", async () => {
		const r = await callTool("docs_create_spreadsheet", { path: "/Reports/c.xlsx", csv: "name,qty\nTea,2\n=1+1,3\n" });
		expect(ok("docs_create_spreadsheet", r).sheets).toEqual([{ name: "Sheet1", rows: 2, columns: 2 }]);
		const parts = checkPackage(office.file(QA.a, "/Reports/c.xlsx")?.bytes as Uint8Array);
		expect(parts.get("xl/worksheets/sheet1.xml")).not.toContain("<f>");
	});
	it("refuses both or neither input, outside-reaching formulas and too many cells", async () => {
		failed(await callTool("docs_create_spreadsheet", { path: "/a.xlsx" }), "invalid_input", "sheets");
		failed(await callTool("docs_create_spreadsheet", { path: "/a.xlsx", csv: "a", sheets: [{ rows: [] }] }), "invalid_input", "sheets");
		const t = failed(await callTool("docs_create_spreadsheet", { path: "/a.xlsx", sheets: [{ columns: [{ header: "f", type: "formula" }], rows: [['=WEBSERVICE("https://x.example")']] }] }), "invalid_input");
		expect(t).toContain("reaches outside the spreadsheet");
		failed(await callTool("docs_create_spreadsheet", { path: "/a.xlsx", sheets: Array.from({ length: 21 }, () => ({ rows: [] })) }), "invalid_input", "sheets");
		failed(await callTool("docs_create_spreadsheet", { path: "/a.xlsx", csv: "x\n".repeat(50_002) }), "invalid_input", "csv");
		failed(await callTool("docs_create_spreadsheet", { path: "/a.csv", csv: "a" }), "invalid_input", "path");
		expect(calls(fake, "PUT", /./)).toHaveLength(0);
	});
});

describe("docs_create_presentation", () => {
	it("builds slides with layouts, bullets and notes", async () => {
		const r = await callTool("docs_create_presentation", {
			path: "/Reports/Deck.pptx",
			slides: [
				{ title: "Kick-off", layout: "title", body: "October" },
				{ title: "Agenda", bullets: ["One", { text: "Sub", level: 2 }], notes: "Smile" },
				{ title: "Next", layout: "section" },
			],
		});
		expect(ok("docs_create_presentation", r)).toMatchObject({ slides: 3, renamed: false, file: { path: "/Reports/Deck.pptx" } });
		const stored = office.file(QA.a, "/Reports/Deck.pptx")?.bytes as Uint8Array;
		checkPackage(stored);
		expect(await textOf(stored, "d.pptx")).toBe("## Slide 1: Kick-off\n\nOctober\n\n## Slide 2: Agenda\n\nOne\n  Sub\n\nNotes: Smile\n\n## Slide 3: Next");
	});
	it("refuses no slides, too many, unknown layouts and bad levels", async () => {
		failed(await callTool("docs_create_presentation", { path: "/a.pptx", slides: [] }), "invalid_input", "slides");
		failed(await callTool("docs_create_presentation", { path: "/a.pptx", slides: Array.from({ length: 61 }, () => ({ title: "x" })) }), "invalid_input", "slides");
		failed(await callTool("docs_create_presentation", { path: "/a.pptx", slides: [{ layout: "blank" }] }), "invalid_input");
		failed(await callTool("docs_create_presentation", { path: "/a.pptx", slides: [{ bullets: [{ text: "x", level: 3 }] }] }), "invalid_input");
	});
});

describe("MCP SDK client (both eras)", () => {
	it("accepts the results against the published output schemas, warnings included", async () => {
		const { devToken, sdkClient } = await import("../../helpers/index");
		office.addFile(QA.a, "/Reports/r.md", "# Hi\n\ntext");
		const t = await devToken(QA.a);
		for (const mode of ["legacy", "auto"] as const) {
			const client = await sdkClient(t.access_token, { mode });
			const s = await client.callTool({
				name: "docs_create_spreadsheet",
				arguments: { path: `/Reports/sdk-${mode}.xlsx`, sheets: [{ columns: [{ header: "n", type: "number" }], rows: [["x"]] }] },
			});
			expect(s.isError, JSON.stringify(s.content)).toBeFalsy();
			expect((s.structuredContent as { warnings: string[] }).warnings).toHaveLength(1);
			const d = await client.callTool({ name: "docs_create_document", arguments: { path: `/Reports/sdk-${mode}.docx`, markdown: "# x" } });
			expect(d.isError).toBeFalsy();
			const r = await client.callTool({ name: "files_read_text", arguments: { path: "/Reports/r.md" } });
			expect(r.structuredContent).toMatchObject({ format: "markdown", total_chars: 10 });
			const listed = await client.listTools();
			const doc = listed.tools.find((x) => x.name === "docs_create_document");
			expect(doc?.annotations).toEqual({ title: "Create a Word document", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
			expect(listed.tools.find((x) => x.name === "files_read_text")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
			await client.close();
		}
	});
});

describe("fix round 2: limits a client can see before it calls", () => {
	it("docs_fill_template publishes values' 200-key limit (maxProperties and the description); docs_create_spreadsheet says what counts", async () => {
		const { devToken, mcpPost, rpcResult } = await import("../../helpers/index");
		const t = await devToken(QA.a, { scopes: ["workspace.read", "workspace.write"] });
		const body = await rpcResult(await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
		const tools = (body.result as { tools: { name: string; description: string; inputSchema: { properties: Record<string, Record<string, unknown>> } }[] }).tools;
		const fill = tools.find((x) => x.name === "docs_fill_template");
		const values = fill?.inputSchema.properties.values ?? {};
		expect(values.maxProperties).toBe(200);
		expect(values.description).toContain("(200 at most)");
		const sheet = tools.find((x) => x.name === "docs_create_spreadsheet");
		expect(sheet?.description).toContain("Up to 20 sheets and 50,000 cells; with sheets, each row and column setting also counts.");
		// 201 keys: still refused in plain words at run time (whatever a client sends).
		office.addFile(QA.a, "/T.docx", fixture("word-python-docx.docx"));
		const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, "v"]));
		expect(failed(await callTool("docs_fill_template", { template_path: "/T.docx", output_path: "/U.docx", values: many }), "invalid_input", "values")).toBe("values can have at most 200 fields.");
	});
});
