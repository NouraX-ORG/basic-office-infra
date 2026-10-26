/**
 * Shared pieces of the sharing tools (DESIGN 11.3), over the OCS files_sharing API v1 as served by
 * NC 35.0.2 (ShareAPIController, read on the server):
 * - shareType is only 0 (person), 1 (group), 3 (link) or 7 (team) when we create; email (4) and
 *   federated (6, 9) shares are never made. sendMail is always "false".
 * - Changing or deleting a share needs uid_owner (the person who made it) to be this person.
 * - Permission bits: 1 read, 2 update, 4 create, 8 delete, 16 share. Links never get delete from
 *   us; bit 16 on a link is the server's own federation flag and is masked when read back.
 * - Server texts are never shown: refusals are matched and replaced by our own sentences.
 * - With privacy between organisations on, Nourax teams are groups "team:<id>" and organisations
 *   are groups "org:<id>"; the Teams app (shareType 7) is off.
 */
import { z } from "zod";
import { isToolError, ToolError } from "../../core/errors";
import { numericId } from "../../core/ids";
import { LIMITS } from "../../core/limits";
import type { ToolCtx } from "../../core/tool";
import { cleanText } from "../../pim/vcard";
import { shown, shownOrNull } from "./bounded";

export const SHARES = "/ocs/v2.php/apps/files_sharing/api/v1/shares";

export const TYPE = { person: 0, group: 1, link: 3, email: 4, remote: 6, team: 7, remoteGroup: 9 } as const;
export const BIT = { read: 1, update: 2, create: 4, delete: 8, share: 16 } as const;

/** Shares with people may last longer than links; ten years is our sanity cap. */
export const PEOPLE_MAX_DAYS = 3660;

/** The bits a link gets, least privilege: view 1; edit 3 for a file, 7 for a folder (never delete); upload_only 4. */
export function linkBits(p: "view" | "edit" | "upload_only", folder: boolean): number {
	if (p === "view") return BIT.read;
	if (p === "edit") return folder ? BIT.read | BIT.update | BIT.create : BIT.read | BIT.update;
	return BIT.create;
}

/** The bits a share with people gets: view 1; edit 3 for a file, 7 for a folder; +8 delete (folders only); +16 reshare. */
export function peopleBits(p: "view" | "edit", canDelete: boolean, canReshare: boolean, folder: boolean): number {
	let bits: number = BIT.read;
	if (p === "edit") bits |= folder ? BIT.update | BIT.create : BIT.update;
	if (canDelete && folder) bits |= BIT.delete;
	if (canReshare) bits |= BIT.share;
	return bits;
}

export interface PeopleChange {
	permission?: "view" | "edit";
	can_delete?: boolean;
	can_reshare?: boolean;
}

/**
 * The bits a share with people gets from a sharing_update change (fix round 3). With permission
 * given, the access level is built again (peopleBits), and a flag that isn't given keeps its
 * current value. Without permission the current bits stay exactly as they are, because a share
 * made in the web page can hold access our levels don't name (read and create without update,
 * or read and update without create), and only the flags given change: 8 for can_delete (set on
 * folders only; NC 35's updateShare stores bits as sent and doesn't strip it from files) and 16
 * for can_reshare. The same function checks an undo: running it on the new bits must give back
 * the old ones.
 */
export function peopleTarget(current: number, change: PeopleChange, folder: boolean): number {
	if (change.permission !== undefined) {
		return peopleBits(change.permission, change.can_delete ?? (current & BIT.delete) !== 0, change.can_reshare ?? (current & BIT.share) !== 0, folder);
	}
	let bits = current;
	if (change.can_delete === true && folder) bits |= BIT.delete;
	if (change.can_delete === false) bits &= ~BIT.delete;
	if (change.can_reshare === true) bits |= BIT.share;
	if (change.can_reshare === false) bits &= ~BIT.share;
	return bits;
}

