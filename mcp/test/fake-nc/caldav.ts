/**
 * Lane D's part of the fake (DESIGN 17.3): CalDAV for NoCalendar and NoTasks, plus the sharees
 * search the invitation tool uses. Shapes follow what NC 35.0.2 answered live on 2026-10-25:
 * - jCal both ways; a PUT answers 201/204 with no ETag; GET gives the ETag;
 * - calendar-query and calendar-multiget with <expand> return each occurrence as its own VEVENT in
 *   UTC with a RECURRENCE-ID and no RRULE (repeats are expanded here with ical.js);
 * - scheduling, as Sabre's ITip Broker::parseEvent does it (NC 35.0.2): only a change made by the
 *   ORGANIZER goes to the attendees (the writer's address, plus the calendar owner's in a shared
 *   calendar, must be the organizer's); an attendee deleting their copy sends the organizer a
 *   decline ("reply"); an event with no organizer is never scheduled. An attendee who is a workspace
 *   person sharing a group with the organizer gets a copy in their "personal" calendar;
 *   SCHEDULE-STATUS then reads "5.0" (the email step after local delivery fails), unless a test
 *   sets scheduleStatusFor;
 * - X-NC-Scheduling: false skips all of that; DELETE puts the object in the calendar trash;
 * - a MOVE into a task-only list is accepted (as the real server does), so the tool must refuse it;
 * - a shared calendar's owner name is {http://nextcloud.com/ns}owner-displayname (CalDavBackend's
 *   NS_NEXTCLOUD), not the files props' http://nextcloud.org/ns.
 */
import ICAL from "ical.js";
import { childEl, childEls, parseXml, type XmlEl } from "../../src/core/xml";
import type { JComp } from "../../src/pim/jcal";
import { vtimezoneFor } from "../../src/pim/tz";
import { type FakeNc, ocs, type Recorded } from "./index";

export interface FakeObject {
	jcal: JComp;
	etag: string;
}

export interface FakeCalendar {
	uri: string;
	displayname: string;
	color?: string;
	comps: string[];
	transparent?: boolean;
	order?: number;
	owner: string;
	ownerName?: string;
	readOnly?: boolean;
	subscription?: boolean;
	timezone?: string;
	/** Published by link: its cs:publish-url. */
	publishUrl?: string;
	objects: Map<string, FakeObject>;
}

export interface Delivery {
	to: string;
	uid: string;
	kind: "request" | "cancel" | "reply";
}

const CAL = "urn:ietf:params:xml:ns:caldav";
const D = "DAV:";

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function multistatus(responses: string[]): Response {
	return new Response(
		`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">${responses.join("")}</d:multistatus>`,
		{ status: 207, headers: { "content-type": "application/xml; charset=utf-8" } },
	);
}

