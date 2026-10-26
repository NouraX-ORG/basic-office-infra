/** Contract tests: sharing_find_people and sharing_create_link against the fake (DESIGN 17.3). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogEntry } from "../../../src/mcp/catalog";
import { toolDef } from "../../../src/tools/registry";
import { NOBODY_NOTE } from "../../../src/tools/sharing/find-people";
import { ocs } from "../../fake-nc/index";
import { devToken, mcpPost, QA, rpcResult } from "../../helpers/index";
import { ALL_SCOPES, callTool, errorCode, expectNoBrand, expectOutputSchema, payload, tokenFor } from "./_call";
import { C, callsTo, daysFromToday, type World, world } from "./setup";

let w: World;
beforeEach(() => {
	w = world();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("sharing_find_people", () => {
	it("finds people, teams and organisations of the person's own organisation, with typed ids", async () => {
		const r = await callTool("sharing_find_people", { query: "ac" });
		expect(r.isError).toBeFalsy();
		expectOutputSchema("sharing_find_people", r);
		const ids = (r.structuredContent.results as { id: string; kind: string; detail: string | null }[]).map((x) => `${x.kind}|${x.id}|${x.detail}`);
		expect(ids).toContain("group|group:org:acme|organisation");
		expect(ids.some((x) => x.includes("admin"))).toBe(false);
		const q = await callTool("sharing_find_people", { query: "QA t1" });
		const people = (q.structuredContent.results as { id: string; kind: string }[]).map((x) => x.id);
		expect(people).toContain(`person:${QA.b}`);
		expect(people).not.toContain(`person:${QA.a}`);
		const t = await callTool("sharing_find_people", { query: "sales" });
		expect(t.structuredContent.results).toEqual([{ id: "group:team:sales", kind: "team", display_name: "Team: Sales", detail: "team" }]);
		expectNoBrand(t);
	});

	it("sends exactly the sharees search it should", async () => {
		w.fake.requests.length = 0;
		await callTool("sharing_find_people", { query: "QA t1", kinds: ["person"] });
		const r = callsTo(w.fake, "GET", /\/sharees$/).pop();
		expect(r?.auth).toBe(QA.a);
		expect(r?.headers.get("authorization")).toMatch(/^Basic /);
		expect(r?.headers.get("ocs-apirequest")).toBe("true");
		expect(r?.url.searchParams.get("search")).toBe("QA t1");
		expect(r?.url.searchParams.getAll("shareType[]")).toEqual(["0"]);
		expect(r?.url.searchParams.get("itemType")).toBe("file");
		expect(r?.url.searchParams.get("lookup")).toBe("false");
		expect(Number(r?.url.searchParams.get("perPage"))).toBeLessThanOrEqual(25);
	});

	it("asks for groups when only teams are wanted, and returns only teams", async () => {
		w.fake.requests.length = 0;
		const r = await callTool("sharing_find_people", { query: "ac", kinds: ["team"] });
		expect(r.structuredContent.results).toEqual([]);
		expect(callsTo(w.fake, "GET", /\/sharees$/).pop()?.url.searchParams.getAll("shareType[]")).toEqual(["1", "7"]);
	});

	it("never finds people of another organisation (privacy), and says why", async () => {
		const r = await callTool("sharing_find_people", { query: "Carol" });
		expect(r.structuredContent.results).toEqual([]);
		expect(r.structuredContent.note).toBe(NOBODY_NOTE);
		expect(r.structuredContent.note).toMatch(/with privacy between organisations on, that is people who share an organisation or team with them/);
		const exact = await callTool("sharing_find_people", { query: C });
		expect(exact.structuredContent.results).toEqual([]);
	});

	describe("texts that hold whether privacy between organisations is on or off (fix round 2)", () => {
		it("describes the privacy rule as the case when it is on, never as always true", () => {
			const d = toolDef("sharing_find_people")?.description ?? "";
			expect(d).toContain("only those the workspace lets this person see (with privacy between organisations on, their own organisation and teams)");
			expect(d).not.toMatch(/Only people of the person's own organisation/);
			expect(d.length).toBeLessThanOrEqual(450);
			expect(NOBODY_NOTE).toMatch(/^Nobody matched\. Only people and groups the workspace lets this person see can be found; with privacy between organisations on/);
		});

		it("with privacy off (Task 6b's switch), finds what the workspace lets the person see, and the texts stay true", async () => {
			w.sh.privacy = false;
			const r = await callTool("sharing_find_people", { query: "Carol" });
			expect(r.isError).toBeFalsy();
			expect(r.structuredContent.results).toEqual([{ id: `person:${C}`, kind: "person", display_name: "Carol Other", detail: null }]);
			expect(r.structuredContent.note).toBeNull();
			// The admin group stays out either way (core's filter).
			const g = await callTool("sharing_find_people", { query: "admin", kinds: ["group"] });
			expect(g.structuredContent.results).toEqual([]);
			// And a share with them now works, with no privacy wording in the way.
			const s = await callTool("sharing_share_with", { path: "/report.pdf", share_with: `person:${C}` });
			expect(s.isError, s.content[0]?.text).toBeFalsy();
			expect(w.sh.shares.at(-1)).toMatchObject({ share_type: 0, share_with: C, permissions: 1 });
		});

		it("explains the server's own privacy refusal as the rule in force, not as permanent", async () => {
			// The fresh search finds QA b, but the server refuses (privacy switched on in between).
			w.fake.on("POST", /\/shares$/, () => ocs([], 403, "Sharing is only allowed with group members"));
			const r = await callTool("sharing_share_with", { path: "/report.pdf", share_with: `person:${QA.b}` });
			expect(errorCode(r)).toBe("permission_denied");
			expect(r.content[0]?.text).toBe(
				"The workspace allows sharing only with people who share a group, organisation or team with the person, and with the person's own groups and teams. sharing_find_people lists who can be shared with.",
			);
			expectNoBrand(r);
		});

		it("says a reshare reaches other people, without naming one organisation", async () => {
			const r = await callTool("sharing_share_with", { path: "/Projects", share_with: `person:${QA.b}`, can_reshare: true });
			expect(r.structuredContent.warnings).toContain("They can share this on with other people.");
			expect(JSON.stringify(r.structuredContent.warnings)).not.toMatch(/their organisation/);
		});
	});

	it("says which tools take which ids (calendar_add_attendees takes person ids only)", () => {
		const d = toolDef("sharing_find_people")?.description ?? "";
		expect(d).toContain('sharing_share_with takes every kind; calendar_add_attendees takes "person:…" ids only.');
		expect(d).not.toMatch(/which sharing_share_with and calendar_add_attendees take/);
	});

	it("refuses short or unknown input with plain messages", async () => {
		expect(errorCode(await callTool("sharing_find_people", { query: "a" }))).toBe("invalid_input");
		const r = await callTool("sharing_find_people", { query: "  a  " });
		expect(errorCode(r)).toBe("invalid_input");
		expect(r.content[0]?.text).toContain("at least 2 characters");
		expect(errorCode(await callTool("sharing_find_people", { query: "ab", kinds: ["email"] }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_find_people", { query: "ab", extra: 1 }))).toBe("invalid_input");
	});

	it("is hidden without the share scope and challenged with 403 insufficient_scope", async () => {
		const t = await devToken(QA.a, { scopes: ["workspace.read", "workspace.write"] });
		const list = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		const names = ((await rpcResult(list)) as unknown as { result: { tools: { name: string }[] } }).result.tools.map((x) => x.name);
		expect(names).not.toContain("sharing_find_people");
		expect(names).toContain("sharing_list");
		const res = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "sharing_find_people", arguments: { query: "QA" } } });
		expect(res.status).toBe(403);
		expect(res.headers.get("www-authenticate")).toContain("insufficient_scope");
	});

	it("maps a server failure to a plain error with no server text", async () => {
		w.fake.on("GET", /\/sharees$/, () => new Response("OC\\Exception at /var/www/html/lib trace", { status: 500 }));
		const r = await callTool("sharing_find_people", { query: "QA t1" });
		expect(errorCode(r)).toBe("upstream_unavailable");
		expect(r.content[0]?.text).not.toMatch(/exception|var\/www/i);
	});
});

describe("sharing_create_link", () => {
	it("makes a view link that expires in 30 days by default, with exactly the request it should", async () => {
		w.fake.requests.length = 0;
		const r = await callTool("sharing_create_link", { path: "Projects/plan.docx" });
		expect(r.isError).toBeFalsy();
		expectOutputSchema("sharing_create_link", r);
		expectNoBrand(r);
		const post = callsTo(w.fake, "POST", /\/shares$/).pop();
		expect(post?.headers.get("ocs-apirequest")).toBe("true");
		expect(post?.headers.get("authorization")).toMatch(/^Basic /);
		expect(JSON.parse(post?.body ?? "{}")).toEqual({ path: "/Projects/plan.docx", shareType: 3, permissions: 1, expireDate: daysFromToday(30), sendMail: "false" });
		// Before making it, one look at the item's live links (for a repeat of the same call).
		const look = callsTo(w.fake, "GET", /\/shares$/);
		expect(look).toHaveLength(1);
		expect(look[0]?.url.searchParams.get("path")).toBe("/Projects/plan.docx");
		const s = r.structuredContent;
		expect(s).toMatchObject({ path: "/Projects/plan.docx", type: "file", permission: "view", expires_on: daysFromToday(30), password_protected: false, generated_password: null, hide_download: false, reused: false });
		expect(s.url).toMatch(/^https:\/\/drive\.nourax\.org\/s\//);
		expect(s.undo).toEqual({ tool: "sharing_delete", arguments: { share_id: s.share_id } });
		expect(r.content[0]?.text.split("\n")[0]).toBe(`Made a view link to /Projects/plan.docx that works until ${daysFromToday(30)}.`);
		expect(payload(r).share_id).toBe(s.share_id);
	});

	it("uses least privilege: edit is 3 for a file and 7 for a folder (never delete), upload_only 4 for folders", async () => {
		const f = await callTool("sharing_create_link", { path: "/report.pdf", permission: "edit" });
		expect(w.sh.shares.at(-1)?.permissions).toBe(3);
		expect(f.structuredContent.warnings).toContain("Anyone with this link can change this file.");
		const d = await callTool("sharing_create_link", { path: "/Projects", permission: "edit", expires_in_days: 7 });
		expect(w.sh.shares.at(-1)?.permissions).toBe(7);
		expect(d.structuredContent.permission).toBe("edit");
		expect(d.structuredContent.expires_on).toBe(daysFromToday(7));
		expect(d.structuredContent.warnings[0]).toMatch(/change and add files in this folder/);
		const u = await callTool("sharing_create_link", { path: "/Projects", permission: "upload_only", allow_duplicate: true });
		expect(w.sh.shares.at(-1)?.permissions).toBe(4);
		expect(u.structuredContent.permission).toBe("upload_only");
	});

	it("refuses upload_only on a file, the top folder, and bad expiries before calling the server", async () => {
		w.fake.requests.length = 0;
		expect(errorCode(await callTool("sharing_create_link", { path: "/report.pdf", permission: "upload_only" }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_create_link", { path: "/" }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_create_link", { path: "/report.pdf", expires_in_days: 91 }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_create_link", { path: "/report.pdf", expires_on: daysFromToday(0) }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_create_link", { path: "/report.pdf", expires_on: daysFromToday(91) }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_create_link", { path: "/report.pdf", expires_on: "2026-02-30" }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_create_link", { path: "/report.pdf", expires_on: daysFromToday(5), expires_in_days: 5 }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_create_link", { path: "/report.pdf", password: "abcdefghijkl", generate_password: true }))).toBe("invalid_input");
		expect(errorCode(await callTool("sharing_create_link", { path: "/../etc/passwd" }))).toBe("invalid_input");
		expect(callsTo(w.fake, "POST", /\/shares$/)).toHaveLength(0);
	});

	it("generates a strong password, sends it, and shows it once", async () => {
		const r = await callTool("sharing_create_link", { path: "/report.pdf", generate_password: true });
		const pw = r.structuredContent.generated_password as string;
		expect(pw).toHaveLength(24);
		expect(pw).toMatch(/[A-Z]/);
		expect(pw).toMatch(/[a-z]/);
		expect(pw).toMatch(/[0-9]/);
		expect(pw).toMatch(/[-_.!@#%+=]/);
		expect(w.sh.shares.at(-1)?.password).toBe(pw);
		expect(r.structuredContent.password_protected).toBe(true);
		expect(r.structuredContent.warnings).toContain("The generated password is shown only in this result; it can't be read again later.");
	});

	it("turns the server's password-policy refusal into the workspace's rules, in our words", async () => {
		w.sh.minPasswordLength = 16;
		const r = await callTool("sharing_create_link", { path: "/report.pdf", password: "abcdefghijkl" });
		expect(errorCode(r)).toBe("invalid_input");
		expect(r.content[0]?.text).toBe("That password is too short for the workspace's password rules (at least 16 characters). generate_password makes one that fits.");
		w.sh.minPasswordLength = 10;
		const c = await callTool("sharing_create_link", { path: "/report.pdf", password: "password1234" });
		expect(c.content[0]?.text).toMatch(/^That password is too common/);
		expect(c.content[0]?.text).not.toMatch(/1,000,000/);
	});

	it("hides the download button with a follow-up change, and stops the link again if that fails", async () => {
		w.fake.requests.length = 0;
		const r = await callTool("sharing_create_link", { path: "/report.pdf", hide_download: true, label: "  For\nthe board  " });
		expect(r.structuredContent.hide_download).toBe(true);
		expect(r.structuredContent.label).toBe("For the board");
		expect(JSON.parse(callsTo(w.fake, "PUT", /\/shares\/\d+$/).pop()?.body ?? "{}")).toEqual({ hideDownload: "true" });
		w.sh.failHideDownload = true;
		const before = w.sh.shares.length;
		const f = await callTool("sharing_create_link", { path: "/Projects/plan.docx", hide_download: true });
		expect(errorCode(f)).toBe("upstream_unavailable");
		expect(f.content[0]?.text).toMatch(/link wasn't made/);
		expect(w.sh.shares.length).toBe(before);
		expect(callsTo(w.fake, "DELETE", /\/shares\/\d+$/)).toHaveLength(1);
	});

	it("refuses items the person may not share, and missing items", async () => {
		w.fake.requests.length = 0;
		const r = await callTool("sharing_create_link", { path: "/Received" });
		expect(errorCode(r)).toBe("permission_denied");
		expect(callsTo(w.fake, "POST", /\/shares$/)).toHaveLength(0);
		expect(errorCode(await callTool("sharing_create_link", { path: "/Nope.txt" }))).toBe("not_found");
	});

	it("returns the link the same call made in the last 10 minutes, from the live shares, unless allow_duplicate is true", async () => {
		w.fake.requests.length = 0;
		const token = await tokenFor();
		const a = await callTool("sharing_create_link", { path: "/Projects", expires_in_days: 3 }, { token });
		expect(a.structuredContent.reused).toBe(false);
		const b = await callTool("sharing_create_link", { path: "/Projects", expires_in_days: 3 }, { token });
		expect(b.isError).toBeFalsy();
		expectOutputSchema("sharing_create_link", b);
		expect(b.structuredContent).toMatchObject({ share_id: a.structuredContent.share_id, url: a.structuredContent.url, reused: true, expires_on: daysFromToday(3) });
		expect(b.structuredContent.undo).toEqual({ tool: "sharing_delete", arguments: { share_id: a.structuredContent.share_id } });
		expect(b.content[0]?.text.split("\n")[0]).toBe(
			"This matches a link to /Projects made less than a minute ago with the same settings; that link is returned and no new one was made. allow_duplicate makes a second one.",
		);
		expect(callsTo(w.fake, "POST", /\/shares$/)).toHaveLength(1);
		// The look-up asks only for the shares on that item.
		const look = callsTo(w.fake, "GET", /\/shares$/).pop();
		expect(look?.url.searchParams.get("path")).toBe("/Projects");
		expect(look?.url.searchParams.get("shared_with_me")).toBeNull();
		const c = await callTool("sharing_create_link", { path: "/Projects", expires_in_days: 3, allow_duplicate: true }, { token });
		expect(c.structuredContent.share_id).not.toBe(a.structuredContent.share_id);
		expect(c.structuredContent.reused).toBe(false);
		expect(callsTo(w.fake, "POST", /\/shares$/)).toHaveLength(2);
		// A new connection of the same person gets the newest such link: the check reads the live shares.
		const other = await callTool("sharing_create_link", { path: "/Projects", expires_in_days: 3 });
		expect(other.structuredContent).toMatchObject({ share_id: c.structuredContent.share_id, reused: true });
		expect(callsTo(w.fake, "POST", /\/shares$/)).toHaveLength(2);
	});

	it("never hands back a link that was stopped in between (fix round 1)", async () => {
		const token = await tokenFor();
		const a = await callTool("sharing_create_link", { path: "/report.pdf" }, { token });
		const d = await callTool("sharing_delete", { share_id: a.structuredContent.share_id }, { token });
		expect(d.isError).toBeFalsy();
		w.fake.requests.length = 0;
		const b = await callTool("sharing_create_link", { path: "/report.pdf" }, { token });
		expect(b.isError).toBeFalsy();
		expect(b.structuredContent.reused).toBe(false);
		expect(b.structuredContent.share_id).not.toBe(a.structuredContent.share_id);
		expect(b.content[0]?.text).not.toMatch(/This matches/);
		expect(callsTo(w.fake, "POST", /\/shares$/)).toHaveLength(1);
		expect(w.sh.shares.map((s) => String(s.id))).toEqual([b.structuredContent.share_id]);
	});

	it("never keeps or shows a generated password again: each call makes its own link (fix round 1)", async () => {
		// Core's stored-result guard is off for this tool, whatever the catalogue says until core
		// turns it off there too (asked for in lane B's fix-round-1 result).
		expect(toolDef("sharing_create_link")?.entry.dedupe).toBe(false);
		expect(catalogEntry("sharing_create_link")).toBeTruthy();
		w.fake.requests.length = 0;
		// One connection, so core's guard (per connection) would have replayed the first result.
		const token = await tokenFor();
		const a = await callTool("sharing_create_link", { path: "/report.pdf", generate_password: true }, { token });
		const b = await callTool("sharing_create_link", { path: "/report.pdf", generate_password: true }, { token });
		expect(a.isError || b.isError).toBeFalsy();
		expect(b.structuredContent.share_id).not.toBe(a.structuredContent.share_id);
		expect(b.structuredContent.reused).toBe(false);
		const pa = a.structuredContent.generated_password as string;
		const pb = b.structuredContent.generated_password as string;
		expect(pb).not.toBe(pa);
		expect(JSON.stringify(b)).not.toContain(pa);
		expect(b.content[0]?.text).not.toMatch(/This matches/);
		// No look-up for links with a password: they are never matched.
		expect(callsTo(w.fake, "GET", /\/shares$/)).toHaveLength(0);
		expect(callsTo(w.fake, "POST", /\/shares$/)).toHaveLength(2);
	});

	it("doesn't match a link with a given password, an older link, other settings, or someone else's link", async () => {
		const token = await tokenFor();
		const p1 = await callTool("sharing_create_link", { path: "/Projects", password: "a-long-password-9" }, { token });
		const p2 = await callTool("sharing_create_link", { path: "/Projects", password: "a-long-password-9" }, { token });
		expect(p2.structuredContent.share_id).not.toBe(p1.structuredContent.share_id);
		expect(p2.structuredContent.reused).toBe(false);
		const nowSec = Math.floor(Date.now() / 1000);
		const base = { share_type: 3, path: "/report.pdf", item_type: "file" as const, file_source: 1, share_with: null, permissions: 1, expiration: daysFromToday(30), password: null, hide_download: false, label: "", note: "", mail_send: false };
		w.sh.shares.push({ ...base, id: 801, uid_owner: QA.a, token: "old801abcdefghij", stime: nowSec - 11 * 60 });
		w.sh.shares.push({ ...base, id: 802, uid_owner: QA.a, token: "lab802abcdefghij", stime: nowSec - 60, label: "other" });
		w.sh.shares.push({ ...base, id: 803, uid_owner: QA.a, token: "hid803abcdefghij", stime: nowSec - 60, hide_download: true });
		w.sh.shares.push({ ...base, id: 804, uid_owner: QA.a, token: "edt804abcdefghij", stime: nowSec - 60, permissions: 3 });
		w.sh.shares.push({ ...base, id: 805, uid_owner: QA.a, token: "exp805abcdefghij", stime: nowSec - 60, expiration: daysFromToday(29) });
		w.sh.shares.push({ ...base, id: 806, uid_owner: QA.a, token: "pwd806abcdefghij", stime: nowSec - 60, password: "a-long-password-9" });
		const r = await callTool("sharing_create_link", { path: "/report.pdf" }, { token });
		expect(r.structuredContent.reused).toBe(false);
		expect(["801", "802", "803", "804", "805", "806"]).not.toContain(r.structuredContent.share_id);
		expect(w.sh.shares.at(-1)?.id).toBe(Number(r.structuredContent.share_id));
		// A link made two minutes ago with the same settings is matched, and the answer says when.
		w.sh.shares.push({ ...base, id: 807, uid_owner: QA.a, token: "new807abcdefghij", stime: nowSec - 125, label: "Q4" });
		const q = await callTool("sharing_create_link", { path: "/report.pdf", label: "Q4" }, { token });
		expect(q.structuredContent).toMatchObject({ share_id: "807", reused: true, label: "Q4", password_protected: false, generated_password: null });
		expect(q.content[0]?.text).toMatch(/made 2 minutes ago/);
	});

	it("makes the link when the look-up fails", async () => {
		w.fake.on("GET", /\/shares$/, () => new Response("OC\\Exception trace", { status: 500 }));
		w.fake.requests.length = 0;
		const r = await callTool("sharing_create_link", { path: "/Projects" });
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent.reused).toBe(false);
		expect(callsTo(w.fake, "POST", /\/shares$/)).toHaveLength(1);
	});

	it("takes the workspace's link limit from its setting, and says so", async () => {
		expect(errorCode(await callTool("sharing_create_link", { path: "/report.pdf", expires_in_days: 366 }))).toBe("invalid_input");
		const r = await callTool("sharing_create_link", { path: "/report.pdf", expires_in_days: 200 });
		expect(errorCode(r)).toBe("invalid_input");
		expect(r.content[0]?.text).toContain("expires_in_days can be 90 at most here (the workspace's link limit).");
		const def = toolDef("sharing_create_link");
		expect(def?.description).toContain("within the workspace's link limit (90 days unless changed)");
		expect(def?.description).not.toMatch(/\(90 days at most\)/);
	});

	it("is a destructive, open-world tool that needs the share scope", async () => {
		const t = await devToken(QA.a, { scopes: ALL_SCOPES });
		const list = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		const tools = ((await rpcResult(list)) as unknown as { result: { tools: { name: string; annotations: Record<string, boolean> }[] } }).result.tools;
		const link = tools.find((x) => x.name === "sharing_create_link");
		expect(link?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
		const find = tools.find((x) => x.name === "sharing_find_people");
		expect(find?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
	});
});
