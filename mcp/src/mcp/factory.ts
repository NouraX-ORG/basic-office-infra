/**
 * The per-request McpServer factory (DESIGN 2.2 step 4). A fresh server per request: the
 * instructions for this connection, the allowed tools in catalogue order, then mail tools (loaded
 * only for tools/list and for tools/call of a mail_ tool). Stateless; serves both protocol eras.
 */
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { LIMITS } from "../core/limits";
import { log } from "../core/log";
import { noteReq } from "../http/rid";
import { registerMailTools } from "../mail/register";
import { SERVER_NAME, SERVER_TITLE, VERSION } from "../version";
import type { RequestCtx } from "./context";
import { visibleTools } from "./gate";
import { buildInstructions } from "./instructions";
import { registerGatedStub, registerOwnTool } from "./register";

export async function buildServer(rc: RequestCtx): Promise<McpServer> {
	const server = new McpServer(
		{ name: SERVER_NAME, title: SERVER_TITLE, version: VERSION },
		{
			capabilities: { tools: { listChanged: false } },
			instructions: buildInstructions(rc.scopes, rc.mail.active, rc.apps),
			cacheHints: { "tools/list": { ttlMs: 60_000, cacheScope: "private" } },
			maxToolInputElements: 50_000,
		},
	);
	const own = visibleTools(rc);
	for (const def of own) registerOwnTool(server, def, rc);
	if (rc.gated) registerGatedStub(server, rc.gated.name, rc.gated.error, rc);

	// Mail tools (lane E, src/mail/register.ts): per-person limits answer first, one log line per call,
	// and at most 100 tools listed in all (ONLYOFFICE's cap). A tools/call of a mail_ name always goes
	// there, also while mail is off or needs a reconnect, so a stand-in tells the person why instead of
	// the SDK's bare "Tool not found" (caller rule 1, DESIGN 26.3; fix round 3). registerMailTools lists
	// nothing for tools/list while mail is off.
	const wantsMail = (rc.method === "tools/list" && rc.mail.active) || (rc.method === "tools/call" && rc.toolName?.startsWith("mail_") === true);
	if (wantsMail) await registerMailTools(server, rc, own.length);
	return server;
}

/** One handler for both eras; the request context travels in authInfo.extra.nx. */
export const mcpHttp = createMcpHandler(
	async ({ era, authInfo }) => {
		const rc = authInfo?.extra?.nx as RequestCtx | undefined;
		if (!rc) throw new Error("missing request context");
		rc.era = era;
		noteReq(rc.rid, { era });
		return buildServer(rc);
	},
	{
		legacy: "stateless",
		maxRequestBodySize: LIMITS.mcpBodyBytes,
		// The SDK turns factory and serving failures into a bare 500; the name alone is logged, never
		// the message (it may carry input). DESIGN 5.3.
		onerror: (e: Error) => log({ t: "auth", ev: "mcp_error", reason: e?.name || "Error" }),
	},
);
