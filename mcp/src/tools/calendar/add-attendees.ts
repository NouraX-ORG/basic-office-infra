/**
 * calendar_add_attendees (DESIGN 11.5): internal invitations only. Listed only while
 * CALENDAR_ATTENDEES=internal (the gate's "attendees" flag); needs the share scope; destructive.
 * 1. Each id is re-checked with a fresh sharees search for its uid: the same OCS search and rule as
 *    core's sharees.verify (an exact match of kind person; never the person themself or a local
 *    account). With privacy between organisations on, it finds only people who share a group with
 *    the person.
 * 2. Their address comes from the same search (shareWithDisplayNameUnique is the account email), so
 *    one search does both (fix round 2: the searches of one call go through one PeopleLookup,
 *    which counts them against the read limit up front, at most 3 for each person).
 *    NoCalendar delivers inside the workspace only to an address that belongs to exactly one
 *    account, so an address that the person can see on two accounts is refused (people.ts).
 * 3. The ORGANIZER is the person's own mailto: address from calendar-user-address-set. An event
 *    that already lists attendees but has no organizer (an imported one) is refused: adding the
 *    person as organizer would send it again to everyone on it.
 * 4. ATTENDEEs are added (PARTSTAT=NEEDS-ACTION, RSVP=TRUE), SEQUENCE goes up on every VEVENT, and
 *    the PUT goes with scheduling on, so NoCalendar puts the event into their calendar and inbox.
 * The result says who was invited (added to the event), not who received it: SCHEDULE-STATUS can't
 * prove delivery, because the email step runs after the delivery inside the workspace and
 * overwrites its code for events still to come (review fix round 1). Only a definite failure code
 * (3.x, 5.2) moves someone to not_invited. No email goes out while the workspace has no outgoing
 * mail (the server has none today); owner-yes "invitation email off" makes that permanent.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { parseTypedId } from "../../core/ids";
import { defineTool } from "../../core/tool";
import { type JComp, props, subs } from "../../pim/jcal";
import { ZoneResolver } from "../../pim/tz";
import { getObject, parseObjectId, putObject } from "./caldav";
import { loadHome, pickById } from "./common";
import { attendeesCutNote, deliveryFailed, ensureVtimezones, masterOf, scheduleStatuses, showEvent, touch } from "./events";
import { EMAIL_RE, PeopleLookup, type Person } from "./people";

interface Candidate {
	id: string;
	uid: string;
	name: string | null;
	email: string;
}

/**
 * Person ids only (fix round 3): core's shared typedIdSchema also lets "group:" and "team:" through,
 * which this tool would then refuse as a whole call, so the published schema said more than the tool
 * does. parseTypedId below still checks the id itself.
 */
export const personIdSchema = z.string().max(140).regex(/^person:.+$/, 'must look like "person:…"');

export const INVITED_NOTE = "Invited people find the event in NoCalendar, where they can accept or decline. No email goes out while workspace email is off.";

