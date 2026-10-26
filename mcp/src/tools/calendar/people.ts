/**
 * Workspace people behind attendee addresses (DESIGN 11.0 Person: { id: "person:<uid>",
 * display_name }), for `notified` in calendar_update_event and calendar_cancel_event and for the
 * checks of calendar_add_attendees.
 *
 * NoCalendar delivers inside the workspace only to an address that belongs to exactly one account,
 * which (with privacy between organisations on) shares a group with the organizer (Sabre's
 * Principal::findByUri, read in NC 35.0.2). The sharees search gives the same view of people: an
 * account matches an address when the account's own email (shareWithDisplayNameUnique) equals it.
 * With privacy on, full-match searches are off (shareapi_restrict_user_enumeration_full_match=no,
 * checked 2026-10-25), so the search is by the address first and then by the attendee's name, and
 * only an exact email match counts. Never the person themself, and only accounts the sharees rules
 * allow (Nourax accounts; QA accounts in dev only).
 *
 * Fix round 2:
 * - Who NoCalendar tells depends on who makes the change (Sabre's ITip Broker::parseEvent, read in
 *   NC 35.0.2): only the ORGANIZER's changes go to the invited people. An attendee's change of their
 *   own copy reaches nobody else (a removal tells the organizer they declined), and an event with no
 *   organizer is never scheduled. The server counts the person's own addresses and, in a calendar
 *   shared with them, also the calendar owner's. roleOf/schedulingRole work that out, so `notified`
 *   names people only when the person (or the calendar's owner) organises the event.
 * - Every sharees search of one tool call goes through one PeopleLookup: it remembers each search for
 *   the rest of the call and counts the searches against the person's read limit before they run
 *   (security review: 50 invitations used to make up to 200 uncounted searches on the server).
 */
import { isUuid, QA_UID_RE } from "../../core/ids";
import type { ToolCtx } from "../../core/tool";
import { type JComp, param, props, subs } from "../../pim/jcal";
import type { CalInfo } from "./caldav";
import { deliveryFailed } from "./events";

const SHAREES = "/ocs/v2.php/apps/files_sharing/api/v1/sharees";
export const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/;
/** At most this many addresses are looked up for one result. */
export const LOOKUPS_MAX = 50;
/** Searches one call makes within its own unit of the read limit; each further 5 count one more read. */
export const FREE_SEARCHES = 5;
export const SEARCHES_PER_READ = 5;
/** The most searches one attendee address can take (by address, then by name). */
export const SEARCHES_PER_ADDRESS = 2;

export interface Person {
	id: string;
	display_name: string | null;
}

interface RawUser {
	label?: unknown;
	value?: { shareType?: unknown; shareWith?: unknown };
	shareWithDisplayNameUnique?: unknown;
}

export interface Hit {
	uid: string;
	name: string | null;
	email: string | null;
}

function allowedUid(ctx: ToolCtx, uid: string): boolean {
	return uid !== ctx.uid && (isUuid(uid) || (ctx.cfg.env === "dev" && QA_UID_RE.test(uid)));
}

/** One sharees search for people (exact and other matches), as plain hits. */
async function searchPeople(ctx: ToolCtx, term: string): Promise<Hit[]> {
	const data = await ctx.nc.ocs.get<Record<string, unknown>>(SHAREES, { search: term, itemType: "file", "shareType[]": ["0"], perPage: 25, lookup: "false" });
	const exact = (data?.exact as Record<string, unknown> | undefined)?.users;
	const out: Hit[] = [];
	for (const list of [exact, data?.users]) {
		if (!Array.isArray(list)) continue;
		for (const u of list as RawUser[]) {
			if (u.value?.shareType !== 0 || typeof u.value.shareWith !== "string") continue;
			const unique = typeof u.shareWithDisplayNameUnique === "string" ? u.shareWithDisplayNameUnique : null;
			out.push({ uid: u.value.shareWith, name: typeof u.label === "string" ? u.label.slice(0, 200) : null, email: unique && EMAIL_RE.test(unique) ? unique : null });
		}
	}
	return out;
}

/** What one attendee address leads to. */
export type AddressMatch = { kind: "person"; person: Person } | { kind: "none" } | { kind: "shared" } | { kind: "not_allowed" };

