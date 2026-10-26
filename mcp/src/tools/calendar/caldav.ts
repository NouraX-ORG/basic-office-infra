/**
 * CalDAV access for lane D (calendar and tasks; DESIGN 11.5 and 11.6), over core's egress-checked
 * NoDrive client. Every URL is built here, under /remote.php/dav/calendars/{uid}/, from ids that
 * our own list tools returned; an id is refused unless it is already in its canonical encoded
 * form, so it can never name another person's home, the calendar trash, the inbox or the outbox.
 */
import { ToolError } from "../../core/errors";
import { splitPairId } from "../../core/ids";
import { childEls, rawXml, xml, type XmlEl } from "../../core/xml";
import { type DavResponse, isCollection, key, NS, type Nc, parseMultistatus, propEl, propHrefs, propText, XMLNS } from "../../nc/index";
import { type JComp, parseJcal } from "../../pim/jcal";
import { caldavUtc, ianaOf } from "../../pim/tz";

/** Collections in the calendar home that are never calendars for our tools. */
const RESERVED = new Set(["inbox", "outbox", "trashbin", "contact_birthdays"]);
/** Calendars made by other apps that the tools leave alone (NoBoard's own due-date feed). */
const APP_GENERATED = /^app-generated--deck--/;
const SEG_OK = /^[A-Za-z0-9_.@%+=-]{1,200}$/;

