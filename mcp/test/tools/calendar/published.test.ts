/**
 * Fix round 3: a calendar published by link shows its events to anyone with the link, so writing an
 * event there is sharing it. Without workspace.share calendar_create_event and calendar_update_event
 * refuse it (nothing is written); with it they go ahead and say so (src/tools/calendar/common.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calCalls, callTool, errCode, QA, resetTokens, type Setup, setup } from "./_helpers";

const NO_SHARE = ["workspace.read", "workspace.write", "workspace.remove"];
let s: Setup;
beforeEach(async () => {
	s = setup();
	await resetTokens();
	s.cal.home(QA.a);
	s.cal.addCalendar(QA.a, { uri: "open", displayname: "Open house", comps: ["VEVENT"], publishUrl: "https://drive.nourax.org/remote.php/dav/public-calendars/ABCDEFGH12345678" });
});
afterEach(() => vi.restoreAllMocks());

describe("a calendar published by link", () => {
	it("calendar_create_event there is refused without workspace.share, and nothing is written", async () => {
		s.fake.requests.length = 0;
		const r = await callTool("calendar_create_event", { title: "Salary talk", start: "2030-11-04T09:00", calendar_id: "open" }, { scopes: NO_SHARE });
		expect(errCode(r)).toBe("not_available");
		expect(r.content[0]?.text).toBe(
			"That calendar is published by link, and this connection can't share, so nothing was written there. Choose another calendar (calendar_list_calendars shows them), or reconnect with sharing allowed.",
		);
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
		// The default calendar isn't published: the same event goes there.
		const ok = await callTool("calendar_create_event", { title: "Salary talk", start: "2030-11-04T09:00" }, { scopes: NO_SHARE });
		expect(ok.isError).toBeFalsy();
		expect(ok.structuredContent?.warnings).toBeUndefined();
	});
	it("with workspace.share it is written, with a warning that anyone with the link sees it", async () => {
		const r = await callTool("calendar_create_event", { title: "Open day", start: "2030-11-04T09:00", calendar_id: "open" });
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent?.warnings).toEqual(["That calendar is published by link, so anyone with the link can see this event."]);
	});
	it("calendar_update_event: a change in a published calendar, or a move into one, is refused without workspace.share", async () => {
		// Set up with a full connection first (a new dev token for other scopes ends the earlier one).
		const made = await callTool("calendar_create_event", { title: "Private", start: "2030-11-05T09:00" });
		const id = (made.structuredContent?.event as { event_id: string }).event_id;
		const there = await callTool("calendar_create_event", { title: "Open day", start: "2030-11-06T09:00", calendar_id: "open" });
		const openId = (there.structuredContent?.event as { event_id: string }).event_id;
		s.fake.requests.length = 0;
		const moved = await callTool("calendar_update_event", { event_id: id, move_to_calendar_id: "open" }, { scopes: NO_SHARE });
		expect(errCode(moved)).toBe("not_available");
		const changed = await callTool("calendar_update_event", { event_id: openId, description: "Secret notes" }, { scopes: NO_SHARE });
		expect(errCode(changed)).toBe("not_available");
		expect(calCalls(s.fake, "PUT")).toHaveLength(0);
		expect(calCalls(s.fake, "MOVE")).toHaveLength(0);
	});
});