/**
 * The sharees searches of one tool call: each term is searched once, and the searches are counted
 * against the person's read limit (one read for every SEARCHES_PER_READ beyond FREE_SEARCHES).
 * reserve() counts them up front, so a tool can be refused before it writes anything; a search
 * beyond what was reserved reserves one more itself.
 */
export class PeopleLookup {
	private readonly memo = new Map<string, Promise<Hit[]>>();
	private reserved = 0;
	private units = 0;
	/** Searches sent to NoDrive in this call. */
	searches = 0;
	constructor(private readonly ctx: ToolCtx) {}

	async reserve(n: number): Promise<void> {
		this.reserved += Math.max(0, Math.ceil(n));
		const need = Math.ceil(Math.max(0, this.reserved - FREE_SEARCHES) / SEARCHES_PER_READ);
		if (need > this.units) {
			const add = need - this.units;
			this.units = need;
			await this.ctx.charge("read", add);
		}
	}

	search(term: string): Promise<Hit[]> {
		const t = term.slice(0, 200);
		let p = this.memo.get(t);
		if (!p) {
			p = (async () => {
				if (this.searches >= this.reserved) await this.reserve(1);
				this.searches++;
				return searchPeople(this.ctx, t);
			})();
			this.memo.set(t, p);
		}
		return p;
	}

	/** The one person a sharees search finds by uid (exact match, kind person, as core's verify), or null. */
	async byUid(uid: string): Promise<Hit | null> {
		if (!allowedUid(this.ctx, uid)) return null;
		for (const h of await this.search(uid)) if (h.uid === uid) return h;
		return null;
	}

	/**
	 * Every account this person can see whose account email is exactly `email`: searched by the
	 * address first and, when that finds nobody, by the attendee's name. Two or more means NoCalendar
	 * would deliver to none of them (Principal::findByUri needs exactly one).
	 */
	async accountsByEmail(email: string, name: string | null = null): Promise<{ uid: string; name: string | null }[]> {
		if (!EMAIL_RE.test(email)) return [];
		const want = email.toLowerCase();
		const terms = [email, ...(name && name.trim() && name.trim().toLowerCase() !== want ? [name.trim()] : [])];
		for (const term of terms) {
			const hits = new Map<string, Hit>();
			for (const h of await this.search(term)) if (h.email?.toLowerCase() === want) hits.set(h.uid, h);
			if (hits.size) return [...hits.values()].map((h) => ({ uid: h.uid, name: h.name }));
		}
		return [];
	}

	/** Who an attendee address leads to: one person, nobody, an address on two or more accounts, or someone not allowed. */
	async matchAddress(email: string, name: string | null = null): Promise<AddressMatch> {
		const hits = await this.accountsByEmail(email, name);
		if (hits.length > 1) return { kind: "shared" };
		const hit = hits[0];
		if (!hit) return { kind: "none" };
		return allowedUid(this.ctx, hit.uid) ? { kind: "person", person: { id: `person:${hit.uid}`, display_name: hit.name } } : { kind: "not_allowed" };
	}
}

/**
 * Attendees (address and name) as workspace people. `unmatched` counts the addresses that matched
 * nobody this person can see, `shared` those on two or more accounts (NoCalendar delivers to none
 * of them) and `unchecked` those beyond LOOKUPS_MAX; `failed` is true when the lookups themselves
 * failed (then nothing is claimed). Each address is looked up once.
 */
export async function peopleOf(
	lookup: PeopleLookup,
	attendees: readonly { email: string; name: string | null }[],
): Promise<{ people: Person[]; unmatched: number; shared: number; unchecked: number; failed: boolean }> {
	const seen = new Set<string>();
	const todo: { email: string; name: string | null }[] = [];
	for (const a of attendees) {
		const k = a.email.toLowerCase();
		if (seen.has(k)) continue;
		seen.add(k);
		todo.push(a);
	}
	const unchecked = Math.max(0, todo.length - LOOKUPS_MAX);
	let found: AddressMatch[];
	try {
		found = await Promise.all(todo.slice(0, LOOKUPS_MAX).map((a) => lookup.matchAddress(a.email, a.name)));
	} catch {
		return { people: [], unmatched: 0, shared: 0, unchecked: 0, failed: true };
	}
	const people: Person[] = [];
	const ids = new Set<string>();
	let shared = 0;
	let unmatched = 0;
	for (const f of found) {
		if (f.kind === "shared") shared++;
		else if (f.kind !== "person") unmatched++;
		else if (!ids.has(f.person.id)) {
			ids.add(f.person.id);
			people.push(f.person);
		}
	}
	return { people, unmatched, shared, unchecked, failed: false };
}

