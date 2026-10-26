/**
 * NoGantt's public calendar links (DESIGN 29.3): /projects/{id}/calendar.ics and /my/calendar.ics
 * are public pages with a token the Worker can't see, so every write that changes what a feed shows
 * carries the standing warning; writes that change nothing a feed shows, and a new project (which
 * has no link yet), don't.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEED_WARNING } from "../../../src/tools/gantt/api";
import type { FakeGantt, GProject, GTask } from "../../fake-nc/gantt";
import { setup, tool } from "./_helpers";
import { QA } from "../../helpers/index";

let g: FakeGantt;
let p: GProject;
let design: GTask;
let build: GTask;
beforeEach(() => {
	({ g } = setup());
	p = g.addProject(QA.a, { title: "Plan" });
	design = g.addTask(p.id, { title: "Design", start_date: "2026-11-02 00:00:00", end_date: "2026-11-06 00:00:00" });
	build = g.addTask(p.id, { title: "Build", start_date: "2026-11-09 00:00:00", end_date: "2026-11-13 00:00:00" });
});
afterEach(() => vi.restoreAllMocks());

const warned = (r: { structuredContent: Record<string, unknown>; isError?: boolean }) => {
	expect(r.isError).toBeFalsy();
	return ((r.structuredContent.warnings as string[] | undefined) ?? []).includes(FEED_WARNING);
};

describe("the calendar-link warning on NoGantt writes", () => {
	it("says plainly who can see what", () => {
		expect(FEED_WARNING).toContain("calendar links work without signing in");
		expect(FEED_WARNING).toContain("titles and dates of the tasks they are on");
	});
	it("gantt_add_task, gantt_update_task and gantt_add_milestone carry it", async () => {
		expect(warned(await tool("gantt_add_task", { project_id: p.id, title: "Test", start_date: "2026-11-03", end_date: "2026-11-04" }))).toBe(true);
		expect(warned(await tool("gantt_update_task", { project_id: p.id, task_id: design.id, title: "Design v2" }))).toBe(true);
		expect(warned(await tool("gantt_add_milestone", { project_id: p.id, title: "Go live", date: "2026-11-20" }))).toBe(true);
	});
	it("gantt_link_tasks carries it when tasks moved", async () => {
		const r = await tool("gantt_link_tasks", { project_id: p.id, links: [{ task_id: build.id, after_task_id: design.id }] });
		expect(r.isError).toBeFalsy();
		expect(warned(r)).toBe(r.structuredContent.moved_total > 0);
	});
	it("gantt_update_project carries it for the title and the planning period, not for the colour", async () => {
		expect(warned(await tool("gantt_update_project", { project_id: p.id, title: "Plan 2" }))).toBe(true);
		expect(warned(await tool("gantt_update_project", { project_id: p.id, color: "#2563EB" }))).toBe(false);
	});
	it("gantt_import_plan carries it into an existing project, not into a new one", async () => {
		const items = [{ key: "a", kind: "task", title: "Imported" }];
		expect(warned(await tool("gantt_import_plan", { project_id: p.id, start_date: "2026-12-01", items }))).toBe(true);
		expect(warned(await tool("gantt_import_plan", { new_project_title: "Fresh", start_date: "2026-12-01", items }))).toBe(false);
	});
});
