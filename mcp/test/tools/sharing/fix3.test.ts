/**
 * Lane B fix round 3, sharing side (DESIGN 17.3):
 * - sharing_update with can_delete or can_reshare alone keeps every other bit of a share made
 *   elsewhere (bits 5 and 3), and its undo gives those bits back;
 * - every answer is bounded as structuredContent carries it: a share note of a million characters
 *   is shown cut short, and sharing_list pages through shares that are large together without
 *   ever repeating or stalling;
 * - pageWindow always moves on, even past an item too large on its own;
 * - names from the sharee search are cut to the server's own column size.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../../src/core/limits";
import { fitJson, jsonLength, pageWindow, shown } from "../../../src/tools/sharing/bounded";
import { BIT, peopleTarget, SHOWN_CHARS } from "../../../src/tools/sharing/shares";
import type { FakeShare } from "../../fake-nc/sharing";
import { QA } from "../../helpers/index";
import { callTool, errorCode, expectBounded, expectNoBrand, expectOutputSchema, tokenFor } from "./_call";
import { callsTo, type World, world } from "./setup";

let w: World;
beforeEach(() => {
	w = world();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const nowSec = () => Math.floor(Date.now() / 1000);

/** A share QA a made with QA b in the web page (custom permissions), straight into the fake. */
function made(id: number, extra: Partial<FakeShare>): FakeShare {
	const s: FakeShare = {
		id,
		share_type: 0,
		uid_owner: QA.a,
		path: "/Projects",
		item_type: "folder",
		file_source: 1,
		share_with: QA.b,
		permissions: 1,
		expiration: null,
		token: null,
		password: null,
		hide_download: false,
		label: "",
		note: "",
		stime: nowSec() - 3600,
		mail_send: false,
		...extra,
	};
	w.sh.shares.push(s);
	return s;
}

const bitsOf = (id: number) => w.sh.shares.find((s) => s.id === id)?.permissions;
const lastPut = () => JSON.parse(callsTo(w.fake, "PUT", /\/shares\/\d+$/).pop()?.body ?? "{}") as Record<string, unknown>;

