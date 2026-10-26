/** Lane E test helpers: a fake NoDrive with Deck, and one tools/call through the whole Worker. */
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import type { z } from "zod";
import type { FakeNc } from "../../fake-nc/index";
import { FakeDeck } from "../../fake-nc/deck";
import { devToken, fakeWithQa, framedPayload, mcpPost, QA, rpcResult } from "../../helpers/index";
import { toolDef } from "../../../src/tools/registry";

export interface ToolResult {
	content: { type: string; text: string }[];
	structuredContent: Record<string, unknown>;
	isError?: boolean;
	_meta?: Record<string, { code: string; field?: string; retryable?: boolean; retry_after_seconds?: number }>;
}

export function setupDeck(): { fake: FakeNc; deck: FakeDeck } {
	const fake = fakeWithQa();
	return { fake, deck: new FakeDeck(fake) };
}

export const WRITE_SCOPES = ["workspace.read", "workspace.write"];

export async function callTool(name: string, args: unknown, o: { uid?: string; scopes?: string[]; apps?: string[] } = {}): Promise<ToolResult> {
	const t = await devToken(o.uid ?? QA.a, { ...(o.scopes ? { scopes: o.scopes } : {}), ...(o.apps ? { apps: o.apps } : {}) });
	const res = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
	const body = await rpcResult(res);
	if (!body.result) throw new Error(`no result (HTTP ${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
	return body.result as ToolResult;
}

/** The framed payload parsed back (nulls are left out of the text form). */
export function payloadOf(r: ToolResult): Record<string, unknown> {
	return JSON.parse(framedPayload(r.content[0]?.text ?? "")) as Record<string, unknown>;
}

/**
 * The output schema exactly as tools/list publishes it: the SDK converts the Standard Schema with
 * io "output" and target draft 2020-12, and stamps type "object" on a typeless object root
 * (standardSchemaToJsonSchema in @modelcontextprotocol/server 2.3.1).
 */
export function publishedOutputSchema(name: string): Record<string, unknown> {
	const def = toolDef(name);
	if (!def?.output) throw new Error(`${name} has no output schema`);
	const std = (def.output as unknown as { "~standard": { jsonSchema: { output(o: { target: string }): Record<string, unknown> } } })["~standard"];
	const s = std.jsonSchema.output({ target: "draft-2020-12" });
	return s.type === undefined ? { type: "object", ...s } : s;
}

const jsonValidator = new CfWorkerJsonSchemaValidator();

/**
 * structuredContent must match the tool's output schema twice over: our zod schema, and the published
 * JSON Schema checked the way spec-following clients check it (the SDK client's own validator,
 * additionalProperties honoured, no stripping of unknown keys).
 */
export function expectSchema(name: string, r: ToolResult): void {
	const def = toolDef(name);
	if (!def?.output) throw new Error(`${name} has no output schema`);
	const parsed = (def.output as z.ZodType).safeParse(r.structuredContent);
	if (!parsed.success) throw new Error(`${name} output doesn't match its schema: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
	const checked = jsonValidator.getValidator(publishedOutputSchema(name))(r.structuredContent);
	if (!checked.valid) throw new Error(`${name} output doesn't match its published JSON Schema: ${checked.errorMessage}`);
}

export function errorCode(r: ToolResult): string | undefined {
	return r._meta?.["nourax/error"]?.code;
}

const N = ["next", "cloud"];
const BRAND = [new RegExp(`${N[0]}[ -]?${N[1]}`, "i"), /#0082c9/i, /#00679e/i];

export function brandFree(text: string): boolean {
	return !BRAND.some((re) => re.test(text));
}
