/**
 * Reading many calendars in one tool call (calendar_list_events, calendar_find_free_time,
 * tasks_list) inside one memory budget (review fix round 1). Without calendar_ids these tools read
 * every calendar in the home, shared ones too, and the isolate's 128 MB is shared by every request it
 * serves, so:
 * - at most 3 REPORTs run at a time;
 * - one answer is read up to 3 MiB (below a single DAV read elsewhere, LIMITS.davXmlBytes 8 MiB),
 *   and all answers of one call together up to 12 MiB; a read in progress holds its full share of
 *   that budget until it is done, so the three in flight never exceed it;
 * - each calendar's objects become small records at once (`each`), and parsing is synchronous, so
 *   only one answer is ever parsed at a time and it is dropped before the next one is;
 * - every calendar beyond the first 3 counts one more read against the person's per-minute limit,
 *   because each one is an expanded query on the server.
 * A calendar over its share of the budget is left out and counted (`tooBig`), so the tool can say so.
 */
import { isToolError } from "../../core/errors";
import type { ToolCtx } from "../../core/tool";
import { type CalInfo, type CalObject, reportCapped } from "./caldav";

export const FAN_OUT = {
	concurrency: 3,
	perCalendarBytes: 3 * 1024 * 1024,
	totalBytes: 12 * 1024 * 1024,
	/** A calendar is not even asked for when less than this is left of the budget. */
	minShareBytes: 256 * 1024,
	/** Calendars covered by the call's own unit of the read limit. */
	includedCalendars: 3,
} as const;

export type FanOutLimits = { readonly [K in keyof typeof FAN_OUT]: number };

/** Errors that end the whole call rather than leave one calendar out. */
const FATAL = new Set(["reconnect_required", "rate_limited", "daily_limit", "timeout"]);

export interface FanOutResult<T> {
	items: T[];
	/** Calendars that answered with an error. */
	unreadable: number;
	/** Calendars whose answer didn't fit in what was left of the budget. */
	tooBig: number;
}

export async function readCalendars<T>(
	ctx: ToolCtx,
	targets: readonly CalInfo[],
	body: string,
	each: (objects: CalObject[], cal: CalInfo) => T[],
	limits: FanOutLimits = FAN_OUT,
): Promise<FanOutResult<T>> {
	const extra = targets.length - limits.includedCalendars;
	if (extra > 0) await ctx.charge("read", extra);
	const per: T[][] = targets.map(() => []);
	let unreadable = 0;
	let tooBig = 0;
	let left = limits.totalBytes;
	let next = 0;
	let stop = false;
	const worker = async (): Promise<void> => {
		while (!stop) {
			const i = next++;
			const cal = targets[i];
			if (!cal) return;
			const cap = Math.min(limits.perCalendarBytes, left);
			if (cap < limits.minShareBytes) {
				tooBig++;
				continue;
			}
			left -= cap;
			let used = 0;
			try {
				const { objects, bytes } = await reportCapped(ctx.nc, cal.id, body, cap);
				used = bytes;
				per[i] = each(objects, cal);
			} catch (e) {
				if (!isToolError(e) || FATAL.has(e.code)) {
					stop = true;
					throw e;
				}
				if (e.code === "too_large") tooBig++;
				else unreadable++;
			} finally {
				left += cap - used;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limits.concurrency, targets.length) }, () => worker()));
	return { items: per.flat(), unreadable, tooBig };
}

/** Plain warnings for calendars that were left out. */
export function leftOutWarnings(r: { unreadable: number; tooBig: number }, noun: "calendar" | "task list", consequence: (one: boolean) => string): string[] {
	const out: string[] = [];
	const n = (k: number) => `${k} ${noun}${k === 1 ? "" : "s"}`;
	if (r.unreadable) out.push(`${n(r.unreadable)} couldn't be read just now; ${consequence(r.unreadable === 1)}`);
	if (r.tooBig) {
		const fix = noun === "calendar" ? "A shorter range or fewer calendar_ids helps." : "A list_id helps.";
		out.push(`${n(r.tooBig)} held more than can be read in one go; ${consequence(r.tooBig === 1)} ${fix}`);
	}
	return out;
}