/** The attendee addresses of every VEVENT in an object (not those in `exclude`), with NoCalendar's code. */
export function attendeeAddresses(cal: JComp, exclude: ReadonlySet<string>): { email: string; name: string | null; code: string | null }[] {
	const out = new Map<string, { email: string; name: string | null; code: string | null }>();
	for (const v of subs(cal, "vevent")) {
		for (const p of props(v, "attendee")) {
			const addr = typeof p[3] === "string" ? p[3] : "";
			if (!/^mailto:/i.test(addr) || exclude.has(addr.toLowerCase())) continue;
			const email = addr.slice(7).slice(0, 254);
			const k = email.toLowerCase();
			const code = param(p, "schedule-status");
			const seen = out.get(k);
			// A definite failure on any occurrence counts (deliveryFailed); otherwise the first code.
			if (!seen) out.set(k, { email, name: param(p, "cn"), code });
			else if (code && deliveryFailed(code)) seen.code = code;
		}
	}
	return [...out.values()];
}

/** The searches notifiedPeople may make for an object, for PeopleLookup.reserve before a write. */
export function notifySearches(cal: JComp, exclude: ReadonlySet<string>): number {
	return SEARCHES_PER_ADDRESS * Math.min(LOOKUPS_MAX, attendeeAddresses(cal, exclude).length);
}

/**
 * Who NoCalendar was asked to tell about a change, as Person ids, plus plain warnings. SCHEDULE-STATUS
 * proves no delivery: the email step runs after the delivery inside the workspace and overwrites its
 * code for events still to come (review fix round 1), so only a definite failure (3.x, 5.2) is
 * believed. Attendees who match nobody this person can see are counted, never claimed. Call it only
 * when the person (or the calendar's owner) organises the event (schedulingRole).
 */
export async function notifiedPeople(lookup: PeopleLookup, cal: JComp, exclude: ReadonlySet<string>, opts: { codes?: boolean } = {}): Promise<{ notified: Person[]; warnings: string[] }> {
	const all = attendeeAddresses(cal, exclude);
	if (!all.length) return { notified: [], warnings: [] };
	const useCodes = opts.codes !== false;
	const failed = useCodes ? all.filter((a) => deliveryFailed(a.code ?? undefined)) : [];
	const rest = useCodes ? all.filter((a) => !deliveryFailed(a.code ?? undefined)) : all;
	const { people, unmatched, shared, unchecked, failed: lookupFailed } = await peopleOf(lookup, rest);
	const warnings: string[] = [];
	const n = (k: number, noun: string) => `${k} ${noun}${k === 1 ? "" : "s"}`;
	if (lookupFailed) warnings.push("Which invited people were told couldn't be checked just now.");
	if (unmatched > 0) {
		warnings.push(
			`${n(unmatched, "attendee")} ${unmatched === 1 ? "isn't" : "aren't"} anyone this person can find in the workspace; NoCalendar tells only workspace accounts, and no email goes out while workspace email is off.`,
		);
	}
	if (shared > 0) warnings.push(`${n(shared, "attendee")} ${shared === 1 ? "has an email address" : "have email addresses"} that another account has too, so NoCalendar can't tell ${shared === 1 ? "them" : "those people"}.`);
	if (unchecked > 0) warnings.push(`${n(unchecked, "more attendee")} ${unchecked === 1 ? "wasn't" : "weren't"} looked up, so ${unchecked === 1 ? "isn't" : "aren't"} listed.`);
	if (failed.length) warnings.push(`NoCalendar couldn't tell ${n(failed.length, "attendee")} inside the workspace.`);
	return { notified: lookupFailed ? [] : people, warnings };
}

