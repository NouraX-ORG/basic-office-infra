/**
 * Helpers for lane A's contract tests: a fake with files, a token, and one-line tool calls. Every
 * successful call is checked against the tool's result shape as zod would publish it
 * (additionalProperties false at every level), with the MCP SDK's own validator, because lane A
 * keeps its shapes in code instead of publishing outputSchema (src/tools/files/define.ts).
 */
import { runInDurableObject } from "cloudflare:test";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { z } from "zod";
import { clearCapabilityCache } from "../../../src/nc/capabilities";
import { FILES_OUTPUTS } from "../../../src/tools/files/define";
import "../../../src/tools/files/index";
import { type Vault, vaultFor } from "../../../src/vault/vault";
import type { FakeNc, Recorded } from "../../fake-nc/index";
import { type FakeFiles, installFiles } from "../../fake-nc/files";
import { devToken, env as nxEnv, fakeWithQa, framedPayload, mcpPost, QA, rpcResult } from "../../helpers/index";

export const LANE_A = [
	"files_list_folder",
	"files_search",
	"files_get_info",
	"files_create_file",
	"files_overwrite_file",
	"files_create_folder",
	"files_move",
	"files_copy",
	"files_rename",
	"files_move_to_trash",
	"files_list_trash",
	"files_restore_from_trash",
	"files_list_versions",
	"files_restore_version",
	"files_list_favorites",
	"files_set_favorite",
	"files_list_recent",
];

type Validator = ReturnType<typeof fromJsonSchema>;
const validators = new Map<string, Validator>();

/** The tool's result shape as JSON Schema (what publishing it would show). */
export function outputJsonSchema(name: string): Record<string, unknown> {
	const shape = FILES_OUTPUTS[name];
	if (!shape) throw new Error(`${name} has no result shape in FILES_OUTPUTS`);
	return z.toJSONSchema(shape, { io: "output" }) as Record<string, unknown>;
}

/** Throws when structuredContent doesn't match the tool's shape exactly (no extra keys anywhere). */
export async function assertShape(name: string, value: unknown): Promise<void> {
	let v = validators.get(name);
	if (!v) {
		v = fromJsonSchema(outputJsonSchema(name) as never);
		validators.set(name, v);
	}
	const r = await v["~standard"].validate(value);
	if ("issues" in r && r.issues) throw new Error(`${name}: result doesn't match its shape: ${JSON.stringify(r.issues).slice(0, 600)}`);
}

export interface ToolResult {
	isError?: boolean;
	content: { type: string; text: string }[];
	structuredContent?: Record<string, unknown>;
	_meta?: Record<string, unknown>;
}

export interface Env {
	fake: FakeNc;
	files: FakeFiles;
	token: string;
	uid: string;
	call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
	/** The same, as another QA account on the same fake (its own dev token, made on first use). */
	callAs(uid: string, name: string, args?: Record<string, unknown>): Promise<ToolResult>;
	/** Requests to the person's DAV files, trash and versions, and to the search provider. */
	davCalls(): Recorded[];
}

export const ALL_WORKSPACE = ["workspace.read", "workspace.write", "workspace.remove", "workspace.share"];

export async function setup(opts: { scopes?: string[]; uid?: string } = {}): Promise<Env> {
	// Capabilities and search providers are cached per person in isolate memory (10 minutes).
	clearCapabilityCache();
	const fake = fakeWithQa();
	const files = installFiles(fake);
	const uid = opts.uid ?? QA.a;
	files.tree(uid);
	files.tree(QA.b);
	const t = await devToken(uid, { scopes: opts.scopes ?? ALL_WORKSPACE });
	// The tests of one file share the person's vault storage, so the per-minute limits (DESIGN 9.4,
	// e.g. 20 a minute for the trash) would add up across tests. Each test starts with fresh minutes.
	await runInDurableObject(vaultFor(nxEnv, uid), async (_i: Vault, state) => {
		state.storage.sql.exec("DELETE FROM counters WHERE k LIKE 'm:%'");
	});
	let id = 10;
	const tokens = new Map<string, string>([[uid, t.access_token]]);
	const callWith = async (token: string, name: string, args: Record<string, unknown>) => {
		const res = await mcpPost(token, { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } });
		const body = await rpcResult(res);
		if (body.error) throw new Error(`JSON-RPC error: ${JSON.stringify(body.error)}`);
		const result = body.result as ToolResult;
		if (!result.isError && FILES_OUTPUTS[name]) await assertShape(name, result.structuredContent);
		return result;
	};
	return {
		fake,
		files,
		token: t.access_token,
		uid,
		call: (name, args = {}) => callWith(t.access_token, name, args),
		async callAs(other, name, args = {}) {
			let token = tokens.get(other);
			if (!token) {
				token = (await devToken(other, { scopes: opts.scopes ?? ALL_WORKSPACE })).access_token;
				tokens.set(other, token);
				await runInDurableObject(vaultFor(nxEnv, other), async (_i: Vault, state) => {
					state.storage.sql.exec("DELETE FROM counters WHERE k LIKE 'm:%'");
				});
			}
			return callWith(token, name, args);
		},
		davCalls() {
			return fake.requests.filter((r) =>
				/^\/remote\.php\/dav\/(files|trashbin|versions)\/|^\/remote\.php\/dav\/?$|\/search\/providers\/|^\/index\.php\/apps\/files\/api\/v1\/recent/.test(r.url.pathname),
			);
		},
	};
}

export function code(r: ToolResult): string | undefined {
	return (r._meta?.["nourax/error"] as { code?: string } | undefined)?.code;
}

export function field(r: ToolResult): string | undefined {
	return (r._meta?.["nourax/error"] as { field?: string } | undefined)?.field;
}

export function text(r: ToolResult): string {
	return r.content[0]?.text ?? "";
}

/** The framed JSON payload of a successful result. */
export function payload(r: ToolResult): Record<string, unknown> {
	return JSON.parse(framedPayload(text(r))) as Record<string, unknown>;
}

export function sc<T = Record<string, unknown>>(r: ToolResult): T {
	if (r.isError) throw new Error(`tool failed: ${text(r)}`);
	return r.structuredContent as T;
}

/** No raw server text, stack traces or the upstream brand in what a person sees. */
export function clean(r: ToolResult): boolean {
	const s = JSON.stringify(r);
	return !/sabre|exception|var\/www|next ?cloud|#0082c9|#00679e/i.test(s);
}
