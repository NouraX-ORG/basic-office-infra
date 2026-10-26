/**
 * Fix round 3: a NOMAIL_TOOLS_URL that can't be used hides the mail tools and nothing else. config()
 * never throws for it (the router would answer 503 for every route); it logs mail_setup_fault with
 * reason nomail_url_invalid once per isolate and per value.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, parseNomailUrl } from "../../src/env";
import { handleRequest } from "../../src/http/router";
import { env, ORIGIN } from "../helpers/index";

afterEach(() => vi.restoreAllMocks());

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const DRIVE = "https://drive.nourax.org";

describe("NOMAIL_TOOLS_URL", () => {
	it.each([
		["not a url"],
		["http://mail-tools.example.org/functions/v1/mcp-tools"],
		["https://mail-tools.example.org/functions/v1/mcp-tools?"],
		["https://mail-tools.example.org/functions/v1/mcp-tools#x"],
		["https://user:pw@mail-tools.example.org/x"],
		["https://drive.nourax.org/x"],
	])("%s is refused without a throw: mail off, everything else works", async (raw) => {
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			lines.push(a.map(String).join(" "));
		});
		const e = { ...env, NOMAIL_TOOLS_URL: raw } as typeof env;
		const cfg = config(e);
		expect(cfg.nomailToolsUrl).toBeNull();
		expect(cfg.nomailHost).toBeNull();
		expect(cfg.nomailUrlInvalid).toBe(true);
		expect(lines.some((l) => l.includes('"ev":"mail_setup_fault"') && l.includes('"reason":"nomail_url_invalid"'))).toBe(true);
		// The rest of the Worker answers as before.
		const health = await handleRequest(new Request(`${ORIGIN}/healthz`), e, ctx);
		expect(health.status).toBe(200);
		const meta = await handleRequest(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`), e, ctx);
		expect(meta.status).toBe(200);
	});
	it("a good value is kept, without the trailing slash", () => {
		expect(parseNomailUrl("https://x.supabase.co/functions/v1/mcp-tools/", false, DRIVE, ORIGIN)).toEqual({ url: "https://x.supabase.co/functions/v1/mcp-tools", host: "x.supabase.co" });
		expect(parseNomailUrl("", false, DRIVE, ORIGIN)).toBeNull();
		expect(parseNomailUrl("http://localhost:8787/dev/mock-nomail", true, DRIVE, "http://localhost:8787")).toEqual({ url: "http://localhost:8787/dev/mock-nomail", host: "localhost:8787" });
		expect(parseNomailUrl("http://localhost:8787/dev/mock-nomail", false, DRIVE, ORIGIN)).toBe("invalid");
	});
});
