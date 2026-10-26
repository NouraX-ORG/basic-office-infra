/** Contract tests: sharing_share_with, sharing_list, sharing_update and sharing_delete (DESIGN 17.3). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_UNDO, UNDO_CHECK_GRACE_MS } from "../../../src/tools/sharing/delete";
import { ocs } from "../../fake-nc/index";
import type { FakeShare } from "../../fake-nc/sharing";
import { QA } from "../../helpers/index";
import { callTool, errorCode, expectNoBrand, expectOutputSchema, tokenFor } from "./_call";
import { C, callsTo, daysFromToday, type World, world } from "./setup";

let w: World;
beforeEach(() => {
	w = world();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function link(path = "/Projects", extra: Record<string, unknown> = {}): Promise<string> {
	const r = await callTool("sharing_create_link", { path, allow_duplicate: true, ...extra });
	if (r.isError) throw new Error(r.content[0]?.text);
	return r.structuredContent.share_id as string;
}

async function shareWith(args: Record<string, unknown>): Promise<string> {
	const r = await callTool("sharing_share_with", args);
	if (r.isError) throw new Error(r.content[0]?.text);
	return r.structuredContent.share_id as string;
}

describe("sharing_share_with", () => {
	it("re-checks the person with a fresh search, then shares view-only without mail", async () => {
		w.fake.requests.length = 0;
		const r = await callTool("sharing_share_with", { path: "/Projects/plan.docx", share_with: `person:${QA.b}` });
		expect(r.isError).toBeFalsy();
		expectOutputSchema("sharing_share_with", r);
		expectNoBrand(r);
		const search = callsTo(w.fake, "GET", /\/sharees$/).pop();
		expect(search?.url.searchParams.get("search")).toBe(QA.b);
		expect(search?.url.searchParams.getAll("shareType[]")).toEqual(["0"]);
		const post = callsTo(w.fake, "POST", /\/shares$/).pop();
		expect(JSON.parse(post?.body ?? "{}")).toEqual({ path: "/Projects/plan.docx", shareType: 0, shareWith: QA.b, permissions: 1, sendMail: "false" });
		expect(r.structuredContent).toMatchObject({
			path: "/Projects/plan.docx",
			type: "file",
			shared_with: { id: `person:${QA.b}`, kind: "person", display_name: "QA t1 92" },
			permission: "view",
			can_delete: false,
			can_reshare: false,
			expires_on: null,
		});
		expect(r.structuredContent.undo).toEqual({ tool: "sharing_delete", arguments: { share_id: r.structuredContent.share_id } });
		// The search comes before the share.
		const order = w.fake.driveCalls().map((c) => `${c.method} ${c.url.pathname.split("/").pop()}`);
		expect(order.indexOf("GET sharees")).toBeLessThan(order.indexOf("POST shares"));
	});

	it("shares a folder with a team (its group) for editing, deleting and resharing", async () => {
		const r = await callTool("sharing_share_with", {
			path: "/Projects",
			share_with: "group:team:sales",
			permission: "edit",
			can_delete: true,
			can_reshare: true,
			expires_on: daysFromToday(10),
			note: "For the\u0007 Q4 plan",
		});
		expect(r.isError).toBeFalsy();
		const s = w.sh.shares.at(-1);
		expect(s).toMatchObject({ share_type: 1, share_with: "team:sales", permissions: 31, expiration: daysFromToday(10), note: "For the Q4 plan" });
		expect(r.structuredContent.shared_with).toEqual({ id: "group:team:sales", kind: "team", display_name: "Team: Sales" });
		expect(r.structuredContent).toMatchObject({ permission: "edit", can_delete: true, can_reshare: true });
	});

	it("never shares with someone of another organisation: the fresh search refuses before any share is made", async () => {
		w.fake.requests.length = 0;
		const r = await callTool("sharing_share_with", { path: "/Projects", share_with: `person:${C}` });
		expect(errorCode(r)).toBe("not_found");
		expect(r.content[0]?.text).toMatch(/own organisation and teams/);
		expect(callsTo(w.fake, "POST", /\/shares$/)).toHaveLength(0);
		const g = await callTool("sharing_share_with", { path: "/Projects", share_with: "group:org:other" });
		expect(errorCode(g)).toBe("not_found");
		const admin = await callTool("sharing_share_with", { path: "/Projects", share_with: "group:admin" });
		expect(errorCode(admin)).toBe("not_found");
		expect(callsTo(w.fake, "POST", /\/shares$/)).toHaveLength(0);
	});

	it("refuses bad ids, the person themself and the top folder locally", async () => {
		w.fake.requests.length = 0;
		expect(errorCode(await callTool("sharing_share_with", { path: "/Projects", share_with: "bob" }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_share_with", { path: "/Projects", share_with: "person:a/b" }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_share_with", { path: "/Projects", share_with: `person:${QA.a}` }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_share_with", { path: "/", share_with: `person:${QA.b}` }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_share_with", { path: "/Projects", share_with: `person:${QA.b}`, expires_on: daysFromToday(0) }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_share_with", { path: "/Projects", share_with: `person:${QA.b}`, permission: "upload_only" }))).toBe("invalid_input");
		expect(callsTo(w.fake, "POST", /\/shares$/)).toHaveLength(0);
	});

	it("says plainly when the item is already shared with them, instead of handing back the old share", async () => {
		const id = await shareWith({ path: "/Projects", share_with: `person:${QA.b}` });
		w.fake.requests.length = 0;
		const r = await callTool("sharing_share_with", { path: "/Projects", share_with: `person:${QA.b}`, permission: "edit" });
		expect(errorCode(r)).toBe("already_exists");
		expect(r.content[0]?.text).toBe(`/Projects is already shared with them (share_id ${id}). sharing_update changes that share.`);
		expect(callsTo(w.fake, "POST", /\/shares$/)).toHaveLength(0);
		expect(callsTo(w.fake, "GET", /\/shares$/).pop()?.url.searchParams.get("path")).toBe("/Projects");
		expect(w.sh.shares.find((s) => String(s.id) === id)?.permissions).toBe(1);
	});

	it("says when someone else's share already gives them access, without pointing at sharing_update", async () => {
		const json = (data: unknown) => new Response(JSON.stringify({ ocs: { meta: { status: "ok", statuscode: 200, message: "OK" }, data } }), { headers: { "content-type": "application/json" } });
		w.fake.on("GET", /\/shares$/, () => json([{ id: "321", share_type: 0, uid_owner: C, share_with: QA.b, permissions: 1, path: "/Projects", item_type: "folder" }]));
		w.fake.requests.length = 0;
		const r = await callTool("sharing_share_with", { path: "/Projects", share_with: `person:${QA.b}` });
		expect(errorCode(r)).toBe("already_exists");
		expect(r.content[0]?.text).toBe("They already have access to /Projects through a share someone else made (share_id 321).");
		expect(callsTo(w.fake, "POST", /\/shares$/)).toHaveLength(0);
	});

	it("notices when the server hands back an existing share instead of making one", async () => {
		// The look-ahead sees nothing (the other share appeared a moment later), and the server answers
		// with a share someone else made (as NC 35 does for access through an existing share).
		const json = (data: unknown) => new Response(JSON.stringify({ ocs: { meta: { status: "ok", statuscode: 200, message: "OK" }, data } }), { headers: { "content-type": "application/json" } });
		w.fake.on("GET", /\/shares$/, () => json([]));
		w.fake.on("POST", /\/shares$/, () =>
			json({ id: "777", share_type: 1, uid_owner: QA.b, share_with: "team:sales", permissions: 1, path: "/Projects", item_type: "folder", stime: 1, file_source: 5 }),
		);
		const r = await callTool("sharing_share_with", { path: "/Projects", share_with: "group:team:sales", permission: "edit" });
		expect(errorCode(r)).toBe("already_exists");
		expect(r.content[0]?.text).toBe("They already have access to /Projects through share 777; nothing new was made. sharing_list shows it.");
		expect(r._meta?.["nourax/error"]).toBeTruthy();
		expect(r.structuredContent).toBeUndefined();
	});

	it("keeps can_delete off a single file and says so", async () => {
		const r = await callTool("sharing_share_with", { path: "/report.pdf", share_with: "group:org:acme", permission: "edit", can_delete: true });
		expect(w.sh.shares.at(-1)?.permissions).toBe(3);
		expect(r.structuredContent.warnings).toContain("can_delete applies only to folders; a single file can't be deleted through a share.");
	});

	it("treats Teams-app teams as unavailable while that app is off", async () => {
		const r = await callTool("sharing_share_with", { path: "/Projects", share_with: "team:abcdef" });
		expect(errorCode(r)).toBe("not_found");
	});
});

describe("sharing_list", () => {
	it("lists the person's own shares newest first, with links, people and teams", async () => {
		const l = await link("/Projects", { password: "a-long-password-1" });
		const p = await shareWith({ path: "/report.pdf", share_with: `person:${QA.b}` });
		const t = await shareWith({ path: "/Projects", share_with: "group:team:sales", permission: "edit" });
		w.fake.requests.length = 0;
		const r = await callTool("sharing_list", { which: "mine" });
		expect(r.isError).toBeFalsy();
		expectOutputSchema("sharing_list", r);
		expectNoBrand(r);
		const get = callsTo(w.fake, "GET", /\/shares$/).pop();
		expect([...(get?.url.searchParams.keys() ?? [])]).toEqual(["format"]);
		const shares = r.structuredContent.shares as Record<string, unknown>[];
		expect(shares.map((s) => s.share_id)).toEqual([t, p, l]);
		expect(shares[2]).toMatchObject({ kind: "link", permission: "view", password_protected: true, mine: true, shared_with: null, path: "/Projects", type: "folder" });
		expect(String(shares[2]?.url)).toMatch(/^https:\/\/drive\.nourax\.org\/s\//);
		expect(shares[1]).toMatchObject({ kind: "person", shared_with: { id: `person:${QA.b}`, display_name: "QA t1 92" }, url: null });
		expect(shares[0]).toMatchObject({ kind: "team", permission: "edit", shared_with: { id: "group:team:sales" } });
		expect(shares[0]?.web_url).toMatch(/^https:\/\/drive\.nourax\.org\/f\/\d+$/);
		expect(shares[0]?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
		expect(r.structuredContent.total).toBe(3);
	});

	it("lists what others shared with the person, from their side", async () => {
		await shareWith({ path: "/Projects/plan.docx", share_with: `person:${QA.b}`, permission: "edit" });
		w.fake.requests.length = 0;
		const r = await callTool("sharing_list", { which: "with_me" }, { uid: QA.b });
		expect(callsTo(w.fake, "GET", /\/shares$/).pop()?.url.searchParams.get("shared_with_me")).toBe("true");
		const s = (r.structuredContent.shares as Record<string, unknown>[])[0];
		expect(s).toMatchObject({ kind: "person", path: "/plan.docx", mine: false, owner: { id: `person:${QA.a}`, display_name: "QA t1 91" }, permission: "edit" });
	});

	it("lists the shares on one item, and needs path only for that", async () => {
		await link("/Projects");
		await link("/report.pdf");
		w.fake.requests.length = 0;
		const r = await callTool("sharing_list", { which: "path", path: "Projects/" });
		expect(callsTo(w.fake, "GET", /\/shares$/).pop()?.url.searchParams.get("path")).toBe("/Projects");
		expect(callsTo(w.fake, "GET", /\/shares$/).pop()?.url.searchParams.get("reshares")).toBe("true");
		expect((r.structuredContent.shares as unknown[]).length).toBe(1);
		expect(errorCode(await callTool("sharing_list", { which: "path" }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_list", { which: "mine", path: "/Projects" }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_list", { which: "path", path: "/Missing" }))).toBe("not_found");
		expect(errorCode(await callTool("sharing_list", { which: "path", path: "/a/../b" }))).toBe("invalid_input");
	});

	it("sorts newest first by the share time, also in the hour that repeats when the clocks go back (fix round 2)", async () => {
		const u = w.fake.users.get(QA.a);
		if (u) u.timezone = "Europe/London";
		const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
		const base = { share_type: 3, uid_owner: QA.a, path: "/Projects", item_type: "folder" as const, file_source: 1, share_with: null, permissions: 1, expiration: null, password: null, hide_download: false, label: "", note: "", mail_send: false };
		// 2026-10-25 in London: 00:30 UTC is 01:30 summer time, 01:10 UTC is 01:10 winter time.
		w.sh.shares.push({ ...base, id: 950, token: "tok950abcdefghij", stime: at("2026-10-25T00:30:00Z") });
		w.sh.shares.push({ ...base, id: 951, token: "tok951abcdefghij", stime: at("2026-10-25T01:10:00Z") });
		w.sh.shares.push({ ...base, id: 949, token: "tok949abcdefghij", stime: at("2026-10-25T00:59:00Z") });
		// Same second: the higher id first.
		w.sh.shares.push({ ...base, id: 948, token: "tok948abcdefghij", stime: at("2026-10-25T00:59:00Z") });
		const r = await callTool("sharing_list", { which: "mine" });
		expect(r.isError).toBeFalsy();
		const shares = r.structuredContent.shares as { share_id: string; created_at: string }[];
		expect(shares.map((s) => s.share_id)).toEqual(["951", "949", "948", "950"]);
		expect(shares.map((s) => s.created_at)).toEqual(["2026-10-25T01:10:00+00:00", "2026-10-25T01:59:00+01:00", "2026-10-25T01:59:00+01:00", "2026-10-25T01:30:00+01:00"]);
	});

	it("pages with a cursor bound to its arguments", async () => {
		for (let i = 0; i < 5; i++) w.sh.shares.push({ id: 900 + i, share_type: 3, uid_owner: QA.a, path: "/Projects", item_type: "folder", file_source: 1, share_with: null, permissions: 1, expiration: null, token: `t${i}`, password: null, hide_download: false, label: `L${i}`, note: "", stime: 1761400000 + i, mail_send: false });
		const token = await tokenFor();
		const a = await callTool("sharing_list", { which: "mine", limit: 2 }, { token });
		expect(a.structuredContent.has_more).toBe(true);
		expect((a.structuredContent.shares as { share_id: string }[]).map((s) => s.share_id)).toEqual(["904", "903"]);
		const b = await callTool("sharing_list", { which: "mine", limit: 2, cursor: a.structuredContent.next_cursor }, { token });
		expect((b.structuredContent.shares as { share_id: string }[]).map((s) => s.share_id)).toEqual(["902", "901"]);
		const c = await callTool("sharing_list", { which: "mine", limit: 2, cursor: b.structuredContent.next_cursor }, { token });
		expect(c.structuredContent).toMatchObject({ has_more: false, next_cursor: null });
		const bad = await callTool("sharing_list", { which: "with_me", limit: 2, cursor: a.structuredContent.next_cursor }, { token });
		expect(errorCode(bad)).toBe("invalid_input");
		expect(bad.content[0]?.text).toMatch(/different search/);
	});
});

describe("sharing_update", () => {
	it("changes a link's access, expiry, label and download button, with an exact undo", async () => {
		const id = await link("/Projects", { expires_in_days: 5, label: "old" });
		w.fake.requests.length = 0;
		const r = await callTool("sharing_update", { share_id: id, permission: "edit", expires_on: daysFromToday(20), label: "new", hide_download: true, note: "hi" });
		expect(r.isError).toBeFalsy();
		expectOutputSchema("sharing_update", r);
		const get = callsTo(w.fake, "GET", /\/shares\/\d+$/);
		const put = callsTo(w.fake, "PUT", /\/shares\/\d+$/).pop();
		expect(get).toHaveLength(1);
		expect(JSON.parse(put?.body ?? "{}")).toEqual({ permissions: 7, expireDate: daysFromToday(20), label: "new", hideDownload: "true", note: "hi" });
		expect(r.structuredContent.changed).toEqual(["permission", "expires_on", "hide_download", "label", "note"]);
		expect(r.structuredContent.share).toMatchObject({ permission: "edit", expires_on: daysFromToday(20), label: "new", hide_download: true });
		expect(r.structuredContent.undo).toEqual({ tool: "sharing_update", arguments: { share_id: id, permission: "view", expires_on: daysFromToday(5), hide_download: false, label: "old", note: "" } });
		// Applying the undo puts the link back.
		const u = await callTool("sharing_update", r.structuredContent.undo.arguments);
		expect(u.isError).toBeFalsy();
		expect(w.sh.shares.find((s) => String(s.id) === id)).toMatchObject({ permissions: 1, expiration: daysFromToday(5), label: "old", hide_download: false, note: "" });
	});

	it("keeps an expiry on links, within the limit, and passwords only on links", async () => {
		const id = await link("/report.pdf");
		w.fake.requests.length = 0;
		expect(errorCode(await callTool("sharing_update", { share_id: id, expires_on: null }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_update", { share_id: id, expires_on: daysFromToday(120) }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_update", { share_id: id, can_delete: true }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_update", { share_id: id, permission: "upload_only" }))).toBe("invalid_input");
		expect(callsTo(w.fake, "PUT", /\/shares\/\d+$/)).toHaveLength(0);
		const p = await shareWith({ path: "/Projects", share_with: `person:${QA.b}` });
		expect(errorCode(await callTool("sharing_update", { share_id: p, password: "abcdefghijklmn" }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_update", { share_id: p, hide_download: true }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_update", { share_id: p, label: "x" }))).toBe("invalid_input");
	});

	it("sets or removes a link password; that can't be undone", async () => {
		const id = await link("/report.pdf");
		const r = await callTool("sharing_update", { share_id: Number(id), password: "a-long-password-2" });
		expect(r.structuredContent.share.password_protected).toBe(true);
		expect(r.structuredContent.undo).toBeNull();
		expect(r.structuredContent.warnings).toContain("This change can't be undone automatically.");
		const off = await callTool("sharing_update", { share_id: id, password: null });
		expect(JSON.parse(callsTo(w.fake, "PUT", /\/shares\/\d+$/).pop()?.body ?? "{}")).toEqual({ password: "" });
		expect(off.structuredContent.share.password_protected).toBe(false);
		w.sh.minPasswordLength = 30;
		const weak = await callTool("sharing_update", { share_id: id, password: "a-long-password-3" });
		expect(errorCode(weak)).toBe("invalid_input");
		expect(weak.content[0]?.text).toMatch(/at least 30 characters/);
	});

	it("changes a share with a person, keeping or setting delete and reshare, and can remove its end date", async () => {
		const id = await shareWith({ path: "/Projects", share_with: `person:${QA.b}`, can_reshare: true, expires_on: daysFromToday(3) });
		w.fake.requests.length = 0;
		const r = await callTool("sharing_update", { share_id: id, permission: "edit", expires_on: null });
		expect(JSON.parse(callsTo(w.fake, "PUT", /\/shares\/\d+$/).pop()?.body ?? "{}")).toEqual({ permissions: 23, expireDate: "" });
		expect(r.structuredContent.share).toMatchObject({ permission: "edit", can_reshare: true, can_delete: false, expires_on: null });
		expect(r.structuredContent.undo.arguments).toEqual({ share_id: id, permission: "view", can_delete: false, can_reshare: true, expires_on: daysFromToday(3) });
	});

	it("gives an undo that runs when a share with people had no end date", async () => {
		const id = await shareWith({ path: "/Projects", share_with: `person:${QA.b}` });
		const r = await callTool("sharing_update", { share_id: id, expires_on: daysFromToday(4) });
		expect(r.structuredContent.undo).toEqual({ tool: "sharing_update", arguments: { share_id: id, expires_on: null } });
		const u = await callTool("sharing_update", r.structuredContent.undo.arguments);
		expect(u.isError).toBeFalsy();
		expect(w.sh.shares.find((s) => String(s.id) === id)?.expiration).toBeNull();
	});

	describe("offers no undo it would refuse itself (fix round 1)", () => {
		const nowSec = () => Math.floor(Date.now() / 1000);
		const made = (id: number, extra: Partial<FakeShare>) =>
			w.sh.shares.push({
				id,
				share_type: 3,
				uid_owner: QA.a,
				path: "/Projects",
				item_type: "folder",
				file_source: 1,
				share_with: null,
				permissions: 1,
				expiration: daysFromToday(10),
				token: `tok${id}abcdefghij`,
				password: null,
				hide_download: false,
				label: "",
				note: "",
				stime: nowSec() - 3600,
				mail_send: false,
				...extra,
			});

		async function expectNoUndo(args: Record<string, unknown>) {
			const r = await callTool("sharing_update", args);
			expect(r.isError, r.content[0]?.text).toBeFalsy();
			expectOutputSchema("sharing_update", r);
			expect(r.structuredContent.undo).toBeNull();
			expect(r.structuredContent.warnings).toContain("This change can't be undone automatically.");
			return r;
		}

		it("for a link made elsewhere without an expiry date", async () => {
			made(701, { expiration: null });
			await expectNoUndo({ share_id: "701", expires_on: daysFromToday(10) });
			expect(w.sh.shares.find((s) => s.id === 701)?.expiration).toBe(daysFromToday(10));
		});

		it("for a link whose earlier date is past the link limit, or already gone by", async () => {
			made(702, { expiration: daysFromToday(200) });
			await expectNoUndo({ share_id: "702", expires_on: daysFromToday(20) });
			made(703, { expiration: daysFromToday(-1) });
			await expectNoUndo({ share_id: "703", expires_on: daysFromToday(20) });
			// A date within the limit stays an exact undo.
			made(704, { expiration: daysFromToday(15) });
			const r = await callTool("sharing_update", { share_id: "704", expires_on: daysFromToday(20) });
			expect(r.structuredContent.undo).toEqual({ tool: "sharing_update", arguments: { share_id: "704", expires_on: daysFromToday(15) } });
		});

		it("for access our tools can't express, and labels or notes longer than our input allows", async () => {
			// read + create without update: "view_and_upload" on a folder link.
			made(705, { permissions: 5 });
			await expectNoUndo({ share_id: "705", permission: "view" });
			// A folder shared for edit without create (3) reads as "edit", but "edit" means 7 here.
			made(706, { share_type: 0, share_with: QA.b, token: null, permissions: 3 });
			await expectNoUndo({ share_id: "706", permission: "view" });
			made(707, { label: "L".repeat(150) });
			await expectNoUndo({ share_id: "707", label: "short" });
			made(708, { share_type: 0, share_with: QA.b, token: null, note: "n".repeat(800) });
			await expectNoUndo({ share_id: "708", note: "short" });
		});

		it("for a label or note our clean-up would change on the way back (fix round 2)", async () => {
			// The undo runs through the same cleanText: tabs, line breaks in a label, outer spaces.
			made(709, { label: " spaced " });
			await expectNoUndo({ share_id: "709", label: "short" });
			made(710, { label: "two\nlines" });
			await expectNoUndo({ share_id: "710", label: "short" });
			made(711, { share_type: 0, share_with: QA.b, token: null, note: "a\tb" });
			await expectNoUndo({ share_id: "711", note: "short" });
			// A clean multi-line note stays an exact undo.
			made(712, { share_type: 0, share_with: QA.b, token: null, note: "line one\nline two" });
			const r = await callTool("sharing_update", { share_id: "712", note: "short" });
			expect(r.structuredContent.undo).toEqual({ tool: "sharing_update", arguments: { share_id: "712", note: "line one\nline two" } });
			const u = await callTool("sharing_update", r.structuredContent.undo.arguments);
			expect(u.isError).toBeFalsy();
			expect(w.sh.shares.find((s) => s.id === 712)?.note).toBe("line one\nline two");
		});
	});

	it("only changes the person's own shares, and refuses empty or no-op changes", async () => {
		const id = await shareWith({ path: "/Projects/plan.docx", share_with: `person:${QA.b}` });
		w.fake.requests.length = 0;
		const r = await callTool("sharing_update", { share_id: id, note: "mine now" }, { uid: QA.b });
		expect(errorCode(r)).toBe("permission_denied");
		expect(callsTo(w.fake, "PUT", /\/shares\/\d+$/)).toHaveLength(0);
		expect(errorCode(await callTool("sharing_update", { share_id: id }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_update", { share_id: id, permission: "view" }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_update", { share_id: "9999", note: "x" }))).toBe("not_found");
		expect(errorCode(await callTool("sharing_update", { share_id: "abc", note: "x" }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_update", { share_id: -1, note: "x" }))).toBe("invalid_input");
	});
});

describe("sharing_delete", () => {
	it("stops a link after checking it is the person's own; no undo for links", async () => {
		const id = await link("/report.pdf");
		w.fake.requests.length = 0;
		const r = await callTool("sharing_delete", { share_id: id });
		expect(r.isError).toBeFalsy();
		expectOutputSchema("sharing_delete", r);
		expect(callsTo(w.fake, "GET", /\/shares\/\d+$/)).toHaveLength(1);
		expect(callsTo(w.fake, "DELETE", /\/shares\/\d+$/)).toHaveLength(1);
		expect(w.sh.shares.find((s) => String(s.id) === id)).toBeUndefined();
		expect(r.structuredContent.stopped).toEqual({ share_id: id, kind: "link", path: "/report.pdf", shared_with: null });
		expect(r.structuredContent.undo).toBeNull();
		expect(r.structuredContent.warnings[0]).toMatch(/can't be brought back/);
		expect(r.content[0]?.text.split("\n")[0]).toBe(`Stopped link ${id}; it no longer works.`);
	});

	it("stops a share with people and gives an undo that shares it again the same way", async () => {
		const id = await shareWith({ path: "/Projects", share_with: "group:team:sales", permission: "edit", can_delete: true, note: "n" });
		w.fake.requests.length = 0;
		const r = await callTool("sharing_delete", { share_id: Number(id) });
		expect(r.isError).toBeFalsy();
		expectOutputSchema("sharing_delete", r);
		expect(r.structuredContent.undo).toEqual({
			tool: "sharing_share_with",
			arguments: { path: "/Projects", share_with: "group:team:sales", permission: "edit", can_delete: true, note: "n" },
		});
		expect(r.structuredContent.warnings ?? []).toEqual([]);
		// The undo was checked the way sharing_share_with checks: a fresh search as this person finds
		// the recipient, and the person may still share the folder.
		const search = callsTo(w.fake, "GET", /\/sharees$/).pop();
		expect(search?.auth).toBe(QA.a);
		expect(search?.url.searchParams.get("search")).toBe("team:sales");
		expect(search?.url.searchParams.getAll("shareType[]")).toEqual(["1"]);
		expect(callsTo(w.fake, "PROPFIND", /\/remote\.php\/dav\/files\/qa-t1-91\/Projects\/?$/)).toHaveLength(1);
		expect(callsTo(w.fake, "DELETE", /\/shares\/\d+$/)).toHaveLength(1);
		const again = await callTool("sharing_share_with", r.structuredContent.undo.arguments);
		expect(again.isError).toBeFalsy();
		expect(w.sh.shares.at(-1)?.permissions).toBe(15);
	});

	it("never stops someone else's share, and says when a share is gone", async () => {
		const id = await shareWith({ path: "/Projects", share_with: `person:${QA.b}` });
		w.fake.requests.length = 0;
		const r = await callTool("sharing_delete", { share_id: id }, { uid: QA.b });
		expect(errorCode(r)).toBe("permission_denied");
		expect(callsTo(w.fake, "DELETE", /\/shares\/\d+$/)).toHaveLength(0);
		await callTool("sharing_delete", { share_id: id });
		const gone = await callTool("sharing_delete", { share_id: id });
		expect(errorCode(gone)).toBe("not_found");
		expect(gone.content[0]?.text).toMatch(/stopped already/);
	});

	describe("offers only an undo that makes the very same share again (fix round 2)", () => {
		const nowSec = () => Math.floor(Date.now() / 1000);
		/** A share QA a made with QA b elsewhere (the web UI), straight into the fake. */
		const made = (id: number, extra: Partial<FakeShare>): FakeShare => {
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
		};

		async function stop(id: number) {
			const r = await callTool("sharing_delete", { share_id: String(id) });
			expect(r.isError, r.content[0]?.text).toBeFalsy();
			expectOutputSchema("sharing_delete", r);
			expectNoBrand(r);
			// Stopping never waits on the undo: the share is gone either way.
			expect(w.sh.shares.find((s) => s.id === id)).toBeUndefined();
			return r;
		}

		async function expectNoUndo(id: number) {
			const r = await stop(id);
			expect(r.structuredContent.undo).toBeNull();
			expect(r.structuredContent.warnings).toEqual([NO_UNDO]);
			expect(NO_UNDO).toBe("This change can't be undone automatically.");
			return r;
		}

		/** Runs the offered undo and returns the share it made. */
		async function replay(r: Awaited<ReturnType<typeof stop>>): Promise<FakeShare | undefined> {
			expect(r.structuredContent.undo?.tool).toBe("sharing_share_with");
			const again = await callTool("sharing_share_with", r.structuredContent.undo.arguments);
			expect(again.isError, again.content[0]?.text).toBeFalsy();
			return w.sh.shares.at(-1);
		}

		it("none for a folder shared for read and update without create (bits 3): edit would add create", async () => {
			made(801, { permissions: 3 });
			w.fake.requests.length = 0;
			await expectNoUndo(801);
			// Decided locally: nothing asks the server about an undo that can't be exact.
			expect(callsTo(w.fake, "GET", /\/sharees$/)).toHaveLength(0);
			expect(callsTo(w.fake, "PROPFIND", /\/remote\.php\/dav\/files\//)).toHaveLength(0);
		});

		it("an exact one when the access level gives back the same bits, and replaying it does", async () => {
			// A file shared for editing is bits 3; a folder shared to view and reshare is 17; a folder
			// shared with a team for editing and deleting is 15.
			const cases: [number, Partial<FakeShare>][] = [
				[811, { path: "/report.pdf", item_type: "file", permissions: 3 }],
				[812, { permissions: 17 }],
				[813, { permissions: 15, share_type: 1, share_with: "team:sales" }],
			];
			for (const [id, extra] of cases) {
				const before = made(id, extra);
				const r = await stop(id);
				expect(r.structuredContent.warnings ?? []).toEqual([]);
				const again = await replay(r);
				expect(again).toMatchObject({ share_type: before.share_type, share_with: before.share_with, path: before.path, permissions: before.permissions, expiration: null, note: "" });
			}
		});

		it("none for a share whose end date is today; an exact one for a later end date", async () => {
			made(821, { expiration: daysFromToday(0) });
			await expectNoUndo(821);
			made(822, { expiration: daysFromToday(5) });
			const r = await stop(822);
			expect(r.structuredContent.undo.arguments).toEqual({ path: "/Projects", share_with: `person:${QA.b}`, permission: "view", expires_on: daysFromToday(5) });
			expect((await replay(r))?.expiration).toBe(daysFromToday(5));
		});

		it("none for a note longer than sharing_share_with takes, or one its clean-up would change", async () => {
			made(831, { note: "n".repeat(800) });
			await expectNoUndo(831);
			made(832, { note: "a\tb" });
			await expectNoUndo(832);
			made(833, { note: " padded " });
			await expectNoUndo(833);
			// Exactly at the limit, with a line break: kept whole.
			const note = `${"x".repeat(250)}\n${"y".repeat(249)}`;
			expect(note.length).toBe(500);
			made(834, { note });
			const r = await stop(834);
			expect(r.structuredContent.undo.arguments.note).toBe(note);
			expect((await replay(r))?.note).toBe(note);
		});

		it("none for a recipient a fresh search no longer finds: another organisation, a demo account, the admin group", async () => {
			w.fake.addUser({ uid: "demo-a01", password: "FAKEAPPPASS-demo-a01-0123456789abcdef", displayName: "Demo A01", email: "demo-a01@example.invalid" });
			w.sh.addGroup("org:acme", "Acme", [QA.a, QA.b, "demo-a01"]);
			made(841, { share_with: C });
			w.fake.requests.length = 0;
			await expectNoUndo(841);
			expect(callsTo(w.fake, "GET", /\/sharees$/).pop()?.url.searchParams.get("search")).toBe(C);
			// A demo account is in the person's organisation, but core leaves non-UUID accounts out of
			// every search (DESIGN 11.3), so sharing_share_with would refuse it.
			made(842, { share_with: "demo-a01" });
			await expectNoUndo(842);
			made(843, { share_type: 1, share_with: "admin" });
			await expectNoUndo(843);
		});

		it("none for an item the person may no longer share", async () => {
			// /Received was shared with QA a without the right to share it on (no R).
			made(851, { path: "/Received" });
			await expectNoUndo(851);
			// Or the item is gone.
			made(852, { path: "/Gone" });
			await expectNoUndo(852);
		});

		it("none, without failing the stop, when a check fails or doesn't answer in time", async () => {
			w.fake.on("GET", /\/sharees$/, () => new Response("Internal Server Error", { status: 500 }));
			made(861, {});
			await expectNoUndo(861);
			w.fake.on(
				"GET",
				/\/sharees$/,
				() => new Promise<Response>((res) => setTimeout(() => res(ocs({ exact: { users: [], groups: [] }, users: [], groups: [] })), UNDO_CHECK_GRACE_MS + 4000)),
			);
			made(862, {});
			await expectNoUndo(862);
		});

		it("none when someone else's share of the item already gives the recipient access, which sharing_share_with would refuse", async () => {
			const projects = w.sh.trees.get(QA.a)?.get("/Projects");
			expect(projects).toBeTruthy();
			made(881, {});
			// Someone QA a shared /Projects with (and who may share it on) shared it with QA b as well.
			made(882, { uid_owner: "qa-t1-94", file_source: projects?.fileId ?? 0 });
			w.fake.requests.length = 0;
			await expectNoUndo(881);
			// The look-ahead is sharing_share_with's own: every share on the item, reshares included.
			const look = callsTo(w.fake, "GET", /\/shares$/).pop();
			expect(look?.auth).toBe(QA.a);
			expect(look?.url.searchParams.get("path")).toBe("/Projects");
			expect(look?.url.searchParams.get("reshares")).toBe("true");
			// The call that undo would have been is indeed refused, and makes nothing.
			const before = w.sh.shares.length;
			const again = await callTool("sharing_share_with", { path: "/Projects", share_with: `person:${QA.b}` });
			expect(errorCode(again)).toBe("already_exists");
			expect(again.content[0]?.text).toMatch(/through a share someone else made \(share_id 882\)/);
			expect(w.sh.shares.length).toBe(before);
		});

		it("an exact one even when the look-ahead still lists the share being stopped (it runs alongside the DELETE)", async () => {
			const json = (data: unknown) => new Response(JSON.stringify({ ocs: { meta: { status: "ok", statuscode: 200, message: "OK" }, data } }), { headers: { "content-type": "application/json" } });
			const s = made(883, {});
			const listed = { id: "883", share_type: 0, uid_owner: QA.a, share_with: QA.b, permissions: 1, path: "/Projects", item_type: "folder", stime: s.stime, file_source: 1 };
			w.fake.on("GET", /\/shares$/, () => json([listed]));
			const r = await stop(883);
			expect(r.structuredContent.undo).toEqual({ tool: "sharing_share_with", arguments: { path: "/Projects", share_with: `person:${QA.b}`, permission: "view" } });
			expect(r.structuredContent.warnings ?? []).toEqual([]);
		});

		it("never for email shares or other kinds made elsewhere", async () => {
			made(871, { share_type: 4, share_with: "someone@example.invalid", token: "tokmailabcdefghij" });
			const r = await stop(871);
			expect(r.structuredContent.undo).toBeNull();
			expect(r.structuredContent.warnings).toEqual([NO_UNDO]);
		});
	});

	it("needs the share scope (without it the call gets the 403 challenge, not a result)", async () => {
		const r = await callTool("sharing_delete", { share_id: "1" }, { scopes: ["workspace.read", "workspace.write", "workspace.remove"] }).catch((e: Error) => e);
		expect(r).toBeInstanceOf(Error);
		expect(String(r)).toMatch(/no result/);
	});
});
