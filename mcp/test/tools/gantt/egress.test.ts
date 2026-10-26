/**
 * The four NoGantt rows of the egress allowlist (DESIGN 25.4): every route lane G uses is allowed,
 * and the ones it must never reach are refused (project and task DELETE, calendar feeds and their
 * tokens, admin routes, Talk, settings, resources, knowledge, attachments, baselines, other apps).
 */
import { describe, expect, it } from "vitest";
import { config } from "../../../src/env";
import { checkEgress, EgressDenied } from "../../../src/core/egress";
import { env } from "../../helpers/index";

const cfg = config(env);
const UID = "qa-t1-91";
const G = "https://drive.nourax.org/ocs/v2.php/apps/nc_gantt/api/v1";
const OP = "00000000-0000-4000-8000-0000000000ab";

const allowed = (url: string, method: string) => checkEgress(cfg, url, { method, headers: { authorization: "Basic x" } }, UID);
function denied(url: string, method: string): boolean {
	try {
		allowed(url, method);
		return false;
	} catch (e) {
		return e instanceof EgressDenied;
	}
}

describe("egress: NoGantt", () => {
	it("allows every route the tools use, with the right rule", () => {
		const ok: [string, string, string][] = [
			["GET", "/projects?format=json", "gantt-read"],
			["GET", "/projects/4?format=json", "gantt-read"],
			["GET", "/projects/4/tasks?format=json", "gantt-read"],
			["GET", "/projects/4/subprojects?format=json", "gantt-read"],
			["GET", "/projects/4/milestones?format=json", "gantt-read"],
			["GET", "/projects/4/shares?format=json", "gantt-read"],
			["GET", "/projects/4/critical-path?format=json", "gantt-read"],
			["GET", "/projects/4/rollup?format=json", "gantt-read"],
			["GET", "/projects/4/report/delta?format=json", "gantt-read"],
			["GET", "/my-tasks?format=json&limit=500", "gantt-read"],
			["POST", "/projects?format=json", "gantt-create"],
			["POST", "/projects/4/tasks?format=json", "gantt-create"],
			["POST", "/projects/4/milestones?format=json", "gantt-create"],
			["POST", "/projects/4/dependencies?format=json", "gantt-create"],
			["POST", "/projects/4/shares?format=json", "gantt-create"],
			["POST", "/tasks/5/deck-links?format=json", "gantt-create"],
			["POST", "/tasks/5/deck-cards?format=json", "gantt-create"],
			["POST", "/structure-import?format=json", "gantt-create"],
			["POST", `/changes/${OP}/revert?format=json`, "gantt-create"],
			["PUT", "/projects/4?format=json", "gantt-update"],
			["PUT", "/tasks/5?format=json", "gantt-update"],
			["DELETE", "/shares/9?format=json", "gantt-delete"],
		];
		for (const [m, path, rule] of ok) expect(allowed(`${G}${path}`, m), `${m} ${path}`).toBe(rule);
	});
	it("never deletes a project or a task, and never reaches calendar feeds, tokens, admin, Talk or other parts", () => {
		const no: [string, string][] = [
			["DELETE", "/projects/4"],
			["DELETE", "/tasks/5"],
			["DELETE", "/tasks/5?format=json&archive_deck_cards=false"],
			["GET", "/tasks/5/deck-delete-preview"],
			["GET", "/tasks/5/deck-links"],
			["GET", "/projects/4/deck-delete-preview"],
			["GET", "/projects/4/calendar-feed"],
			["POST", "/projects/4/calendar-feed/regenerate"],
			["PUT", "/projects/4/calendar-feed"],
			["GET", "/personal-calendar-feed"],
			["POST", "/personal-calendar-feed"],
			["DELETE", "/personal-calendar-feed"],
			["GET", "/task-sync"],
			["PUT", "/task-sync"],
			["POST", "/admin/holidays"],
			["POST", "/admin/work-schedules"],
			["PUT", "/admin/work-calendars/1"],
			["DELETE", "/admin/holidays/1"],
			["GET", "/holidays"],
			["GET", "/projects/4/talk"],
			["POST", "/projects/4/talk"],
			["PUT", "/settings"],
			["GET", "/settings"],
			["GET", "/resources"],
			["POST", "/resources"],
			["GET", "/knowledge/search"],
			["POST", "/attachments"],
			["POST", "/projects/4/baselines"],
			["GET", "/sharees"],
			["GET", "/users/search"],
			["GET", "/users/by-email"],
			["PUT", "/shares/9"],
			["DELETE", "/milestones/3"],
			["DELETE", "/subprojects/3"],
			["POST", "/projects/4/duplicate"],
			["POST", "/projects/4/simulate"],
			["POST", "/projects/4/tasks/recalculate"],
			["DELETE", "/tasks/5/deck-links/50"],
			["POST", "/changes/not-a-uuid/revert"],
			["POST", `/changes/${OP}/revert/../../projects/4`],
			["GET", "/projects/4/../../admin/holidays"],
			["GET", "/projects/%2e%2e/admin"],
		];
		for (const [m, path] of no) expect(denied(`${G}${path}`, m), `${m} ${path}`).toBe(true);
		// The public calendar feed routes and the old app-route form are not OCS and not allowed either.
		expect(denied("https://drive.nourax.org/index.php/apps/nc_gantt/projects/4/calendar.ics", "GET")).toBe(true);
		expect(denied("https://drive.nourax.org/apps/nc_gantt/my/calendar.ics", "GET")).toBe(true);
		expect(denied("https://drive.nourax.org/index.php/apps/nc_gantt/api/v1/projects", "GET")).toBe(true);
		expect(denied("https://office.nourax.org/ocs/v2.php/apps/nc_gantt/api/v1/projects", "GET")).toBe(true);
	});
});