describe("sharing_update changes only the rights asked for (fix round 3)", () => {
	it("bits 5 (read and create) with only can_reshare become 21, not 17; the undo gives 5 back", async () => {
		made(901, { permissions: BIT.read | BIT.create });
		const r = await callTool("sharing_update", { share_id: "901", can_reshare: true });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		expectOutputSchema("sharing_update", r);
		expect(lastPut()).toEqual({ permissions: 21 });
		expect(bitsOf(901)).toBe(21);
		expect(r.structuredContent.share).toMatchObject({ permission: "view_and_upload", can_reshare: true, can_delete: false });
		expect(r.structuredContent.undo).toEqual({ tool: "sharing_update", arguments: { share_id: "901", can_reshare: false } });
		expect(r.structuredContent.warnings ?? []).toEqual([]);
		const u = await callTool("sharing_update", r.structuredContent.undo.arguments);
		expect(u.isError, u.content[0]?.text).toBeFalsy();
		expect(bitsOf(901)).toBe(5);
	});

	it("bits 3 (read and update) with only can_reshare become 19: create is never added", async () => {
		made(902, { permissions: BIT.read | BIT.update });
		const r = await callTool("sharing_update", { share_id: "902", can_reshare: true });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		expect(lastPut()).toEqual({ permissions: 19 });
		expect((bitsOf(902) ?? BIT.create) & BIT.create).toBe(0);
		expect(r.structuredContent.undo.arguments).toEqual({ share_id: "902", can_reshare: false });
		await callTool("sharing_update", r.structuredContent.undo.arguments);
		expect(bitsOf(902)).toBe(3);
	});

	it("with only can_delete: bits 5 become 13 and bits 3 become 11; clearing it gives them back", async () => {
		made(903, { permissions: 5 });
		made(904, { permissions: 3 });
		const a = await callTool("sharing_update", { share_id: "903", can_delete: true });
		expect(lastPut()).toEqual({ permissions: 13 });
		const b = await callTool("sharing_update", { share_id: "904", can_delete: true });
		expect(lastPut()).toEqual({ permissions: 11 });
		expect(a.structuredContent.undo.arguments).toEqual({ share_id: "903", can_delete: false });
		expect(b.structuredContent.undo.arguments).toEqual({ share_id: "904", can_delete: false });
		await callTool("sharing_update", a.structuredContent.undo.arguments);
		await callTool("sharing_update", b.structuredContent.undo.arguments);
		expect([bitsOf(903), bitsOf(904)]).toEqual([5, 3]);
	});

	it("clears a right that is set and keeps the rest: bits 31 without can_reshare become 15", async () => {
		made(905, { permissions: 31 });
		const r = await callTool("sharing_update", { share_id: "905", can_reshare: false, can_delete: true });
		expect(lastPut()).toEqual({ permissions: 15 });
		expect(r.structuredContent.undo.arguments).toEqual({ share_id: "905", can_delete: true, can_reshare: true });
	});

	it("on a single file, can_delete alone changes nothing and says why; with can_reshare only 16 is set", async () => {
		made(906, { path: "/report.pdf", item_type: "file", permissions: 3 });
		w.fake.requests.length = 0;
		const none = await callTool("sharing_update", { share_id: "906", can_delete: true });
		expect(errorCode(none)).toBe("invalid_input");
		expect(none.content[0]?.text).toBe("Nothing to change: the share already has those values. can_delete applies only to folders; a single file can't be deleted through a share.");
		expect(callsTo(w.fake, "PUT", /\/shares\/\d+$/)).toHaveLength(0);
		const r = await callTool("sharing_update", { share_id: "906", can_delete: true, can_reshare: true });
		expect(lastPut()).toEqual({ permissions: 19 });
		expect(r.structuredContent.warnings).toContain("can_delete applies only to folders; a single file can't be deleted through a share.");
	});

	it("with permission given, sets that level (and says when its undo couldn't be exact)", async () => {
		made(907, { permissions: 5 });
		const r = await callTool("sharing_update", { share_id: "907", permission: "edit" });
		expect(lastPut()).toEqual({ permissions: 7 });
		expect(r.structuredContent.undo).toBeNull();
		expect(r.structuredContent.warnings).toContain("This change can't be undone automatically.");
		// A level the tools name gives an exact undo: view and reshare (17) to edit and back.
		made(908, { permissions: 17 });
		const e = await callTool("sharing_update", { share_id: "908", permission: "edit" });
		expect(lastPut()).toEqual({ permissions: 23 });
		expect(e.structuredContent.undo.arguments).toEqual({ share_id: "908", permission: "view", can_delete: false, can_reshare: true });
		await callTool("sharing_update", e.structuredContent.undo.arguments);
		expect(bitsOf(908)).toBe(17);
	});

	it("peopleTarget: flags alone keep every other bit; a level is built again", () => {
		for (const bits of [1, 3, 5, 7, 9, 13, 15, 17, 19, 21, 23, 31]) {
			for (const folder of [true, false]) {
				for (const can_reshare of [true, false]) {
					const next = peopleTarget(bits, { can_reshare }, folder);
					expect(next & ~BIT.share).toBe(bits & ~BIT.share);
					expect((next & BIT.share) !== 0).toBe(can_reshare);
				}
				const del = peopleTarget(bits, { can_delete: true }, folder);
				expect(del & ~BIT.delete).toBe(bits & ~BIT.delete);
				expect((del & BIT.delete) !== 0).toBe(folder || (bits & BIT.delete) !== 0);
			}
		}
		expect(peopleTarget(5, { permission: "edit" }, true)).toBe(7);
		expect(peopleTarget(21, { permission: "view" }, true)).toBe(17);
		expect(peopleTarget(13, { permission: "view", can_delete: false }, true)).toBe(1);
	});
});

