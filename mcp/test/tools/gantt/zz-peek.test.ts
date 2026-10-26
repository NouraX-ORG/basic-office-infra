/**
 * Lane G input schemas as MCP clients see them (zod's "input" mode, which the SDK publishes):
 * every object, nested ones included, stays strict (additionalProperties false), because zod drops
 * that in input mode unless the object is .strict(). Checked for all 15 gantt tools.
 */
import { expect, it } from "vitest";
import { z } from "zod";
import { tools } from "../../../src/tools/gantt/index";

type S = { type?: string | string[]; properties?: Record<string, S>; items?: S; anyOf?: S[]; additionalProperties?: unknown };

function objects(s: S, where: string, out: string[]): void {
	for (const x of s.anyOf ?? []) objects(x, where, out);
	const t = Array.isArray(s.type) ? s.type : [s.type];
	if (t.includes("object") || s.properties) {
		if (s.additionalProperties !== false) out.push(where);
		for (const [k, v] of Object.entries(s.properties ?? {})) objects(v, `${where}.${k}`, out);
	}
	if (s.items) objects(s.items, `${where}[]`, out);
}

it("every input object of every gantt tool is strict in input mode", () => {
	const loose: string[] = [];
	for (const t of tools) objects(z.toJSONSchema(t.input, { io: "input" }) as S, t.name, loose);
	expect(loose).toEqual([]);
});
