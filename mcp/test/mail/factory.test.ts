/**
 * Mail tools through core's per-request server factory (DESIGN 2.2 step 4, 13.4, 14, 15): listed
 * after our own tools, filtered by mail.read and mail.write, at most 100 tools in all, registered
 * with the provider's JSON Schema, and called through runMailCall: a per-person limit answers first
 * without asking NoMail anything, our own input check, then the aggregator, then one tool log line.
 */
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "../../src/core/errors";
import { ALL_APPS, ALL_SCOPES } from "../../src/mcp/catalog";
import type { RequestCtx } from "../../src/mcp/context";
import { buildServer } from "../../src/mcp/factory";
import { visibleTools } from "../../src/mcp/gate";
import { blockMessage, MAIL_MESSAGES } from "../../src/mail/index";
import { CLIENT_TOOL_CAP, mailRoom, registerMailTools } from "../../src/mail/register";
import { installMock, logLines, makeCtx, MemCache, type CtxOptions } from "./helpers";

let mock: ReturnType<typeof installMock>["mock"];
let logs: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	({ mock } = installMock());
	logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

type Tools = Awaited<ReturnType<Client["listTools"]>>["tools"];
type Called = { content: { text: string }[]; isError?: boolean; _meta?: Record<string, { code?: string; retryable?: boolean; field?: string; retry_after_seconds?: number }> };

/**
 * A client on the per-request server. `direct` builds a bare server with only registerMailTools (for
 * a given number of own tools), for the 100-tool room. Since fix round 3 core's factory passes every
 * tools/call of a mail_ name through, also while mail is off, so the mail-off stand-ins are tested
 * through buildServer like the rest.
 */
async function connect(o: { scopes: string[]; method: string; toolName?: string; mail?: CtxOptions; apps?: string[]; blocked?: ToolError; direct?: { ownCount: number } }) {
	const { ctx } = makeCtx({ read: o.scopes.includes("mail.read"), write: o.scopes.includes("mail.write"), ...(o.mail ?? {}) });
	const rc = {
		rid: "0123456789abcdef0123456789abcdef",
		env: ctx.env,
		uid: "11111111-2222-4333-8444-555555555555",
		connectionId: "c0ffee00c0ffee00c0ffee00c0ffee00",
		cli: "claude",
		stats: { calls: 0 },
		inBytes: 120,
		scopes: o.scopes,
		apps: o.apps ?? ["files", "docs", "calendar", "contacts", "boards", "mail"],
		cfg: ctx.cfg,
		mail: ctx,
		method: o.method,
		toolName: o.toolName,
		blocked: o.blocked,
	} as unknown as RequestCtx;
	let server: McpServer;
	if (o.direct) {
		server = new McpServer({ name: "direct", version: "1" }, { capabilities: { tools: { listChanged: false } } });
		await registerMailTools(server, rc, o.direct.ownCount);
	} else server = await buildServer(rc);
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: "factory-test", version: "1" });
	await client.connect(clientSide);
	return { client, rc };
}

const toolLines = () => logLines(logs).filter((l) => l.t === "tool");

