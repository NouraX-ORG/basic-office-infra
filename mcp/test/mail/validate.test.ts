/** Validation of provider tools (DESIGN 13.3) and the mock provider's contract basics. */
import { describe, expect, it } from "vitest";
import { annotationsOf, schemaOk, validateProviderTools } from "../../src/mail/validate";
import { badTools, createMockProvider, okTools } from "../../src/mail/mock-provider";

const OK_TOOLS = okTools();
const BAD_TOOLS = badTools();

describe("validateProviderTools", () => {
	it("keeps good tools as they are, sorted by name", () => {
		const v = validateProviderTools([...OK_TOOLS].reverse());
		expect(v.dropped).toEqual([]);
		expect(v.tools.map((t) => t.name)).toEqual([...OK_TOOLS].map((t) => t.name).sort());
		expect(v.tools.find((t) => t.name === "mail_get_message")?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
	});
	it("drops each bad tool with its own reason", () => {
		const v = validateProviderTools(BAD_TOOLS);
		const reasons = Object.fromEntries(v.dropped.map((d) => [d.name, d.reason]));
		expect(reasons).toMatchObject({
			Mail_Search: "bad_name",
			search_mail: "bad_name",
			"mail-search": "bad_name",
			mail_no_title: "no_title",
			mail_long_title: "long_title",
			mail_no_description: "no_description",
			mail_long_description: "long_description",
			mail_brand: "brand",
			mail_array_schema: "bad_input_schema",
			mail_remote_ref: "bad_input_schema",
			mail_huge_schema: "bad_input_schema",
			mail_bad_output: "bad_output_schema",
			mail_get_message: "duplicate",
			"": "not_object",
		});
		expect(v.tools.find((t) => t.name === "mail_create_draft")?.description).toBe("Control characters are stripped.");
	});
	it("fills missing or odd hints in the cautious direction", () => {
		const cautious = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
		expect(annotationsOf("mail_list", undefined)).toEqual(cautious);
		expect(annotationsOf("mail_list", { readOnlyHint: "yes", destructiveHint: 0 })).toEqual(cautious);
		expect(annotationsOf("mail_list", { readOnlyHint: true })).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true });
	});
	it("a tool whose name changes mail can't be read-only, and sending is always destructive", () => {
		const claimsRead = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
		expect(annotationsOf("mail_send_now", claimsRead)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
		// A read-only claim the name shows false: none of the provider's hints are trusted (fix round 4).
		expect(annotationsOf("mail_move_to_trash", claimsRead)).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
		expect(annotationsOf("mail_reply_all", { readOnlyHint: false, destructiveHint: false })).toMatchObject({ destructiveHint: true });
		expect(annotationsOf("mail_get_draft", claimsRead)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
	});
	it("read-only only for names that start with a reading verb and change nothing", () => {
		const claimsRead = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
		for (const name of ["mail_purge_folder", "mail_clear_inbox", "mail_discard_draft", "mail_snooze_thread", "mail_import_messages", "mail_unread_count", "mail_list_and_purge", "mail_get_and_archive", "mail_star_message"]) {
			expect(annotationsOf(name, claimsRead), name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
		}
		for (const name of ["mail_get_message", "mail_list_recent", "mail_search", "mail_read_thread", "mail_count_unread", "mail_find_contact", "mail_preview_draft", "mail_show_labels"]) {
			expect(annotationsOf(name, claimsRead), name).toEqual(claimsRead);
		}
	});
	it("sending, removing, moving and exposing are destructive whatever the provider says; reply and forward only as the first word", () => {
		const additive = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
		for (const name of ["mail_delete_draft", "mail_move", "mail_archive_thread", "mail_mark_spam", "mail_block_sender", "mail_empty_trash", "mail_create_and_send", "mail_forward_message", "mail_reply", "mail_share_thread", "mail_unsubscribe"]) {
			expect(annotationsOf(name, additive).destructiveHint, name).toBe(true);
		}
		// Making a draft (a reply or forward draft sends nothing) or saving a copy under a free name only
		// adds something new: the provider's hints stand.
		for (const name of ["mail_create_reply_draft", "mail_create_forward_draft", "mail_create_draft", "mail_save_attachment_to_drive"]) {
			expect(annotationsOf(name, additive), name).toEqual(additive);
		}
	});
	it("any other tool that isn't read-only changes existing data, so it is destructive (DESIGN 10.3 tier D; fix round 2)", () => {
		const additive = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
		for (const name of ["mail_mark_read", "mail_label", "mail_attach_drive_file", "mail_update_draft", "mail_set_signature", "mail_add_label", "mail_rename_folder", "mail_snooze_thread", "mail_draft_reply"]) {
			// Only destructiveHint changes; the provider's other hints are kept.
			expect(annotationsOf(name, additive), name).toEqual({ ...additive, destructiveHint: true });
		}
		// A provider's destructiveHint true is never lowered, not even for an additive first word.
		expect(annotationsOf("mail_create_rule", { ...additive, destructiveHint: true }).destructiveHint).toBe(true);
		// Read-only tools stay non-destructive.
		expect(annotationsOf("mail_list_labels", { readOnlyHint: true, destructiveHint: true, idempotentHint: true, openWorldHint: false }).destructiveHint).toBe(false);
	});
	it("NoMail's 18 published tools (contract v1, 2026-10-25): kept hints, except the three that change existing data", () => {
		// Names and hints only, from handoffs/2026-10-25-nomail-to-workspace-mcp-tools.json and NoMail's
		// supabase/functions/mcp-tools/tools.ts (read-only).
		const R = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
		const A = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
		const AI = { ...A, idempotentHint: true };
		const D = { ...A, destructiveHint: true };
		const DI = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
		// [name, what NoMail publishes, what we publish]
		const nomail: [string, typeof R, typeof R][] = [
			["mail_search", R, R],
			["mail_list_recent", R, R],
			["mail_list_drafts", R, R],
			["mail_list_folders", R, R],
			["mail_read_message", R, R],
			["mail_read_thread", R, R],
			["mail_list_identities", R, R],
			["mail_get_draft", R, R],
			["mail_create_draft", A, A],
			["mail_update_draft", DI, DI],
			["mail_create_reply_draft", A, A],
			["mail_create_forward_draft", A, A],
			["mail_send_draft", { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }],
			["mail_move", DI, DI],
			// Marking read, labelling and attaching to an existing draft change existing data.
			["mail_mark_read", AI, DI],
			["mail_label", AI, DI],
			["mail_attach_drive_file", A, D],
			["mail_save_attachment_to_drive", A, A],
		];
		for (const [name, published, ours] of nomail) expect(annotationsOf(name, published), name).toEqual(ours);
	});
	it("schemas: an object, at most 32 KB, local refs only, and compilable", () => {
		expect(schemaOk({ type: "object" })).toBe(true);
		expect(schemaOk({ type: "object", properties: { a: { $ref: "#/$defs/x" } }, $defs: { x: { type: "string" } } })).toBe(true);
		expect(schemaOk({ type: "object", properties: { a: { $ref: "other.json#/x" } } })).toBe(false);
		expect(schemaOk({ type: "object", $id: "https://example.invalid/s" })).toBe(false);
		expect(schemaOk({ type: "object", properties: { a: { $dynamicRef: "#x" } } })).toBe(false);
		expect(schemaOk({ type: "array" })).toBe(false);
		expect(schemaOk(null)).toBe(false);
		expect(schemaOk({ type: "object", description: "x".repeat(33 * 1024) })).toBe(false);
		let deep: Record<string, unknown> = { type: "object" };
		for (let i = 0; i < 40; i++) deep = { type: "object", properties: { a: deep } };
		expect(schemaOk(deep)).toBe(false);
	});
	it("keeps at most 29 (LIMITS.mailTools since fix round 3)", () => {
		const many = Array.from({ length: 35 }, (_, i) => ({ ...OK_TOOLS[4], name: `mail_t_${String(i).padStart(2, "0")}` }));
		const v = validateProviderTools(many);
		expect(v.tools).toHaveLength(29);
		expect(v.dropped.filter((d) => d.reason === "over_cap")).toHaveLength(6);
	});
	it("never keeps a list that isn't an array", () => {
		expect(validateProviderTools({ tools: OK_TOOLS }).tools).toEqual([]);
	});
});

describe("mock provider", () => {
	const mk = (path: string, init: RequestInit & { token?: string | null; key?: string | null } = {}) => {
		const h = new Headers(init.headers);
		if (init.token !== null) h.set("authorization", `Bearer ${init.token ?? "t"}`);
		if (init.key !== null) h.set("x-nourax-tools-key", init.key ?? "k");
		return new Request(`https://x.test/functions/v1/mcp-tools${path}`, { ...init, headers: h });
	};
	it("answers the contract shapes and checks both headers", async () => {
		const m = createMockProvider();
		const list = (await (await m.handle(mk("/v1/tools"))).json()) as { version: number; tools: unknown[] };
		expect(list.version).toBe(1);
		expect(list.tools).toHaveLength(6);
		expect((await m.handle(mk("/v1/tools", { token: null }))).status).toBe(401);
		expect((await m.handle(mk("/v1/tools", { token: "expired-1" }))).status).toBe(401);
		const noKey = await m.handle(mk("/v1/tools", { key: null }));
		expect(noKey.status).toBe(403);
		expect(await noKey.json()).toEqual({ code: "TOOLS_KEY_INVALID" });
		const call = await m.handle(mk("/v1/call", { method: "POST", body: JSON.stringify({ name: "mail_send_draft", arguments: { draft_id: "d1" } }) }));
		expect(await call.json()).toEqual({ content: [{ type: "text", text: "Draft d1 was sent." }], isError: false });
		expect((await m.handle(mk("/s/status-429/v1/call", { method: "POST", body: "{}" }))).headers.get("retry-after")).toBe("7");
		expect((await m.handle(mk("/v1/call", { method: "POST", body: JSON.stringify({ name: "mail_nope" }) }))).status).toBe(404);
		expect(m.requests.at(-1)?.scenario).toBe("ok");
	});
});
