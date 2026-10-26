/**
 * The memory budget for reading many calendars in one call (src/tools/calendar/fan-out.ts; review
 * fix round 1): at most 3 REPORTs at a time, a cap per answer and one budget for all answers of a
 * call, an extra read counted per calendar beyond the first 3, and fatal errors that end the call.
 */
import { describe, expect, it, vi } from "vitest";
import { readCapped } from "../../../src/core/egress";
import { ToolError } from "../../../src/core/errors";
import type { ToolCtx } from "../../../src/core/tool";
import type { CalInfo, CalObject } from "../../../src/tools/calendar/caldav";
import { FAN_OUT, type FanOutLimits, leftOutWarnings, readCalendars } from "../../../src/tools/calendar/fan-out";

function cal(id: string): CalInfo {
	return { id, name: id, color: null, events: true, tasks: false, readOnly: false, sharedBy: null, sharedByName: null, isDefault: false, transparent: false, order: 0, timezone: null, published: false };
}

/** A multistatus with one event object, padded to about `bytes` bytes. */
function answer(calId: string, bytes: number): string {
	const jcal = JSON.stringify(["vcalendar", [["version", {}, "text", "2.0"]], [["vevent", [["uid", {}, "text", calId], ["summary", {}, "text", calId]], []]]]).replace(/"/g, "&quot;");
	const head = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/remote.php/dav/calendars/u/${calId}/${calId}.ics</d:href><d:propstat><d:prop><d:getetag>"e"</d:getetag><cal:calendar-data>${jcal}</cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
	const tail = "</d:multistatus>";
	const pad = Math.max(0, bytes - head.length - tail.length - 7);
	return `${head}<!--${"x".repeat(pad)}-->${tail}`;
}

interface Stub {
	ctx: ToolCtx;
	charge: ReturnType<typeof vi.fn>;
	maxActive: () => number;
	bytesRead: () => number;
	asked: string[];
}

/** A ToolCtx whose NoDrive client answers each calendar's REPORT with `sizes[id]` bytes, or throws `errors[id]`. */
function stub(sizes: Record<string, number>, errors: Record<string, ToolError> = {}): Stub {
	let active = 0;
	let max = 0;
	let read = 0;
	const asked: string[] = [];
	const charge = vi.fn(async () => {});
	const nc = {
		uid: "u",
		async request(method: string, path: string) {
			expect(method).toBe("REPORT");
			const id = path.split("/").filter(Boolean).pop() as string;
			asked.push(id);
			active++;
			max = Math.max(max, active);
			await new Promise((r) => setTimeout(r, 5));
			const err = errors[id];
			if (err) {
				active--;
				throw err;
			}
			return new Response(answer(id, sizes[id] ?? 500), { status: 207 });
		},
		async readBytes(res: Response, cap: number) {
			try {
				const b = await readCapped(res, cap);
				read += b.byteLength;
				return b;
			} finally {
				active--;
			}
		},
	};
	const ctx = { uid: "u", nc, charge } as unknown as ToolCtx;
	return { ctx, charge, maxActive: () => max, bytesRead: () => read, asked };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => cal(`c${i + 1}`));
const titles = (o: CalObject) => o.objId;

describe("readCalendars", () => {
	it("reads every calendar, at most 3 at a time, and counts one more read per calendar beyond the first 3", async () => {
		const s = stub({});
		const r = await readCalendars(s.ctx, ids(7), "<body/>", (objects, c) => objects.map(() => c.id));
		expect(r.items).toEqual(["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
		expect(r).toMatchObject({ unreadable: 0, tooBig: 0 });
		expect(s.maxActive()).toBeLessThanOrEqual(FAN_OUT.concurrency);
		expect(s.charge).toHaveBeenCalledTimes(1);
		expect(s.charge).toHaveBeenCalledWith("read", 4);
		const few = stub({});
		await readCalendars(few.ctx, ids(3), "<body/>", (objects) => objects.map(titles));
		expect(few.charge).not.toHaveBeenCalled();
	});

	it("never reads more than the call's budget, and leaves the rest out as too big", async () => {
		const limits: FanOutLimits = { concurrency: 3, perCalendarBytes: 1000, totalBytes: 2500, minShareBytes: 100, includedCalendars: 3 };
		const s = stub({ c1: 900, c2: 900, c3: 900, c4: 900, c5: 900, c6: 900 });
		const r = await readCalendars(s.ctx, ids(6), "<body/>", (objects, c) => objects.map(() => c.id), limits);
		expect(s.bytesRead()).toBeLessThanOrEqual(limits.totalBytes);
		expect(r.items.length + r.tooBig + r.unreadable).toBe(6);
		expect(r.tooBig).toBeGreaterThanOrEqual(3);
		expect(r.items.length).toBeGreaterThanOrEqual(2);
	});

	it("leaves out an answer over the per-calendar cap without reading it all", async () => {
		const limits: FanOutLimits = { ...FAN_OUT, perCalendarBytes: 2000, minShareBytes: 100 };
		const s = stub({ c1: 500, c2: 50_000 });
		const r = await readCalendars(s.ctx, ids(2), "<body/>", (objects, c) => objects.map(() => c.id), limits);
		expect(r).toMatchObject({ items: ["c1"], tooBig: 1, unreadable: 0 });
		expect(s.bytesRead()).toBeLessThan(2500);
	});

	it("counts a calendar that answers with an error, and ends the call on a fatal one", async () => {
		const s = stub({}, { c2: new ToolError("upstream_unavailable") });
		const r = await readCalendars(s.ctx, ids(3), "<body/>", (objects, c) => objects.map(() => c.id));
		expect(r).toMatchObject({ items: ["c1", "c3"], unreadable: 1, tooBig: 0 });
		const dead = stub({}, { c1: new ToolError("reconnect_required") });
		await expect(readCalendars(dead.ctx, ids(6), "<body/>", (objects) => objects.map(titles))).rejects.toMatchObject({ code: "reconnect_required" });
		// Once a fatal error is seen, no new calendar is asked for.
		expect(dead.asked.length).toBeLessThanOrEqual(FAN_OUT.concurrency);
	});

	it("words the warnings for one and for several", () => {
		expect(leftOutWarnings({ unreadable: 1, tooBig: 0 }, "calendar", (one) => `${one ? "it is" : "they are"} left out.`)).toEqual(["1 calendar couldn't be read just now; it is left out."]);
		expect(leftOutWarnings({ unreadable: 0, tooBig: 2 }, "task list", (one) => `${one ? "it is" : "they are"} left out.`)).toEqual([
			"2 task lists held more than can be read in one go; they are left out. A list_id helps.",
		]);
	});
});