describe("mail tools in the server factory", () => {
	it("are listed after our own tools, sorted, with the provider's hints, and only within the granted scopes", async () => {
		let { client } = await connect({ scopes: ["workspace.read", "mail.read"], method: "tools/list" });
		let tools: Tools = (await client.listTools()).tools;
		const mail = tools.filter((t) => t.name.startsWith("mail_"));
		expect(mail.map((t) => t.name)).toEqual(["mail_get_message", "mail_list_messages", "mail_search"]);
		expect(tools.findIndex((t) => t.name.startsWith("mail_"))).toBeGreaterThan(tools.findIndex((t) => t.name === "workspace_whoami"));
		expect(mail[0]?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: "Read a message" });
		// The provider's own JSON Schema is what clients see; no output schema is published for mail.
		expect(mail[0]?.inputSchema).toMatchObject({ type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 100 } } });
		expect(mail.find((t) => t.name === "mail_list_messages")?.outputSchema).toBeUndefined();
		await client.close();
		({ client } = await connect({ scopes: ["workspace.read", "mail.read", "mail.write"], method: "tools/list" }));
		tools = (await client.listTools()).tools;
		const send = tools.find((t) => t.name === "mail_send_draft");
		expect(send?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
		expect(send?._meta).toMatchObject({ securitySchemes: [{ type: "oauth2", scopes: ["mail.write"] }] });
		expect(tools.filter((t) => t.name.startsWith("mail_"))).toHaveLength(6);
		await client.close();
	});
	it("are not loaded for other methods, and hidden when mail isn't active", async () => {
		let { client } = await connect({ scopes: ["workspace.read", "mail.read"], method: "tools/call", toolName: "workspace_whoami" });
		await client.close();
		expect(mock.requests).toHaveLength(0);
		({ client } = await connect({ scopes: ["workspace.read", "mail.read"], method: "tools/list", mail: { active: false, state: "not_set_up" } }));
		expect((await client.listTools()).tools.some((t) => t.name.startsWith("mail_"))).toBe(false);
		expect(mock.requests).toHaveLength(0);
		await client.close();
	});
	it("a call goes through the aggregator, comes back framed, and writes one tool log line without mail text", async () => {
		const { client } = await connect({ scopes: ["workspace.read", "mail.read", "mail.write"], method: "tools/call", toolName: "mail_send_draft" });
		const r = (await client.callTool({ name: "mail_send_draft", arguments: { draft_id: "d1" } })) as Called;
		expect(r.isError).toBeFalsy();
		expect(r.content[0]?.text).toContain("Mail content from NoMail.");
		expect(r.content[0]?.text).toContain("Draft d1 was sent.");
		expect(mock.requests.map((x) => x.path.split("/").pop())).toEqual(["tools", "call"]);
		const lines = toolLines();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ t: "tool", tool: "mail_send_draft", ok: true, cli: "claude", in_bytes: 120, nc_calls: 0 });
		expect(String(lines[0]?.who)).toMatch(/^[0-9a-f]{12}$/);
		expect(String(lines[0]?.conn)).toMatch(/^[0-9a-f]{8}$/);
		expect(lines[0]?.code).toBeUndefined();
		const all = JSON.stringify(logLines(logs));
		for (const s of ["d1", "Draft", "11111111-2222", "c0ffee00"]) expect(all).not.toContain(s);
		await client.close();
	});
	it.each([
		["rate_limited", new ToolError("rate_limited", "Too many requests in a short time (mail). Try again shortly.", { retryAfterSec: 12 })],
		["daily_limit", new ToolError("daily_limit", "This connection reached today's limit for mail actions. It resets at midnight UTC.", { retryAfterSec: 3600 })],
	])("a per-person %s answers the call; NoMail is never asked anything, and the call is logged", async (code, blocked) => {
		const { client } = await connect({ scopes: ["workspace.read", "mail.read", "mail.write"], method: "tools/call", toolName: "mail_send_draft", blocked });
		const r = (await client.callTool({ name: "mail_send_draft", arguments: { draft_id: "d1" } })) as Called;
		expect(r.isError).toBe(true);
		expect(r._meta?.["nourax/error"]).toMatchObject({ code, retryable: true, retry_after_seconds: blocked.retryAfterSec });
		expect(r.content[0]?.text).toBe(blocked.message);
		expect(mock.requests).toHaveLength(0);
		expect(toolLines()).toEqual([expect.objectContaining({ t: "tool", tool: "mail_send_draft", ok: false, code })]);
		await client.close();
	});
	it("a blocked call to a name that isn't a mail tool name gets no stand-in", async () => {
		const blocked = new ToolError("rate_limited", "Too many requests in a short time. Try again shortly.");
		const { client } = await connect({ scopes: ["workspace.read", "mail.read", "mail.write"], method: "tools/call", toolName: "mail_Send Draft", blocked });
		// The SDK knows no such tool and answers with its own JSON-RPC error.
		await expect(client.callTool({ name: "mail_Send Draft", arguments: {} })).rejects.toThrow(/not found/);
		expect(mock.requests).toHaveLength(0);
		expect(toolLines()).toHaveLength(0);
		await client.close();
	});
	it("arguments that break the provider's schema never reach NoMail and get a plain invalid_input", async () => {
		const { client } = await connect({ scopes: ["workspace.read", "mail.read", "mail.write"], method: "tools/call", toolName: "mail_send_draft" });
		const r = (await client.callTool({ name: "mail_send_draft", arguments: { draft_id: 42 } })) as Called;
		expect(r.isError).toBe(true);
		expect(r._meta?.["nourax/error"]).toMatchObject({ code: "invalid_input", retryable: false, field: "draft_id" });
		expect(r.content[0]?.text).toBe("The input doesn't match what mail_send_draft takes: draft_id must be string, not number.");
		const extra = (await client.callTool({ name: "mail_send_draft", arguments: { draft_id: "d1", extra: true } })) as Called;
		expect(extra._meta?.["nourax/error"]).toMatchObject({ code: "invalid_input", field: "extra" });
		expect(extra.content[0]?.text).toBe("The input doesn't match what mail_send_draft takes: extra isn't one of its inputs.");
		const none = (await client.callTool({ name: "mail_send_draft", arguments: {} })) as Called;
		expect(none.content[0]?.text).toBe("The input doesn't match what mail_send_draft takes: draft_id is required.");
		expect(mock.requests.map((x) => x.path.split("/").pop())).toEqual(["tools"]);
		expect(toolLines().map((l) => l.code)).toEqual(["invalid_input", "invalid_input", "invalid_input"]);
		await client.close();
	});
	it("only the called mail tool is registered for tools/call; a write tool on a mail.read connection answers in plain words", async () => {
		const { client } = await connect({ scopes: ["workspace.read", "mail.read"], method: "tools/call", toolName: "mail_send_draft" });
		// mail.write isn't granted: a stand-in says why, instead of the SDK's bare "Tool not found".
		const r = (await client.callTool({ name: "mail_send_draft", arguments: { draft_id: "d1" } })) as Called;
		expect(r.isError).toBe(true);
		expect(r._meta?.["nourax/error"]).toEqual({ code: "not_available", retryable: false });
		expect(r.content[0]?.text).toBe(MAIL_MESSAGES.noWrite);
		// Only the list was loaded; nothing was forwarded.
		expect(mock.requests.map((x) => x.path.split("/").pop())).toEqual(["tools"]);
		expect(toolLines()).toEqual([expect.objectContaining({ t: "tool", tool: "mail_send_draft", ok: false, code: "not_available" })]);
		await client.close();
	});
	it("never lists more than 100 tools: with every app on (71 own tools), exactly 29 mail tools; with fewer apps, 29", async () => {
		expect(CLIENT_TOOL_CAP).toBe(100);
		expect([mailRoom(0), mailRoom(55), mailRoom(71), mailRoom(72), mailRoom(80), mailRoom(100), mailRoom(120)]).toEqual([29, 29, 29, 28, 20, 0, 0]);
		const everything = { scopes: [...ALL_SCOPES], method: "tools/list", apps: [...ALL_APPS], mail: { scenario: "many" } };
		let { client, rc } = await connect(everything);
		const own = visibleTools(rc).length;
		let tools: Tools = (await client.listTools()).tools;
		const mail = tools.filter((t) => t.name.startsWith("mail_"));
		expect(tools.length).toBeLessThanOrEqual(100);
		expect(mail).toHaveLength(Math.min(29, 100 - own));
		// Name order decides which ones fit.
		expect(mail[0]?.name).toBe("mail_tool_00");
		await client.close();
		({ client } = await connect({ ...everything, apps: ["files", "mail"] }));
		tools = (await client.listTools()).tools;
		expect(tools.filter((t) => t.name.startsWith("mail_"))).toHaveLength(29);
		await client.close();
	});
});

