/**
 * Fix round 4: a document tool saving under "rename" looks at each name before it sends the file,
 * so the whole file goes up once (not once per taken name), and every PUT it does send counts
 * toward the person's daily upload cap.
 */
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Vault, vaultFor } from "../../../src/vault/vault";
import { type FakeNc } from "../../fake-nc/index";
import { installOffice, type OfficeFake } from "../../fake-nc/office";
import { env as nxEnv, fakeWithQa, QA } from "../../helpers/index";
import { fixture } from "../../docs/helpers";
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

/** Today's upload bytes in the person's vault. */
async function uploadedToday(): Promise<number> {
	const day = Math.floor(Date.now() / 1000 / 86400);
	return runInDurableObject(vaultFor(nxEnv, QA.a), async (_v: Vault, state) => {
		const rows = state.storage.sql.exec<{ n: number }>("SELECT n FROM counters WHERE k = ?", `d:bytes:${day}`).toArray();
		return rows[0] ? Number(rows[0].n) : 0;
	});
}

describe("docs writers and taken names", () => {
	it("docs_convert with three taken names sends the PDF once, to the first free name, and counts it once", async () => {
		const pdf = new TextEncoder().encode("%PDF-1.7 already here");
		for (const name of ["Plan.pdf", "Plan (2).pdf", "Plan (3).pdf"]) office.addFile(QA.a, `/Docs/${name}`, pdf);
		const before = await uploadedToday();
		const r = await callTool("docs_convert", { path: "/Docs/Plan.docx" });
		expect(ok("docs_convert", r)).toMatchObject({ renamed: true, file: { path: "/Docs/Plan (4).pdf" } });
		const puts = calls(fake, "PUT", /\/Docs\//);
		expect(puts.map((p) => decodeURIComponent(p.url.pathname).replace(/^.*\/Docs\//, ""))).toEqual(["Plan (4).pdf"]);
		const size = office.file(QA.a, "/Docs/Plan (4).pdf")?.bytes.byteLength ?? 0;
		expect(size).toBeGreaterThan(0);
		expect((await uploadedToday()) - before).toBe(size);
	});

	it('if_exists "fail" refuses a taken name without sending the file at all', async () => {
		office.addFile(QA.a, "/Docs/Plan.pdf", new TextEncoder().encode("%PDF-1.7"));
		const t = failed(await callTool("docs_convert", { path: "/Docs/Plan.docx", if_exists: "fail" }), "already_exists");
		expect(t).toBe('/Docs/Plan.pdf already exists. Use if_exists "rename", or another output_path.');
		expect(calls(fake, "PUT", /\/Docs\//)).toHaveLength(0);
	});

	it("a name taken between the look and the PUT: the next name is tried, and both PUTs count", async () => {
		const before = await uploadedToday();
		// Someone saves Plan.pdf just before the PUT arrives: NoDrive answers 412.
		fake.on("PUT", /\/Docs\/Plan\.pdf$/, () => {
			office.addFile(QA.a, "/Docs/Plan.pdf", "%PDF-1.7 theirs");
			return new Response("", { status: 412 });
		});
		const r = await callTool("docs_convert", { path: "/Docs/Plan.docx" });
		expect(ok("docs_convert", r)).toMatchObject({ renamed: true, file: { path: "/Docs/Plan (2).pdf" } });
		const size = office.file(QA.a, "/Docs/Plan (2).pdf")?.bytes.byteLength ?? 0;
		expect(calls(fake, "PUT", /\/Docs\//)).toHaveLength(2);
		expect((await uploadedToday()) - before).toBe(2 * size);
	});
});
