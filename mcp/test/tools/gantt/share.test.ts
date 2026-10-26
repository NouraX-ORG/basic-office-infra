/**
 * Contract tests for gantt_share_project (DESIGN 25.2 and 25.3), above all privacy between
 * organisations: the tool offers and accepts only what core's sharees search returns for the
 * person, although NoGantt's own share endpoint (like the fake here) accepts any account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHARE_OUTPUTS } from "../../../src/tools/gantt/share";
import type { FakeGantt, GProject } from "../../fake-nc/gantt";
import type { FakeNc } from "../../fake-nc/index";
import { errCode, ganttCalls, QA, setup, tool } from "./_helpers";

let fake: FakeNc;
let g: FakeGantt;
let p: GProject;
// Organisation A: QA.a and qa-t1-93 (and the group qa-org-a). Organisation B: QA.b.
const PEER = "qa-t1-93";
beforeEach(() => {
	({ fake, g } = setup());
	fake.addUser({ uid: PEER, password: "FAKEAPPPASS-qa-t1-93-0123456789abcdef", displayName: "QA t1 93" });
	g.directory.set(QA.a, [
		{ kind: "user", id: PEER, label: "QA t1 93" },
		{ kind: "group", id: "qa-org-a", label: "QA organisation A" },
		{ kind: "group", id: "admin", label: "admin" },
	]);
	g.directory.set(QA.b, [{ kind: "user", id: QA.b, label: "QA t1 92" }]);
	p = g.addProject(QA.a, { title: "Plan" });
});
afterEach(() => vi.restoreAllMocks());

describe("gantt_share_project", () => {
	it("find offers only core's search results for the person (never the admin group)", async () => {
		fake.requests.length = 0;
		const r = await tool("gantt_share_project", { project_id: p.id, action: "find", query: "qa" });
		const d = SHARE_OUTPUTS.gantt_share_project.parse(r.structuredContent);
		expect(d.candidates).toEqual([
			{ id: `person:${PEER}`, kind: "person", display_name: "QA t1 93", detail: null },
			{ id: "group:qa-org-a", kind: "group", display_name: "QA organisation A", detail: "group" },
		]);
		const search = fake.driveCalls().find((c) => c.url.pathname.endsWith("/files_sharing/api/v1/sharees"));
		expect(search?.url.searchParams.get("search")).toBe("qa");
		// NoGantt's own people search is never used.
		expect(fake.driveCalls().some((c) => /nc_gantt\/api\/v1\/(?:sharees|users)/.test(c.url.pathname))).toBe(false);
	});
	it("shares with a person core's search returns, and the undo unshares", async () => {
		const r = await tool("gantt_share_project", { project_id: p.id, action: "share", share_with: `person:${PEER}`, role: "editor" });
		expect(r.isError).toBeFalsy();
		const post = fake.driveCalls().find((c) => c.method === "POST" && c.url.pathname.endsWith(`/projects/${p.id}/shares`));
		expect(JSON.parse(post?.body ?? "{}")).toEqual({ principal_id: PEER, principal_type: "user", permission: "editor" });
		const d = SHARE_OUTPUTS.gantt_share_project.parse(r.structuredContent);
		expect(d.share).toMatchObject({ with: { id: `person:${PEER}`, kind: "person", display_name: "QA t1 93" }, role: "editor" });
		expect(d.changed_role_from).toBeNull();
		expect(r.structuredContent.warnings[0]).toContain("attached");
		const undo = r.structuredContent.undo as { tool: string; arguments: Record<string, unknown> };
		expect(undo).toEqual({ tool: "gantt_share_project", arguments: { project_id: p.id, action: "unshare", share_id: d.share?.share_id } });
		const un = await tool("gantt_share_project", undo.arguments);
		expect(un.isError).toBeFalsy();
		expect(g.shares.size).toBe(0);
		expect(fake.driveCalls().find((c) => c.method === "DELETE")?.url.pathname).toBe(`/ocs/v2.php/apps/nc_gantt/api/v1/shares/${d.share?.share_id}`);
		expect(un.structuredContent.undo).toEqual({ tool: "gantt_share_project", arguments: { project_id: p.id, action: "share", share_with: `person:${PEER}`, role: "editor" } });
	});
	it("refuses a person of another organisation, though NoGantt itself would take them", async () => {
		fake.requests.length = 0;
		const r = await tool("gantt_share_project", { project_id: p.id, action: "share", share_with: `person:${QA.b}` });
		expect(errCode(r)).toBe("permission_denied");
		expect(r.content[0]?.text).toContain("isn't someone this person can share with");
		expect(fake.driveCalls().some((c) => c.method === "POST")).toBe(false);
		expect(g.shares.size).toBe(0);
		// And the admin group, which the core search answers but our filter drops.
		expect(errCode(await tool("gantt_share_project", { project_id: p.id, action: "share", share_with: "group:admin" }))).toBe("permission_denied");
	});
	it("refuses missing or malformed parameters before any call", async () => {
		fake.requests.length = 0;
		const bad = [
			{ project_id: p.id, action: "find" },
			{ project_id: p.id, action: "find", query: "a" },
			{ project_id: p.id, action: "share" },
			{ project_id: p.id, action: "share", share_with: "qa-t1-93" },
			{ project_id: p.id, action: "share", share_with: "person:" },
			{ project_id: p.id, action: "unshare" },
			{ project_id: p.id, action: "share", share_with: "person:x", role: "owner" },
			{ project_id: p.id, action: "publish" },
		];
		for (const b of bad) expect(errCode(await tool("gantt_share_project", b, { uid: QA.b })), JSON.stringify(b)).toBe("invalid_input");
		expect(ganttCalls(fake)).toEqual([]);
	});
});
