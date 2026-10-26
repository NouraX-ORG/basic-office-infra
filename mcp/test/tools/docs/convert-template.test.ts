/**
 * Contract tests for docs_convert, docs_list_template_fields and docs_fill_template (DESIGN 17.3):
 * the file id comes from our own PROPFIND (never from the client), the connector's answer is
 * checked, nothing is written when conversion or filling fails, and the template is never changed.
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
	office.addFile(QA.a, "/Docs/Plan.docx", fixture("word-python-docx.docx"));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("docs_convert", () => {
	it("converts through downloadas with the file id from our PROPFIND and saves next to the original", async () => {
		const id = office.file(QA.a, "/Docs/Plan.docx")?.fileId;
		const r = await callTool("docs_convert", { path: "/Docs/Plan.docx" });
		expect(ok("docs_convert", r)).toMatchObject({ from: "/Docs/Plan.docx", renamed: false, file: { path: "/Docs/Plan.pdf", mime: "application/pdf" } });
		const dl = calls(fake, "GET", /^\/index\.php\/apps\/onlyoffice\/downloadas$/);
		expect(dl).toHaveLength(1);
		expect(dl[0]?.url.searchParams.get("fileId")).toBe(String(id));
		expect(dl[0]?.url.searchParams.get("toExtension")).toBe("pdf");
		expect(dl[0]?.headers.get("authorization")).toMatch(/^Basic /);
		expect(dl[0]?.headers.get("cookie")).toBeNull();
		const put = calls(fake, "PUT", /\/Docs\/Plan\.pdf$/)[0];
		expect(put?.headers.get("if-none-match")).toBe("*");
		expect(new TextDecoder().decode(office.file(QA.a, "/Docs/Plan.pdf")?.bytes).startsWith("%PDF-")).toBe(true);
		expect(r.content[0]?.text.split("\n")[0]).toMatch(/^Saved \/Docs\/Plan\.docx as \/Docs\/Plan\.pdf \(\d+ bytes\)\.$/);
	});
	it("renames by default, fails when asked, and honours output_path", async () => {
		await callTool("docs_convert", { path: "/Docs/Plan.docx" });
		expect(ok("docs_convert", await callTool("docs_convert", { path: "/Docs/Plan.docx" }))).toMatchObject({ renamed: true, file: { path: "/Docs/Plan (2).pdf" } });
		failed(await callTool("docs_convert", { path: "/Docs/Plan.docx", if_exists: "fail" }), "already_exists");
		office.addFolder(QA.a, "/Out");
		expect(ok("docs_convert", await callTool("docs_convert", { path: "/Docs/Plan.docx", to: "odt", output_path: "/Out/plan-copy.odt" }))).toMatchObject({ file: { path: "/Out/plan-copy.odt" } });
		failed(await callTool("docs_convert", { path: "/Docs/Plan.docx", to: "odt", output_path: "/Out/plan.pdf" }), "invalid_input", "output_path");
	});
	it("refuses pairs the connector can't do, and same-format copies, without calling it", async () => {
		office.addFile(QA.a, "/Docs/photo.png", new Uint8Array([137, 80, 78, 71]));
		const t = failed(await callTool("docs_convert", { path: "/Docs/photo.png" }), "unsupported_type");
		expect(t).toBe(".png files can't be converted here.");
		expect(failed(await callTool("docs_convert", { path: "/Docs/Plan.docx", to: "csv" }), "unsupported_type")).toContain("It can become: pdf, odt, txt.");
		failed(await callTool("docs_convert", { path: "/Docs/Plan.docx", to: "docx" }), "invalid_input", "to");
		failed(await callTool("docs_convert", { path: "/Docs/Plan.docx", to: "html" }), "invalid_input", "to");
		expect(calls(fake, "GET", /downloadas/)).toHaveLength(0);
	});
	it("an HTML error page from the connector is a plain failure and nothing is written", async () => {
		office.convert = () => new Response("<!DOCTYPE html><html><body>Error while converting</body></html>", { status: 200, headers: { "content-type": "text/html" } });
		const t = failed(await callTool("docs_convert", { path: "/Docs/Plan.docx" }), "unsupported_type");
		expect(t).toContain("/Docs/Plan.docx couldn't be converted to .pdf");
		office.convert = () => new Response("%PDF-1.7 but labelled html", { status: 200, headers: { "content-type": "text/html" } });
		failed(await callTool("docs_convert", { path: "/Docs/Plan.docx" }), "unsupported_type");
		office.convert = () => new Response("PK\u0003\u0004 not a pdf", { status: 200, headers: { "content-type": "application/pdf" } });
		failed(await callTool("docs_convert", { path: "/Docs/Plan.docx" }), "unsupported_type");
		expect(calls(fake, "PUT", /./)).toHaveLength(0);
	});
	it("missing files, folders, big files and server errors", async () => {
		failed(await callTool("docs_convert", { path: "/Docs/nope.docx" }), "not_found");
		office.addFolder(QA.a, "/Docs/Folder.docx");
		failed(await callTool("docs_convert", { path: "/Docs/Folder.docx" }), "invalid_input", "path");
		office.addFile(QA.a, "/Docs/Huge.docx", new Uint8Array(26 * 1024 * 1024));
		expect(failed(await callTool("docs_convert", { path: "/Docs/Huge.docx" }), "too_large")).toContain("26.0 MB");
		fake.on("GET", /^\/index\.php\/apps\/onlyoffice\/downloadas$/, () => new Response("trace", { status: 500 }));
		// A server error is retryable and its body never reaches the person.
		expect(failed(await callTool("docs_convert", { path: "/Docs/Plan.docx" }), "upstream_unavailable")).not.toContain("trace");
		expect(calls(fake, "PUT", /./)).toHaveLength(0);
	});
});

describe("docs_list_template_fields", () => {
	it("lists fields with counts", async () => {
		const r = await callTool("docs_list_template_fields", { path: "/Docs/Plan.docx" });
		const data = ok("docs_list_template_fields", r);
		expect(data.path).toBe("/Docs/Plan.docx");
		expect(Object.fromEntries((data.fields as { name: string; count: number }[]).map((f) => [f.name, f.count]))).toEqual({ client: 1, item: 1, amount: 2, "due date": 1, company: 1 });
		expect(r.content[0]?.text.split("\n")[0]).toBe("/Docs/Plan.docx has 5 fields.");
		// A read-only connection may list fields.
		ok("docs_list_template_fields", await callTool("docs_list_template_fields", { path: "/Docs/Plan.docx" }, { scopes: ["workspace.read"] }));
	});
	it("refuses other formats, big templates and damaged files", async () => {
		office.addFile(QA.a, "/Docs/a.pdf", "%PDF-1.4");
		failed(await callTool("docs_list_template_fields", { path: "/Docs/a.pdf" }), "unsupported_type");
		office.addFile(QA.a, "/Docs/big.docx", new Uint8Array(11 * 1024 * 1024));
		failed(await callTool("docs_list_template_fields", { path: "/Docs/big.docx" }), "too_large");
		office.addFile(QA.a, "/Docs/broken.docx", "not a zip at all");
		failed(await callTool("docs_list_template_fields", { path: "/Docs/broken.docx" }), "unsupported_type");
	});
});

describe("docs_fill_template", () => {
	const values = { client: "Ann <&>", item: "Tea", amount: "£5", "due date": "Friday", company: "Acme" };
	it("fills a new file and leaves the template as it was", async () => {
		const before = office.file(QA.a, "/Docs/Plan.docx")?.bytes.slice();
		const r = await callTool("docs_fill_template", { template_path: "/Docs/Plan.docx", output_path: "/Docs/Filled.docx", values: { ...values, unusedKey: "x" } });
		const data = ok("docs_fill_template", r);
		expect(data).toMatchObject({ filled: ["amount", "client", "company", "due date", "item"], missing: [], unused: ["unusedKey"], file: { path: "/Docs/Filled.docx" } });
		expect(data.warnings).toEqual(["These values matched no field in the template: unusedKey."]);
		expect(office.file(QA.a, "/Docs/Plan.docx")?.bytes).toEqual(before);
		expect(calls(fake, "PUT", /Plan\.docx$/)).toHaveLength(0);
		const out = office.file(QA.a, "/Docs/Filled.docx")?.bytes as Uint8Array;
		checkPackage(out);
		const t = await extractText(out, { name: "f.docx", mime: null, offset: 0, maxChars: 50_000 });
		expect("text" in t && t.text).toContain("Dear Ann <&>, thank you");
	});
	it("missing fail writes nothing and gives a count (field names stay out of the unframed error); keep and blank write", async () => {
		const t = failed(await callTool("docs_fill_template", { template_path: "/Docs/Plan.docx", output_path: "/Docs/F.docx", values: { client: "x" } }), "invalid_input", "values");
		expect(t).toBe('The template has 4 fields with no value. docs_list_template_fields lists them. Give a value for each, or use missing "keep" or "blank".');
		expect(t).not.toContain("amount");
		expect(calls(fake, "PUT", /./)).toHaveLength(0);
		const keep = ok("docs_fill_template", await callTool("docs_fill_template", { template_path: "/Docs/Plan.docx", output_path: "/Docs/F.docx", values: { client: "x" }, missing: "keep" }));
		expect(keep).toMatchObject({ missing: ["amount", "company", "due date", "item"], missing_total: 4, truncated: false });
		expect((keep.warnings as string[])[0]).toBe("4 fields had no value and were left as they were: amount, company, due date, item.");
	});
	it("refuses bad keys, too many keys, wrong output kinds and writing over the template", async () => {
		failed(await callTool("docs_fill_template", { template_path: "/Docs/Plan.docx", output_path: "/Docs/F.docx", values: { "a/b": "x" } }), "invalid_input", "values");
		const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, "v"]));
		failed(await callTool("docs_fill_template", { template_path: "/Docs/Plan.docx", output_path: "/Docs/F.docx", values: many }), "invalid_input", "values");
		failed(await callTool("docs_fill_template", { template_path: "/Docs/Plan.docx", output_path: "/Docs/F.xlsx", values }), "invalid_input", "output_path");
		failed(await callTool("docs_fill_template", { template_path: "/Docs/Plan.docx", output_path: "/Docs/F.docm", values }), "invalid_input", "output_path");
		failed(await callTool("docs_fill_template", { template_path: "/Docs/Plan.docx", output_path: "/Docs/Plan.docx", values }), "invalid_input", "output_path");
		failed(await callTool("docs_fill_template", { template_path: "/Docs/Plan.docx", output_path: "/Docs/F.docx", values: { a: "x".repeat(10_001) } }), "invalid_input");
		expect(calls(fake, "PUT", /./)).toHaveLength(0);
	});
	it("an existing output is never replaced unless renamed", async () => {
		office.addFile(QA.a, "/Docs/F.docx", "keep me");
		failed(await callTool("docs_fill_template", { template_path: "/Docs/Plan.docx", output_path: "/Docs/F.docx", values }), "already_exists");
		expect(ok("docs_fill_template", await callTool("docs_fill_template", { template_path: "/Docs/Plan.docx", output_path: "/Docs/F.docx", values, if_exists: "rename" }))).toMatchObject({ renamed: true, file: { path: "/Docs/F (2).docx" } });
		expect(new TextDecoder().decode(office.file(QA.a, "/Docs/F.docx")?.bytes)).toBe("keep me");
	});
});
