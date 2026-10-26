/**
 * NoMail's tools on the per-request MCP server (DESIGN 2.2 step 4, 13.4, 14, 15), lane E. Core's
 * factory calls registerMailTools() after our own tools, only for tools/list and for tools/call of
 * a mail_ tool, and only while mail is active for the connection.
 *
 * Every mail call goes through runMailCall(), the mail twin of core's runTool:
 * 1. a per-person limit that stopped this call (the vault's "mail" bucket: 30 a minute, 1,000 a day,
 *    and 5,000 calls a day in all) answers first, and NoMail is never asked anything;
 * 2. the arguments are checked against the provider's JSON Schema here, with a plain message and
 *    the code invalid_input (the SDK sees a pass-through schema that still publishes the real one);
 * 3. the aggregator forwards the call (src/mail/index.ts);
 * 4. one tool log line, metadata only: the tool name, ok, the error code, time and sizes. Never the
 *    arguments or any mail text.
 *
 * At most 100 tools are listed in all, because ONLYOFFICE Desktop Editors turns on no more than 100
 * tools of one server (DESIGN 5.1). With every app (71 tools of our own since calendar_respond, fix
 * round 3) that leaves room for exactly 29 mail tools (LIMITS.mailTools); NoMail ships 18. A new tool
 * of our own would shrink the mail share again.
 *
 * Which tools a connection may list and call is decided by ./access.ts, from the connection's scopes
 * and apps: the mail scope, and since fix round 3 the Files app and workspace scopes for the tools
 * that reach NoDrive (mail_attach_drive_file, mail_save_attachment_to_drive), and the share scope for
 * a Drive file sent as a link (DESIGN 26).
 *
 * A tools/call of a mail_ name that can't be served right now never reaches the SDK's bare "Tool not
 * found": a stand-in answers with the plain reason (caller rule 1, DESIGN 13.5): mail is off or needs
 * a reconnect, a per-person limit, NoMail's 403 code, NoMail asking to slow down, NoMail down (the
 * circuit), a tool this connection's scopes or apps don't allow, or a tool that didn't fit in the
 * 100. Clients keep tools/list for a while, so they do call tools that have gone. Only a name that
 * isn't a mail tool name at all (MAIL_NAME_RE) is left to the SDK. Core's factory calls this module
 * for every tools/call of a mail_ name, also while mail is off (DESIGN 26.3, applied in fix round 3).
 *
 * A result that asks the person to reconnect (the upstream sign-in ended) carries
 * `_meta["mcp/www_authenticate"]`, so ChatGPT shows its re-link prompt for mail too (fix round 3).
 */
import { fromJsonSchema, type McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ToolError } from "../core/errors";
import { log, pseudonym } from "../core/log";
import type { MailToolDef } from "../core/mail-contract";
import { errorResult, oneLine } from "../core/result";
import type { RequestCtx } from "../mcp/context";
import { passThroughSchema, wwwAuthenticate } from "../mcp/register";
import { CLIENT_TOOL_CAP, driveReach, type MailGrant, mailRoom, shownDescription, shownMailTools } from "./access";
import { type CallResult, callMailTool, listMailTools, MAIL_MESSAGES, mailUnavailable, unsureResult } from "./index";
import { MAIL_NAME_RE } from "./validate";

export { CLIENT_TOOL_CAP, mailRoom, shownMailTools };

/** The connection's grant, as the vault record holds it (scopes and apps). */
function grantOf(rc: RequestCtx): MailGrant {
	return { scopes: rc.scopes, apps: rc.apps };
}

/** The scopes a listed tool needs, for clients that read securitySchemes. */
function neededScopes(t: MailToolDef): string[] {
	const mail = t.annotations.readOnlyHint ? "mail.read" : "mail.write";
	const reach = driveReach(t);
	return reach === "write" ? [mail, "workspace.write"] : reach === "read" ? [mail, "workspace.read"] : [mail];
}

/** Publishes the provider's JSON Schema in tools/list but accepts anything; runMailCall checks it. */
function publishOnly(schema: Record<string, unknown>): StandardSchemaWithJSON {
	return {
		"~standard": {
			version: 1,
			vendor: "nourax",
			validate: (value: unknown) => ({ value: value ?? {} }),
			jsonSchema: { input: () => schema, output: () => schema },
		},
	} as unknown as StandardSchemaWithJSON;
}