/**
 * Fix round 2: a tools/call of a mail_ name that can't be served right now gets the plain reason
 * (caller rule 1, DESIGN 13.5), never the SDK's bare "Tool not found". Clients keep tools/list for a
 * while (cacheHints 60 s, sessions often longer), so they do call tools that have gone.
 */
describe("a mail tool that can't be served right now answers in plain words", () => {
	const ALL_MAIL = ["workspace.read", "mail.read", "mail.write"];
	async function callOnce(o: Omit<Parameters<typeof connect>[0], "method" | "toolName">, name: string, args: Record<string, unknown> = { query: "q" }) {
		const { client } = await connect({ ...o, method: "tools/call", toolName: name });
		const r = (await client.callTool({ name, arguments: args })) as Called;
		await client.close();
		return r;
	}
	const calls = () => mock.requests.filter((x) => x.path.endsWith("/v1/call"));

	it.each([
		["TOOLS_KEY_INVALID", "Mail isn't set up correctly in Nourax Workspace right now"],
		["TOKEN_NOT_FOR_MCP", "NoMail didn't accept this connection's sign-in"],
		["MFA_REQUIRED", "Reconnecting won't change that; it needs the administrator."],
		["MAILBOX_NOT_VERIFIED", "mailbox isn't verified yet"],
	] as const)("NoMail's 403 %s on the list: permission_denied with the block message", async (code, words) => {
		const r = await callOnce({ scopes: ALL_MAIL, mail: { scenario: `403-${code.toLowerCase()}` } }, "mail_search");
		expect(r.isError).toBe(true);
		expect(r._meta?.["nourax/error"]).toEqual({ code: "permission_denied", retryable: false });
		expect(r.content[0]?.text).toBe(blockMessage(code));
		expect(r.content[0]?.text).toContain(words);
		expect(calls()).toHaveLength(0);
		expect(toolLines()).toEqual([expect.objectContaining({ tool: "mail_search", ok: false, code: "permission_denied" })]);
	});
	it("a cached 403 block answers without asking NoMail again", async () => {
		const cache = new MemCache();
		await callOnce({ scopes: ALL_MAIL, mail: { scenario: "403-mfa_required", cache } }, "mail_search");
		mock.requests.length = 0;
		const r = await callOnce({ scopes: ALL_MAIL, mail: { scenario: "403-mfa_required", cache } }, "mail_send_draft", { draft_id: "d1" });
		expect(r._meta?.["nourax/error"]).toMatchObject({ code: "permission_denied" });
		expect(r.content[0]?.text).toContain("two-step sign-in");
		expect(mock.requests).toHaveLength(0);
	});
	it("NoMail refused a freshly refreshed token while listing (a second 401): upstream_unavailable, retry in 60 s, mail not ended (DESIGN 29.6)", async () => {
		const r = await callOnce({ scopes: ALL_MAIL, mail: { token: "expired-1", refreshTo: "expired-2" } }, "mail_send_draft", { draft_id: "d1" });
		expect(r._meta?.["nourax/error"]).toEqual({ code: "upstream_unavailable", retryable: true, retry_after_seconds: 60 });
		expect(r.content[0]?.text).toBe(MAIL_MESSAGES.unavailable);
		expect(calls()).toHaveLength(0);
	});
	it("the mail sign-in ended while listing (the vault calls the refresh dead): reconnect_required", async () => {
		const r = await callOnce({ scopes: ALL_MAIL, mail: { token: "expired-1", refreshTo: null } }, "mail_send_draft", { draft_id: "d1" });
		expect(r._meta?.["nourax/error"]).toEqual({ code: "reconnect_required", retryable: false });
		expect(r.content[0]?.text).toBe(MAIL_MESSAGES.reconnect);
		expect(calls()).toHaveLength(0);
	});
	it("NoMail down while listing: upstream_unavailable, retry in 60 s", async () => {
		const r = await callOnce({ scopes: ALL_MAIL, mail: { scenario: "status-503" } }, "mail_search");
		expect(r._meta?.["nourax/error"]).toEqual({ code: "upstream_unavailable", retryable: true, retry_after_seconds: 60 });
		expect(r.content[0]?.text).toBe(MAIL_MESSAGES.unavailable);
		expect(calls()).toHaveLength(0);
	});
	it("the circuit open: the same answer, and NoMail is asked nothing", async () => {
		const cache = new MemCache();
		for (let i = 0; i < 3; i++) await cache.fail();
		const r = await callOnce({ scopes: ALL_MAIL, mail: { cache } }, "mail_search");
		expect(r._meta?.["nourax/error"]).toEqual({ code: "upstream_unavailable", retryable: true, retry_after_seconds: 60 });
		expect(mock.requests).toHaveLength(0);
	});
	it("NoMail's 429 on the list: rate_limited with its Retry-After; the call isn't sent", async () => {
		const r = await callOnce({ scopes: ALL_MAIL, mail: { scenario: "limited" } }, "mail_send_draft", { draft_id: "d1" });
		expect(r._meta?.["nourax/error"]).toEqual({ code: "rate_limited", retryable: true, retry_after_seconds: 60 });
		expect(r.content[0]?.text).toBe(MAIL_MESSAGES.slowDown);
		expect(calls()).toHaveLength(0);
	});
	it("a mail_ name NoMail doesn't offer: not_available", async () => {
		const r = await callOnce({ scopes: ALL_MAIL }, "mail_unknown_tool", {});
		expect(r._meta?.["nourax/error"]).toEqual({ code: "not_available", retryable: false });
		expect(r.content[0]?.text).toBe(MAIL_MESSAGES.notListed);
		expect(calls()).toHaveLength(0);
	});
	it("a tool that didn't fit in the 100 says so", async () => {
		// 95 tools of our own leave room for 5 mail tools; mail_tool_10 is listed by NoMail but didn't fit.
		const o = { scopes: ALL_MAIL, mail: { scenario: "many" }, direct: { ownCount: 95 } };
		const r = await callOnce(o, "mail_tool_10");
		expect(r._meta?.["nourax/error"]).toEqual({ code: "not_available", retryable: false });
		expect(r.content[0]?.text).toBe(MAIL_MESSAGES.noRoom);
		expect(calls()).toHaveLength(0);
		// One that fits is forwarded as usual (the mock then answers 404 for its made-up name).
		const fits = await callOnce(o, "mail_tool_04");
		expect(fits.content[0]?.text).toBe(MAIL_MESSAGES.gone);
		expect(calls()).toHaveLength(1);
	});
	it.each([
		["not_set_up", "not_available", "Mail tools aren't set up for this connection in Nourax Workspace."],
		["off", "not_available", "This connection was set up without mail. The person can add it by reconnecting the assistant."],
		["reconnect_needed", "reconnect_required", MAIL_MESSAGES.reconnect],
	] as const)("mail off on the connection (%s): %s, and nothing is loaded", async (state, code, text) => {
		const r = await callOnce({ scopes: ALL_MAIL, mail: { active: false, state } }, "mail_send_draft", { draft_id: "d1" });
		expect(r._meta?.["nourax/error"]).toEqual({ code, retryable: false });
		expect(r.content[0]?.text).toBe(text);
		// A reconnect asks ChatGPT to show its re-link prompt (error and error_description, fix round 3).
		const challenge = (r._meta as Record<string, unknown> | undefined)?.["mcp/www_authenticate"];
		if (code === "reconnect_required") expect(String((challenge as string[])[0])).toMatch(/error="invalid_token", error_description="[^"]+", resource_metadata=/);
		else expect(challenge).toBeUndefined();
		expect(mock.requests).toHaveLength(0);
		expect(toolLines()).toEqual([expect.objectContaining({ tool: "mail_send_draft", ok: false, code })]);
	});
	it("mail off beats a per-person limit, as core's stub for a hidden tool does", async () => {
		const blocked = new ToolError("rate_limited", "Too many requests in a short time (mail). Try again shortly.", { retryAfterSec: 12 });
		const r = await callOnce({ scopes: ALL_MAIL, mail: { active: false, state: "off" }, blocked }, "mail_search");
		expect(r._meta?.["nourax/error"]).toMatchObject({ code: "not_available" });
		expect(r.content[0]?.text).toContain("set up without mail");
		expect(mock.requests).toHaveLength(0);
	});
	it("never forwards the arguments a stand-in got, and logs no mail text", async () => {
		await callOnce({ scopes: ["workspace.read", "mail.read"] }, "mail_send_draft", { draft_id: "secret-draft-77", note: "Quarterly numbers" });
		expect(calls()).toHaveLength(0);
		const all = JSON.stringify(logLines(logs));
		for (const s of ["secret-draft-77", "Quarterly"]) expect(all).not.toContain(s);
	});
});

