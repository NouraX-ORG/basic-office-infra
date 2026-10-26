/**
 * Lane B's test helper: call one tool through the whole Worker (dev token, /mcp, the gate, the
 * wrapper), and check structuredContent against the tool's output schema as zod would publish it
 * (additionalProperties false at every level), so the shape stays exact even though lane B does
 * not publish outputSchema (tools/list size, DESIGN 10.8).
 */
import { expect } from "vitest";
import { z } from "zod";
import { LIMITS } from "../../../src/core/limits";
import { contactsAddOutput } from "../../../src/tools/contacts/add";
import { contactsGetOutput } from "../../../src/tools/contacts/get";
import { contactsSearchOutput } from "../../../src/tools/contacts/search";
import { contactsUpdateOutput } from "../../../src/tools/contacts/update";
import { sharingCreateLinkOutput } from "../../../src/tools/sharing/create-link";
import { sharingDeleteOutput } from "../../../src/tools/sharing/delete";
import { sharingFindPeopleOutput } from "../../../src/tools/sharing/find-people";
import { sharingListOutput } from "../../../src/tools/sharing/list";
import { sharingShareWithOutput } from "../../../src/tools/sharing/share-with";
import { sharingUpdateOutput } from "../../../src/tools/sharing/update";
import { devToken, framedPayload, mcpPost, QA, rpcResult } from "../../helpers/index";

export const ALL_SCOPES = ["workspace.read", "workspace.write", "workspace.remove", "workspace.share"];

export interface ToolResult {
	content: { type: string; text: string }[];
	// biome-ignore lint/suspicious/noExplicitAny: test access to free-form results
	structuredContent: Record<string, any>;
	isError?: boolean;
	_meta?: Record<string, { code: string; field?: string; retryable?: boolean; retry_after_seconds?: number }>;
}

/** One connection (the duplicate guard and the mail cache are per connection). */
export async function tokenFor(uid: string = QA.a, scopes: string[] = ALL_SCOPES): Promise<string> {
	return (await devToken(uid, { scopes })).access_token;
}

export async function callTool(name: string, args: Record<string, unknown>, opts: { uid?: string; scopes?: string[]; token?: string } = {}): Promise<ToolResult> {
	const token = opts.token ?? (await tokenFor(opts.uid ?? QA.a, opts.scopes ?? ALL_SCOPES));
	const res = await mcpPost(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
	const body = await rpcResult(res);
	if (!body.result) throw new Error(`no result: ${JSON.stringify(body).slice(0, 400)}`);
	return body.result as ToolResult;
}

export function errorCode(r: ToolResult): string | undefined {
	return r._meta?.["nourax/error"]?.code;
}

/** The framed JSON payload of a successful result. */
export function payload(r: ToolResult): Record<string, unknown> {
	return JSON.parse(framedPayload(r.content[0]?.text ?? "")) as Record<string, unknown>;
}

// biome-ignore lint/suspicious/noExplicitAny: JSON Schema walking
type Schema = Record<string, any>;

/** A tiny JSON Schema check for what zod publishes: types, required, enum, additionalProperties false. */
function check(s: Schema, v: unknown, at: string, problems: string[]): void {
	if (s.anyOf) {
		const ok = (s.anyOf as Schema[]).some((x) => {
			const p: string[] = [];
			check(x, v, at, p);
			return p.length === 0;
		});
		if (!ok) problems.push(`${at}: matches no anyOf branch`);
		return;
	}
	const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
	const actual = v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v;
	if (types.length && !types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
		problems.push(`${at}: ${actual} is not ${types.join("|")}`);
		return;
	}
	if (s.enum && !(s.enum as unknown[]).includes(v)) problems.push(`${at}: ${JSON.stringify(v)} not in enum`);
	if (actual === "object" && v !== null) {
		const o = v as Record<string, unknown>;
		const props = (s.properties ?? {}) as Record<string, Schema>;
		for (const r of (s.required ?? []) as string[]) if (!(r in o)) problems.push(`${at}.${r}: missing`);
		for (const [k, val] of Object.entries(o)) {
			if (props[k]) check(props[k] as Schema, val, `${at}.${k}`, problems);
			else if (s.additionalProperties === false) problems.push(`${at}.${k}: not in the output schema`);
		}
	}
	if (actual === "array" && s.items) (v as unknown[]).forEach((x, i) => check(s.items as Schema, x, `${at}[${i}]`, problems));
}

const OUTPUTS: Record<string, z.ZodType> = {
	sharing_find_people: sharingFindPeopleOutput,
	sharing_create_link: sharingCreateLinkOutput,
	sharing_share_with: sharingShareWithOutput,
	sharing_list: sharingListOutput,
	sharing_update: sharingUpdateOutput,
	sharing_delete: sharingDeleteOutput,
	contacts_search: contactsSearchOutput,
	contacts_get: contactsGetOutput,
	contacts_add: contactsAddOutput,
	contacts_update: contactsUpdateOutput,
};

export function expectOutputSchema(name: string, r: ToolResult): void {
	const out = OUTPUTS[name];
	if (!out) throw new Error(`${name} has no output schema`);
	const schema = z.toJSONSchema(out, { io: "output" }) as Schema;
	const problems: string[] = [];
	check(schema, r.structuredContent, name, problems);
	expect(problems).toEqual([]);
	expect(() => out.parse(r.structuredContent)).not.toThrow();
}

/**
 * DESIGN 10.4 as structuredContent carries it (fix round 3): the JSON (nulls kept) and the framed
 * text are each within one result, and the text is never cut short.
 */
export function expectBounded(r: ToolResult): void {
	expect(JSON.stringify(r.structuredContent).length).toBeLessThanOrEqual(LIMITS.resultChars);
	const text = r.content[0]?.text ?? "";
	expect(text.length).toBeLessThanOrEqual(LIMITS.resultChars);
	expect(text).not.toContain("[Cut short");
}

const N = ["next", "cloud"];
/** Brand rule 6 on everything a person could see. */
export function expectNoBrand(r: ToolResult): void {
	const text = JSON.stringify(r);
	expect(text).not.toMatch(new RegExp(`${N[0]}[ -]?${N[1]}`, "i"));
	expect(text).not.toMatch(/#0082c9|#00679e/i);
}