/**
 * The provider's schema check, as one plain sentence naming the field that doesn't fit. The workerd
 * validator joins its findings with "; ", most general first, each as "<#/json/pointer>: <text>", for
 * example `#: Property "draft_id" does not match schema.; #/draft_id: Instance type "number" is
 * invalid. Expected "string".`
 */
export function checkMailInput(def: MailToolDef, args: unknown): ToolError | null {
	let issues: readonly { message?: unknown }[] | undefined;
	try {
		const std = (fromJsonSchema(def.inputSchema as never) as { "~standard": { validate(v: unknown): unknown } })["~standard"];
		const r = std.validate(args ?? {}) as { issues?: readonly { message?: unknown }[] };
		issues = r.issues;
	} catch {
		return new ToolError("not_available", MAIL_MESSAGES.notListed);
	}
	if (!issues?.length) return null;
	const parts = String(issues[0]?.message ?? "")
		.split(/; (?=#)/)
		.map((p) => {
			const m = /^#((?:\/[^:]*)?): (.*)$/s.exec(p);
			return m ? { loc: (m[1] ?? "").replace(/^\//, "").replaceAll("/", "."), text: m[2] ?? "" } : { loc: "", text: p };
		});
	const at = (loc: string, key?: string) => [loc, key].filter(Boolean).join(".") || undefined;
	let field: string | undefined;
	let what: string;
	const extra = parts.map((p) => ({ p, k: /^Property "([^"]{1,64})" does not match additional properties schema\.$/.exec(p.text)?.[1] })).find((x) => x.k);
	const missing = parts.map((p) => ({ p, k: /^Instance does not have required property "([^"]{1,64})"\.$/.exec(p.text)?.[1] })).find((x) => x.k);
	if (extra) {
		field = at(extra.p.loc, extra.k);
		what = `${field} isn't one of its inputs`;
	} else if (missing) {
		field = at(missing.p.loc, missing.k);
		what = `${field} is required`;
	} else {
		const last = parts[parts.length - 1] ?? { loc: "", text: "" };
		field = at(last.loc);
		const type = /^Instance type "([^"]+)" is invalid\. Expected "([^"]+)"\.$/.exec(last.text);
		what = type ? `${field ?? "the input"} must be ${type[2]}, not ${type[1]}` : `${field ? `${field}: ` : ""}${last.text.replace(/^Instance /, "the value ").replace(/\.$/, "") || "it isn't valid"}`;
	}
	return new ToolError("invalid_input", oneLine(`The input doesn't match what ${def.name} takes: ${what}.`), field ? { field } : {});
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

async function logMailCall(rc: RequestCtx, tool: string, result: CallResult, started: number): Promise<void> {
	const meta = result._meta?.["nourax/error"] as { code?: unknown } | undefined;
	const code = typeof meta?.code === "string" ? meta.code : result.isError ? "mail_tool_error" : undefined;
	log({
		t: "tool",
		rid: rc.rid,
		who: await pseudonym(rc.env, rc.uid, 12),
		conn: await pseudonym(rc.env, rc.connectionId, 8),
		cli: rc.cli,
		tool,
		ok: result.isError !== true,
		code,
		ms: Date.now() - started,
		nc_calls: rc.stats.calls,
		nc_status: rc.stats.lastStatus,
		in_bytes: rc.inBytes,
		out_bytes: JSON.stringify(result).length,
	});
}

/**
 * The answer of a stand-in (a mail_ name that couldn't be registered): mail that is off answers
 * first, as core's stub for a hidden tool does; then a per-person limit, without loading anything from
 * NoMail; then the reason from this request's list (mailUnavailable). A tool that is listed and allowed
 * was left out only by the 100-tool room. Never forwards anything to NoMail.
 */
async function standInResult(rc: RequestCtx, name: string): Promise<CallResult> {
	if (rc.mail.active && rc.blocked) return errorResult(rc.blocked) as CallResult;
	try {
		return (await mailUnavailable(rc.mail, name, grantOf(rc))) ?? (errorResult(new ToolError("not_available", MAIL_MESSAGES.noRoom)) as CallResult);
	} catch {
		return errorResult(new ToolError("upstream_unavailable", MAIL_MESSAGES.unavailable, { retryAfterSec: 60 })) as CallResult;
	}
}

/**
 * One mail call: limits first, then the input check, then NoMail, then one log line. Never throws.
 * `def` is a name only for a stand-in, which answers with the reason the tool can't be used now.
 */
export async function runMailCall(rc: RequestCtx, def: MailToolDef | string, args: unknown): Promise<CallResult> {
	const started = Date.now();
	const name = typeof def === "string" ? def : def.name;
	let result: CallResult;
	if (typeof def === "string") {
		result = await standInResult(rc, name);
	} else if (rc.blocked) {
		result = errorResult(rc.blocked) as CallResult;
	} else {
		const bad = checkMailInput(def, args);
		if (bad) result = errorResult(bad) as CallResult;
		else {
			try {
				result = await callMailTool(rc.mail, name, isPlainObject(args) ? args : {}, grantOf(rc));
			} catch {
				// callMailTool answers every failure itself; reaching here is our bug, after which nothing
				// is known about NoMail's side.
				result = def.annotations.readOnlyHint ? (errorResult(new ToolError("upstream_unavailable", MAIL_MESSAGES.unavailable)) as CallResult) : unsureResult("upstream_unavailable", MAIL_MESSAGES.unsureError);
			}
		}
	}
	const code = (result._meta?.["nourax/error"] as { code?: unknown } | undefined)?.code;
	if (code === "reconnect_required") {
		result = { ...result, _meta: { ...(result._meta ?? {}), "mcp/www_authenticate": wwwAuthenticate(rc.cfg, "Mail needs a new sign-in. Connect again") } };
	}
	await logMailCall(rc, name, result, started);
	return result;
}

function registerListed(server: McpServer, rc: RequestCtx, t: MailToolDef): void {
	server.registerTool(
		t.name,
		{
			title: t.title,
			description: shownDescription(t, grantOf(rc)),
			inputSchema: publishOnly(t.inputSchema),
			annotations: { title: t.title, ...t.annotations },
			_meta: { securitySchemes: [{ type: "oauth2", scopes: neededScopes(t) }] },
		},
		async (args: unknown) => (await runMailCall(rc, t, args)) as never,
	);
}

/** Registered for tools/call only, so never listed; it accepts any arguments and forwards nothing. */
function registerStandIn(server: McpServer, rc: RequestCtx, name: string): void {
	server.registerTool(name, { description: "Not available right now.", inputSchema: passThroughSchema(z.object({}).passthrough()) }, async () => (await runMailCall(rc, name, {})) as never);
}

async function loadTools(rc: RequestCtx): Promise<MailToolDef[]> {
	try {
		return await listMailTools(rc.mail);
	} catch {
		return [];
	}
}

/**
 * Registers the mail tools this request needs. For tools/list: every allowed tool within the room,
 * only while mail is active. For tools/call of a mail_ name: the called tool when it is listed,
 * allowed and fits; otherwise a stand-in that answers with the reason (see standInResult). When mail
 * is off or a per-person limit stopped the call, nothing is loaded from NoMail. Returns how many
 * tools were registered.
 */
export async function registerMailTools(server: McpServer, rc: RequestCtx, ownCount: number): Promise<number> {
	if (rc.method === "tools/list") {
		if (!rc.mail.active) return 0;
		const shown = shownMailTools(await loadTools(rc), grantOf(rc), ownCount);
		for (const t of shown) registerListed(server, rc, t);
		return shown.length;
	}
	if (rc.method !== "tools/call") return 0;
	const called = rc.toolName ?? "";
	// A name that isn't a mail tool name at all is unknown to the SDK, which answers "not found".
	if (!MAIL_NAME_RE.test(called)) return 0;
	if (!rc.mail.active || rc.blocked) {
		registerStandIn(server, rc, called);
		return 1;
	}
	const def = shownMailTools(await loadTools(rc), grantOf(rc), ownCount).find((t) => t.name === called);
	if (def) registerListed(server, rc, def);
	else registerStandIn(server, rc, called);
	return 1;
}
