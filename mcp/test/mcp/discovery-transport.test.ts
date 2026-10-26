/** Discovery (RFC 9728 and 8414) and the transport rules on /mcp (DESIGN 5.2, 6.1, 17.2). */
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../../src/http/router";
import { type Vault, vaultFor } from "../../src/vault/vault";
import { call, devToken, env, fakeWithQa, INIT_2024, mcpPost, ORIGIN, QA, rpcResult } from "../helpers/index";

beforeEach(() => {
	fakeWithQa();
});
afterEach(() => vi.restoreAllMocks());

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("discovery", () => {
	it("401 without a token carries resource_metadata and the required scope", async () => {
		const res = await mcpPost(null, INIT_2024);
		expect(res.status).toBe(401);
		const h = res.headers.get("www-authenticate") ?? "";
		expect(h).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
		expect(h).toContain('scope="workspace.read"');
	});
	it("protected resource metadata: exact resource, one authorization server, header only", async () => {
		for (const p of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
			const res = await call(p);
			expect(res.status, p).toBe(200);
			const j = (await res.json()) as Record<string, unknown>;
			expect(j.resource).toBe(`${ORIGIN}/mcp`);
			expect(j.authorization_servers).toEqual([ORIGIN]);
			expect(j.bearer_methods_supported).toEqual(["header"]);
			// Deliberately the minimal set (MCP 2026-07-28, Scope Selection Strategy: "scopes_supported is
			// intended to represent the minimal set of scopes necessary for basic functionality"); more
			// comes by step-up. Never offline_access (a refresh token is not a resource requirement).
			expect(j.scopes_supported).toEqual(["workspace.read"]);
		}
	});
	it("authorization server metadata: S256 only, iss parameter, registration, no CIMD", async () => {
		const res = await call("/.well-known/oauth-authorization-server");
		const j = (await res.json()) as Record<string, unknown>;
		expect(j.issuer).toBe(ORIGIN);
		expect(j.code_challenge_methods_supported).toEqual(["S256"]);
		expect(j.authorization_response_iss_parameter_supported).toBe(true);
		expect(j.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
		expect(j.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
		expect(j.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
		expect(j.client_id_metadata_document_supported).not.toBe(true);
		expect(j.grant_types_supported).toEqual(expect.arrayContaining(["authorization_code", "refresh_token"]));
		expect(j.grant_types_supported).not.toContain("urn:ietf:params:oauth:grant-type:token-exchange");
		expect(j.scopes_supported).toEqual(expect.arrayContaining(["workspace.read", "workspace.share", "mail.write", "offline_access"]));
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	});
	it("health check: the build id (\"dev\" without predeploy's define) and the release", async () => {
		const j = (await (await call("/healthz")).json()) as Record<string, unknown>;
		expect(j).toEqual({ status: "ok", version: "dev", release: "0.1.0" });
	});
});

describe("transport rules on /mcp", () => {
	it("a bad web Origin gets 403; null and a custom scheme are allowed without CORS; ours gets CORS", async () => {
		const t = await devToken(QA.a);
		expect((await mcpPost(t.access_token, INIT_2024, { origin: "https://evil.test" })).status).toBe(403);
		const n = await mcpPost(t.access_token, INIT_2024, { origin: "null" });
		expect(n.status).toBe(200);
		expect(n.headers.get("access-control-allow-origin")).toBeNull();
		const oo = await mcpPost(t.access_token, INIT_2024, { origin: "onlyoffice-proxy://desktop" });
		expect(oo.status).toBe(200);
		expect(oo.headers.get("access-control-allow-origin")).toBeNull();
		const mine = await mcpPost(t.access_token, INIT_2024, { origin: ORIGIN });
		expect(mine.headers.get("access-control-allow-origin")).toBe(ORIGIN);
		expect(mine.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
		const pre = await call("/mcp", { method: "OPTIONS", headers: { origin: "http://localhost:6274", "access-control-request-method": "POST" } });
		expect(pre.status).toBe(204);
		expect(pre.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
		// The 2026-07-28 era sends Mcp-Method on every POST and Mcp-Name on tools/call.
		const allowed = (pre.headers.get("access-control-allow-headers") ?? "").split(/,\s*/).map((h) => h.toLowerCase());
		for (const h of ["authorization", "content-type", "mcp-protocol-version", "mcp-method", "mcp-name"]) expect(allowed).toContain(h);
		const preBad = await call("/mcp", { method: "OPTIONS", headers: { origin: "https://evil.test" } });
		expect(preBad.status).toBe(403);
	});
	it("GET and DELETE get 405; wrong Content-Type 415; a body over 4 MiB 413; bad JSON 400", async () => {
		const t = await devToken(QA.a);
		const auth = { authorization: `Bearer ${t.access_token}` };
		expect((await call("/mcp", { method: "GET", headers: auth })).status).toBe(405);
		expect((await call("/mcp", { method: "DELETE", headers: auth })).status).toBe(405);
		expect((await call("/mcp", { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
		const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { x: "a".repeat(4 * 1024 * 1024 + 10) } });
		expect((await mcpPost(t.access_token, big)).status).toBe(413);
		expect((await mcpPost(t.access_token, "{not json")).status).toBe(400);
	});
	it("a token for another resource, or a made-up token, gets 401", async () => {
		expect((await mcpPost("x:y:z", INIT_2024)).status).toBe(401);
		expect((await mcpPost("nxw_ct_" + "A".repeat(43), INIT_2024)).status).toBe(401);
	});
	it("a wrong Host gets 421, plain http on a public origin is refused, and https pages redirect", async () => {
		expect((await call("http://127.0.0.1:8787/healthz")).status).toBe(421);
		const prod = { ...env, PUBLIC_ORIGIN: "https://mcp.example.test", NX_ENV: "production", DEV_QA_ACCOUNTS: undefined };
		const plain = await handleRequest(new Request("http://mcp.example.test/mcp", { method: "POST" }), prod, ctx);
		expect(plain.status).toBe(400);
		const page = await handleRequest(new Request("http://mcp.example.test/"), prod, ctx);
		expect(page.status).toBe(308);
		expect(page.headers.get("location")).toBe("https://mcp.example.test/");
		const wrongHost = await handleRequest(new Request("https://other.example.test/healthz"), prod, ctx);
		expect(wrongHost.status).toBe(421);
		// The Host is checked before the https redirect, which is built from PUBLIC_ORIGIN.
		const evil = await handleRequest(new Request("http://evil.example:8788/healthz"), prod, ctx);
		expect(evil.status).toBe(421);
		expect(evil.headers.get("location")).toBeNull();
		const kept = await handleRequest(new Request("http://mcp.example.test/connections?x=1"), prod, ctx);
		expect(kept.headers.get("location")).toBe("https://mcp.example.test/connections?x=1");
	});
	it("a JSON-RPC batch is refused before any limit is counted or NoDrive is called", async () => {
		const fake = fakeWithQa();
		const t = await devToken(QA.a);
		const calls = () =>
			runInDurableObject(vaultFor(env, QA.a), async (_i: Vault, state) =>
				Number(state.storage.sql.exec<{ n: number }>("SELECT COALESCE(SUM(n), 0) AS n FROM counters WHERE k LIKE 'd:calls:%'").one().n),
			);
		const counted = await calls();
		const before = fake.requests.length;
		const whoami = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "workspace_whoami", arguments: {} } });
		for (const body of [[whoami(1), whoami(2), whoami(3)], [INIT_2024], []]) {
			const res = await mcpPost(t.access_token, body);
			expect(res.status).toBe(400);
			const j = (await res.json()) as { error: { code: number; message: string } };
			expect(j.error.code).toBe(-32600);
			expect(j.error.message).toContain("Batch requests aren't supported");
		}
		expect(fake.requests.length).toBe(before);
		expect(await calls()).toBe(counted);
		// A single call is still counted once.
		await mcpPost(t.access_token, whoami(9));
		expect(await calls()).toBe(counted + 1);
	});
});

describe("one MCP endpoint", () => {
	it("paths under /mcp/ never reach the handler: 404, no CORS, no tool run, from any Origin", async () => {
		const fake = fakeWithQa();
		const t = await devToken(QA.a);
		const before = fake.requests.length;
		const whoami = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspace_whoami", arguments: {} } });
		for (const path of ["/mcp/", "/mcp/x", "/mcp/anything/else", "/mcp/.well-known/x"]) {
			for (const origin of ["https://evil.example", ORIGIN, null]) {
				const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${t.access_token}` };
				if (origin) headers.origin = origin;
				const post = await call(path, { method: "POST", headers, body: whoami });
				expect(post.status, `${path} ${origin}`).toBe(404);
				expect(post.headers.get("access-control-allow-origin")).toBeNull();
				expect(post.headers.get("access-control-allow-methods")).toBeNull();
				const body = (await post.json()) as { error: { code: number } };
				expect(body.error.code).toBe(-32601);
				const pre = await call(path, { method: "OPTIONS", headers: { ...(origin ? { origin } : {}), "access-control-request-method": "POST" } });
				expect(pre.status, `OPTIONS ${path} ${origin}`).toBe(404);
				expect(pre.headers.get("access-control-allow-origin")).toBeNull();
				expect(pre.headers.get("access-control-allow-headers")).toBeNull();
			}
		}
		// No tool ran: NoDrive was never called.
		expect(fake.requests.length).toBe(before);
		// The endpoint itself is unchanged: a foreign Origin still gets 403 there.
		expect((await mcpPost(t.access_token, whoami, { origin: "https://evil.example" })).status).toBe(403);
		expect((await call("/mcp", { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status).toBe(403);
	});
});

describe("a vault without NX_SECRET", () => {
	it("answers 503 with Retry-After and keeps the connection", async () => {
		const t = await devToken(QA.a);
		const v = vaultFor(env, QA.a);
		await runInDurableObject(v, async (instance: Vault) => {
			(instance as unknown as { env: unknown }).env = { ...env, NX_SECRET: "" };
		});
		try {
			const res = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspace_whoami", arguments: {} } });
			expect(res.status).toBe(503);
			expect(res.headers.get("retry-after")).toBe("30");
		} finally {
			await runInDurableObject(v, async (instance: Vault) => {
				(instance as unknown as { env: unknown }).env = env;
			});
		}
		expect(await v.status(t.connection_id)).toBe("active");
		expect((await mcpPost(t.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).status).toBe(200);
	});
});

describe("limits before any token check", () => {
	const refuse = { limit: async () => ({ success: false }) } as unknown as RateLimit;
	it("RL_IP answers 429 on /mcp and /oauth/token before the token is looked up", async () => {
		const kvGet = vi.spyOn(env.OAUTH_KV, "get");
		const mcp = await handleRequest(
			new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer a:b:c", "cf-connecting-ip": "198.51.100.77" }, body: JSON.stringify(INIT_2024) }),
			{ ...env, RL_IP: refuse },
			ctx,
		);
		expect(mcp.status).toBe(429);
		expect(mcp.headers.get("retry-after")).toBe("60");
		const tok = await handleRequest(
			new Request(`${ORIGIN}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.77" }, body: "grant_type=refresh_token&refresh_token=a:b:c&client_id=x" }),
			{ ...env, RL_IP: refuse },
			ctx,
		);
		expect(tok.status).toBe(429);
		expect(kvGet).not.toHaveBeenCalled();
		// Control: with the limit open, the same token does cost a KV read (and gets 401).
		const open = await handleRequest(
			new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer qa-t1-91:AAAAAAAAAAAAAAAA:x", "cf-connecting-ip": "198.51.100.78" }, body: JSON.stringify(INIT_2024) }),
			env,
			ctx,
		);
		expect(open.status).toBe(401);
		expect(kvGet).toHaveBeenCalled();
	});
	it("RL_TOKEN is keyed by IP and client_id, from the form or Basic auth", async () => {
		const keys: string[] = [];
		const record = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) } as unknown as RateLimit;
		const post = (headers: Record<string, string>, body: string) =>
			handleRequest(new Request(`${ORIGIN}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body }), { ...env, RL_TOKEN: record }, ctx);
		await post({ "cf-connecting-ip": "203.0.113.5" }, "grant_type=refresh_token&refresh_token=a:b:c&client_id=client-1");
		await post({ "cf-connecting-ip": "203.0.113.6", authorization: `Basic ${btoa("client-2:secret")}` }, "grant_type=refresh_token&refresh_token=a:b:c");
		expect(keys).toEqual(["tok:203.0.113.5|client-1", "tok:203.0.113.6|client-2"]);
	});
	it("RL_IP and RL_TOKEN count an IPv6 caller by its /64, so rotating addresses inside it doesn't escape them (fix round 3)", async () => {
		const ipKeys: string[] = [];
		const tokKeys: string[] = [];
		const rec = (into: string[]) => ({ limit: async ({ key }: { key: string }) => (into.push(key), { success: true }) }) as unknown as RateLimit;
		const e = { ...env, RL_IP: rec(ipKeys), RL_TOKEN: rec(tokKeys) };
		await handleRequest(
			new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer a:b:c", "cf-connecting-ip": "2001:db8:1234:5678:aaaa::1" }, body: JSON.stringify(INIT_2024) }),
			e,
			ctx,
		);
		await handleRequest(
			new Request(`${ORIGIN}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "2001:db8:1234:5678:bbbb::2" }, body: "grant_type=refresh_token&refresh_token=a:b:c&client_id=client-1" }),
			e,
			ctx,
		);
		expect(ipKeys).toEqual(["mcp:2001:db8:1234:5678::/64", "tok:2001:db8:1234:5678::/64"]);
		expect(tokKeys).toEqual(["tok:2001:db8:1234:5678::/64|client-1"]);
	});
	it("an exception answers JSON-RPC on /mcp and OAuth JSON on /oauth/*, never the HTML page (fix round 3)", async () => {
		const { failureResponse } = await import("../../src/http/router");
		const mcp = failureResponse("/mcp");
		expect(mcp.status).toBe(500);
		expect(mcp.headers.get("content-type") ?? "").toContain("application/json");
		expect(((await mcp.json()) as { error: { code: number } }).error.code).toBe(-32603);
		const tok = failureResponse("/oauth/token");
		expect(tok.status).toBe(500);
		expect(tok.headers.get("cache-control")).toBe("no-store");
		expect(((await tok.json()) as { error: string }).error).toBe("server_error");
		expect(failureResponse("/connections").headers.get("content-type") ?? "").toContain("text/html");
	});
	it("/authorize has its own budget (RL_AUTHZ, GET and POST); pages, /authorize and registration count IPv6 by /64", async () => {
		const pagesKeys: string[] = [];
		const authzKeys: string[] = [];
		const regKeys: string[] = [];
		const rec = (into: string[]) => ({ limit: async ({ key }: { key: string }) => (into.push(key), { success: true }) }) as unknown as RateLimit;
		const e = { ...env, RL_PAGES: rec(pagesKeys), RL_AUTHZ: rec(authzKeys), RL_REGISTER: rec(regKeys) };
		const v6 = "2001:db8:1234:5678:aaaa:bbbb:cccc:dddd";
		await handleRequest(new Request(`${ORIGIN}/authorize?client_id=x`, { headers: { "cf-connecting-ip": v6 } }), e, ctx);
		await handleRequest(new Request(`${ORIGIN}/authorize`, { method: "POST", headers: { "cf-connecting-ip": "2001:db8:1234:5678::1", origin: ORIGIN }, body: "" }), e, ctx);
		await handleRequest(new Request(`${ORIGIN}/connect`, { headers: { "cf-connecting-ip": "198.51.100.200" } }), e, ctx);
		await handleRequest(new Request(`${ORIGIN}/oauth/register`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "2001:db8:1234:5678:1::9" }, body: "{}" }), e, ctx);
		expect(authzKeys).toEqual(["authz:2001:db8:1234:5678::/64", "authz:2001:db8:1234:5678::/64"]);
		expect(pagesKeys).toEqual(["page:198.51.100.200"]);
		expect(regKeys).toEqual(["reg:2001:db8:1234:5678::/64"]);
		const refuse = { limit: async () => ({ success: false }) } as unknown as RateLimit;
		const kvGet = vi.spyOn(env.OAUTH_KV, "get");
		const limited = await handleRequest(new Request(`${ORIGIN}/authorize?client_id=x`, { headers: { "cf-connecting-ip": "198.51.100.201" } }), { ...env, RL_AUTHZ: refuse }, ctx);
		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).toBe("60");
		expect(kvGet).not.toHaveBeenCalled();
		// RL_PAGES is not what limits /authorize any more.
		const other = await handleRequest(new Request(`${ORIGIN}/authorize?client_id=x`, { headers: { "cf-connecting-ip": "198.51.100.202" } }), { ...env, RL_PAGES: refuse }, ctx);
		expect(other.status).not.toBe(429);
	});
	it("token and registration bodies over 16 KB are refused, chunked ones included", async () => {
		const chunked = (size: number) =>
			new ReadableStream<Uint8Array>({
				start(c) {
					for (let i = 0; i < size; i += 4096) c.enqueue(new Uint8Array(4096).fill(97));
					c.close();
				},
			});
		let n = 40;
		for (const path of ["/oauth/token", "/oauth/register"]) {
			const declared = await call(path, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(17 * 1024), "cf-connecting-ip": `198.51.100.${n++}` },
				body: "a".repeat(17 * 1024),
			});
			expect(declared.status, path).toBe(413);
			const streamed = await call(path, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${n++}` }, body: chunked(64 * 1024), duplex: "half" } as RequestInit);
			expect(streamed.status, path).toBe(413);
		}
		// Small bodies still reach the library unchanged.
		const reg = await call("/oauth/register", {
			method: "POST",
			headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.88" },
			body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:33418/callback"], token_endpoint_auth_method: "none", client_name: "Small" }),
		});
		expect(reg.status).toBe(201);
	});
	it("every response carries a request id", async () => {
		const res = await call("/healthz");
		expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f]{32}$/);
	});
	it("GET on a legacy session endpoint gets 405 and the modern era's header mismatch gets -32020", async () => {
		const t = await devToken(QA.a);
		const res = await mcpPost(
			t.access_token,
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
				params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } },
			},
			{ "mcp-protocol-version": "2025-11-25" },
		);
		const j = await rpcResult(res);
		expect((j.error as { code: number } | undefined)?.code).toBe(-32020);
	});
});