/** One share as the OCS API sends it (only the fields we read). */
export interface RawShare {
	id: string | number;
	share_type: number;
	uid_owner: string;
	displayname_owner?: string | null;
	permissions: number;
	stime?: number;
	expiration?: string | null;
	path?: string | null;
	item_type?: string;
	file_source?: number | string | null;
	share_with?: string | null;
	share_with_displayname?: string | null;
	url?: string | null;
	password?: string | null;
	hide_download?: number | boolean;
	label?: string | null;
	note?: string | null;
}

export type ShareKind = "link" | "person" | "group" | "team" | "email" | "other";
export type Access = "view" | "edit" | "upload_only" | "view_and_upload";

export const SharePersonOut = z.object({ id: z.string().nullable(), display_name: z.string().nullable() });

/**
 * How much of each text a share view shows (fix round 3). NC 35 keeps a share's note in an
 * unlimited text column and ShareAPIController doesn't check its length, so someone else's share
 * with a huge note could otherwise outgrow a whole result. The others are the server's own column
 * sizes (path 4,000, label and names 255), so they are never cut in practice.
 */
export const SHOWN_CHARS = { path: 4_096, name: 255, email: 320, label: 255, note: LIMITS.notesOutChars, url: 2_048 } as const;

export const ShareOut = z.object({
	share_id: z.string(),
	kind: z.enum(["link", "person", "group", "team", "email", "other"]),
	path: z.string().max(SHOWN_CHARS.path).nullable(),
	type: z.enum(["file", "folder"]),
	shared_with: SharePersonOut.nullable(),
	url: z.string().max(SHOWN_CHARS.url).nullable(),
	permission: z.enum(["view", "edit", "upload_only", "view_and_upload"]),
	can_delete: z.boolean(),
	can_reshare: z.boolean(),
	expires_on: z.string().nullable(),
	password_protected: z.boolean(),
	hide_download: z.boolean(),
	label: z.string().max(SHOWN_CHARS.label).nullable(),
	note: z.string().max(SHOWN_CHARS.note).nullable(),
	/** true when the note is longer than the 2,000 characters shown. */
	note_truncated: z.boolean(),
	created_at: z.string().nullable(),
	owner: SharePersonOut,
	mine: z.boolean(),
	web_url: z.string().nullable(),
});
export type ShareOut = z.infer<typeof ShareOut>;

/** Nourax teams and organisations are groups named "team:<id>" and "org:<id>". */
export function groupKind(gid: string): "team" | "group" {
	return gid.startsWith("team:") ? "team" : "group";
}

export function kindOf(raw: RawShare): ShareKind {
	switch (raw.share_type) {
		case TYPE.link:
			return "link";
		case TYPE.person:
			return "person";
		case TYPE.group:
			return groupKind(String(raw.share_with ?? ""));
		case TYPE.team:
			return "team";
		case TYPE.email:
			return "email";
		default:
			return "other";
	}
}

export function isLinkLike(raw: RawShare): boolean {
	return raw.share_type === TYPE.link || raw.share_type === TYPE.email;
}

/** What a permission number means, in our words. */
export function accessOf(raw: RawShare): { permission: Access; can_delete: boolean; can_reshare: boolean } {
	const link = isLinkLike(raw);
	const p = link ? raw.permissions & ~BIT.share : raw.permissions;
	const can_delete = (p & BIT.delete) !== 0;
	const can_reshare = !link && (p & BIT.share) !== 0;
	if (!(p & BIT.read)) return { permission: p & BIT.create ? "upload_only" : "view", can_delete, can_reshare };
	if (p & BIT.update) return { permission: "edit", can_delete, can_reshare };
	if (p & BIT.create) return { permission: "view_and_upload", can_delete, can_reshare };
	return { permission: "view", can_delete, can_reshare };
}

