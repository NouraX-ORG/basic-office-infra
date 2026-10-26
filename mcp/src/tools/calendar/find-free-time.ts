/**
 * calendar_find_free_time (DESIGN 11.5). Busy time comes from an expanded calendar-query over the
 * person's own calendars that count for free time (not transparent), or exactly the ones given.
 * An event is busy unless it is TRANSP:TRANSPARENT, STATUS:CANCELLED or declined by the person.
 * The free-busy-query REPORT was the alternative; calendar-query was chosen because it lets the
 * Worker leave out events the person declined, which free-busy-query counts as busy.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import { defineTool } from "../../core/tool";
import { toZonedIso } from "../../core/time";
import { freeSlots, hhmm, type Interval } from "../../pim/freetime";
import { loadHome, parseRange, pickById } from "./common";
import { checkZone, timeArg, zoneArg } from "./events";
import { leftOutWarnings } from "./fan-out";
import { eventsInRange } from "./query";

const HHMM = z.string().max(5);

/**
 * DESIGN 11.5: exactly 15, 30 or 60, as an enum in the schema, so 45 is refused before the tool runs.
 * The bounds are stated as well, for core's lint (every number has a minimum and a maximum).
 * Slot starts fall on this grid of the local clock and the slots follow each other back to back
 * (freeSlots moves on by the slot length rounded up to the grid), which is what the description says
 * (live review of fix round 2: it used to say "between slot starts").
 */
export const stepArg = () => z.literal([15, 30, 60]).meta({ minimum: 15, maximum: 60 }).default(30).describe("Start grid; slots run back to back.");

/** The working hours used when none (or only some) are given; the description states them. */
export const DEFAULT_HOURS = { from: "09:00", to: "17:00", weekdays: [1, 2, 3, 4, 5] } as const;

export const findFreeTime = defineTool({
	name: "calendar_find_free_time",
	title: "Find free time",
	description:
		"Finds free slots in the person's own calendars over up to 31 days, inside working hours (default Monday to Friday 09:00-17:00 in their zone). Events marked free, cancelled or declined don't count. Earliest first, from now on.",
	input: z
		.object({
			start: timeArg("A date or date-time."),
			end: timeArg("A date includes that day."),
			duration_minutes: z.number().int().min(15).max(480).describe("Slot length."),
			working_hours: z
				.object({
					from: HHMM.optional().describe("HH:MM"),
					to: HHMM.optional().describe("HH:MM, up to 24:00"),
					weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional().describe("1 Monday to 7 Sunday"),
				})
				.strict()
				.optional()
				.describe("Working hours."),
			time_zone: zoneArg().optional(),
			calendar_ids: z.array(z.string().max(200)).min(1).max(20).optional().describe("Default: own calendars."),
			step_minutes: stepArg(),
			max_results: z.number().int().min(1).max(50).default(10).describe("How many."),
		})
		.strict(),
	async run(ctx, args) {
		const zone = checkZone(args.time_zone, ctx.time.zone);
		// Defaults apply field by field (the schema leaves them out to keep tools/list small; DESIGN 10.8).
		const given = args.working_hours ?? {};
		const wh = { from: given.from ?? DEFAULT_HOURS.from, to: given.to ?? DEFAULT_HOURS.to, weekdays: given.weekdays ?? [...DEFAULT_HOURS.weekdays] };
		const fromMin = hhmm(wh.from);
		const toMin = hhmm(wh.to);
		if (fromMin === null || fromMin >= 1440) throw new ToolError("invalid_input", 'working_hours.from must be a time like "09:00".', { field: "working_hours.from" });
		if (toMin === null) throw new ToolError("invalid_input", 'working_hours.to must be a time like "17:00".', { field: "working_hours.to" });
		if (toMin <= fromMin) throw new ToolError("invalid_input", `working_hours.to (${wh.to}) must be after from (${wh.from}).`, { field: "working_hours.to" });
		if (toMin - fromMin < args.duration_minutes) {
			throw new ToolError("invalid_input", `A ${args.duration_minutes}-minute slot doesn't fit in working hours ${wh.from} to ${wh.to}.`, { field: "duration_minutes" });
		}
		const asked = parseRange(ctx, args.start, args.end, LIMITS.freeTimeDays, zone);
		const now = ctx.time.now();
		const range = { startMs: Math.max(asked.startMs, now), endMs: asked.endMs };

		const { principal, cals } = await loadHome(ctx.nc);
		const targets = args.calendar_ids
			? [...new Map(args.calendar_ids.map((id) => pickById(cals, id, "events", false, "calendar_ids")).map((c) => [c.id, c])).values()]
			: cals.filter((c) => c.events && !c.sharedBy && !c.transparent);

		let slots: Interval[] = [];
		let left = { unreadable: 0, tooBig: 0 };
		if (range.endMs > range.startMs) {
			const mine = new Set(principal.addresses.map((a) => a.toLowerCase()));
			const res = await eventsInRange(ctx, targets, range, zone, mine);
			left = res;
			const busy = res.found
				.filter((f) => f.event.status !== "cancelled" && !f.transparent && !f.declinedByMe)
				.map((f) => ({ start: f.span.startMs, end: f.span.endMs }));
			slots = freeSlots({
				range: { start: range.startMs, end: range.endMs },
				busy,
				durationMin: args.duration_minutes,
				stepMin: args.step_minutes,
				workingHours: { fromMin, toMin, weekdays: [...new Set(wh.weekdays)] },
				zone,
				max: args.max_results,
			});
		}
		const out = slots.map((s) => ({ start: toZonedIso(s.start, zone), end: toZonedIso(s.end, zone) }));
		const warnings: string[] = [];
		if (asked.startMs < now) warnings.push("The part of the range that is already past was left out.");
		warnings.push(...leftOutWarnings(left, "calendar", (one) => `${one ? "its" : "their"} events weren't counted, so a slot may not really be free.`));
		return {
			data: { slots: out, time_zone: zone, calendars_checked: targets.map((c) => c.id) },
			summary: out.length
				? `Found ${out.length} free slot${out.length === 1 ? "" : "s"} of ${args.duration_minutes} minutes.`
				: `No free slot of ${args.duration_minutes} minutes in that range and those working hours.`,
			...(warnings.length ? { warnings } : {}),
		};
	},
});
