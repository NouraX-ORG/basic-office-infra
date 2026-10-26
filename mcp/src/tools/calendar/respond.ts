/**
 * calendar_respond (fix round 3; DESIGN 11.5): the person answers an invitation they got, the other
 * half of calendar_add_attendees, whose note tells people to accept or decline.
 *
 * The person's own ATTENDEE (an address in their calendar-user-address-set) gets the new PARTSTAT in
 * their copy of the event, with If-Match, and RSVP is cleared. Scheduling stays on (when
 * CALENDAR_ATTENDEES is "internal"), so Sabre's iTIP broker sends the organizer a REPLY inside the
 * workspace, as NoCalendar's own buttons do. An answer changes no SEQUENCE (RFC 5546: only the
 * organizer's changes do); DTSTAMP and LAST-MODIFIED are updated. For a repeating event, scope
 * "series" answers the master and every changed occurrence; scope "this" answers one occurrence (an
 * override is made when there is none). Nothing is written when the answer is already that one. The
 * undo is the same tool with the earlier answer.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { defineTool } from "../../core/tool";
import { type JComp, type JProp, mainComps, prop, repeats, setProp, utcStamp } from "../../pim/jcal";
import { ZoneResolver } from "../../pim/tz";
import { getObject, parseObjectId, putObject } from "./caldav";
import { etagArg, loadHome, occurrenceArg, pickById, scopeArg } from "./common";
import { ensureVtimezones, masterOf, parseWhen, showEvent } from "./events";
import { findOverride, occurrenceKey, overrideFor } from "./occurrence";

const RESPONSES = { accepted: "ACCEPTED", declined: "DECLINED", tentative: "TENTATIVE" } as const;
type Answer = keyof typeof RESPONSES;
const BACK: Readonly<Record<string, Answer | "needs_action">> = { ACCEPTED: "accepted", DECLINED: "declined", TENTATIVE: "tentative", "NEEDS-ACTION": "needs_action" };

function ownAttendees(c: JComp, mine: ReadonlySet<string>): JProp[] {
	return c[1].filter((p) => p[0] === "attendee" && typeof p[3] === "string" && mine.has(p[3].toLowerCase()));
}

function stamp(c: JComp, now: number): void {
	setProp(c, "dtstamp", {}, "date-time", utcStamp(now));
	setProp(c, "last-modified", {}, "date-time", utcStamp(now));
}

export const respondEvent = defineTool({
	name: "calendar_respond",
	title: "Answer an invitation",
	description:
		'Answers an invitation the person got: "accepted", "declined" or "tentative". NoCalendar tells the organizer in the workspace. Repeating events need scope "this" (with occurrence_start) or "series". Only the person\'s own answer changes; calendar_list_events shows every answer.',
	input: z
		.object({
			event_id: z.string().max(420).describe("From calendar_list_events."),
			response: z.enum(["accepted", "declined", "tentative"]).describe("The answer."),
			scope: scopeArg(),
			occurrence_start: occurrenceArg(),
			expected_etag: etagArg(),
		})
		.strict(),
	async run(ctx, args) {
		const zone = ctx.time.zone;
		const ids = parseObjectId(args.event_id, "event_id", "event");
		const { principal, cals } = await loadHome(ctx.nc);
		pickById(cals, ids.calId, "events", true, "event_id");
		const mine = new Set(principal.addresses.map((a) => a.toLowerCase()));
		const want = RESPONSES[args.response];

		for (let attempt = 0; attempt < 2; attempt++) {
			const obj = await getObject(ctx.nc, ids.calId, ids.objId, "event");
			if (args.expected_etag && obj.etag !== args.expected_etag) {
				throw new ToolError("conflict", `The event changed since it was read (etag now ${obj.etag ?? "unknown"}). List it again first.`, { field: "expected_etag" });
			}
			const work = JSON.parse(JSON.stringify(obj.cal)) as JComp;
			const { master, overrides } = masterOf(work);
			const isRepeating = Boolean(prop(master, "rrule") || prop(master, "rdate"));
			if (isRepeating && !args.scope) throw new ToolError("invalid_input", 'This event repeats: give scope "this" (with occurrence_start) or "series".', { field: "scope" });
			const one = isRepeating && args.scope === "this";
			if (one && !args.occurrence_start) throw new ToolError("invalid_input", 'scope "this" needs occurrence_start (from calendar_list_events).', { field: "occurrence_start" });
			const organizer = prop(master, "organizer");
			const organizes = typeof organizer?.[3] === "string" && mine.has(organizer[3].toLowerCase());
			if (ownAttendees(master, mine).length === 0) {
				throw new ToolError(
					"not_available",
					organizes ? "This person organises that event, so there's no invitation to answer." : "This person isn't invited to that event, so there's no invitation to answer.",
					{ field: "event_id", hint: organizes ? "calendar_update_event changes it." : undefined },
				);
			}
			const comps: JComp[] = one
				? [(await overrideFor(ctx, ids, work, master, overrides, parseWhen(ctx.time, args.occurrence_start as string, "occurrence_start", zone), zone)).comp]
				: [master, ...overrides];
			let previous: string | null = null;
			let changed = false;
			const now = ctx.time.now();
			for (const c of comps) {
				let here = false;
				for (const p of ownAttendees(c, mine)) {
					const params = p[1] as Record<string, unknown>;
					const was = String(params.partstat ?? "NEEDS-ACTION").toUpperCase();
					if (c === comps[0] && previous === null) previous = was;
					if (was !== want || params.rsvp !== undefined) {
						params.partstat = want;
						delete params.rsvp;
						delete params["schedule-status"];
						here = true;
					}
				}
				if (here) {
					stamp(c, now);
					changed = true;
				}
			}
			const before = BACK[previous ?? "NEEDS-ACTION"] ?? "needs_action";
			const base = {
				event_id: `${ids.calId}/${ids.objId}`,
				response: args.response,
				previous_response: before,
				scope: isRepeating ? (one ? "this" : "series") : null,
				occurrence_start: one ? (args.occurrence_start as string) : null,
			};
			if (!changed) return { data: { ...base, undo: null }, summary: "That was already the person's answer; nothing changed.", undo: null };
			ensureVtimezones(work);
			// The answer reaches the organizer only through scheduling (an iTIP REPLY).
			const scheduling = ctx.cfg.calendarAttendees === "internal";
			const status = await putObject(ctx.nc, ids.calId, ids.objId, work, { ifMatch: obj.etag, scheduling });
			if (status === 412) {
				if (args.expected_etag || attempt === 1) throw new ToolError("conflict", "The event changed while the answer was being saved. Read it again and retry.");
				continue;
			}
			const warnings: string[] = [];
			if (!scheduling) warnings.push("Invitations are off on this server, so the organizer isn't told; the answer is saved in the person's own copy only.");
			if (one) warnings.push("This answers one occurrence only; the rest of the series keeps its earlier answer.");
			const back = await getObject(ctx.nc, ids.calId, ids.objId, "event");
			const r = new ZoneResolver(back.cal, zone);
			const main = mainComps(back.cal, "vevent");
			let comp = main.master ?? main.overrides[0] ?? null;
			if (one && main.master) comp = findOverride(main.overrides, occurrenceKey(main.master, parseWhen(ctx.time, args.occurrence_start as string, "occurrence_start", zone)), r) ?? comp;
			const shown = comp ? showEvent(comp, r, { calId: ids.calId, objId: ids.objId, etag: back.etag, uid: ctx.uid, driveOrigin: ctx.cfg.driveOrigin, zone, seriesMember: repeats(main.master) }) : null;
			// "Not answered yet" can't be given back by this tool, so then there is no undo.
			const undoArgs: Record<string, unknown> = { event_id: base.event_id, response: before };
			if (isRepeating) undoArgs.scope = one ? "this" : "series";
			if (one) undoArgs.occurrence_start = args.occurrence_start;
			const undo = before === "needs_action" ? null : { tool: "calendar_respond", arguments: undoArgs };
			if (!undo) warnings.push('The earlier state was "not answered yet", which can\'t be set back from here; answer again to change it.');
			const word = args.response === "accepted" ? "Accepted" : args.response === "declined" ? "Declined" : "Tentatively accepted";
			return {
				data: { ...base, ...(shown ? { event: shown.event } : {}), undo },
				summary: `${word} the invitation${one ? " for one occurrence" : isRepeating ? " for the whole series" : ""}${scheduling ? "; NoCalendar tells the organizer" : ""}.`,
				undo,
				...(warnings.length ? { warnings } : {}),
			};
		}
		throw new ToolError("conflict", "The event changed while the answer was being saved. Read it again and retry.");
	},
});
