/** calendar_list_events (DESIGN 11.5): events in a range, repeating ones occurrence by occurrence. */
import { z } from "zod";
import { LIMITS } from "../../core/limits";
import { cursorArg, limitArg } from "../../core/shapes";
import { defineTool } from "../../core/tool";
import { calendarIdsArg, loadHome, parseRange, pickById } from "./common";
import { attendeesCutInList, timeArg } from "./events";
import { leftOutWarnings } from "./fan-out";
import { eventsInRange } from "./query";

export const listEvents = defineTool({
	name: "calendar_list_events",
	title: "List events",
	description:
		"Lists events from start to end (92 days at most), each occurrence of a repeating event on its own. query matches title, location and notes. All-day events give dates, end being the last day.",
	input: z
		.object({
			start: timeArg("A date or date-time."),
			end: timeArg("A date includes that day."),
			calendar_ids: calendarIdsArg(),
			query: z.string().max(200).optional().describe("Text to match."),
			limit: limitArg(LIMITS.listMax, 100).describe("How many."),
			cursor: cursorArg().describe("From next_cursor."),
		})
		.strict(),
	async run(ctx, args) {
		const zone = ctx.time.zone;
		const range = parseRange(ctx, args.start, args.end, LIMITS.eventRangeDays, zone);
		const { cals } = await loadHome(ctx.nc);
		const targets = args.calendar_ids
			? [...new Map(args.calendar_ids.map((id) => pickById(cals, id, "events", false, "calendar_ids")).map((c) => [c.id, c])).values()]
			: cals.filter((c) => c.events);
		const { found, unreadable, tooBig } = await eventsInRange(ctx, targets, range, zone);
		// Both sides in NFC, so combining accents typed in the query or stored by a client still match (DESIGN 29.9).
		const fold = (s: string) => s.normalize("NFC").toLowerCase();
		const q = args.query === undefined ? undefined : fold(args.query);
		const all = q
			? found.filter((f) => [f.event.title, f.event.location ?? "", f.event.description ?? ""].some((s) => fold(s).includes(q)))
			: found;
		const offset = (await ctx.page.decode<number>()) ?? 0;
		const off = Number.isInteger(offset) && offset >= 0 ? offset : 0;
		const window = all.slice(off, off + args.limit).map((f) => f.event);
		const fitted = ctx.page.fit(window, (items) => ({ events: items, next_cursor: "x".repeat(200), has_more: true })).items;
		// Always make progress: one event is never larger than a result (descriptions are cut).
		const items = fitted.length ? fitted : window.slice(0, 1);
		const next = off + items.length;
		const has_more = next < all.length;
		const left = leftOutWarnings({ unreadable, tooBig }, "calendar", (one) => `${one ? "it is" : "they are"} left out.`);
		const cut = attendeesCutInList(items);
		if (cut) left.push(cut);
		const warnings = left.length ? left : undefined;
		return {
			data: { events: items, next_cursor: has_more ? await ctx.page.encode(next) : null, has_more },
			summary: `Found ${all.length} event${all.length === 1 ? "" : "s"} in ${targets.length} calendar${targets.length === 1 ? "" : "s"}${has_more ? `; showing ${items.length}, next_cursor continues` : ""}.`,
			...(warnings ? { warnings } : {}),
		};
	},
});
