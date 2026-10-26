/** Events of several calendars in one range, expanded by NoCalendar into single occurrences. */
import type { ToolCtx } from "../../core/tool";
import { param, props, subs, text } from "../../pim/jcal";
import { ZoneResolver } from "../../pim/tz";
import { type CalInfo, eventQueryBody } from "./caldav";
import type { Range } from "./common";
import { type EventOut, type Span, showEvent } from "./events";
import { readCalendars } from "./fan-out";

/** One occurrence as the list and free-time tools need it (the parsed jCal is not kept). */
export interface Found {
	event: EventOut;
	span: Span;
	calId: string;
	/** TRANSP:TRANSPARENT ("free"). */
	transparent: boolean;
	/** The person is an attendee and declined. */
	declinedByMe: boolean;
}

export async function eventsInRange(
	ctx: ToolCtx,
	targets: readonly CalInfo[],
	range: Range,
	zone: string,
	mine: ReadonlySet<string> = new Set(),
): Promise<{ found: Found[]; unreadable: number; tooBig: number }> {
	const body = eventQueryBody(range.startMs, range.endMs);
	const res = await readCalendars(ctx, targets, body, (objects) => {
		const out: Found[] = [];
		for (const o of objects) {
			const r = new ZoneResolver(o.cal, zone);
			for (const vev of subs(o.cal, "vevent")) {
				const shown = showEvent(vev, r, {
					calId: o.calId,
					objId: o.objId,
					etag: o.etag,
					uid: ctx.uid,
					driveOrigin: ctx.cfg.driveOrigin,
					zone,
					seriesMember: false,
				});
				if (!shown) continue;
				// The server's time-range test is the source of truth, but keep only what overlaps.
				const overlaps = shown.span.endMs > range.startMs && shown.span.startMs < range.endMs;
				const instantInside = shown.span.startMs === shown.span.endMs && shown.span.startMs >= range.startMs && shown.span.startMs < range.endMs;
				if (!overlaps && !instantInside) continue;
				const me = props(vev, "attendee").find((p) => typeof p[3] === "string" && mine.has(p[3].toLowerCase()));
				out.push({
					...shown,
					calId: o.calId,
					transparent: (text(vev, "transp") ?? "").toUpperCase() === "TRANSPARENT",
					declinedByMe: Boolean(me && (param(me, "partstat") ?? "").toUpperCase() === "DECLINED"),
				});
			}
		}
		return out;
	});
	const found = res.items;
	found.sort((a, b) => a.span.startMs - b.span.startMs || a.event.title.localeCompare(b.event.title) || a.event.event_id.localeCompare(b.event.event_id));
	return { found, unreadable: res.unreadable, tooBig: res.tooBig };
}