/**
 * Fix rounds 3 and 4 (DESIGN 26.4, 26.6): the mail tools that reach NoDrive follow the connection's
 * Files app and workspace scopes in tools/list and tools/call alike, and a tool failure NoMail reports
 * is logged with its code.
 */
describe("mail tools that reach NoDrive, through the server", () => {
	const drive = { scenario: "drive" };
	const listMail = async (scopes: string[], apps: string[]) => {
		const { client } = await connect({ scopes, method: "tools/list", apps, mail: drive });
		const tools = (await client.listTools()).tools.filter((t) => t.name.startsWith("mail_"));
		await client.close();
		return tools;
	};
	it("are listed only with the Files app, saving only with create and edit, and the link rule is in the description", async () => {
		const mailOnly = await listMail(["workspace.read", "mail.read", "mail.write"], ["calendar", "mail"]);
		expect(mailOnly.map((t) => t.name)).not.toContain("mail_attach_drive_file");
		expect(mailOnly.map((t) => t.name)).not.toContain("mail_save_attachment_to_drive");
		expect(mailOnly).toHaveLength(6);
		const readFiles = await listMail(["workspace.read", "mail.read", "mail.write"], ["files", "mail"]);
		const attach = readFiles.find((t) => t.name === "mail_attach_drive_file");
		expect(attach?.description).toContain('On this connection only as "file" works');
		expect(attach?._meta).toMatchObject({ securitySchemes: [{ type: "oauth2", scopes: ["mail.write", "workspace.read"] }] });
		expect(readFiles.map((t) => t.name)).not.toContain("mail_save_attachment_to_drive");
		const everything = await listMail(["workspace.read", "workspace.write", "workspace.share", "mail.read", "mail.write"], ["files", "mail"]);
		expect(everything.find((t) => t.name === "mail_attach_drive_file")?.description).not.toContain("On this connection");
		expect(everything.find((t) => t.name === "mail_save_attachment_to_drive")?._meta).toMatchObject({ securitySchemes: [{ scopes: ["mail.write", "workspace.write"] }] });
	});
	it("a call the connection may not make gets the plain reason from a stand-in, and nothing reaches NoMail's call route", async () => {
		const call = async (scopes: string[], apps: string[], name: string, args: Record<string, unknown>) => {
			const { client } = await connect({ scopes, method: "tools/call", toolName: name, apps, mail: drive });
			const r = (await client.callTool({ name, arguments: args })) as Called;
			await client.close();
			return r;
		};
		let r = await call(["workspace.read", "mail.read", "mail.write"], ["mail"], "mail_attach_drive_file", { draft_id: "d1", path: "/a.pdf", as: "file" });
		expect(r._meta?.["nourax/error"]).toEqual({ code: "not_available", retryable: false });
		expect(r.content[0]?.text).toBe(MAIL_MESSAGES.noFiles);
		r = await call(["workspace.read", "mail.read", "mail.write"], ["files", "mail"], "mail_save_attachment_to_drive", { message_id: "m1", attachment_id: "a1" });
		expect(r.content[0]?.text).toBe(MAIL_MESSAGES.noFilesWrite);
		r = await call(["workspace.read", "mail.read", "mail.write"], ["files", "mail"], "mail_attach_drive_file", { draft_id: "d1", path: "/a.pdf" });
		expect(r._meta?.["nourax/error"]).toMatchObject({ code: "not_available", field: "as" });
		expect(mock.requests.filter((x) => x.path.endsWith("/v1/call"))).toHaveLength(0);
		r = await call(["workspace.read", "workspace.write", "mail.read", "mail.write"], ["files", "mail"], "mail_save_attachment_to_drive", { message_id: "m1", attachment_id: "a1" });
		expect(r.isError).toBeFalsy();
		expect(mock.requests.filter((x) => x.path.endsWith("/v1/call"))).toHaveLength(1);
	});
	it("a tool failure NoMail reports is logged with the code mail_tool_error", async () => {
		const { client } = await connect({ scopes: ["workspace.read", "mail.read"], method: "tools/call", toolName: "mail_get_message" });
		const r = (await client.callTool({ name: "mail_get_message", arguments: { id: "missing" } })) as Called;
		expect(r.isError).toBe(true);
		expect(r._meta?.["nourax/error"]).toEqual({ code: "mail_tool_error", retryable: false });
		expect(toolLines()).toEqual([expect.objectContaining({ tool: "mail_get_message", ok: false, code: "mail_tool_error" })]);
		await client.close();
	});
});