function okProps(href: string, props: string): string {
	return `<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function prop(c: JComp, name: string): JComp[1][number] | undefined {
	return c[1].find((p) => p[0] === name);
}

function utc(ms: number): string {
	return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

function ymd(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** Registers every TZID an object uses (its VTIMEZONEs, else the IANA block) with ical.js. */
function registerZones(cal: JComp): void {
	for (const c of cal[2]) {
		if (c[0] === "vtimezone") {
			const id = prop(c, "tzid")?.[3];
			if (typeof id === "string" && !ICAL.TimezoneService.has(id)) ICAL.TimezoneService.register(new ICAL.Component(clone(c) as unknown as unknown[]));
		}
	}
	for (const c of cal[2]) {
		for (const p of c[1]) {
			const tz = (p[1] as Record<string, unknown>).tzid;
			if (typeof tz === "string" && !ICAL.TimezoneService.has(tz)) {
				const block = vtimezoneFor(tz);
				if (block) ICAL.TimezoneService.register(new ICAL.Component(clone(block) as unknown as unknown[]));
			}
		}
	}
}

interface Instance {
	start: number;
	end: number;
	allDay: boolean;
	rid: { ms: number; date: boolean } | null;
	comp: JComp;
}

/** Every VEVENT occurrence of an object overlapping [from, to). */
export function instancesOf(cal: JComp, from: number, to: number, kind = "vevent"): Instance[] {
	registerZones(cal);
	const vcal = new ICAL.Component(clone(cal) as unknown as unknown[]);
	const all = vcal.getAllSubcomponents(kind);
	const master = all.find((c) => !c.hasProperty("recurrence-id")) ?? all[0];
	if (!master) return [];
	const out: Instance[] = [];
	const ms = (t: InstanceType<typeof ICAL.Time>) => t.toUnixTime() * 1000;
	if (kind === "vtodo") {
		out.push({ start: 0, end: 0, allDay: false, rid: null, comp: master.toJSON() as unknown as JComp });
		return out;
	}
	const ev = new ICAL.Event(master, { exceptions: all.filter((c) => c !== master) });
	if (!ev.isRecurring()) {
		for (const c of all) {
			const e = new ICAL.Event(c);
			const s = ms(e.startDate);
			const en = e.endDate ? ms(e.endDate) : s;
			if ((en > from && s < to) || (en === s && s >= from && s < to)) {
				out.push({ start: s, end: en, allDay: e.startDate.isDate, rid: c.hasProperty("recurrence-id") ? { ms: ms(c.getFirstPropertyValue("recurrence-id") as InstanceType<typeof ICAL.Time>), date: false } : null, comp: c.toJSON() as unknown as JComp });
			}
		}
		return out;
	}
	const it = ev.iterator();
	for (let i = 0; i < 5000; i++) {
		const next = it.next();
		if (!next || ms(next) >= to) break;
		const det = ev.getOccurrenceDetails(next);
		const s = ms(det.startDate);
		const e = ms(det.endDate);
		if (e > from && s < to) {
			out.push({ start: s, end: e, allDay: det.startDate.isDate, rid: { ms: ms(det.recurrenceId), date: det.recurrenceId.isDate }, comp: det.item.component.toJSON() as unknown as JComp });
		}
	}
	return out;
}

function expandObject(cal: JComp, from: number, to: number): JComp {
	const out: JComp = ["vcalendar", [["prodid", {}, "text", "-//Sabre//Sabre VObject 4.5.6//EN"], ["calscale", {}, "text", "GREGORIAN"], ["version", {}, "text", "2.0"]], []];
	for (const inst of instancesOf(cal, from, to)) {
		const c = clone(inst.comp);
		c[1] = c[1].filter((p) => !["rrule", "rdate", "exdate", "exrule", "dtstart", "dtend", "duration", "recurrence-id"].includes(p[0]));
		c[1].push(inst.allDay ? ["dtstart", {}, "date", ymd(inst.start)] : ["dtstart", {}, "date-time", utc(inst.start)]);
		c[1].push(inst.allDay ? ["dtend", {}, "date", ymd(inst.end)] : ["dtend", {}, "date-time", utc(inst.end)]);
		if (inst.rid) c[1].push(inst.rid.date ? ["recurrence-id", {}, "date", ymd(inst.rid.ms)] : ["recurrence-id", {}, "date-time", utc(inst.rid.ms)]);
		out[2].push(c);
	}
	return out;
}

function caldavTime(s: string | undefined): number | null {
	const m = s ? /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s) : null;
	return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : null;
}

function find(el: XmlEl, ns: string, local: string): XmlEl | undefined {
	if (el.ns === ns && el.local === local) return el;
	for (const c of el.children) {
		const f = find(c, ns, local);
		if (f) return f;
	}
	return undefined;
}

export class FakeCalDav {
	homes = new Map<string, Map<string, FakeCalendar>>();
	trash: { uid: string; cal: string; obj: string; jcal: JComp }[] = [];
	deliveries: Delivery[] = [];
	/** Tests may override the SCHEDULE-STATUS the server writes for an address. */
	scheduleStatusFor: ((email: string) => string | undefined) | null = null;
	/** Calendars whose REPORT answers 500 (to test "couldn't be read"). */
	failReport = new Set<string>();
	private n = 0;

	constructor(private readonly fake: FakeNc) {}

	home(uid: string): Map<string, FakeCalendar> {
		let h = this.homes.get(uid);
		if (!h) {
			h = new Map();
			this.homes.set(uid, h);
			this.addCalendar(uid, { uri: "personal", displayname: "Personal", comps: ["VEVENT", "VTODO", "VJOURNAL"], order: 0, color: "#0082c9" });
		}
		return h;
	}

	addCalendar(uid: string, c: Partial<FakeCalendar> & { uri: string; displayname: string; comps: string[] }): FakeCalendar {
		const h = this.homes.get(uid) ?? (this.homes.set(uid, new Map()), this.homes.get(uid) as Map<string, FakeCalendar>);
		const cal: FakeCalendar = { owner: uid, objects: new Map(), ...c };
		h.set(c.uri, cal);
		return cal;
	}

	put(uid: string, calUri: string, objId: string, jcal: JComp): FakeObject {
		const o = { jcal: clone(jcal), etag: this.etag() };
		this.home(uid).get(calUri)?.objects.set(objId, o);
		return o;
	}

	get(uid: string, calUri: string, objId: string): FakeObject | undefined {
		return this.home(uid).get(calUri)?.objects.get(objId);
	}

	etag(): string {
		this.n++;
		return `"etag${this.n.toString(16).padStart(28, "0")}"`;
	}

	private shareGroup(a: string, b: string): boolean {
		const ga = new Set((this.fake.users.get(a)?.groups ?? []).filter((g) => g !== "admin"));
		return (this.fake.users.get(b)?.groups ?? []).some((g) => ga.has(g));
	}

	private userByEmail(email: string): string | null {
		const hits = [...this.fake.users.values()].filter((u) => u.email?.toLowerCase() === email.toLowerCase());
		return hits.length === 1 ? (hits[0]?.uid ?? null) : null;
	}

	/**
	 * Internal scheduling. `writer` makes the change in a calendar owned by `owner` (the same person
	 * unless the calendar is shared with the writer).
	 */
	private schedule(writer: string, owner: string, jcal: JComp, kind: "request" | "cancel", previous?: JComp): void {
		const uidProp = jcal[2].find((c) => c[0] === "vevent");
		const eventUid = String(uidProp ? (prop(uidProp, "uid")?.[3] ?? "") : "");
		const addrs = new Set(
			[writer, owner]
				.map((u) => this.fake.users.get(u)?.email)
				.filter((e): e is string => Boolean(e))
				.map((e) => `mailto:${e.toLowerCase()}`),
		);
		const vevents = jcal[2].filter((c) => c[0] === "vevent");
		const orgProp = vevents.map((v) => prop(v, "organizer")).find((p) => typeof p?.[3] === "string");
		const orgAddr = typeof orgProp?.[3] === "string" ? orgProp[3].toLowerCase() : null;
		// No organizer before or after the change: nothing to schedule.
		if (!orgAddr) return;
		if (!addrs.has(orgAddr)) {
			const isAttendee = vevents.some((v) => v[1].some((p) => p[0] === "attendee" && typeof p[3] === "string" && addrs.has(p[3].toLowerCase())));
			const master = vevents.find((v) => !prop(v, "recurrence-id")) ?? vevents[0];
			const cancelled = String(master ? (prop(master, "status")?.[3] ?? "") : "").toUpperCase() === "CANCELLED";
			const mine = master?.[1].find((p) => p[0] === "attendee" && typeof p[3] === "string" && addrs.has(p[3].toLowerCase()));
			const declined = String((mine?.[1] as Record<string, unknown> | undefined)?.partstat ?? "").toUpperCase() === "DECLINED";
			// An attendee deleting their copy declines, unless it is cancelled or declined already
			// (parseEventForAttendee); their other changes here change no PARTSTAT.
			if (isAttendee && kind === "cancel" && !cancelled && !declined) {
				const to = this.userByEmail(orgAddr.slice(7));
				if (to && to !== writer && this.shareGroup(writer, to) && !this.deliveries.some((d) => d.to === to && d.uid === eventUid && d.kind === "reply")) {
					this.deliveries.push({ to, uid: eventUid, kind: "reply" });
				}
			}
			// An attendee changing their own answer (PARTSTAT) sends the organizer a reply, as Sabre's
			// iTIP broker does (calendar_respond).
			if (isAttendee && kind === "request" && previous) {
				const partstats = (cal: JComp) =>
					cal[2]
						.filter((v) => v[0] === "vevent")
						.flatMap((v) => v[1].filter((p) => p[0] === "attendee" && typeof p[3] === "string" && addrs.has(p[3].toLowerCase())))
						.map((p) => String((p[1] as Record<string, unknown>).partstat ?? "NEEDS-ACTION").toUpperCase())
						.join(",");
				const to = this.userByEmail(orgAddr.slice(7));
				if (partstats(previous) !== partstats(jcal) && to && to !== writer && this.shareGroup(writer, to)) this.deliveries.push({ to, uid: eventUid, kind: "reply" });
			}
			return;
		}
		const organizer = this.userByEmail(orgAddr.slice(7)) ?? writer;
		for (const c of jcal[2]) {
			if (c[0] !== "vevent") continue;
			for (const p of c[1]) {
				if (p[0] !== "attendee" || typeof p[3] !== "string" || !/^mailto:/i.test(p[3])) continue;
				const email = p[3].slice(7);
				const to = this.userByEmail(email);
				const local = to && to !== organizer && this.shareGroup(organizer, to);
				if (local && to) {
					const copy = clone(jcal);
					for (const v of copy[2]) for (const a of v[1]) if (a[0] === "attendee") delete (a[1] as Record<string, unknown>)["schedule-status"];
					if (kind === "cancel") for (const v of copy[2]) if (v[0] === "vevent") v[1] = [...v[1].filter((x) => x[0] !== "status"), ["status", {}, "text", "CANCELLED"]];
					const personal = this.home(to).get("personal");
					personal?.objects.set(`sabredav-${eventUid}.ics`, { jcal: copy, etag: this.etag() });
					if (!this.deliveries.some((d) => d.to === to && d.uid === eventUid && d.kind === kind)) this.deliveries.push({ to, uid: eventUid, kind });
				}
				(p[1] as Record<string, unknown>)["schedule-status"] = this.scheduleStatusFor?.(email) ?? (local ? "5.0" : "5.0");
			}
		}
	}

	install(): void {
		const fake = this.fake;
		const unauth = () => new Response("", { status: 401 });
		const pathOf = (req: Recorded, m: RegExpExecArray) => ({ uid: decodeURIComponent(m[1] ?? ""), cal: m[2] ? decodeURIComponent(m[2]) : null, obj: m[3] ? decodeURIComponent(m[3]) : null, req });

		fake.on("PROPFIND", /^\/remote\.php\/dav\/principals\/users\/([^/]+)\/$/, (req, _f, m) => {
			if (!req.auth || req.auth !== decodeURIComponent(m[1] ?? "")) return unauth();
			const u = fake.users.get(req.auth);
			const addresses = [...(u?.email ? [`mailto:${u.email}`] : []), `/remote.php/dav/principals/users/${req.auth}/`];
			const home = this.home(req.auth);
			const def = home.has("personal") ? `<cal:schedule-default-calendar-URL><d:href>/remote.php/dav/calendars/${encodeURIComponent(req.auth)}/personal/</d:href></cal:schedule-default-calendar-URL>` : "";
			return multistatus([
				okProps(
					`/remote.php/dav/principals/users/${req.auth}/`,
					`<cal:calendar-home-set><d:href>/remote.php/dav/calendars/${encodeURIComponent(req.auth)}/</d:href></cal:calendar-home-set>${def}<cal:calendar-user-address-set>${addresses.map((a) => `<d:href>${esc(a)}</d:href>`).join("")}</cal:calendar-user-address-set><d:displayname>${esc(u?.displayName ?? req.auth)}</d:displayname>`,
				),
			]);
		});

		fake.on("PROPFIND", /^\/remote\.php\/dav\/calendars\/([^/]+)\/$/, (req, _f, m) => {
			const { uid } = pathOf(req, m);
			if (!req.auth || req.auth !== uid) return unauth();
			const base = `/remote.php/dav/calendars/${encodeURIComponent(uid)}/`;
			const priv = (w: boolean) => `<d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${w ? "<d:privilege><d:write/></d:privilege><d:privilege><d:write-content/></d:privilege><d:privilege><d:bind/></d:privilege>" : ""}</d:current-user-privilege-set>`;
			const out = [okProps(base, `<d:resourcetype><d:collection/></d:resourcetype>${priv(true)}`)];
			for (const c of this.home(uid).values()) {
				const rt = c.subscription ? "<d:collection/><cs:subscribed/>" : "<d:collection/><cal:calendar/>";
				const tz =
					(c.timezone ? `<cal:calendar-timezone>BEGIN:VCALENDAR&#13;\nBEGIN:VTIMEZONE&#13;\nTZID:${esc(c.timezone)}&#13;\nEND:VTIMEZONE&#13;\nEND:VCALENDAR</cal:calendar-timezone>` : "") +
					(c.publishUrl ? `<cs:publish-url><d:href>${esc(c.publishUrl)}</d:href></cs:publish-url>` : "");
				out.push(
					okProps(
						`${base}${encodeURIComponent(c.uri)}/`,
						`<d:displayname>${esc(c.displayname)}</d:displayname><d:resourcetype>${rt}</d:resourcetype><cal:supported-calendar-component-set>${c.comps.map((x) => `<cal:comp name="${x}"/>`).join("")}</cal:supported-calendar-component-set><cal:schedule-calendar-transp>${c.transparent ? "<cal:transparent/>" : "<cal:opaque/>"}</cal:schedule-calendar-transp>${priv(!c.readOnly)}${c.color ? `<x1:calendar-color xmlns:x1="http://apple.com/ns/ical/">${esc(c.color)}</x1:calendar-color>` : ""}<x1:calendar-order xmlns:x1="http://apple.com/ns/ical/">${c.order ?? 1}</x1:calendar-order><oc:owner-principal>principals/users/${esc(c.owner)}</oc:owner-principal>${c.ownerName ? `<x3:owner-displayname xmlns:x3="http://nextcloud.com/ns">${esc(c.ownerName)}</x3:owner-displayname>` : ""}${tz}`,
					),
				);
			}
			for (const special of ["inbox", "outbox"]) out.push(okProps(`${base}${special}/`, `<d:resourcetype><d:collection/><cal:schedule-${special}/></d:resourcetype>`));
			out.push(okProps(`${base}trashbin/`, `<d:resourcetype><d:collection/><x2:trash-bin xmlns:x2="http://nextcloud.com/ns"/></d:resourcetype>`));
			return multistatus(out);
		});

		// One calendar, Depth 0 (the handler's time-zone lookup reads its calendar-timezone).
		fake.on("PROPFIND", /^\/remote\.php\/dav\/calendars\/([^/]+)\/([^/]+)\/$/, (req, _f, m) => {
			const { uid, cal } = pathOf(req, m);
			if (!req.auth || req.auth !== uid) return unauth();
			const c = cal ? this.home(uid).get(cal) : undefined;
			if (!c) return new Response("", { status: 404 });
			const tz = c.timezone ? `<cal:calendar-timezone>BEGIN:VCALENDAR&#13;\nBEGIN:VTIMEZONE&#13;\nTZID:${esc(c.timezone)}&#13;\nEND:VTIMEZONE&#13;\nEND:VCALENDAR</cal:calendar-timezone>` : "";
			return multistatus([okProps(`/remote.php/dav/calendars/${encodeURIComponent(uid)}/${encodeURIComponent(c.uri)}/`, `<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>${tz}`)]);
		});

		fake.on("MKCALENDAR", /^\/remote\.php\/dav\/calendars\/([^/]+)\/([^/]+)\/$/, (req, _f, m) => {
			const { uid, cal } = pathOf(req, m);
			if (!req.auth || req.auth !== uid || !cal) return unauth();
			if (this.home(uid).has(cal)) return new Response("", { status: 405 });
			const root = parseXml(req.body);
			const name = find(root, D, "displayname")?.text ?? cal;
			const comps = childEls(find(root, CAL, "supported-calendar-component-set"), CAL, "comp").map((c) => c.attrs.name ?? "");
			const color = root ? find(root, "http://apple.com/ns/ical/", "calendar-color")?.text : undefined;
			this.addCalendar(uid, { uri: cal, displayname: name, comps: comps.length ? comps : ["VEVENT", "VTODO"], ...(color ? { color } : {}), order: 5 });
			return new Response("", { status: 201 });
		});

		// Extended MKCOL (RFC 5689): how the Worker makes a calendar, since workerd refuses MKCALENDAR.
		fake.on("MKCOL", /^\/remote\.php\/dav\/calendars\/([^/]+)\/([^/]+)\/$/, (req, _f, m) => {
			const { uid, cal } = pathOf(req, m);
			if (!req.auth || req.auth !== uid || !cal) return unauth();
			if (this.home(uid).has(cal)) return new Response("", { status: 405 });
			const root = parseXml(req.body);
			if (!find(root, CAL, "calendar")) return new Response("", { status: 403 });
			const comps = childEls(find(root, CAL, "supported-calendar-component-set"), CAL, "comp").map((c) => c.attrs.name ?? "");
			const color = find(root, "http://apple.com/ns/ical/", "calendar-color")?.text;
			this.addCalendar(uid, { uri: cal, displayname: find(root, D, "displayname")?.text ?? cal, comps: comps.length ? comps : ["VEVENT", "VTODO"], ...(color ? { color } : {}), order: 5 });
			return new Response("", { status: 201 });
		});

		fake.on("PUT", /^\/remote\.php\/dav\/calendars\/([^/]+)\/([^/]+)\/([^/]+)$/, (req, _f, m) => {
			const { uid, cal, obj } = pathOf(req, m);
			if (!req.auth || req.auth !== uid || !cal || !obj) return unauth();
			const c = this.home(uid).get(cal);
			if (!c) return new Response("", { status: 409 });
			if (c.readOnly) return new Response("", { status: 403 });
			if (!(req.headers.get("content-type") ?? "").startsWith("application/calendar+json")) return new Response("", { status: 415 });
			const existing = c.objects.get(obj);
			if (req.headers.get("if-none-match") === "*" && existing) return new Response("", { status: 412 });
			const im = req.headers.get("if-match");
			if (im && (!existing || existing.etag !== im)) return new Response("", { status: 412 });
			let jcal: JComp;
			try {
				jcal = JSON.parse(req.body) as JComp;
			} catch {
				return new Response("", { status: 400 });
			}
			if (!Array.isArray(jcal) || jcal[0] !== "vcalendar") return new Response("", { status: 415 });
			// NoCalendar's validation (checked live): DTSTART and DUE/DTEND must share a value type.
			for (const comp of jcal[2]) {
				const st = prop(comp, "dtstart")?.[2];
				const en = (prop(comp, "due") ?? prop(comp, "dtend"))?.[2];
				if (st && en && st !== en) return new Response("Validation error in iCalendar: The value type (DATE or DATE-TIME) must be identical", { status: 415 });
			}
			if (req.headers.get("x-nc-scheduling") !== "false") this.schedule(uid, c.owner, jcal, "request", existing?.jcal);
			c.objects.set(obj, { jcal, etag: this.etag() });
			return new Response(null, { status: existing ? 204 : 201, headers: { "content-type": "text/html; charset=UTF-8" } });
		});

		fake.on("GET", /^\/remote\.php\/dav\/calendars\/([^/]+)\/([^/]+)\/([^/]+)$/, (req, _f, m) => {
			const { uid, cal, obj } = pathOf(req, m);
			if (!req.auth || req.auth !== uid || !cal || !obj) return unauth();
			const o = this.home(uid).get(cal)?.objects.get(obj);
			if (!o) return new Response("", { status: 404 });
			return new Response(JSON.stringify(o.jcal), { status: 200, headers: { "content-type": "application/calendar+json", etag: o.etag } });
		});

		fake.on("DELETE", /^\/remote\.php\/dav\/calendars\/([^/]+)\/([^/]+)\/([^/]+)$/, (req, _f, m) => {
			const { uid, cal, obj } = pathOf(req, m);
			if (!req.auth || req.auth !== uid || !cal || !obj) return unauth();
			const c = this.home(uid).get(cal);
			const o = c?.objects.get(obj);
			if (!c || !o) return new Response("", { status: 404 });
			if (c.readOnly) return new Response("", { status: 403 });
			const im = req.headers.get("if-match");
			if (im && im !== o.etag) return new Response("", { status: 412 });
			if (req.headers.get("x-nc-scheduling") !== "false") this.schedule(uid, c.owner, o.jcal, "cancel");
			c.objects.delete(obj);
			this.trash.push({ uid, cal, obj, jcal: o.jcal });
			return new Response(null, { status: 204 });
		});

		fake.on("MOVE", /^\/remote\.php\/dav\/calendars\/([^/]+)\/([^/]+)\/([^/]+)$/, (req, _f, m) => {
			const { uid, cal, obj } = pathOf(req, m);
			if (!req.auth || req.auth !== uid || !cal || !obj) return unauth();
			const src = this.home(uid).get(cal);
			const o = src?.objects.get(obj);
			if (!src || !o) return new Response("", { status: 404 });
			const dest = new URL(req.headers.get("destination") ?? "").pathname;
			const dm = /^\/remote\.php\/dav\/calendars\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(dest);
			if (!dm || decodeURIComponent(dm[1] ?? "") !== uid) return new Response("", { status: 403 });
			const target = this.home(uid).get(decodeURIComponent(dm[2] ?? ""));
			if (!target) return new Response("", { status: 409 });
			const name = decodeURIComponent(dm[3] ?? "");
			if (target.objects.has(name) && req.headers.get("overwrite") === "F") return new Response("", { status: 412 });
			src.objects.delete(obj);
			target.objects.set(name, { jcal: o.jcal, etag: this.etag() });
			return new Response(null, { status: 201 });
		});

		fake.on("REPORT", /^\/remote\.php\/dav\/calendars\/([^/]+)\/([^/]+)\/$/, (req, _f, m) => {
			const { uid, cal } = pathOf(req, m);
			if (!req.auth || req.auth !== uid || !cal) return unauth();
			const c = this.home(uid).get(cal);
			if (!c) return new Response("", { status: 404 });
			if (this.failReport.has(cal)) return new Response("Sabre trace", { status: 500 });
			const root = parseXml(req.body);
			const expand = find(root, CAL, "expand");
			const from = caldavTime(expand?.attrs.start) ?? Number.NEGATIVE_INFINITY;
			const to = caldavTime(expand?.attrs.end) ?? Number.POSITIVE_INFINITY;
			const base = `/remote.php/dav/calendars/${encodeURIComponent(uid)}/${encodeURIComponent(cal)}/`;
			let picks: [string, FakeObject][] = [];
			if (root.local === "calendar-multiget") {
				for (const h of childEls(root, D, "href")) {
					const name = decodeURIComponent(h.text.trim().split("/").pop() ?? "");
					const o = c.objects.get(name);
					if (o) picks.push([name, o]);
				}
			} else {
				const filter = childEl(childEl(childEl(root, CAL, "filter"), CAL, "comp-filter"), CAL, "comp-filter");
				const kind = (filter?.attrs.name ?? "VEVENT").toLowerCase();
				const range = childEl(filter, CAL, "time-range");
				const rs = caldavTime(range?.attrs.start) ?? Number.NEGATIVE_INFINITY;
				const re = caldavTime(range?.attrs.end) ?? Number.POSITIVE_INFINITY;
				const completedUndefined = childEls(filter, CAL, "prop-filter").some((p) => p.attrs.name === "COMPLETED" && childEl(p, CAL, "is-not-defined"));
				picks = [...c.objects.entries()].filter(([, o]) => {
					const comps = o.jcal[2].filter((x) => x[0] === kind);
					if (!comps.length) return false;
					if (kind === "vtodo") return !(completedUndefined && comps.some((t) => prop(t, "completed")));
					return instancesOf(o.jcal, rs, re).length > 0;
				});
			}
			return multistatus(
				picks.map(([name, o]) => {
					const data = expand ? expandObject(o.jcal, from, to) : o.jcal;
					return okProps(`${base}${encodeURIComponent(name)}`, `<d:getetag>${esc(o.etag)}</d:getetag><cal:calendar-data>${esc(JSON.stringify(data))}</cal:calendar-data>`);
				}),
			);
		});

		fake.on("GET", /^\/ocs\/v2\.php\/apps\/files_sharing\/api\/v1\/sharees$/, (req) => {
			if (!req.auth) return unauth();
			const q = (req.url.searchParams.get("search") ?? "").toLowerCase();
			const users = [...fake.users.values()]
				.filter((u) => u.uid !== req.auth && this.shareGroup(req.auth as string, u.uid))
				.filter((u) => [u.uid, u.displayName, u.email ?? ""].some((s) => s.toLowerCase().includes(q)))
				.map((u) => ({ label: u.displayName, subline: "", icon: "icon-user", value: { shareType: 0, shareWith: u.uid }, shareWithDisplayNameUnique: u.email ?? u.uid, status: [] }));
			return ocs({ exact: { users: [], groups: [], remotes: [], remote_groups: [], emails: [], circles: [], rooms: [] }, users, groups: [], remotes: [], remote_groups: [], emails: [], lookup: [], circles: [], rooms: [], lookupEnabled: false });
		});
	}
}

/** Adds the CalDAV emulator to a fake and returns it. */
export function installCalDav(fake: FakeNc): FakeCalDav {
	const c = new FakeCalDav(fake);
	c.install();
	return c;
}
