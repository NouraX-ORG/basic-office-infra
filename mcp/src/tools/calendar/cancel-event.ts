/**
 * calendar_cancel_event (DESIGN 11.5).
 * - mark_cancelled (default): STATUS:CANCELLED, SEQUENCE+1, If-Match. For one occurrence of a
 *   series, its override is marked cancelled (it stays visible, struck through).
 * - remove: DELETE of the object, which NoCalendar keeps in its trash for 30 days (checked live:
 *   trash-bin-retention-duration 2592000). For one occurrence, an EXDATE on the master instead
 *   (and its override, if any, goes). That occurrence never reaches the trash and can't be put back
 *   from here: the description and a warning say so (review fix round 1). Fix round 3: when its
 *   override holds changes of its own (occurrence.ts, hasOwnChanges), removing is refused before
 *   anything is written, and mark_cancelled is offered instead, so the only thing ever removed for
 *   good is an occurrence the series itself describes (DESIGN 27).
 * - Scheduling follows calendar_update_event: attendees in the workspace are told when
 *   CALENDAR_ATTENDEES=internal (checked live: their copy becomes cancelled). `notified` lists them
 *   as Person ids (people.ts). One occurrence marked cancelled is the exception: NoCalendar's copy
 *   for attendees lags one change behind (seen four times live), so nobody is claimed and a warning
 *   says so.
 * - Review fix round 2: only the organizer's changes reach the invited people (people.ts,
 *   schedulingRole). When the person is an attendee, marking cancelled changes their own copy only
 *   (sent with X-NC-Scheduling: false), while removing keeps scheduling on, so NoCalendar tells the
 *   organizer they declined, as NoCalendar's own pages do. An event with no organizer, or someone
 *   else's that the person isn't invited to, is never scheduled. `notified` is then empty and a
 *   warning says who hears about it. The sharees searches behind `notified` are counted against
 *   the read limit before anything is written.
 * - An item saved by another app under a name not ending in ".ics" can't be removed (the egress rule
 *   lets DELETE reach "*.ics" objects only): refused before anything is written.
 * Never a whole calendar and never the calendar trash (the egress allowlist allows DELETE on one
 * event object only).
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { defineTool } from "../../core/tool";
import { type JComp, prop, setProp, text } from "../../pim/jcal";
import { ZoneResolver } from "../../pim/tz";
import { deleteObject, getObject, movableName, parseObjectId, putObject } from "./caldav";
import { etagArg, loadHome, occurrenceArg, pickById, schedulingFor, scopeArg } from "./common";
import { ensureVtimezones, hasAttendees, masterOf, occurrenceProp, parseWhen, touch } from "./events";
import { findOverride, hasOwnChanges, occurrenceKey, overrideFor } from "./occurrence";
import { declineWouldGo, notifiedPeople, notifySearches, notToldWarning, PeopleLookup, type Person, schedulingRole } from "./people";

export const OCCURRENCE_LAG_WARNING =
	'Invited people may not see this one occurrence as cancelled in their NoCalendar until the event next changes. mode "remove" reaches them at once, but can\'t be undone.';

export const OCCURRENCE_GONE_WARNING = "This occurrence was left out of the series. It doesn't go to NoCalendar's trash and can't be put back from here.";

export const OWN_CHANGES_REFUSAL =
	"This occurrence was changed on its own (its time, details, reminder or someone's answer differ from the rest of the series). Removing it would lose that for good, outside NoCalendar's trash, so nothing was changed.";

export const OWN_CHANGES_HINT = 'mode "mark_cancelled" keeps it, marked as cancelled; NoCalendar can still delete it.';

function told(n: number): string {
	return n ? `; NoCalendar tells ${n} invited ${n === 1 ? "person" : "people"} in the workspace` : "";
}

export const cancelEvent = defineTool({
	name: "calendar_cancel_event",
	title: "Cancel an event",
	description:
		'Cancels an event: "mark_cancelled" (default) keeps it, marked; "remove" puts it in NoCalendar\'s trash for 30 days, but removes a single occurrence for good (refused if it was changed on its own). Repeating events need scope "this" (with occurrence_start) or "series". If the person organises it, invited people are told in NoCalendar.',
	input: z
		.object({
			event_id: z.string().max(420).describe("From calendar_list_events."),
			scope: scopeArg(),
			occurrence_start: occurrenceArg(),
			mode: z.enum(["mark_cancelled", "remove"]).default("mark_cancelled").describe("How to cancel."),
			expected_etag: etagArg(),
		})
		.strict(),
	async run(ctx, args) {
		const zone = ctx.time.zone;
		const ids = parseObjectId(args.event_id, "event_id", "event");
		const { principal, cals } = await loadHome(ctx.nc);
		const calendar = pickById(cals, ids.calId, "events", true, "event_id");
		const mine = new Set(principal.addresses.map((a) => a.toLowerCase()));
		const lookup = new PeopleLookup(ctx);
		let reserved = false;

		for (let attempt = 0; attempt < 2; attempt++) {
			const obj = await getObject(ctx.nc, ids.calId, ids.objId, "event");
			if (args.expected_etag && obj.etag !== args.expected_etag) {
				throw new ToolError("conflict", `The event changed since it was read (etag now ${obj.etag ?? "unknown"}). List it again first.`, { field: "expected_etag" });
			}
			const work = JSON.parse(JSON.stringify(obj.cal)) as JComp;
			const { master, overrides } = masterOf(work);
			const isRepeating = Boolean(prop(master, "rrule") || prop(master, "rdate"));
			if (isRepeating && !args.scope) {
				throw new ToolError("invalid_input", 'This event repeats: give scope "this" (with occurrence_start) or "series".', { field: "scope" });
			}
			const one = isRepeating && args.scope === "this";
			if (one && !args.occurrence_start) throw new ToolError("invalid_input", 'scope "this" needs occurrence_start (from calendar_list_events).', { field: "occurrence_start" });
			const attendees = hasAttendees(work);
			const removing = args.mode === "remove";
			// The organizer's changes go to the invited people; an attendee's removal tells the organizer
			// they declined; anything else reaches nobody, so it is saved without scheduling (people.ts).
			const sched = attendees ? await schedulingRole(lookup, work, mine, calendar) : null;
			const tells = Boolean(sched?.tellsInvited);
			const scheduling = schedulingFor(ctx, attendees) && (tells || (sched?.role === "attendee" && removing));
			const now = ctx.time.now();
			const warnings: string[] = [];
			if (sched && !tells) warnings.push(notToldWarning(sched.role, removing ? (one ? "remove_one" : "remove") : "mark", scheduling && declineWouldGo(work, mine)));
			else if (attendees && !scheduling) warnings.push("Attendees were not told.");
			// The searches behind `notified` are counted (once) before anything is written.
			const reserve = async (): Promise<void> => {
				if (sched && tells && scheduling && !reserved) {
					reserved = true;
					await lookup.reserve(notifySearches(work, sched.exclude));
				}
			};
			const base = { event_id: `${ids.calId}/${ids.objId}`, mode: args.mode, scope: isRepeating ? (one ? "this" : "series") : null };

			if (args.mode === "remove" && !one) {
				if (!movableName(ids.objId)) {
					throw new ToolError("not_available", "This event was saved by another app under a name that can't be removed from here; nothing was changed.", {
						field: "mode",
						hint: 'mode "mark_cancelled" works for it, or remove it in NoCalendar.',
					});
				}
				await reserve();
				// Who NoCalendar will tell is read before the object goes (its codes say nothing about this DELETE).
				const who = sched && tells && scheduling ? await notifiedPeople(lookup, work, sched.exclude, { codes: false }) : { notified: [] as Person[], warnings: [] as string[] };
				const status = await deleteObject(ctx.nc, ids.calId, ids.objId, { ifMatch: obj.etag, scheduling });
				if (status === 404) throw new ToolError("not_found", "There's no event with that event_id; it may be gone already.", { hint: "calendar_list_events finds events and their ids." });
				if (status === 412) {
					if (args.expected_etag || attempt === 1) throw new ToolError("conflict", "The event changed while it was being removed. Read it again and retry.");
					continue;
				}
				warnings.unshift("NoCalendar's trash keeps it for 30 days; it can be restored from there.");
				warnings.push(...who.warnings);
				return {
					data: { ...base, occurrence_start: null, notified: who.notified },
					summary: `Moved the event${isRepeating ? " series" : ""} to NoCalendar's trash${told(who.notified.length)}.`,
					undo: null,
					warnings,
				};
			}

			let occurrenceStart: string | null = null;
			let already = false;
			if (one) {
				const occ = parseWhen(ctx.time, args.occurrence_start as string, "occurrence_start", zone);
				occurrenceStart = args.occurrence_start as string;
				if (args.mode === "remove") {
					const key = occurrenceKey(master, occ);
					const r = new ZoneResolver(work, zone);
					const existing = findOverride(overrides, key, r);
					// Fix round 3: an occurrence changed on its own would lose that change for good (its override
					// goes, outside the trash), so it is refused before anything is written.
					if (existing && hasOwnChanges(existing, master, r, zone)) {
						throw new ToolError("not_available", OWN_CHANGES_REFUSAL, { field: "mode", hint: OWN_CHANGES_HINT });
					}
					// Make sure the occurrence exists before writing an EXDATE (throws not_found otherwise).
					if (!existing) await overrideFor(ctx, ids, work, master, overrides, occ, zone);
					work[2] = work[2].filter((c) => !(c[0].toLowerCase() === "vevent" && c !== master && findOverride([c], key, r)));
					master[1].push(occurrenceProp("exdate", master, occ));
					touch(master, now);
				} else {
					const { comp } = await overrideFor(ctx, ids, work, master, overrides, occ, zone);
					already = (text(comp, "status") ?? "").toUpperCase() === "CANCELLED";
					setProp(comp, "status", {}, "text", "CANCELLED");
					touch(comp, now);
				}
			} else {
				const comps = [master, ...overrides];
				already = comps.every((c) => (text(c, "status") ?? "").toUpperCase() === "CANCELLED");
				for (const c of comps) {
					setProp(c, "status", {}, "text", "CANCELLED");
					touch(c, now);
				}
			}
			if (already) {
				return {
					data: { ...base, occurrence_start: occurrenceStart, notified: [] },
					summary: "The event was already marked as cancelled; nothing changed.",
					undo: null,
				};
			}
			if (!(one && !removing)) await reserve();
			ensureVtimezones(work);
			const status = await putObject(ctx.nc, ids.calId, ids.objId, work, { ifMatch: obj.etag, scheduling });
			if (status === 412) {
				if (args.expected_etag || attempt === 1) throw new ToolError("conflict", "The event changed while it was being saved. Read it again and retry.");
				continue;
			}
			let notified: Person[] = [];
			if (one && removing) warnings.unshift(OCCURRENCE_GONE_WARNING);
			if (sched && tells && scheduling && one && !removing) warnings.push(OCCURRENCE_LAG_WARNING);
			else if (sched && tells && scheduling) {
				const back = await getObject(ctx.nc, ids.calId, ids.objId, "event");
				const who = await notifiedPeople(lookup, back.cal, sched.exclude);
				notified = who.notified;
				warnings.push(...who.warnings);
			}
			const what = one
				? removing
					? "Removed one occurrence of the series"
					: "Marked one occurrence of the series as cancelled"
				: isRepeating
					? "Marked the whole series as cancelled"
					: "Marked the event as cancelled";
			return {
				data: { ...base, occurrence_start: occurrenceStart, notified },
				summary: `${what}${told(notified.length)}.`,
				undo: null,
				...(warnings.length ? { warnings } : {}),
			};
		}
		throw new ToolError("conflict", "The event changed while it was being saved. Read it again and retry.");
	},
});
