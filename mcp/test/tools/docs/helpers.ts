/** Helpers for lane C's contract tests: call a tool through the whole Worker and check its result. */
import { expect, vi } from "vitest";
import { BUILTIN_BRAND_RULES } from "../../../src/core/brand";
import { toolDef } from "../../../src/tools/registry";
import type { FakeNc, Recorded } from "../../fake-nc/index";
import { devToken, framedPayload, mcpPost, QA, rpcResult } from "../../helpers/index";

const REAL_NOW = Date.now();
let dayShift = 0;

/**
 * Each test starts on its own day, so the vault's exact per-person limits (heavy: 10 a minute,
 * conversions: 20 an hour) start from zero, as they would for a person. Only Date is faked.
 */
export function freshDay(): void {
	vi.useFakeTimers({ toFake: ["Date"] });
	dayShift += 2;
	vi.setSystemTime(REAL_NOW + dayShift * 86_400_000);
}

export interface ToolResult {
	content: { type: string; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	_meta?: { "nourax/error"?: { code: string; field?: string; retryable?: boolean } };
}

export async function callTool(name: string, args: unknown, opts: { uid?: string; scopes?: string[]; apps?: string[] } = {}): Promise<ToolResult> {
	const t = await devToken(opts.uid ?? QA.a, { ...(opts.scopes ? { scopes: opts.scopes } : {}), ...(opts.apps ? { apps: opts.apps } : {}) });
	const res = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
	const body = await rpcResult(res);
	if (!body.result) throw new Error(`no result: ${JSON.stringify(body).slice(0, 300)}`);
	return body.result as ToolResult;
}

/** A successful result: framed, brand-clean, and its structuredContent matches the output schema. */
export function ok(name: string, r: ToolResult): Record<string, unknown> {
	if (r.isError) throw new Error(`${name} failed: ${r.content[0]?.text}`);
	const text = r.content[0]?.text ?? "";
	framedPayload(text);
	brandClean(text);
	const def = toolDef(name);
	if (def?.output) def.output.parse(r.structuredContent);
	return r.structuredContent as Record<string, unknown>;
}

/** A failed result with this code; its text is plain (no server traces, no upstream brand). */
export function failed(r: ToolResult, code: string, field?: string): string {
	expect(r.isError, r.content[0]?.text).toBe(true);
	expect(r._meta?.["nourax/error"]?.code).toBe(code);
	if (field) expect(r._meta?.["nourax/error"]?.field).toBe(field);
	const text = r.content[0]?.text ?? "";
	expect(text).not.toMatch(/sabre|exception|stack|\/var\/www|<html/i);
	brandClean(text);
	return text;
}

export function brandClean(text: string): void {
	for (const r of BUILTIN_BRAND_RULES) expect(r.pattern.test(text), `brand rule ${r.id}`).toBe(false);
}

export function calls(fake: FakeNc, method: string, re: RegExp): Recorded[] {
	return fake.driveCalls().filter((c) => c.method === method && re.test(c.url.pathname));
}
