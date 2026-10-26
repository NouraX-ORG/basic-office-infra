/** Contract tests for workspace_overview (DESIGN 11.1) against the fake NoDrive. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeNc } from "../../fake-nc/index";
import { devToken, fakeWithQa, mcpPost, QA } from "../../helpers/index";
import { brandFree, callTool, errorCode, expectSchema } from "../boards/helpers";
import { clearCapabilityCache } from "../../../src/nc/capabilities";

let fake: FakeNc;
beforeEach(() => {
	clearCapabilityCache();
	fake = fakeWithQa();
});
afterEach(() => vi.restoreAllMocks());

type Overview = {
	apps: Record<string, Record<string, unknown>>;
	limits: Record<string, number>;
	connection: { kind: string; can: string[]; cannot: string[]; apps: string[] };
	notes: string[];
};

describe("workspace_overview", () => {
	it("reads capabilities, navigation and search providers, and reports apps in our own names", async () => {
		fake.requests.length = 0;
		const r = await callTool("workspace_overview", {});
		expect(r.isError).toBeFalsy();
		expectSchema("workspace_overview", r);
		const paths = fake.driveCalls().map((c) => `${c.method} ${c.url.pathname}`);
		expect(paths).toEqual(expect.arrayContaining(["GET /ocs/v2.php/cloud/capabilities", "GET /ocs/v2.php/core/navigation/apps", "GET /ocs/v2.php/search/providers"]));
		for (const c of fake.driveCalls().filter((x) => x.url.pathname.startsWith("/ocs/"))) expect(c.headers.get("ocs-apirequest")).toBe("true");
		const o = r.structuredContent as unknown as Overview;
		expect(o.apps.files).toMatchObject({ available: true, in_this_connection: true, trash: true, versions: true });
		expect(o.apps.sharing).toMatchObject({ available: true, allowed: false, public_links: true });
		expect(o.apps.content_search).toEqual({ available: true });
		expect(o.apps.calendar).toMatchObject({ available: true, attendees: "internal" });
		expect(o.apps.tasks).toMatchObject({ available: false });
		expect(o.apps.boards).toMatchObject({ available: true, in_this_connection: true, tools: 8 });
		expect(o.apps.gantt).toMatchObject({ available: false, in_this_connection: true });
		expect(o.apps.mail).toEqual({ status: "not_set_up", tools: null, note: "Mail tools aren't set up for this connection in Nourax Workspace." });
		expect(o.limits).toMatchObject({ upload_bytes: 2 * 1024 * 1024, text_upload_chars: 1_000_000, read_chars_max: 50_000, list_max: 200, link_days_max: 90, result_chars: 60_000, comment_chars: 1_000 });
		expect(o.connection.kind).toBe("dev");
		expect(o.connection.can).toEqual(["read", "create and edit", "replace and remove (most can be undone for 30 days)"]);
		expect(o.connection.cannot).toEqual(["share files, create public links or invite people to events", "The person can allow more by reconnecting the assistant."]);
		const text = JSON.stringify(r);
		expect(brandFree(text)).toBe(true);
		expect(text).not.toContain('"deck"');
	});
	it("maps NoTasks and NoGantt from the navigation, without showing raw app ids", async () => {
		fake.navigation.push({ id: "tasks", name: "Tasks" }, { id: "nc_gantt", name: "NoGantt" });
		const r = await callTool("workspace_overview", {}, { uid: QA.b });
		const o = r.structuredContent as unknown as Overview;
		expect(o.apps.tasks).toMatchObject({ available: true });
		expect(o.apps.gantt).toMatchObject({ available: true, in_this_connection: true });
		expect(JSON.stringify(r)).not.toContain("nc_gantt");
	});
	it("a connection with fewer apps and only read says what it can't do", async () => {
		const r = await callTool("workspace_overview", {}, { scopes: ["workspace.read"], apps: ["files", "boards"] });
		const o = r.structuredContent as unknown as Overview;
		expect(o.apps.calendar).toMatchObject({ in_this_connection: false, tools: 0 });
		expect(o.apps.boards).toMatchObject({ in_this_connection: true, tools: 3 });
		expect(o.connection.cannot).toEqual(
			expect.arrayContaining([
				"create or change files, documents, events, tasks, contacts or cards",
				"use Calendar and tasks (NoCalendar, NoTasks) (not chosen for this connection)",
				"use Contacts (NoContacts) (not chosen for this connection)",
				"use Projects (NoGantt) (not chosen for this connection)",
				"The person can allow more by reconnecting the assistant.",
			]),
		);
		expect(o.connection.apps).toEqual(["Files and sharing (NoDrive)", "Boards (NoBoard)"]);
		expect(r.content[0]?.text.split("\n")[0]).toBe("This connection covers NoDrive, NoBoard.");
	});
	it("a source that fails is reported as unknown, not as a failure", async () => {
		fake.on("GET", /^\/ocs\/v2\.php\/search\/providers$/, () => new Response("boom", { status: 500 }));
		const r = await callTool("workspace_overview", {});
		expect(r.isError).toBeFalsy();
		const o = r.structuredContent as unknown as Overview;
		expect(o.apps.content_search).toEqual({ available: null });
		expect(o.notes[0]).toContain("couldn't be read just now");
	});
	it("a dead credential still ends the connection", async () => {
		fake.on("GET", /^\/ocs\/v2\.php\/cloud\/(capabilities|user)$/, () => new Response("", { status: 401 }));
		fake.on("GET", /^\/ocs\/v2\.php\/(core\/navigation\/apps|search\/providers)$/, () => new Response("", { status: 401 }));
		const t = await devToken(QA.a);
		const res = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspace_overview", arguments: {} } });
		expect(res.status).toBe(401);
	});
	it("takes no input", async () => {
		const r = await callTool("workspace_overview", { verbose: true });
		expect(errorCode(r)).toBe("invalid_input");
	});
});
