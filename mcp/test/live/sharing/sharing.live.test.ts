/**
 * Lane B's live sharing cases (DESIGN 17.6): every sharing tool, for real, under `wrangler dev --env
 * dev`, against drive.nourax.org, with privacy between organisations on.
 * - qa-t1-211 finds and shares with qa-t1-212 and their team; qa-t1-213 (another organisation) can
 *   neither be found nor shared with;
 * - qa-t1-212 sees the shares from their side (with_me), and checks repeated link calls in a
 *   folder of their own (their own per-person limits);
 * - every share and link made here is stopped again with sharing_delete (the rule-3 exception),
 *   and the clean-up checks each answer and fails the run if a share may still be active.
 *
 * A new dev token for a person ends that person's earlier connection (the same client connecting
 * again), so the read-only token comes last and the clean-up gets fresh tokens.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { A, B, brandScanOwn, call, code, dav, devToken, ocsAs, ok, ORG, OTHER, ROOT, rpc, sdk, stopAll, TEAM } from "./live";

let tokenA = "";
let tokenB = "";
const made: string[] = [];
const madeByB: string[] = [];
const FILE = `${ROOT}/notes.txt`;
const FOLDER = `${ROOT}/Team plan`;
const B_ROOT = `${ROOT}-two`;
const B_FILE = `${B_ROOT}/plan.txt`;
const SHARES = "/ocs/v2.php/apps/files_sharing/api/v1/shares";

function inDays(n: number): string {
	const t = new Date();
	return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) + n * 86_400_000).toISOString().slice(0, 10);
}

function forget(list: string[], id: string): void {
	const i = list.indexOf(id);
	if (i >= 0) list.splice(i, 1);
}

beforeAll(async () => {
	tokenA = await devToken(A);
	tokenB = await devToken(B);
	expect(await dav(A, "MKCOL", `${ROOT}/`)).toBe(201);
	expect(await dav(A, "MKCOL", `${FOLDER}/`)).toBe(201);
	expect([201, 204]).toContain(await dav(A, "PUT", FILE, "Lane B live test file.\n"));
	expect(await dav(B, "MKCOL", `${B_ROOT}/`)).toBe(201);
	expect([201, 204]).toContain(await dav(B, "PUT", B_FILE, "Lane B live test file, second person.\n"));
});

afterAll(async () => {
	// Stop anything a failed case left behind (only shares and links made here), with fresh tokens.
	const left = [...(made.length ? await stopAll(await devToken(A), made) : []), ...(madeByB.length ? await stopAll(await devToken(B), madeByB) : [])];
	if (left.length) throw new Error(`These shares made by this run may still be active; stop them with sharing_delete: ${left.join(", ")}`);
}, 300_000);

describe("live: sharing (privacy between organisations on)", () => {
	it("finds the person, the team and the organisation, but nobody of another organisation", async () => {
		const r = ok(await call(tokenA, "sharing_find_people", { query: "QA t1 B" }), "find");
		const ids = (r.structuredContent.results as { id: string; kind: string; detail: string | null }[]).map((x) => `${x.kind}|${x.id}`);
		expect(ids).toContain(`person|person:${B}`);
		expect(ids).not.toContain(`person|person:${OTHER}`);
		expect(ids).not.toContain(`person|person:${A}`);
		const t = ok(await call(tokenA, "sharing_find_people", { query: TEAM, kinds: ["team"] }), "find team");
		expect(t.structuredContent.results).toEqual([expect.objectContaining({ id: `group:team:${TEAM}`, kind: "team", detail: "team" })]);
		const o = ok(await call(tokenA, "sharing_find_people", { query: ORG, kinds: ["group"] }), "find org");
		expect(o.structuredContent.results).toEqual([expect.objectContaining({ id: `group:org:${ORG}`, kind: "group", detail: "organisation" })]);
		const none = ok(await call(tokenA, "sharing_find_people", { query: OTHER }), "find other");
		expect(none.structuredContent.results).toEqual([]);
		const org2 = ok(await call(tokenA, "sharing_find_people", { query: "qa-t1-b-org-2" }), "find other org");
		expect(org2.structuredContent.results).toEqual([]);
	});

	it("makes a view link with a generated password and a hidden download button, then changes and stops it", async () => {
		const r = ok(await call(tokenA, "sharing_create_link", { path: FILE, generate_password: true, hide_download: true, label: "Lane B live", expires_in_days: 3 }), "create link");
		const s = r.structuredContent;
		made.push(s.share_id);
		expect(s).toMatchObject({ path: FILE, type: "file", permission: "view", expires_on: inDays(3), password_protected: true, hide_download: true, label: "Lane B live", reused: false });
		expect(String(s.url)).toMatch(/^https:\/\/drive\.nourax\.org\/s\/[A-Za-z0-9]+$/);
		expect(String(s.generated_password)).toHaveLength(24);
		expect(s.undo).toEqual({ tool: "sharing_delete", arguments: { share_id: s.share_id } });

		// The public page answers (password form), and the server kept our settings.
		const page = await fetch(String(s.url), { redirect: "manual" });
		expect([200, 303, 401]).toContain(page.status);
		await page.arrayBuffer();

		const u = ok(await call(tokenA, "sharing_update", { share_id: s.share_id, permission: "edit", expires_on: inDays(10), hide_download: false }), "update link");
		expect(u.structuredContent.share).toMatchObject({ permission: "edit", expires_on: inDays(10), hide_download: false, password_protected: true });
		expect(u.structuredContent.undo.arguments).toEqual({ share_id: s.share_id, permission: "view", expires_on: inDays(3), hide_download: true });
		const back = ok(await call(tokenA, "sharing_update", u.structuredContent.undo.arguments), "undo update");
		expect(back.structuredContent.share).toMatchObject({ permission: "view", expires_on: inDays(3), hide_download: true });

		expect(code(await call(tokenA, "sharing_update", { share_id: s.share_id, expires_on: null }))).toBe("invalid_input");
		expect(code(await call(tokenA, "sharing_update", { share_id: s.share_id, expires_on: inDays(120) }))).toBe("invalid_input");
		const weak = await call(tokenA, "sharing_update", { share_id: s.share_id, password: "password1234" });
		expect(code(weak)).toBe("invalid_input");
		expect(weak.content[0]?.text).toMatch(/password rules|too common|leaked/);

		const d = ok(await call(tokenA, "sharing_delete", { share_id: s.share_id }), "delete link");
		expect(d.structuredContent.stopped).toMatchObject({ share_id: s.share_id, kind: "link", path: FILE });
		forget(made, s.share_id);
		const gone = await fetch(String(s.url), { redirect: "manual" });
		expect(gone.status).toBe(404);
		await gone.arrayBuffer();
	});

	it("makes an upload-only folder link and refuses it on a file", async () => {
		const r = ok(await call(tokenA, "sharing_create_link", { path: FOLDER, permission: "upload_only" }), "upload link");
		made.push(r.structuredContent.share_id);
		expect(r.structuredContent.permission).toBe("upload_only");
		expect(r.structuredContent.expires_on).toBe(inDays(30));
		expect(code(await call(tokenA, "sharing_create_link", { path: FILE, permission: "upload_only" }))).toBe("invalid_input");
		ok(await call(tokenA, "sharing_delete", { share_id: r.structuredContent.share_id }), "delete upload link");
		forget(made, r.structuredContent.share_id);
	});

	it("a repeated link call returns the live link; after a stop it makes a new one; generated passwords are never shown twice (fix round 1)", async () => {
		const a = ok(await call(tokenB, "sharing_create_link", { path: B_FILE, expires_in_days: 2 }), "link");
		madeByB.push(a.structuredContent.share_id);
		expect(a.structuredContent.reused).toBe(false);
		const again = ok(await call(tokenB, "sharing_create_link", { path: B_FILE, expires_in_days: 2 }), "same call");
		expect(again.structuredContent).toMatchObject({ share_id: a.structuredContent.share_id, url: a.structuredContent.url, reused: true });
		expect(again.content[0]?.text).toMatch(/^This matches a link to .* made less than a minute ago with the same settings; that link is returned/);
		ok(await call(tokenB, "sharing_delete", { share_id: a.structuredContent.share_id }), "stop");
		forget(madeByB, a.structuredContent.share_id);
		const fresh = ok(await call(tokenB, "sharing_create_link", { path: B_FILE, expires_in_days: 2 }), "same call after the stop");
		madeByB.push(fresh.structuredContent.share_id);
		expect(fresh.structuredContent.reused).toBe(false);
		expect(fresh.structuredContent.share_id).not.toBe(a.structuredContent.share_id);
		expect(fresh.structuredContent.url).not.toBe(a.structuredContent.url);

		const p1 = ok(await call(tokenB, "sharing_create_link", { path: B_FILE, generate_password: true }), "generated 1");
		madeByB.push(p1.structuredContent.share_id);
		const p2 = ok(await call(tokenB, "sharing_create_link", { path: B_FILE, generate_password: true }), "generated 2");
		madeByB.push(p2.structuredContent.share_id);
		expect(p2.structuredContent.share_id).not.toBe(p1.structuredContent.share_id);
		expect(p2.structuredContent.generated_password).not.toBe(p1.structuredContent.generated_password);
		expect(JSON.stringify(p2)).not.toContain(String(p1.structuredContent.generated_password));
		expect(p2.content[0]?.text).not.toMatch(/This matches/);

		for (const id of [fresh.structuredContent.share_id, p1.structuredContent.share_id, p2.structuredContent.share_id]) {
			ok(await call(tokenB, "sharing_delete", { share_id: id }), `stop ${id}`);
			forget(madeByB, id);
		}
	});

	it("sharing_update gives no undo for a link made elsewhere without an expiry date (fix round 1)", async () => {
		// Fixture: a link with no expiry, made straight through the OCS API (as another app would).
		const made0 = await ocsAs(A, "POST", SHARES, { path: FILE, shareType: "3", permissions: "1" });
		expect(made0.status).toBe(200);
		const id = String(made0.data.id);
		made.push(id);
		expect(made0.data.expiration ?? null).toBeNull();
		const u = ok(await call(tokenA, "sharing_update", { share_id: id, expires_on: inDays(5) }), "give it a date");
		expect(u.structuredContent.share.expires_on).toBe(inDays(5));
		expect(u.structuredContent.undo).toBeNull();
		expect(u.structuredContent.warnings).toContain("This change can't be undone automatically.");
		ok(await call(tokenA, "sharing_delete", { share_id: id }), "stop it");
		forget(made, id);
	});

	it("shares with the person and the team; the person sees it from their side; nobody else can be shared with", async () => {
		const p = ok(await call(tokenA, "sharing_share_with", { path: FILE, share_with: `person:${B}`, note: "Lane B live" }), "share person");
		made.push(p.structuredContent.share_id);
		expect(p.structuredContent).toMatchObject({ permission: "view", shared_with: { id: `person:${B}`, kind: "person" }, can_delete: false, can_reshare: false });
		const t = ok(await call(tokenA, "sharing_share_with", { path: FOLDER, share_with: `group:team:${TEAM}`, permission: "edit", expires_on: inDays(5) }), "share team");
		made.push(t.structuredContent.share_id);
		expect(t.structuredContent).toMatchObject({ permission: "edit", expires_on: inDays(5), shared_with: { id: `group:team:${TEAM}`, kind: "team" } });
		const mineNow = [p.structuredContent.share_id, t.structuredContent.share_id];

		const again = await call(tokenA, "sharing_share_with", { path: FILE, share_with: `person:${B}` });
		expect(code(again)).toBe("already_exists");
		const other = await call(tokenA, "sharing_share_with", { path: FILE, share_with: `person:${OTHER}` });
		expect(code(other)).toBe("not_found");
		const otherOrg = await call(tokenA, "sharing_share_with", { path: FILE, share_with: "group:org:qa-t1-b-org-2" });
		expect(code(otherOrg)).toBe("not_found");

		const onFile = ok(await call(tokenA, "sharing_list", { which: "path", path: FILE }), "list path");
		expect((onFile.structuredContent.shares as { share_id: string }[]).map((x) => x.share_id)).toEqual([p.structuredContent.share_id]);

		// "mine" also lists the person's older shares, which may carry the brand in their own names
		// (user data): those are reported; everything this lane writes and made must be clean.
		const mine = ok(await call(tokenA, "sharing_list", { which: "mine" }, { onlyoffice: true, brand: "own" }), "list mine (ONLYOFFICE shape)");
		brandScanOwn("sharing_list mine", mine, "shares", mineNow);
		const mineIds = (mine.structuredContent.shares as { share_id: string; mine: boolean }[]).filter((x) => x.mine).map((x) => x.share_id);
		expect(mineIds).toEqual(expect.arrayContaining(mineNow));

		const withMe = ok(await call(tokenB, "sharing_list", { which: "with_me" }, { brand: "own" }), "list with_me");
		brandScanOwn("sharing_list with_me", withMe, "shares", mineNow);
		const seen = (withMe.structuredContent.shares as { share_id: string; mine: boolean; owner: { id: string }; path: string }[]).filter((x) => mineNow.includes(x.share_id));
		expect(seen).toHaveLength(2);
		for (const x of seen) expect(x).toMatchObject({ mine: false, owner: { id: `person:${A}` } });

		// The other person can't change or stop it.
		expect(code(await call(tokenB, "sharing_update", { share_id: p.structuredContent.share_id, note: "mine" }))).toBe("permission_denied");
		expect(code(await call(tokenB, "sharing_delete", { share_id: p.structuredContent.share_id }))).toBe("permission_denied");

		const u = ok(await call(tokenA, "sharing_update", { share_id: p.structuredContent.share_id, permission: "edit", can_reshare: true, expires_on: inDays(7) }), "update person share");
		expect(u.structuredContent.share).toMatchObject({ permission: "edit", can_reshare: true, expires_on: inDays(7) });
		// The share had no end date: its undo takes the date away again, and runs.
		expect(u.structuredContent.undo.arguments).toEqual({ share_id: p.structuredContent.share_id, permission: "view", can_delete: false, can_reshare: false, expires_on: null });

		const dp = ok(await call(tokenA, "sharing_delete", { share_id: p.structuredContent.share_id }), "delete person share");
		expect(dp.structuredContent.undo.tool).toBe("sharing_share_with");
		forget(made, p.structuredContent.share_id);
		ok(await call(tokenA, "sharing_delete", { share_id: t.structuredContent.share_id }), "delete team share");
		forget(made, t.structuredContent.share_id);
		expect(code(await call(tokenA, "sharing_delete", { share_id: t.structuredContent.share_id }))).toBe("not_found");
		const after = ok(await call(tokenB, "sharing_list", { which: "with_me" }, { brand: "own" }), "with_me after");
		brandScanOwn("sharing_list with_me after", after, "shares", []);
		expect((after.structuredContent.shares as { share_id: string }[]).map((x) => x.share_id)).not.toContain(p.structuredContent.share_id);
	});

	it("sharing_delete offers only an undo that makes the very same share again, and that undo runs (fix round 2)", async () => {
		const NO_UNDO = "This change can't be undone automatically.";
		// A folder shared for read and update without create (bits 3), as the web page can: "edit"
		// would mean 7 here, so replaying an undo would give create rights the person never gave.
		const f3 = await ocsAs(A, "POST", SHARES, { path: FOLDER, shareType: "0", shareWith: B, permissions: "3" });
		expect(f3.status).toBe(200);
		const id3 = String(f3.data.id);
		made.push(id3);
		expect(f3.data.permissions).toBe(3);
		const d3 = ok(await call(tokenA, "sharing_delete", { share_id: id3 }), "stop the bits-3 share");
		forget(made, id3);
		expect(d3.structuredContent.undo).toBeNull();
		expect(d3.structuredContent.warnings).toEqual([NO_UNDO]);

		// A note longer than sharing_share_with takes (500 characters) would come back cut short.
		const longNote = `Lane B live ${"n".repeat(790)}`;
		const fn = await ocsAs(A, "POST", SHARES, { path: FILE, shareType: "0", shareWith: B, permissions: "1", note: longNote });
		expect(fn.status).toBe(200);
		const idn = String(fn.data.id);
		made.push(idn);
		expect(String(fn.data.note ?? "")).toHaveLength(longNote.length);
		const dn = ok(await call(tokenA, "sharing_delete", { share_id: idn }), "stop the long-note share");
		forget(made, idn);
		expect(dn.structuredContent.undo).toBeNull();
		expect(dn.structuredContent.warnings).toEqual([NO_UNDO]);

		// A share the tools can express gets an exact undo, and running it makes the same share again.
		const s = ok(
			await call(tokenA, "sharing_share_with", { path: FOLDER, share_with: `person:${B}`, permission: "edit", expires_on: inDays(6), note: "Lane B live undo" }),
			"share to stop",
		);
		made.push(s.structuredContent.share_id);
		const before = await ocsAs(A, "GET", `${SHARES}/${s.structuredContent.share_id}`);
		const d = ok(await call(tokenA, "sharing_delete", { share_id: s.structuredContent.share_id }), "stop it");
		forget(made, s.structuredContent.share_id);
		expect(d.structuredContent.warnings ?? []).toEqual([]);
		expect(d.structuredContent.undo).toEqual({
			tool: "sharing_share_with",
			arguments: { path: FOLDER, share_with: `person:${B}`, permission: "edit", expires_on: inDays(6), note: "Lane B live undo" },
		});
		const again = ok(await call(tokenA, "sharing_share_with", d.structuredContent.undo.arguments), "run the undo");
		made.push(again.structuredContent.share_id);
		const after = await ocsAs(A, "GET", `${SHARES}/${again.structuredContent.share_id}`);
		const pick = (r: { data: Record<string, unknown> }) => {
			const x = (Array.isArray(r.data) ? r.data[0] : r.data) as Record<string, unknown>;
			return { share_type: x.share_type, share_with: x.share_with, permissions: x.permissions, expiration: x.expiration, note: x.note, path: x.path };
		};
		expect(pick(before).permissions).toBe(7);
		expect(pick(after)).toEqual(pick(before));
		ok(await call(tokenA, "sharing_delete", { share_id: again.structuredContent.share_id }), "stop the replayed share");
		forget(made, again.structuredContent.share_id);
	});

	it("works in the 2026-07-28 era through the SDK, and is hidden without the share scope", async () => {
		const client = await sdk(tokenA);
		const r = (await client.callTool({ name: "sharing_find_people", arguments: { query: B } })) as unknown as { structuredContent: { results: { id: string }[] } };
		expect(r.structuredContent.results.map((x) => x.id)).toContain(`person:${B}`);
		await client.close();
		// This ends tokenA's connection (the same client again), so it comes last.
		const readOnly = await devToken(A, ["workspace.read"]);
		const list = await rpc(readOnly, "tools/list", {});
		const names = ((list.json.result as { tools: { name: string }[] }).tools ?? []).map((x) => x.name);
		expect(names).toContain("sharing_list");
		expect(names).not.toContain("sharing_create_link");
		const denied = await rpc(readOnly, "tools/call", { name: "sharing_create_link", arguments: { path: FILE } });
		expect(denied.status).toBe(403);
	});
});