/** "2026-11-24 00:00:00" → "2026-11-24". */
export function dateOnly(s: string | null | undefined): string | null {
	const m = typeof s === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(s) : null;
	return m ? (m[1] as string) : null;
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

export function sharedWithOf(raw: RawShare): { id: string | null; display_name: string | null } | null {
	const w = str(raw.share_with);
	const name = shownOrNull(raw.share_with_displayname, SHOWN_CHARS.name);
	switch (raw.share_type) {
		case TYPE.link:
			return null;
		case TYPE.person:
			return { id: w ? `person:${w}` : null, display_name: name };
		case TYPE.group:
			return { id: w ? `group:${w}` : null, display_name: name };
		case TYPE.team:
			return { id: w ? `team:${w}` : null, display_name: name };
		case TYPE.email:
			return { id: null, display_name: shownOrNull(w, SHOWN_CHARS.email) };
		default:
			return { id: null, display_name: name };
	}
}

/**
 * One share as the tools show it. Its texts are display text, cut to SHOWN_CHARS (fix round 3);
 * undos and checks use the server's own values in `raw`, never these.
 */
export function shareView(ctx: ToolCtx, raw: RawShare): ShareOut {
	const a = accessOf(raw);
	const fileId = raw.file_source !== null && raw.file_source !== undefined && /^\d+$/.test(String(raw.file_source)) ? String(raw.file_source) : null;
	const note = typeof raw.note === "string" && raw.note.length > 0 ? shown(raw.note, SHOWN_CHARS.note, true) : null;
	return {
		share_id: String(raw.id),
		kind: kindOf(raw),
		path: shownOrNull(raw.path, SHOWN_CHARS.path),
		type: raw.item_type === "folder" ? "folder" : "file",
		shared_with: sharedWithOf(raw),
		url: raw.share_type === TYPE.link ? shownOrNull(raw.url, SHOWN_CHARS.url) : null,
		permission: a.permission,
		can_delete: a.can_delete,
		can_reshare: a.can_reshare,
		expires_on: dateOnly(raw.expiration),
		password_protected: isLinkLike(raw) && str(raw.password) !== null,
		hide_download: raw.hide_download === 1 || raw.hide_download === true,
		label: shownOrNull(raw.label, SHOWN_CHARS.label),
		note: note && note.text.length ? note.text : null,
		note_truncated: note?.cut ?? false,
		created_at: typeof raw.stime === "number" && raw.stime > 0 ? ctx.time.format(raw.stime * 1000) : null,
		owner: { id: `person:${raw.uid_owner}`, display_name: shownOrNull(raw.displayname_owner, SHOWN_CHARS.name) },
		mine: raw.uid_owner === ctx.uid,
		web_url: fileId ? `${ctx.cfg.driveOrigin}/f/${fileId}` : null,
	};
}

/** A share_id argument: the OCS id, a positive integer (given as text or a number). */
export const shareIdArg = () =>
	z.union([z.string().max(12), z.number().int().min(1).max(999_999_999_999)]).describe("From sharing_list.");

export function shareIdOf(v: string | number): string {
	return String(numericId(v, "share_id"));
}

/**
 * The answer for a share that is gone: getShare's own, and shareError's when NC 35 answers a PUT or
 * DELETE with 404 "Wrong share ID, share does not exist" (the share was stopped after getShare
 * read it, or by two calls at the same moment).
 */
export function noShare(id: string | undefined, upstreamStatus?: number): ToolError {
	const which = id === undefined ? "That share doesn't exist" : `There's no share with id ${id}`;
	return new ToolError("not_found", `${which} (it may have been stopped already). sharing_list shows the shares.`, { field: "share_id", upstreamStatus });
}

/** GET /shares/{id}: the share when this person can see it, else not_found. */
export async function getShare(ctx: ToolCtx, id: string): Promise<RawShare> {
	let data: unknown;
	try {
		data = await ctx.nc.ocs.get<unknown>(`${SHARES}/${id}`);
	} catch (e) {
		if (isToolError(e) && (e.code === "not_found" || e.upstreamStatus === 404)) throw noShare(id);
		throw e;
	}
	const raw = Array.isArray(data) ? data[0] : data;
	if (!raw || typeof raw !== "object" || typeof (raw as RawShare).uid_owner !== "string") {
		throw new ToolError("not_found", `There's no share with id ${id}. sharing_list shows the shares.`, { field: "share_id" });
	}
	return raw as RawShare;
}

/**
 * Every share on one item as this person sees it, other people's reshares of it included
 * (path=, reshares=true): what sharing_share_with looks at before it shares, and what
 * sharing_delete asks before it offers that call as an undo. Errors are the raw ones.
 */
export async function sharesOn(ctx: ToolCtx, path: string): Promise<RawShare[]> {
	const data = await ctx.nc.ocs.get<unknown>(SHARES, { path, reshares: "true" }, { what: path });
	return Array.isArray(data) ? (data as RawShare[]).filter((s) => s !== null && typeof s === "object") : [];
}

/** The share in `list` that already gives this recipient access the same way (type and id), if any. */
export function sameRecipient(list: readonly RawShare[], shareType: number, shareWith: string): RawShare | undefined {
	return list.find((s) => s.share_type === shareType && s.share_with === shareWith);
}

/** Changing or stopping a share is only for shares this person made (uid_owner). */
export function requireMine(ctx: ToolCtx, raw: RawShare): void {
	if (raw.uid_owner !== ctx.uid) {
		throw new ToolError("permission_denied", "Only shares the person made can be changed or stopped; this one was made by someone else.", { field: "share_id" });
	}
}

/** The OCS meta message of a refusal, for matching only. Never shown. */
export function ocsMessage(e: ToolError): string {
	if (!e.detail) return "";
	try {
		const j = JSON.parse(e.detail) as { ocs?: { meta?: { message?: unknown } } };
		return typeof j.ocs?.meta?.message === "string" ? j.ocs.meta.message : "";
	} catch {
		return "";
	}
}

/** The workspace's password rules, from the server's own refusal, in our words. */
export function passwordProblem(msg: string): string | null {
	const m = msg.toLowerCase();
	if (!m.includes("password")) return null;
	const len = /at least (\d+) characters/.exec(m);
	if (len) return `That password is too short for the workspace's password rules (at least ${len[1]} characters).`;
	if (m.includes("numeric")) return "That password doesn't meet the workspace's password rules: it needs at least one digit.";
	if (m.includes("special character")) return "That password doesn't meet the workspace's password rules: it needs at least one special character.";
	if (m.includes("upper case") || m.includes("lower and")) return "That password doesn't meet the workspace's password rules: it needs upper- and lower-case letters.";
	if (m.includes("common")) return "That password is too common for the workspace's password rules.";
	if (m.includes("compromised") || m.includes("breach")) return "That password appears in a list of leaked passwords; choose another one.";
	if (m.includes("enforced")) return "The workspace requires a password on links.";
	return "That password doesn't meet the workspace's password rules.";
}

export interface ShareErrorOptions {
	/**
	 * The share the call works on (sharing_update, sharing_delete). Every "not found" then means
	 * that share: NC 35's updateShare and deleteShare look up nothing else by id.
	 */
	shareId?: string;
	/**
	 * Added after a password-rule refusal. Only for a tool whose own input can follow it:
	 * sharing_create_link names generate_password; sharing_update has no such field, so it gives none.
	 */
	passwordHint?: string;
}

/** `what` at the start of a sentence: "the shared item" becomes "The shared item"; a path stays as it is. */
function sentence(what: string): string {
	return what.charAt(0).toUpperCase() + what.slice(1);
}

/**
 * Turns a refusal from the sharing API into one of our errors with our own words. `what` names the
 * item from the tool's own input (a path), or "the shared item", never text from the server.
 */
export function shareError(e: unknown, what: string, opts: ShareErrorOptions = {}): unknown {
	if (!isToolError(e)) return e;
	if (e.deadCredential || e.code === "reconnect_required" || e.code === "rate_limited" || e.code === "timeout") return e;
	const msg = ocsMessage(e);
	const m = msg.toLowerCase();
	const status = e.upstreamStatus;
	// NC 35: "Wrong share ID, share does not exist" (404) from getShare, updateShare and deleteShare.
	// Matched before the path texts below, which also say "does not exist".
	if (m.includes("wrong share id") || m.includes("share does not exist")) return noShare(opts.shareId, status);
	const pw = passwordProblem(msg);
	if (pw) return new ToolError("invalid_input", opts.passwordHint ? `${pw} ${opts.passwordHint}` : pw, { field: "password", upstreamStatus: status });
	if (m.includes("already shared")) {
		return new ToolError("already_exists", `${sentence(what)} is already shared with them. sharing_list shows that share and sharing_update changes it.`, { upstreamStatus: status });
	}
	if (m.includes("only allowed with") || m.includes("group members") || m.includes("organisation") || m.includes("organization")) {
		// This refusal comes only while the workspace limits sharing (privacy between organisations
		// on); the words say what the rule is when it applies, and hold whichever way it is set.
		return new ToolError(
			"permission_denied",
			"The workspace allows sharing only with people who share a group, organisation or team with the person, and with the person's own groups and teams. sharing_find_people lists who can be shared with.",
			{ upstreamStatus: status },
		);
	}
	if (m.includes("expiration date is in the past")) return new ToolError("invalid_input", "The expiry date must be after today.", { field: "expires_on", upstreamStatus: status });
	if (m.includes("cannot set expiration date more than")) {
		return new ToolError("invalid_input", "That expiry date is further ahead than the workspace allows.", { field: "expires_on", upstreamStatus: status });
	}
	if (m.includes("expiration date is enforced")) return new ToolError("invalid_input", "The workspace requires an expiry date on this share.", { field: "expires_on", upstreamStatus: status });
	if (m.includes("invalid date")) return new ToolError("invalid_input", "The expiry date must look like 2026-11-24.", { field: "expires_on", upstreamStatus: status });
	if (m.includes("public upload") || m.includes("upload is only possible")) {
		return new ToolError("invalid_input", "upload_only works only for folders.", { field: "permission", upstreamStatus: status });
	}
	if (m.includes("team if the app is not enabled") || m.includes("valid team")) {
		return new ToolError("not_available", "Sharing with that kind of team isn't available. sharing_find_people lists the teams that can be shared with.", { upstreamStatus: status });
	}
	if (m.includes("valid account") || m.includes("valid group") || m.includes("not a valid user") || m.includes("not a valid group")) {
		return new ToolError("not_found", "That person or group couldn't be found for sharing. sharing_find_people lists who can be shared with.", { field: "share_with", upstreamStatus: status });
	}
	if (m.includes("yourself") || m.includes("share owner")) return new ToolError("invalid_input", "An item can't be shared with its own owner.", { field: "share_with", upstreamStatus: status });
	if (m.includes("root folder")) return new ToolError("invalid_input", "The top folder \"/\" can't be shared; share a folder inside it.", { field: "path", upstreamStatus: status });
	if (m.includes("resharing") || m.includes("reshare") || m.includes("sharing rights") || m.includes("increase permissions") || m.includes("permissions")) {
		return new ToolError("permission_denied", `The person isn't allowed to share ${what} with those rights.`, { upstreamStatus: status });
	}
	if (m.includes("wrong path") || m.includes("does not exist")) {
		if (opts.shareId !== undefined) return noShare(opts.shareId, status);
		return new ToolError("not_found", `There's no file or folder at ${what}.`, { field: "path", upstreamStatus: status, hint: "files_search can find it by name." });
	}
	// deleteShare says "Could not delete share" twice: 404 when the item is locked, 403 when the
	// person may not delete the share (canDeleteShare). Read on the server, NC 35.0.2.
	if (m.includes("could not delete share") && status === 403) {
		return new ToolError("permission_denied", "The person isn't allowed to stop this share.", { field: "share_id", upstreamStatus: status });
	}
	if (m.includes("could not lock") || m.includes("could not create share") || m.includes("could not delete share")) {
		return new ToolError("locked", `${sentence(what)} is busy right now. Try again in a moment.`, { upstreamStatus: status });
	}
	if (m.includes("not allowed to edit incoming")) return new ToolError("permission_denied", "Shares made by someone else can't be changed.", { upstreamStatus: status });
	if (m.includes("label length")) return new ToolError("invalid_input", "The label is too long.", { field: "label", upstreamStatus: status });
	if (e.code === "permission_denied") return new ToolError("permission_denied", `The person isn't allowed to share ${what} that way.`, { upstreamStatus: status });
	if (e.code === "invalid_input") return new ToolError("invalid_input", "NoDrive refused that sharing request as invalid.", { upstreamStatus: status });
	if (e.code === "not_found") {
		// With a share id, the share is the only thing looked up (a plain 404, or the text in
		// another language).
		if (opts.shareId !== undefined) return noShare(opts.shareId, status);
		return new ToolError("not_found", `There's no file, folder or share at ${what}.`, { upstreamStatus: status });
	}
	return e;
}

// --- Dates ----------------------------------------------------------------------------------------

/** Today's date in the person's time zone, as UTC midnight milliseconds. */
function todayUtc(ctx: ToolCtx): number {
	const iso = ctx.time.format(ctx.time.now());
	const y = Number(iso.slice(0, 4));
	const mo = Number(iso.slice(5, 7));
	const d = Number(iso.slice(8, 10));
	return Date.UTC(y, mo - 1, d);
}

function ymd(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export const dateArg = (d: string) => z.string().max(10).describe(d);

/** Checks a YYYY-MM-DD expiry: after today in the person's zone and at most maxDays away. Returns the days away. */
export function checkExpiry(ctx: ToolCtx, raw: string, field: string, maxDays: number | null): { date: string; days: number } {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
	if (!m) throw new ToolError("invalid_input", `${field} must look like 2026-11-24.`, { field });
	const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	if (!Number.isFinite(t) || ymd(t) !== raw.trim()) throw new ToolError("invalid_input", `${field} isn't a real date (${raw.trim()}).`, { field });
	const days = Math.round((t - todayUtc(ctx)) / 86_400_000);
	if (days < 1) throw new ToolError("invalid_input", `${field} must be after today (today is ${ymd(todayUtc(ctx))} in the person's time zone).`, { field });
	if (maxDays !== null && days > maxDays) throw new ToolError("invalid_input", `${field} is ${days} days away; at most ${maxDays} days are allowed here.`, { field });
	return { date: raw.trim(), days };
}

export function expiryInDays(ctx: ToolCtx, days: number): string {
	return ymd(todayUtc(ctx) + days * 86_400_000);
}

/**
 * Whether sharing_update could set this earlier expiry again, for an undo: a link needs a date
 * after today and within the link limit; a share with people may also go back to no date.
 */
export function expiryRestorable(ctx: ToolCtx, before: string | null, link: boolean): boolean {
	if (before === null) return !link;
	try {
		checkExpiry(ctx, before, "expires_on", link ? ctx.cfg.maxLinkDays : PEOPLE_MAX_DAYS);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether a label or note can be written back exactly, for an undo: it fits the input limit and
 * the tools' own clean-up (cleanText: control characters, tabs, line ends, outer spaces) would
 * leave it as it is.
 */
export function textRestorable(s: string, max: number, multiline: boolean): boolean {
	return s.length <= max && cleanText(s, multiline) === s;
}

// --- Generated passwords --------------------------------------------------------------------------

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGIT = "23456789";
const SPECIAL = "-_.!@#%+=";

function pick(set: string): string {
	// Rejection sampling, so every character is equally likely.
	const limit = 256 - (256 % set.length);
	const b = new Uint8Array(1);
	for (;;) {
		crypto.getRandomValues(b);
		const v = b[0] as number;
		if (v < limit) return set[v % set.length] as string;
	}
}

/** 24 random characters with upper and lower case, digits and specials (meets the usual rules). */
export function generatePassword(): string {
	const all = UPPER + LOWER + DIGIT + SPECIAL;
	const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SPECIAL)];
	while (chars.length < 24) chars.push(pick(all));
	for (let i = chars.length - 1; i > 0; i--) {
		const b = new Uint32Array(1);
		crypto.getRandomValues(b);
		const j = (b[0] as number) % (i + 1);
		[chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
	}
	return chars.join("");
}
