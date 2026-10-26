/**
 * Brand rule 6 (DESIGN 10.8). Loads Task 3's sweep rules when the file is in the repo, otherwise the
 * built-in minimal set, and scans every text a person can see that this Worker produces.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { sha256Hex } from "../../src/core/bytes";
import { BUILTIN_BRAND_RULES } from "../../src/core/brand";
import { DEFAULT_MESSAGE } from "../../src/core/errors";
import { CSS } from "../../src/http/html";
import { LOGO_PNG_BASE64, LOGO_SHA256 } from "../../src/http/logo";
import { APP_WORDS, SCOPE_WORDS } from "../../src/mcp/catalog";
import { BASE_INSTRUCTIONS, buildInstructions } from "../../src/mcp/instructions";
import { TOOLS } from "../../src/tools/registry";
import { fromB64 } from "../../src/core/bytes";
import { call, fakeWithQa } from "../helpers/index";

afterEach(() => vi.restoreAllMocks());

type Rule = { id: string; pattern: RegExp };

const sweep = import.meta.glob("../../../nextcloud-apps/nourax_branding/sweep/rules.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function compile(re: string): RegExp {
	const ci = re.startsWith("(?i)");
	return new RegExp(ci ? re.slice(4) : re, ci ? "iu" : "u");
}

function loadRules(): { text: Rule[]; links: Rule[]; source: string } {
	const raw = Object.values(sweep)[0];
	if (!raw) return { text: [...BUILTIN_BRAND_RULES], links: [], source: "builtin" };
	const j = JSON.parse(raw) as { name_patterns?: { id: string; re: string }[]; blue_patterns?: { id: string; re: string }[]; link_patterns?: { id: string; re: string }[] };
	const text = [...(j.name_patterns ?? []), ...(j.blue_patterns ?? [])].map((r) => ({ id: r.id, pattern: compile(r.re) }));
	const links = (j.link_patterns ?? []).map((r) => ({ id: r.id, pattern: compile(r.re) }));
	return { text, links, source: "rules.json" };
}

const rules = loadRules();

function violations(where: string, s: string): string[] {
	const out: string[] = [];
	for (const r of rules.text) if (r.pattern.test(s)) out.push(`${where}: ${r.id}`);
	for (const url of s.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi) ?? []) for (const r of rules.links) if (r.pattern.test(url)) out.push(`${where}: link ${r.id}`);
	return out;
}

describe(`brand rule 6 (${rules.source})`, () => {
	it("the built-in rules catch the upstream name, blue and links", () => {
		const N = ["Next", "cloud"].join("");
		for (const s of [N, `next ${"cloud"}`, "#0082c9", "#00679E", `https://apps.${N.toLowerCase()}.com/x`, `github.com/${N.toLowerCase()}/server`]) {
			expect(BUILTIN_BRAND_RULES.some((r) => r.pattern.test(s)), s).toBe(true);
		}
		expect(BUILTIN_BRAND_RULES.some((r) => r.pattern.test("Nourax Workspace NoDrive"))).toBe(false);
	});
	it("tool titles, descriptions and schemas are clean", () => {
		const v = TOOLS.flatMap((t) => violations(t.name, `${t.title}\n${t.description}\n${JSON.stringify(z.toJSONSchema(t.input))}\n${t.output ? JSON.stringify(z.toJSONSchema(t.output)) : ""}`));
		expect(v).toEqual([]);
	});
	it("error messages, scope and app words, instructions and the stylesheet are clean", () => {
		const texts: [string, string][] = [
			...Object.entries(DEFAULT_MESSAGE),
			...Object.entries(SCOPE_WORDS),
			...Object.entries(APP_WORDS),
			["instructions", BASE_INSTRUCTIONS + buildInstructions(["workspace.read"], true)],
			["css", CSS],
		];
		expect(texts.flatMap(([k, s]) => violations(k, s))).toEqual([]);
	});
	it("our pages are clean", async () => {
		fakeWithQa();
		const pages: string[] = [];
		for (const p of ["/", "/connections", "/connect", "/nope", "/authorize?client_id=x"]) {
			const res = await call(p, { headers: { "cf-connecting-ip": "203.0.113.9" } });
			pages.push(`${p}\n${await res.text()}`);
		}
		expect(pages.flatMap((t, i) => violations(`page${i}`, t))).toEqual([]);
	});
	it("the bundled logo is the official file, byte for byte", async () => {
		const official = import.meta.glob("../../../branding/nourax-logo.png", { query: "?inline", import: "default", eager: true }) as Record<string, string>;
		const dataUrl = Object.values(official)[0] as string;
		expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
		const officialBytes = fromB64(dataUrl.slice("data:image/png;base64,".length));
		expect(await sha256Hex(officialBytes)).toBe(LOGO_SHA256);
		expect(await sha256Hex(fromB64(LOGO_PNG_BASE64))).toBe(LOGO_SHA256);
		const res = await call("/assets/nourax-logo.png");
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(await sha256Hex(new Uint8Array(await res.arrayBuffer()))).toBe(LOGO_SHA256);
	});
});