/** The person's part in an event, as NoCalendar's scheduling sees it. */
export type Role = "organizer" | "attendee" | "other" | "no_organizer";

/** The ORGANIZER address (lower case) and the person's part, from the object alone. */
export function roleOf(cal: JComp, mine: ReadonlySet<string>): { role: Role; organizer: string | null } {
	let organizer: string | null = null;
	let attendee = false;
	for (const v of subs(cal, "vevent")) {
		const org = props(v, "organizer")[0];
		if (!organizer && typeof org?.[3] === "string") organizer = org[3].toLowerCase();
		for (const p of props(v, "attendee")) if (typeof p[3] === "string" && mine.has(p[3].toLowerCase())) attendee = true;
	}
	if (organizer && mine.has(organizer)) return { role: "organizer", organizer };
	if (!organizer) return { role: "no_organizer", organizer };
	return { role: attendee ? "attendee" : "other", organizer };
}

export interface SchedulingRole {
	role: Role;
	/** True when NoCalendar passes this person's changes on to the invited people. */
	tellsInvited: boolean;
	/** Addresses never listed as told: the person's own and the organizer's. */
	exclude: Set<string>;
}

/**
 * roleOf plus the calendar's owner: in a calendar shared with the person, NoCalendar also counts the
 * owner's addresses (NC 35.0.2 Schedule\Plugin::calendarObjectChange), so an event the owner
 * organises is passed on to its invited people. The owner's address comes from one sharees search.
 */
export async function schedulingRole(lookup: PeopleLookup, cal: JComp, mine: ReadonlySet<string>, calendar: CalInfo): Promise<SchedulingRole> {
	const { role, organizer } = roleOf(cal, mine);
	const exclude = new Set(mine);
	if (organizer) exclude.add(organizer);
	if (role === "organizer") return { role, tellsInvited: true, exclude };
	if (organizer && calendar.sharedBy) {
		const owner = await lookup.byUid(calendar.sharedBy).catch(() => null);
		if (owner?.email && `mailto:${owner.email}`.toLowerCase() === organizer) return { role: "organizer", tellsInvited: true, exclude };
	}
	return { role, tellsInvited: false, exclude };
}

/**
 * Whether NoCalendar would send the organizer a decline when this attendee removes their copy (or
 * one occurrence of it): not when the copy is already cancelled or they declined already (Sabre's
 * parseEventForAttendee sends nothing for a cancelled event, nor for an unchanged answer).
 */
export function declineWouldGo(cal: JComp, mine: ReadonlySet<string>): boolean {
	const master = subs(cal, "vevent").find((v) => !props(v, "recurrence-id").length) ?? subs(cal, "vevent")[0];
	if (!master) return false;
	const status = props(master, "status")[0]?.[3];
	if (typeof status === "string" && status.toUpperCase() === "CANCELLED") return false;
	const me = props(master, "attendee").find((p) => typeof p[3] === "string" && mine.has(p[3].toLowerCase()));
	if (!me) return false;
	return (param(me, "partstat") ?? "NEEDS-ACTION").toUpperCase() !== "DECLINED";
}

/** Plain words for a change NoCalendar passes on to nobody, by the person's part in the event. */
export function notToldWarning(role: Role, what: "change" | "mark" | "remove" | "remove_one", declineSent: boolean): string {
	if (role === "attendee") {
		if (what === "remove" || what === "remove_one") {
			const gone = what === "remove" ? "It was taken out of this person's own calendar" : "This occurrence was taken out of this person's own copy";
			return `This person is invited to this event, not its organizer. ${gone}; ${declineSent ? "NoCalendar tells the organizer that they declined (if the organizer is in the workspace)" : "the organizer isn't told"}.`;
		}
		if (what === "mark") return 'This person is invited to this event, not its organizer, so it is marked cancelled in their own copy only and nobody else is told. mode "remove" takes it out of their calendar and tells the organizer they declined.';
		return "This person is invited to this event, not its organizer, so the change is in their own copy only; the organizer and the other invited people don't see it.";
	}
	if (role === "no_organizer") return "This event lists people but has no organizer, so NoCalendar tells nobody about this.";
	return "This event's organizer is someone else and this person isn't among the people invited, so NoCalendar tells nobody about this.";
}