export const addAttendees = defineTool({
	name: "calendar_add_attendees",
	title: "Invite people to an event",
	description:
		"Invites workspace people (person ids from sharing_find_people) to one of the person's events; it appears in their NoCalendar to accept or decline. Nobody outside the workspace can be invited, and no email goes out while workspace email is off. Says who wasn't invited and why.",
	input: z
		.object({
			event_id: z.string().max(420).describe("From calendar_list_events."),
			attendees: z.array(personIdSchema).min(1).max(50).describe('"person:…" ids.'),
		})
		.strict(),
	async run(ctx, args) {
		if (ctx.cfg.calendarAttendees !== "internal") throw new ToolError("not_available", "Invitations are switched off in Nourax Workspace right now.");
		const ids = parseObjectId(args.event_id, "event_id", "event");
		const { principal, cals } = await loadHome(ctx.nc);
		pickById(cals, ids.calId, "events", true, "event_id");
		if (!principal.email) {
			throw new ToolError("not_available", "This person's account has no email address, which invitations need.", {
				hint: "An email address can be added to the Nourax account; then try again.",
			});
		}
		const mine = new Set(principal.addresses.map((a) => a.toLowerCase()));
		const lookup = new PeopleLookup(ctx);

		const wanted = [...new Set(args.attendees)];
		const notInvited: { id: string; reason: string }[] = [];
		const toCheck: { id: string; uid: string }[] = [];
		for (const raw of wanted) {
			const t = parseTypedId(raw, ["person"], "attendees");
			if (t.id === ctx.uid) notInvited.push({ id: raw, reason: "That is the person themself; the organizer needs no invitation." });
			else toCheck.push({ id: raw, uid: t.id });
		}
		// By uid, then by address and, when that finds nobody, by name: counted before any search runs.
		await lookup.reserve(3 * toCheck.length);
		const checked = await Promise.all(
			toCheck.map(async (c): Promise<Candidate | { id: string; reason: string }> => {
				const v = await lookup.byUid(c.uid);
				if (!v) return { id: c.id, reason: "Not found among the people this person can share with and invite." };
				const email = v.email;
				if (!email || !EMAIL_RE.test(email)) return { id: c.id, reason: "This person has no email address in the workspace, which an invitation needs." };
				if (mine.has(`mailto:${email.toLowerCase()}`)) return { id: c.id, reason: "This person's email address is the organizer's own." };
				// The address must lead back to this one person, as NoCalendar's own delivery needs: refused when
				// any other account the person can see has it too (fix round 1: two owners used to pass).
				const owners = await lookup.accountsByEmail(email, v.name);
				if (owners.some((o) => o.uid !== c.uid)) return { id: c.id, reason: "This person's email address belongs to another account too, so NoCalendar couldn't deliver to them." };
				return { id: c.id, uid: c.uid, name: v.name, email };
			}),
		);
		const valid: Candidate[] = [];
		for (const c of checked) {
			if ("reason" in c) notInvited.push(c);
			else valid.push(c);
		}

		let added: Candidate[] = [];
		let back: { cal: JComp; etag: string | null } | null = null;
		for (let attempt = 0; attempt < 2; attempt++) {
			const obj = await getObject(ctx.nc, ids.calId, ids.objId, "event");
			const work = JSON.parse(JSON.stringify(obj.cal)) as JComp;
			const { master } = masterOf(work);
			const comps = subs(work, "vevent");
			const org = props(master, "organizer")[0];
			const orgAddr = typeof org?.[3] === "string" ? org[3].toLowerCase() : null;
			if (orgAddr && !mine.has(orgAddr)) {
				throw new ToolError("permission_denied", "Only the event's organizer can invite people, and this person isn't its organizer.");
			}
			const present = new Set<string>();
			for (const c of comps) for (const p of props(c, "attendee")) if (typeof p[3] === "string") present.add(p[3].toLowerCase());
			if (!orgAddr && [...present].some((a) => !mine.has(a))) {
				throw new ToolError("invalid_input", "This event already lists people but has no organizer (it was probably imported), so inviting from here would send it to all of them again. Invite people in NoCalendar instead.", {
					field: "event_id",
				});
			}
			added = [];
			for (const v of valid) {
				if (present.has(`mailto:${v.email.toLowerCase()}`)) {
					if (attempt === 0) notInvited.push({ id: v.id, reason: "Already invited to this event." });
				} else added.push(v);
			}
			if (added.length === 0) break;
			const now = ctx.time.now();
			for (const c of comps) {
				if (!props(c, "organizer").length) {
					c[1].push(["organizer", principal.displayName ? { cn: principal.displayName.slice(0, 200) } : {}, "cal-address", `mailto:${principal.email}`]);
				}
				for (const v of added) {
					c[1].push([
						"attendee",
						{ ...(v.name ? { cn: v.name.slice(0, 200) } : {}), cutype: "INDIVIDUAL", role: "REQ-PARTICIPANT", partstat: "NEEDS-ACTION", rsvp: "TRUE" },
						"cal-address",
						`mailto:${v.email}`,
					]);
				}
				// A new attendee is a significant change (RFC 5546): SEQUENCE goes up (DESIGN 11.5).
				touch(c, now);
			}
			ensureVtimezones(work);
			const status = await putObject(ctx.nc, ids.calId, ids.objId, work, { ifMatch: obj.etag, scheduling: true });
			if (status !== 412) {
				back = await getObject(ctx.nc, ids.calId, ids.objId, "event");
				break;
			}
			if (attempt === 1) throw new ToolError("conflict", "The event changed while people were being invited. Try again.");
		}

		const invited: Person[] = [];
		if (back) {
			const statuses = scheduleStatuses(back.cal);
			for (const v of added) {
				if (deliveryFailed(statuses.get(v.email.toLowerCase()))) notInvited.push({ id: v.id, reason: "NoCalendar couldn't deliver the invitation to this person." });
				else invited.push({ id: v.id, display_name: v.name });
			}
		}
		const source = back ?? (await getObject(ctx.nc, ids.calId, ids.objId, "event"));
		const { master } = masterOf(source.cal);
		const shown = showEvent(master, new ZoneResolver(source.cal, ctx.time.zone), {
			calId: ids.calId,
			objId: ids.objId,
			etag: source.etag,
			uid: ctx.uid,
			driveOrigin: ctx.cfg.driveOrigin,
			zone: ctx.time.zone,
			seriesMember: false,
		});
		if (!shown) throw new ToolError("upstream_unavailable", "The event couldn't be read back. calendar_list_events shows it.");
		const cut = attendeesCutNote(shown.event);
		return {
			data: { event: shown.event, invited, not_invited: notInvited },
			summary: invited.length
				? `Invited ${invited.length} ${invited.length === 1 ? "person" : "people"} from the workspace (added to the event)${notInvited.length ? `; ${notInvited.length} not invited (see not_invited)` : ""}.`
				: "Nobody was invited; not_invited says why.",
			warnings: cut ? [INVITED_NOTE, cut] : [INVITED_NOTE],
			undo: null,
		};
	},
});
