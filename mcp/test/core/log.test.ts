/** The log lint (DESIGN 15): fixed keys per line type, and no content can slip through. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliOf, log, pseudonym, sanitize } from "../../src/core/log";
import { devToken, env, fakeWithQa, mcpPost, QA } from "../helpers/index";

afterEach(() => vi.restoreAllMocks());

const FORBIDDEN = ["/Projects/Secret plan.docx", "hammad@example.com", "Bearer abc.def", "FAKEAPPPASS", "qa-t1-91", "token=", "Dear Hammad"];

describe("sanitize", () => {
	it("drops unknown keys and replaces content-like strings", () => {
		const out = sanitize({ t: "tool", rid: "abc", tool: "files_read_text", path: "/Projects/Secret plan.docx", email: "a@b.c", code: "Hello there, friend", ok: true, ms: 3.4 });
		expect(out).toEqual({ t: "tool", rid: "abc", tool: "files_read_text", code: "redacted", ok: true, ms: 3 });
		expect(sanitize({ t: "unknown", rid: "x" })).toEqual({});
	});
	it("pseudonyms are short HMACs, stable and not the uid", async () => {
		const a = await pseudonym(env, "5224252b-4938-4a86-a276-54bbae5d5b49", 12);
		expect(a).toMatch(/^[0-9a-f]{12}$/);
		expect(await pseudonym(env, "5224252b-4938-4a86-a276-54bbae5d5b49", 12)).toBe(a);
	});
	it("client labels", () => {
		expect(cliOf("claude-code/2.1", undefined)).toBe("claude-code");
		expect(cliOf("node", "claude.ai")).toBe("claude");
		expect(cliOf("python-httpx", "chatgpt.com")).toBe("chatgpt");
		expect(cliOf(null, undefined)).toBe("other");
	});
});

describe("a real tool call logs metadata only", () => {
	it("no path, email, token, password or uid in any log line", async () => {
		fakeWithQa();
		const lines: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			lines.push(a.map(String).join(" "));
		});
		const t = await devToken(QA.a);
		await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspace_whoami", arguments: {} } });
		log({ t: "auth", ev: "consent_ok", reason: "/Projects/Secret plan.docx" });
		spy.mockRestore();
		const tool = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.t === "tool");
		expect(tool.length).toBeGreaterThan(0);
		expect(tool[0]).toMatchObject({ t: "tool", tool: "workspace_whoami", ok: true });
		for (const l of lines) for (const f of FORBIDDEN) expect(l, l).not.toContain(f);
	});
});
