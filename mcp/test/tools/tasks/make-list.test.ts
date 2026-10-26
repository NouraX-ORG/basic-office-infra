/**
 * tasks_create once core's egress rule allows extended MKCOL on calendars (DESIGN 11.6, fix round 2):
 * a person with no list of their own gets a new "Tasks" list. Core's rule has no MKCOL today, so
 * canMakeLists and makeTaskList are stood in for here; the real makeTaskList's request is tested in
 * tasks.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MADE_LIST_NOTE } from "../../../src/tools/tasks/create";
import { calCalls, callTool, QA, resetTokens, type Setup, setup } from "../calendar/_helpers";

const hooks = vi.hoisted(() => ({ make: null as null | ((taken: ReadonlySet<string>) => Promise<string>) }));

vi.mock("../../../src/tools/tasks/new-list", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../../src/tools/tasks/new-list")>();
	return {
		...real,
		canMakeLists: () => true,
		makeTaskList: async (_ctx: unknown, taken: ReadonlySet<string>) => {
			if (!hooks.make) throw new Error("no stand-in");
			return hooks.make(taken);
		},
	};
});

let s: Setup;
let seen: string[] = [];
beforeEach(async () => {
	s = setup();
	await resetTokens();
	const p = s.cal.home(QA.a);
	const personal = p.get("personal");
	if (personal) personal.comps = ["VEVENT"];
	seen = [];
	hooks.make = async (taken) => {
		seen = [...taken];
		s.cal.addCalendar(QA.a, { uri: "tasks", displayname: "Tasks", comps: ["VTODO"], order: 5 });
		return "tasks";
	};
});
afterEach(() => {
	hooks.make = null;
	vi.restoreAllMocks();
});

describe("tasks_create with no list of the person's own, where lists can be made", () => {
	it("makes the Tasks list, puts the task there and says so", async () => {
		const r = await callTool("tasks_create", { title: "First task" });
		expect(r.isError).toBeFalsy();
		expect(seen).toContain("personal");
		expect(r.structuredContent.task).toMatchObject({ list_id: "tasks", title: "First task" });
		expect(r.structuredContent.warnings).toEqual([MADE_LIST_NOTE]);
		expect(r.content[0]?.text.split("\n")[0]).toBe("Created a task in a new list called Tasks.");
		const put = calCalls(s.fake, "PUT")[0];
		expect(put?.url.pathname).toMatch(new RegExp(`^/remote\\.php/dav/calendars/${QA.a}/tasks/[0-9a-f-]+\\.ics$`));
		expect(put?.headers.get("if-none-match")).toBe("*");
		// The next task goes to that list; no second list is made.
		hooks.make = async () => {
			throw new Error("a second list was asked for");
		};
		const again = await callTool("tasks_create", { title: "Second task" });
		expect(again.structuredContent.task).toMatchObject({ list_id: "tasks" });
		expect(again.structuredContent.warnings).toBeUndefined();
	});

	it("still uses an own list when there is one", async () => {
		s.cal.addCalendar(QA.a, { uri: "todo", displayname: "To do", comps: ["VTODO"], order: 1 });
		const r = await callTool("tasks_create", { title: "Mine" });
		expect(r.structuredContent.task).toMatchObject({ list_id: "todo" });
		expect(seen).toEqual([]);
	});
});
