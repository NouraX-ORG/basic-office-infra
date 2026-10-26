/**
 * The runtime insufficient-scope challenge, end to end through the whole Worker (router, CORS,
 * provider, handler, gate): a built tool that needs a scope the token lacks gets HTTP 403 with
 * error="insufficient_scope", the scopes to ask for and resource_metadata (DESIGN 6.2).
 *
 * Lane B hasn't built sharing_create_link yet, so this file replaces lane B's module with one
 * stand-in tool. Nothing else changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devToken, fakeWithQa, mcpPost, ORIGIN, QA, rpcResult } from "../helpers/index";

vi.mock("../../src/tools/sharing/index", async () => {
	const { z } = await import("zod");
	const { defineTool } = await import("../../src/core/tool");
	return {
		tools: [
			defineTool({
				name: "sharing_create_link",
				title: "Create a public link (test stand-in)",
				description: "Test stand-in for lane B's tool. It only answers with a fixed text.",
				input: z.object({ path: z.string().max(100) }).strict(),
				async run() {
					return { data: { ok: true }, summary: "Stand-in ran." };
				},
			}),
		],
	};
});

beforeEach(() => {
	fakeWithQa();
});
afterEach(() => vi.restoreAllMocks());

const call = (name: string) => ({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: { path: "/a.txt" } } });

describe("step-up (403 insufficient_scope) through the whole Worker", () => {
	it("a read and write token calling a sharing tool gets 403 naming the scopes, in the 2025 era", async () => {
		const t = await devToken(QA.a, { scopes: ["workspace.read", "workspace.write"] });
		const list = (await rpcResult(await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" }))).result as { tools: { name: string }[] };
		expect(list.tools.map((x) => x.name)).not.toContain("sharing_create_link");
		const res = await mcpPost(t.access_token, call("sharing_create_link"), { origin: ORIGIN });
		expect(res.status).toBe(403);
		const h = res.headers.get("www-authenticate") ?? "";
		expect(h).toContain('error="insufficient_scope"');
		expect(h).toContain('scope="workspace.read workspace.write workspace.share"');
		expect(h).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
		// Our CORS policy still applies to the 403, so a browser client on our origin can read it.
		expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
		expect(res.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
	});

	it("the same in the 2026-07-28 era", async () => {
		const t = await devToken(QA.a, { scopes: ["workspace.read"] });
		const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
		const body = { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "sharing_create_link", arguments: { path: "/a.txt" }, _meta: meta } };
		const res = await mcpPost(t.access_token, body, { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "sharing_create_link" });
		expect(res.status).toBe(403);
		expect(res.headers.get("www-authenticate")).toContain('scope="workspace.read workspace.share"');
	});

	it("with the scope, the tool is listed and runs", async () => {
		const t = await devToken(QA.a, { scopes: ["workspace.read", "workspace.share"] });
		const list = (await rpcResult(await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" }))).result as { tools: { name: string }[] };
		expect(list.tools.map((x) => x.name)).toContain("sharing_create_link");
		const r = (await rpcResult(await mcpPost(t.access_token, call("sharing_create_link")))).result as { isError?: boolean };
		expect(r.isError).not.toBe(true);
	});
});