/** The canonical encoded form of one path segment, or null when it can't be one. */
export function canonSeg(raw: string): string | null {
	let dec: string;
	try {
		dec = decodeURIComponent(raw);
	} catch {
		return null;
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
	if (!dec || dec === "." || dec === ".." || /[/\\\u0000-\u001f\u007f]/.test(dec)) return null;
	const enc = encodeURIComponent(dec).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return SEG_OK.test(enc) ? enc : null;
}

/** The last segment of an href (a collection's or an object's). */
export function lastSeg(href: string): string | null {
	let path = href;
	try {
		if (/^https?:\/\//i.test(href)) path = new URL(href).pathname;
	} catch {
		return null;
	}
	const parts = path.split("/").filter(Boolean);
	const seg = parts[parts.length - 1];
	return seg ? canonSeg(seg) : null;
}

export function homePath(uid: string): string {
	return `/remote.php/dav/calendars/${encodeURIComponent(uid)}/`;
}

export function calendarPath(uid: string, calId: string): string {
	return `${homePath(uid)}${calId}/`;
}

export function objectPath(uid: string, calId: string, objId: string): string {
	return `${homePath(uid)}${calId}/${objId}`;
}

function badId(field: string, what: string): ToolError {
	return new ToolError("invalid_input", `${field} isn't a valid ${what} id. Ids come from the list tools.`, { field });
}

/** A calendar or task-list id from tool input. */
export function parseCalendarId(raw: string, field = "calendar_id"): string {
	const c = canonSeg(raw);
	if (!c || c !== raw || RESERVED.has(raw.toLowerCase())) throw badId(field, "calendar");
	return c;
}

/** "<calendar_id>/<object name>" from tool input (event_id, task_id). */
export function parseObjectId(raw: string, field: string, what: "event" | "task"): { calId: string; objId: string } {
	let pair: { collection: string; object: string };
	try {
		pair = splitPairId(raw, field);
	} catch {
		throw badId(field, what);
	}
	const calId = canonSeg(pair.collection);
	const objId = canonSeg(pair.object);
	if (!calId || !objId || calId !== pair.collection || objId !== pair.object || RESERVED.has(calId.toLowerCase())) throw badId(field, what);
	return { calId, objId };
}

export interface CalInfo {
	/** calendar_id / list_id: the collection's canonical segment. */
	id: string;
	name: string;
	color: string | null;
	events: boolean;
	tasks: boolean;
	readOnly: boolean;
	/** The owner's uid when it isn't the person (a calendar shared with them). */
	sharedBy: string | null;
	sharedByName: string | null;
	isDefault: boolean;
	transparent: boolean;
	order: number;
	/** The calendar's own zone (calendar-timezone), when it names one we can read. */
	timezone: string | null;
	/** Published by link (cs:publish-url): anyone with the link sees its events (fix round 3). */
	published: boolean;
}

export interface PrincipalInfo {
	/** calendar-user-address-set values, for example "mailto:ana@example.org". */
	addresses: string[];
	email: string | null;
	defaultCalId: string | null;
	displayName: string | null;
}

const PRINCIPAL_BODY = `<?xml version="1.0" encoding="utf-8"?><d:propfind ${XMLNS}><d:prop><cal:calendar-user-address-set/><cal:schedule-default-calendar-URL/><d:displayname/></d:prop></d:propfind>`;

export async function principalInfo(nc: Nc): Promise<PrincipalInfo> {
	const res = await nc.dav.propfind(`/remote.php/dav/principals/users/${encodeURIComponent(nc.uid)}/`, 0, PRINCIPAL_BODY);
	const r = res[0];
	const addresses = r ? propHrefs(r, NS.cal, "calendar-user-address-set") : [];
	const mail = addresses.find((a) => /^mailto:/i.test(a));
	const def = r ? propHrefs(r, NS.cal, "schedule-default-calendar-URL")[0] : undefined;
	return {
		addresses,
		email: mail ? mail.slice(7) : null,
		defaultCalId: def ? lastSeg(def) : null,
		displayName: r ? propText(r, NS.d, "displayname") : null,
	};
}

/**
 * NoCalendar's own namespace for a calendar's owner name and trash time (CalDavBackend uses
 * Sharing\Plugin::NS_NEXTCLOUD for both, checked in NC 35.0.2's source). It isn't the
 * "http://nextcloud.org/ns" of the files props, so asking there gave an empty owner name (live review).
 */
export const NS_NC_COM = "http://nextcloud.com/ns";

/**
 * cs:publish-url comes back only for a calendar published by link (NC 35.0.2 PublishPlugin, read on
 * the server 2026-10-26: handled for every Calendar node, empty unless published).
 */
const HOME_BODY = `<?xml version="1.0" encoding="utf-8"?><d:propfind ${XMLNS} xmlns:x3="${NS_NC_COM}"><d:prop><d:displayname/><d:resourcetype/><cal:supported-calendar-component-set/><cal:schedule-calendar-transp/><d:current-user-privilege-set/><x1:calendar-color/><x1:calendar-order/><oc:owner-principal/><x3:owner-displayname/><cal:calendar-timezone/><x3:deleted-at/><cs:publish-url/></d:prop></d:propfind>`;

function hasChild(el: XmlEl | undefined, ns: string, local: string): boolean {
	return Boolean(el?.children.some((c) => c.ns === ns && c.local === local));
}

function privileges(r: DavResponse): Set<string> {
	const out = new Set<string>();
	for (const p of childEls(propEl(r, NS.d, "current-user-privilege-set"), NS.d, "privilege")) {
		for (const c of p.children) out.add(c.name);
	}
	return out;
}

function calendarTz(r: DavResponse): string | null {
	const t = propText(r, NS.cal, "calendar-timezone");
	const m = t ? /^TZID:(.{1,80})$/m.exec(t) : null;
	return m?.[1] ? ianaOf(m[1].trim()) : null;
}

/** Every calendar and task list in the person's home, shared ones included (not subscriptions). */
export async function listCalendars(nc: Nc, defaultCalId: string | null): Promise<CalInfo[]> {
	const res = await nc.dav.propfind(homePath(nc.uid), 1, HOME_BODY);
	const me = `principals/users/${nc.uid}`;
	const out: CalInfo[] = [];
	for (const r of res) {
		if (r.status && r.status >= 300) continue;
		const rt = propEl(r, NS.d, "resourcetype");
		if (!isCollection(r) || !hasChild(rt, NS.cal, "calendar") || hasChild(rt, NS.cs, "subscribed")) continue;
		if ((propText(r, NS_NC_COM, "deleted-at") ?? "").trim()) continue;
		const id = lastSeg(r.href);
		if (!id || RESERVED.has(id.toLowerCase()) || APP_GENERATED.test(id)) continue;
		const comps = childEls(propEl(r, NS.cal, "supported-calendar-component-set"), NS.cal, "comp").map((c) => (c.attrs.name ?? "").toUpperCase());
		// No component set means every component is allowed (RFC 4791 5.2.3).
		const events = comps.length === 0 || comps.includes("VEVENT");
		const tasks = comps.length === 0 || comps.includes("VTODO");
		if (!events && !tasks) continue;
		const priv = privileges(r);
		const writable = priv.has(key(NS.d, "all")) || priv.has(key(NS.d, "write")) || priv.has(key(NS.d, "write-content"));
		const owner = (propText(r, NS.oc, "owner-principal") ?? "").replace(/^\/?remote\.php\/dav\//, "").replace(/\/$/, "");
		const ownerUid = owner.startsWith("principals/users/") ? decodeURIComponentSafe(owner.slice("principals/users/".length)) : null;
		const shared = ownerUid !== null && owner !== me;
		const color = brandColor(propText(r, NS.apple, "calendar-color"));
		const order = Number(propText(r, NS.apple, "calendar-order") ?? "");
		out.push({
			id,
			name: (propText(r, NS.d, "displayname") ?? decodeURIComponentSafe(id) ?? id).slice(0, 200),
			color: color && /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(color) ? color.slice(0, 7).toUpperCase() : null,
			events,
			tasks,
			readOnly: !writable,
			sharedBy: shared ? ownerUid : null,
			sharedByName: shared ? ((propText(r, NS_NC_COM, "owner-displayname") ?? "").trim().slice(0, 200) || null) : null,
			isDefault: id === defaultCalId,
			transparent: hasChild(propEl(r, NS.cal, "schedule-calendar-transp"), NS.cal, "transparent"),
			order: Number.isFinite(order) ? order : 1000,
			timezone: calendarTz(r),
			published: (propEl(r, NS.cs, "publish-url")?.children ?? []).some((c) => c.local === "href" && c.text.trim() !== ""),
		});
	}
	return out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * The upstream product's own blues (#0082c9, #00679e: the old default calendar colours) are never
 * shown (brief rule 6); they become Nourax cobalt, as NoGantt's colours do.
 */
export function brandColor(c: string | null): string | null {
	if (!c) return null;
	const up = c.trim().toUpperCase();
	if (/^#(?:0082C9|00679E)(?:[0-9A-F]{2})?$/.test(up)) return "#2563EB";
	return up;
}

function decodeURIComponentSafe(s: string): string | null {
	try {
		return decodeURIComponent(s);
	} catch {
		return null;
	}
}

export interface CalObject {
	calId: string;
	objId: string;
	etag: string | null;
	cal: JComp;
}

/** calendar-query for VEVENTs overlapping [start, end), expanded into single occurrences. */
export function eventQueryBody(startMs: number, endMs: number): string {
	const s = caldavUtc(startMs);
	const e = caldavUtc(endMs);
	return xml`<?xml version="1.0" encoding="utf-8"?><cal:calendar-query ${rawXml(XMLNS)}><d:prop><d:getetag/><cal:calendar-data content-type="application/calendar+json"><cal:expand start="${s}" end="${e}"/></cal:calendar-data></d:prop><cal:filter><cal:comp-filter name="VCALENDAR"><cal:comp-filter name="VEVENT"><cal:time-range start="${s}" end="${e}"/></cal:comp-filter></cal:comp-filter></cal:filter></cal:calendar-query>`.xml;
}

/** calendar-query for VTODOs; `openOnly` asks the server for tasks without COMPLETED. */
export function todoQueryBody(openOnly: boolean): string {
	const filter = openOnly
		? `<cal:comp-filter name="VTODO"><cal:prop-filter name="COMPLETED"><cal:is-not-defined/></cal:prop-filter></cal:comp-filter>`
		: `<cal:comp-filter name="VTODO"/>`;
	return `<?xml version="1.0" encoding="utf-8"?><cal:calendar-query ${XMLNS}><d:prop><d:getetag/><cal:calendar-data content-type="application/calendar+json"/></d:prop><cal:filter><cal:comp-filter name="VCALENDAR">${filter}</cal:comp-filter></cal:filter></cal:calendar-query>`;
}

/** calendar-multiget of one object, expanded in a window (checks that an occurrence exists). */
export function multigetExpandBody(uid: string, calId: string, objId: string, startMs: number, endMs: number): string {
	return xml`<?xml version="1.0" encoding="utf-8"?><cal:calendar-multiget ${rawXml(XMLNS)}><d:prop><d:getetag/><cal:calendar-data content-type="application/calendar+json"><cal:expand start="${caldavUtc(startMs)}" end="${caldavUtc(endMs)}"/></cal:calendar-data></d:prop><d:href>${objectPath(uid, calId, objId)}</d:href></cal:calendar-multiget>`.xml;
}

function objectsOf(res: DavResponse[], calId: string): CalObject[] {
	const out: CalObject[] = [];
	for (const r of res) {
		if (r.status && r.status >= 300) continue;
		const objId = lastSeg(r.href);
		const data = propText(r, NS.cal, "calendar-data");
		if (!objId || !data) continue;
		let cal: JComp;
		try {
			cal = parseJcal(data);
		} catch {
			continue;
		}
		out.push({ calId, objId, etag: propText(r, NS.d, "getetag"), cal });
	}
	return out;
}

/**
 * A REPORT on one calendar, reading at most `maxBytes` of the answer (too_large beyond that).
 * Returns the objects and how many bytes the answer took, so a call over many calendars can keep
 * one memory budget for all of them (fan-out.ts).
 */
export async function reportCapped(nc: Nc, calId: string, body: string, maxBytes: number): Promise<{ objects: CalObject[]; bytes: number }> {
	const res = await nc.request("REPORT", calendarPath(nc.uid, calId), {
		headers: { "content-type": "application/xml; charset=utf-8", depth: "1" },
		body,
		what: "that calendar",
	});
	if (res.status === 204) {
		await res.body?.cancel();
		return { objects: [], bytes: 0 };
	}
	const raw = await nc.readBytes(res, maxBytes);
	return { objects: objectsOf(parseMultistatus(new TextDecoder().decode(raw)), calId), bytes: raw.byteLength };
}

/** One calendar object as jCal with its ETag. */
export async function getObject(nc: Nc, calId: string, objId: string, what: "event" | "task"): Promise<CalObject> {
	const res = await nc.dav.get(objectPath(nc.uid, calId, objId), { headers: { accept: "application/calendar+json" }, allow: [404] });
	if (res.status === 404) {
		await res.body?.cancel();
		throw new ToolError("not_found", what === "event" ? "There's no event with that event_id." : "There's no task with that task_id.", {
			hint: what === "event" ? "calendar_list_events finds events and their ids." : "tasks_list finds tasks and their ids.",
		});
	}
	const etag = res.headers.get("etag");
	const textBody = await nc.readText(res, 4 * 1024 * 1024);
	return { calId, objId, etag, cal: parseJcal(textBody) };
}

export interface WriteOpts {
	/** Send If-None-Match: * (a new object). */
	create?: boolean;
	ifMatch?: string | null;
	/** True lets NoCalendar tell attendees (internal scheduling); false sends X-NC-Scheduling: false. */
	scheduling: boolean;
}

/** PUT a calendar object as jCal. Returns the status; 412 is returned, not thrown. */
export async function putObject(nc: Nc, calId: string, objId: string, cal: JComp, o: WriteOpts): Promise<number> {
	const headers: Record<string, string> = { "content-type": "application/calendar+json" };
	if (o.create) headers["if-none-match"] = "*";
	else if (o.ifMatch) headers["if-match"] = o.ifMatch;
	if (!o.scheduling) headers["x-nc-scheduling"] = "false";
	try {
		const res = await nc.dav.put(objectPath(nc.uid, calId, objId), JSON.stringify(cal), { headers, allow: [412] });
		await res.body?.cancel();
		return res.status;
	} catch (e) {
		throw friendlyWriteError(e);
	}
}

export async function deleteObject(nc: Nc, calId: string, objId: string, o: { ifMatch?: string | null; scheduling: boolean }): Promise<number> {
	const headers: Record<string, string> = {};
	if (o.ifMatch) headers["if-match"] = o.ifMatch;
	if (!o.scheduling) headers["x-nc-scheduling"] = "false";
	try {
		const res = await nc.dav.delete(objectPath(nc.uid, calId, objId), { headers, allow: [404, 412] });
		await res.body?.cancel();
		return res.status;
	} catch (e) {
		throw friendlyWriteError(e);
	}
}

/** DAV MOVE of one object to another calendar of the person (never overwrites). */
export async function moveObject(nc: Nc, calId: string, objId: string, toCalId: string, ifMatch: string | null): Promise<number> {
	const headers: Record<string, string> = {};
	if (ifMatch) headers["if-match"] = ifMatch;
	try {
		const res = await nc.dav.move(objectPath(nc.uid, calId, objId), objectPath(nc.uid, toCalId, objId), { headers, overwrite: false, allow: [412] });
		await res.body?.cancel();
		return res.status;
	} catch (e) {
		throw friendlyWriteError(e);
	}
}

/** Plain words for refusals on calendar writes (the server's text is never shown). */
export function friendlyWriteError(e: unknown): unknown {
	if (!(e instanceof ToolError)) return e;
	if (e.code === "permission_denied") return new ToolError("permission_denied", "The person can't change items in that calendar; it is read-only for them.", { upstreamStatus: e.upstreamStatus });
	// 415 is how NoCalendar answers data it will not store (a validation error), not a file type.
	if (e.code === "invalid_input" || e.code === "unsupported_type") return new ToolError("invalid_input", "NoCalendar refused that change as invalid.", { upstreamStatus: e.upstreamStatus });
	if (e.code === "not_found") return new ToolError("not_found", "That item or calendar doesn't exist any more. List it again.", { upstreamStatus: e.upstreamStatus });
	if (e.code === "parent_missing") return new ToolError("not_found", "That calendar doesn't exist any more. calendar_list_calendars shows the calendars.", { upstreamStatus: e.upstreamStatus });
	return e;
}

/** A calendar's web link (NoCalendar), or the task list's (NoTasks). */
export function eventWebUrl(driveOrigin: string, uid: string, calId: string, objId: string, occurrenceUtcMs: number | null, dayFallback: string): string {
	// NoCalendar's own links are /apps/calendar/edit/<base64 of the object's href>[/<unix time>],
	// with the href as the server writes it (Sabre's path encoding). A "/" inside the base64 can't be
	// sent (the web server refuses encoded slashes), so such an event would link to its day instead.
	const b64 = btoa(`/remote.php/dav/calendars/${sabreSeg(encodeURIComponent(uid))}/${sabreSeg(calId)}/${sabreSeg(objId)}`);
	if (b64.includes("/")) return `${driveOrigin}/apps/calendar/timeGridDay/${dayFallback}`;
	return `${driveOrigin}/apps/calendar/edit/${b64}${occurrenceUtcMs !== null ? `/${Math.floor(occurrenceUtcMs / 1000)}` : ""}`;
}

/** A canonical segment in the server's own href encoding (Sabre leaves these characters as they are). */
export function sabreSeg(canonical: string): string {
	let dec: string;
	try {
		dec = decodeURIComponent(canonical);
	} catch {
		return canonical;
	}
	const enc = new TextEncoder();
	return dec.replace(/[^A-Za-z0-9_\-.~()'!$&+,;=@:]/gu, (ch) => [...enc.encode(ch)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""));
}

export function taskWebUrl(driveOrigin: string, listId: string, objId: string): string {
	return `${driveOrigin}/apps/tasks/calendars/${listId}/tasks/${objId}`;
}

/**
 * Whether NoCalendar's object can be moved or removed from here. The egress allowlist lets MOVE and
 * DELETE reach one event object whose name ends in ".ics" (never a collection); items saved by other
 * apps under other names can still be changed (PUT) but not moved or removed. Checked before
 * anything is written, so a change never half-happens (review fix round 1).
 */
export function movableName(objId: string): boolean {
	return /\.ics$/i.test(objId);
}

/** A new object name: a random UUID plus ".ics". */
export function newObjectId(): { uid: string; objId: string } {
	const uid = crypto.randomUUID();
	return { uid, objId: `${uid}.ics` };
}
