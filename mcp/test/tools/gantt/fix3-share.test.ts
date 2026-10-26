/**
 * Fix round 3 for gantt_share_project (DESIGN 25.8): role has no default. A new share is viewer when
 * role is left out; an existing share keeps its role, and nothing is written, unless a different role
 * is given. NoGantt's own create changes an existing share's role in place, so a default would take
 * rights away. In its own file: the share bucket allows 10 calls a minute per person.
 */
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHARE_OUTPUTS, shareProject } from "../../../src/tools/gantt/share";
import type { FakeGantt, GProject } from "../../fake-nc/gantt";
import type { FakeNc } from "../../fake-nc/index";
import { QA, setup, tool } from "./_helpers";

let fake: FakeNc;
let g: FakeGantt;
let p: GProject;
// Organisation A: QA.a and qa-t1-93 (and the group qa-org-a).
const PEER = "qa-t1-93";
beforeEach(() => {
	({ fake, g } = setup());
	fake.addUser({ uid: PEER, password: "FAKEAPPPASS-qa-t1-93-0123456789abcdef", displayName: "QA t1 93" });
	g.directory.set(QA.a, [
		{ kind: "user", id: PEER, label: "QA t1 93" },
		{ kind: "group", id: "qa-org-a", label: "QA organisation A" },
	]);
	p = g.addProject(QA.a, { title: "Plan" });
});
afterEach(() => vi.restoreAllMocks());

const posts = () => fake.driveCalls().filter((c) => c.method === "POST" && c.url.pathname.endsWith(`/projects/${p.id}/shares`));

describe("gantt_share_project: role without a default (DESIGN 25.8)", () => {
	it("share without role leaves an existing editor as editor and writes nothing", async () => {
		g.shares.set(501, { id: 501, project_id: p.id, principal_id: PEER, principal_type: "user", permission: "editor" });
		fake.requests.length = 0;
		const r = await tool("gantt_share_project", { project_id: p.id, action: "share", share_with: `person:${PEER}` });
		expect(r.isError).toBeFalsy();
		expect(posts()).toEqual([]);
		const d = SHARE_OUTPUTS.gantt_share_project.parse(r.structuredContent);
		expect(d.share).toMatchObject({ share_id: 501, with: { id: `person:${PEER}`, display_name: "QA t1 93" }, role: "editor" });
		expect(d.changed_role_from).toBeNull();
		expect(r.structuredContent.undo).toBeNull();
		expect(r.content[0]?.text.split("\n")[0]).toBe(`NoGantt project ${p.id} is already shared with them as editor; nothing was changed.`);
		expect(g.shares.get(501)?.permission).toBe("editor");
	});
	it("the role it already has, given again, writes nothing either", async () => {
		g.shares.set(502, { id: 502, project_id: p.id, principal_id: "qa-org-a", principal_type: "group", permission: "admin" });
		fake.requests.length = 0;
		const r = await tool("gantt_share_project", { project_id: p.id, action: "share", share_with: "group:qa-org-a", role: "project_admin" });
		expect(posts()).toEqual([]);
		expect(r.structuredContent).toMatchObject({ share: { role: "project_admin" }, changed_role_from: null, undo: null });
	});
	it("a new share without role is viewer, checked with core's search first", async () => {
		fake.requests.length = 0;
		const r = await tool("gantt_share_project", { project_id: p.id, action: "share", share_with: `person:${PEER}` });
		expect(r.isError).toBeFalsy();
		expect(posts().map((c) => JSON.parse(c.body ?? "{}"))).toEqual([{ principal_id: PEER, principal_type: "user", permission: "viewer" }]);
		expect(fake.driveCalls().some((c) => c.url.pathname.endsWith("/files_sharing/api/v1/sharees"))).toBe(true);
		expect(r.structuredContent).toMatchObject({ share: { role: "viewer" }, changed_role_from: null });
		expect(r.structuredContent.undo).toMatchObject({ arguments: { action: "unshare" } });
	});
	it("a different role given changes an existing share, and the undo gives the old role back", async () => {
		g.shares.set(503, { id: 503, project_id: p.id, principal_id: PEER, principal_type: "user", permission: "editor" });
		const r = await tool("gantt_share_project", { project_id: p.id, action: "share", share_with: `person:${PEER}`, role: "viewer" });
		expect(posts()).toHaveLength(1);
		expect(r.structuredContent).toMatchObject({ share: { role: "viewer" }, changed_role_from: "editor" });
		expect(r.structuredContent.undo).toEqual({ tool: "gantt_share_project", arguments: { project_id: p.id, action: "share", share_with: `person:${PEER}`, role: "editor" } });
	});
	it("publishes role with no default, and says what leaving it out does", () => {
		const js = z.toJSONSchema(shareProject.input) as { properties: Record<string, { default?: unknown; description?: string }> };
		expect(js.properties.role).not.toHaveProperty("default");
		expect(js.properties.role?.description).toBe("For share. Left out: viewer for a new share; an existing share keeps its role.");
		expect(shareProject.description).toContain("without role: viewer when new; an existing share keeps its role");
	});
});