describe("answers are bounded as structuredContent carries them (fix round 3)", () => {
	it("a share someone made with a million-character note is shown with the note cut short", async () => {
		made(910, { note: `"${"n".repeat(1_000_000)}` });
		const token = await tokenFor();
		const l = await callTool("sharing_list", { which: "mine" }, { token });
		expect(l.isError, l.content[0]?.text).toBeFalsy();
		expectOutputSchema("sharing_list", l);
		expectBounded(l);
		const s = (l.structuredContent.shares as { share_id: string; note: string; note_truncated: boolean }[])[0];
		expect(s?.share_id).toBe("910");
		expect(s?.note.length).toBe(LIMITS.notesOutChars);
		expect(s?.note.endsWith(String.fromCharCode(0x2026))).toBe(true);
		expect(s?.note_truncated).toBe(true);
		// The single-share tools too, and the undo still uses the server's own note (too long: none).
		const d = await callTool("sharing_delete", { share_id: "910" }, { token });
		expectBounded(d);
		expect(d.structuredContent.undo).toBeNull();
	});

	it("pages through shares that are too large together, never repeating, stalling or cutting the text", async () => {
		for (let i = 0; i < 40; i++) made(920 + i, { note: `${'"\\'.repeat(5_000)}${i}`, stime: nowSec() - 1000 + i, path: `/Projects/${"p".repeat(200)}${i}` });
		const token = await tokenFor();
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		for (;;) {
			const r = await callTool("sharing_list", { which: "mine", limit: 200, ...(cursor ? { cursor } : {}) }, { token });
			expect(r.isError, r.content[0]?.text).toBeFalsy();
			expectOutputSchema("sharing_list", r);
			expectBounded(r);
			const ids = (r.structuredContent.shares as { share_id: string }[]).map((s) => s.share_id);
			expect(ids.length).toBeGreaterThan(0);
			seen.push(...ids);
			pages++;
			if (!r.structuredContent.has_more) break;
			cursor = r.structuredContent.next_cursor as string;
			expect(pages).toBeLessThan(40);
		}
		expect(pages).toBeGreaterThan(1);
		expect(new Set(seen).size).toBe(40);
		expect(seen).toHaveLength(40);
	});

	it("cuts names from the sharee search to the server's column size", async () => {
		w.fake.addUser({ uid: "qa-t1-95", password: "FAKEAPPPASS-qa-t1-95-0123456789abcdef", displayName: `Long ${"L".repeat(2_000)}`, email: "l@example.invalid" });
		w.sh.addGroup("org:acme", "Acme", [QA.a, QA.b, "qa-t1-95"]);
		const r = await callTool("sharing_find_people", { query: "Long", kinds: ["person"] });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		expectOutputSchema("sharing_find_people", r);
		expectNoBrand(r);
		// Core's sharee search already cuts names to 200 characters; lane B's own cap (the server's
		// 255) is the second guard, for every share view too.
		const hit = (r.structuredContent.results as { display_name: string }[])[0];
		expect(hit?.display_name.length).toBeGreaterThan(100);
		expect(hit?.display_name.length).toBeLessThanOrEqual(SHOWN_CHARS.name);
	});
});

describe("bounded helpers (fix round 3)", () => {
	it("shown drops control characters, keeps line breaks only where asked, and cuts with one ellipsis", () => {
		const bell = String.fromCharCode(7);
		const lineSep = String.fromCharCode(0x2028);
		expect(shown(`a${bell}b\tc\r\nd`, 100)).toEqual({ text: "ab c d", cut: false });
		expect(shown(`a${lineSep}b\nc`, 100, true)).toEqual({ text: "a\nb\nc", cut: false });
		const cut = shown("x".repeat(50), 10);
		expect(cut).toEqual({ text: `${"x".repeat(9)}${String.fromCharCode(0x2026)}`, cut: true });
		// A surrogate pair is never split, and a lone surrogate becomes U+FFFD (so JSON stays short).
		const emoji = String.fromCodePoint(0x1f600);
		const pairs = shown(emoji.repeat(10), 6);
		expect(pairs.text.length).toBeLessThanOrEqual(6);
		expect(pairs.text.toWellFormed()).toBe(pairs.text);
		expect(shown(String.fromCharCode(0xd800), 5).text).toBe(String.fromCharCode(0xfffd));
	});

	it("fitJson measures with nulls kept, and pageWindow moves past an item too large on its own", () => {
		const items = [{ a: null }, { a: null }, { a: null }];
		// Three null fields: compact JSON would drop them; structuredContent keeps them.
		expect(fitJson(items, (xs) => ({ xs }), jsonLength({ xs: items.slice(0, 2) }))).toHaveLength(2);
		const big = { t: "x".repeat(1_000) };
		const small = { t: "y" };
		const render = (xs: unknown[]) => ({ items: xs });
		const first = pageWindow([big, small, small], 0, 10, render, 200);
		expect(first).toEqual({ items: [], next: 1, skipped: 1 });
		const second = pageWindow([big, small, small], first.next, 10, render, 200);
		expect(second).toEqual({ items: [small, small], next: 3, skipped: 0 });
		expect(pageWindow([small], 1, 10, render, 200)).toEqual({ items: [], next: 1, skipped: 0 });
	});
});
