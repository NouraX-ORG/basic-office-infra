/**
 * Lane B's share of tools/list (DESIGN 10.8: every own tool together at most 60 KB). Lane B keeps
 * its ten tools under 18 KB, with no published output schemas (the same JSON is in the framed text
 * block, and the tests hold each result to its schema), and checks the description rules here too.
 */
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { LIMITS } from "../../../src/core/limits";
import { toolDef } from "../../../src/tools/registry";
import { devToken, fakeWithQa, mcpPost, QA, rpcResult } from "../../helpers/index";
import { ALL_SCOPES } from "./_call";

const LANE_B = ["sharing_find_people", "sharing_create_link", "sharing_share_with", "sharing_list", "sharing_update", "sharing_delete", "contacts_search", "contacts_get", "contacts_add", "contacts_update"];

afterEach(() => vi.restoreAllMocks());

it("lane B's tools stay under 18 KB of tools/list, without output schemas", async () => {
	fakeWithQa();
	const t = await devToken(QA.a, { scopes: ALL_SCOPES });
	const body = await rpcResult(await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
	const tools = (body.result as { tools: Record<string, unknown>[] }).tools.filter((x) => LANE_B.includes(String(x.name)));
	expect(tools.map((x) => x.name)).toEqual(LANE_B);
	for (const x of tools) expect(x.outputSchema, String(x.name)).toBeUndefined();
	expect(JSON.stringify(tools).length).toBeLessThanOrEqual(18 * 1024);
});

it("every input property has a short description, every string a maximum and every number bounds", () => {
	const problems: string[] = [];
	// biome-ignore lint/suspicious/noExplicitAny: JSON Schema walking
	const walk = (s: any, at: string) => {
		for (const x of [...(s.anyOf ?? []), ...(s.oneOf ?? [])]) walk(x, at);
		const types = Array.isArray(s.type) ? s.type : [s.type];
		if (types.includes("string") && s.enum === undefined && s.maxLength === undefined) problems.push(`${at}: string without maxLength`);
		if ((types.includes("number") || types.includes("integer")) && (s.minimum === undefined || s.maximum === undefined)) problems.push(`${at}: number without bounds`);
		for (const [k, v] of Object.entries(s.properties ?? {})) {
			// biome-ignore lint/suspicious/noExplicitAny: JSON Schema walking
			const d = (v as any).description as string | undefined;
			if (!d) problems.push(`${at}.${k}: no description`);
			else if (d.length > LIMITS.propertyDescriptionChars) problems.push(`${at}.${k}: description too long`);
			walk(v, `${at}.${k}`);
		}
		if (s.items) walk(s.items, `${at}[]`);
	};
	for (const name of LANE_B) {
		const def = toolDef(name);
		if (!def) throw new Error(`${name} is not registered`);
		expect(def.description.length, name).toBeLessThanOrEqual(LIMITS.descriptionChars);
		expect(def.description, name).not.toMatch(/\b(you must|always call|never call|you should)\b/i);
		walk(z.toJSONSchema(def.input, { io: "input" }), name);
	}
	expect(problems).toEqual([]);
});
