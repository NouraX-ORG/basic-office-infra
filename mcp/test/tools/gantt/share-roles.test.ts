/** gantt_share_project: changing roles, listing, and who may manage shares (DESIGN 25.3). In its own file because the share bucket allows 10 calls a minute per person. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHARE_OUTPUTS } from "../../../src/tools/gantt/share";
import type { FakeGantt, GProject } from "../../fake-nc/gantt";
import type { FakeNc } from "../../fake-nc/index";
import { errCode, QA, setup, tool } from "./_helpers";

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

describe("gantt_share_project roles", () => {
	it("changes the role of an existing share and offers the old role as undo; lists the shares", async () => {
		await tool("gantt_share_project", { project_id: p.id, action: "share", share_with: "group:qa-org-a" });
		const r = await tool("gantt_share_project", { project_id: p.id, action: "share", share_with: "group:qa-org-a", role: "project_admin" });
		expect(r.structuredContent.changed_role_from).toBe("viewer");
		expect(r.structuredContent.share.role).toBe("project_admin");
		expect(r.structuredContent.warnings).toEqual(["A project admin can share the project further and delete it."]);
		expect(r.structuredContent.undo.arguments).toEqual({ project_id: p.id, action: "share", share_with: "group:qa-org-a", role: "viewer" });
		const l = SHARE_OUTPUTS.gantt_share_project.parse((await tool("gantt_share_project", { project_id: p.id, action: "list" })).structuredContent);
		expect(l.shares).toHaveLength(1);
		expect(l.total).toBe(1);
		expect(l.shares?.[0]).toMatchObject({ with: { id: "group:qa-org-a", kind: "group" }, role: "project_admin" });
	});
	it("only the owner or a project admin may list or change shares; others get plain answers", async () => {
		const other = g.addProject(QA.b);
		g.shares.set(77, { id: 77, project_id: other.id, principal_id: QA.a, principal_type: "user", permission: "editor" });
		expect(errCode(await tool("gantt_share_project", { project_id: other.id, action: "list" }))).toBe("permission_denied");
		const hidden = g.addProject(QA.b);
		expect(errCode(await tool("gantt_share_project", { project_id: hidden.id, action: "list" }))).toBe("not_found");
		expect(errCode(await tool("gantt_share_project", { project_id: p.id, action: "unshare", share_id: 12345 }))).toBe("not_found");
	});
});
