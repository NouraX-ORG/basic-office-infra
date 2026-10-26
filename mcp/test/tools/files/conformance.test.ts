/**
 * Every lane A tool, as a real MCP client sees it (DESIGN 17.3): listed with the catalogue's
 * annotations and without an output schema (src/tools/files/define.ts), called through the MCP SDK
 * client, with structuredContent checked against the tool's shape in code exactly as zod would
 * publish it, framed (the same JSON is in the text block), within the result budget, and clean of
 * the upstream brand. Plus paging when a page is cut to fit the 60,000-character budget.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../../src/core/limits";
import { annotationsFor, catalogEntry } from "../../../src/mcp/catalog";
import { FILES_OUTPUTS } from "../../../src/tools/files/define";
import { tools } from "../../../src/tools/files/index";
import { framedPayload, QA, sdkClient } from "../../helpers/index";
import { assertShape, clean, LANE_A, outputJsonSchema, sc, setup, text } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("lane A tools as a client sees them", () => {
	it("builds exactly the 17 catalogue tools, in order, each with a result shape in code", () => {
		expect(tools.map((t) => t.name)).toEqual(LANE_A);
		for (const t of tools) {
			expect(catalogEntry(t.name)?.lane).toBe("A");
			expect(t.output, t.name).toBeUndefined();
			expect(FILES_OUTPUTS[t.name], t.name).toBeDefined();
			const schema = outputJsonSchema(t.name);
			expect(schema.type, t.name).toBe("object");
			expect(schema.additionalProperties, t.name).toBe(false);
			expect(clean({ content: [{ type: "text", text: JSON.stringify(schema) }] }), t.name).toBe(true);
		}
	});
	it("lists each with title, all four hints from the catalogue, its scope, and no output schema", async () => {
		const e = await setup();
		const client = await sdkClient(e.token);
		const listed = (await client.listTools()).tools.filter((t) => t.name.startsWith("files_") && t.name !== "files_read_text");
		expect(listed.map((t) => t.name)).toEqual(LANE_A);
		for (const t of listed) {
			const entry = catalogEntry(t.name);
			if (!entry) throw new Error(t.name);
			expect(t.annotations, t.name).toMatchObject(annotationsFor(entry));
			expect(t.title, t.name).toBeTruthy();
			expect(t.outputSchema, t.name).toBeUndefined();
			expect(t.inputSchema.additionalProperties, t.name).toBe(false);
			expect((t._meta as { securitySchemes: { scopes: string[] }[] }).securitySchemes[0]?.scopes).toEqual([entry.scope]);
			expect(clean({ content: [{ type: "text", text: JSON.stringify(t) }] }), t.name).toBe(true);
		}
		// Lane A's part of the own tools/list (DESIGN 10.8 caps the whole list at 60 KB): 17,870
		// characters after fix round 3, kept within 18 KB so the lane doesn't grow unnoticed.
		expect(JSON.stringify(listed).length).toBeLessThanOrEqual(18 * 1024);
		const destructive = listed.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
		expect(destructive).toEqual(["files_overwrite_file", "files_move", "files_rename", "files_move_to_trash", "files_restore_version", "files_set_favorite"]);
		// files_search's limit counts name matches; content matches come on top (fix round 1).
		const search = listed.find((t) => t.name === "files_search");
		const limit = (search?.inputSchema.properties as Record<string, { description?: string; maximum?: number }>).limit;
		expect(limit?.maximum).toBe(50);
		expect(limit?.description).toBe("Name matches per call; content matches add up to the same number again (25 at most).");
		await client.close();
	});
	it("every tool's result matches its shape through the SDK client, and the text block carries the same JSON", async () => {
		const e = await setup();
		const f = e.files;
		const n = f.write(QA.a, "/Work/report.txt", "kiwi report", { favorite: true });
		f.write(QA.a, "/Work/notes.md", "kiwi notes");
		f.mkdir(QA.a, "/Archive");
		const client = await sdkClient(e.token);
		await client.listTools();
		const run = async (name: string, args: Record<string, unknown>) => {
			const r = await client.callTool({ name, arguments: args });
			expect(r.isError, `${name}: ${JSON.stringify(r.content).slice(0, 300)}`).toBeFalsy();
			const t = (r.content as { type: string; text: string }[])[0]?.text ?? "";
			expect(t.length, name).toBeLessThanOrEqual(LIMITS.resultChars);
			expect(() => framedPayload(t), name).not.toThrow();
			expect(clean({ content: [{ type: "text", text: t }] }), name).toBe(true);
			await assertShape(name, r.structuredContent);
			// The framed JSON is the structuredContent with nulls left out (DESIGN 10.4).
			const framed = JSON.parse(framedPayload(t)) as Record<string, unknown>;
			const dropNulls = (v: unknown): unknown =>
				Array.isArray(v) ? v.map(dropNulls) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)])) : v;
			expect(dropNulls(framed), name).toEqual(dropNulls(r.structuredContent));
			return r.structuredContent as Record<string, unknown>;
		};
		await run("files_list_folder", { path: "/Work" });
		await run("files_search", { query: "kiwi" });
		await run("files_get_info", { path: "/Work/report.txt" });
		await run("files_create_file", { path: "/Work/new.txt", content: "hello" });
		const ow = await run("files_overwrite_file", { path: "/Work/report.txt", content: "v2", expected_etag: n.etag });
		await run("files_create_folder", { path: "/Work/Sub/Deeper" });
		await run("files_move", { path: "/Work/new.txt", to_folder: "/Archive" });
		await run("files_copy", { path: "/Work/notes.md", to_folder: "/Archive" });
		await run("files_rename", { path: "/Archive/notes.md", new_name: "notes-copy.md" });
		const tr = await run("files_move_to_trash", { path: "/Archive/notes-copy.md" });
		await run("files_list_trash", {});
		await run("files_restore_from_trash", { trash_item_id: tr.trash_item_id as string });
		await run("files_list_versions", { path: "/Work/report.txt" });
		await run("files_restore_version", (ow.undo as { arguments: Record<string, unknown> }).arguments);
		await run("files_list_favorites", {});
		await run("files_set_favorite", { path: "/Work/notes.md", favorite: true });
		await run("files_list_recent", {});
		await client.close();
	});
});

describe("results stay inside the 60,000-character budget and paging continues where a page was cut", () => {
	it("files_list_folder", async () => {
		const e = await setup();
		const long = "x".repeat(230);
		for (let i = 0; i < 150; i++) e.files.write(QA.a, `/Big/${String(i).padStart(3, "0")}-${long}.txt`, "1");
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const r = await e.call("files_list_folder", { path: "/Big", limit: 200, ...(cursor ? { cursor } : {}) });
			expect(text(r).length).toBeLessThanOrEqual(LIMITS.resultChars);
			const out = sc<{ items: { name: string }[]; next_cursor: string | null; total: number }>(r);
			expect(out.total).toBe(150);
			seen.push(...out.items.map((i) => i.name));
			cursor = out.next_cursor;
			pages++;
		} while (cursor && pages < 10);
		expect(pages).toBeGreaterThan(1);
		expect(seen).toHaveLength(150);
		expect(new Set(seen).size).toBe(150);
	});
	it("files_search, across both streams", async () => {
		const e = await setup();
		const long = "y".repeat(230);
		for (let i = 0; i < 50; i++) e.files.write(QA.a, `/S/${String(i).padStart(2, "0")}-kiwi-${long}.txt`, "plain");
		for (let i = 0; i < 25; i++) e.files.write(QA.a, `/T/${String(i).padStart(2, "0")}-${long}.md`, "has kiwi inside");
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const r = await e.call("files_search", { query: "kiwi", limit: 50, ...(cursor ? { cursor } : {}) });
			expect(text(r).length).toBeLessThanOrEqual(LIMITS.resultChars);
			const out = sc<{ items: { path: string; match: string }[]; next_cursor: string | null }>(r);
			seen.push(...out.items.map((i) => i.path));
			cursor = out.next_cursor;
			pages++;
		} while (cursor && pages < 12);
		expect(pages).toBeGreaterThan(1);
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen.filter((p) => p.startsWith("/S/"))).toHaveLength(50);
		expect(seen.filter((p) => p.startsWith("/T/"))).toHaveLength(25);
	});
});
