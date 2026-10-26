/**
 * Typed and opaque identifiers (DESIGN 10.6). People, groups and teams always travel as
 * "person:<uid>", "group:<gid>" or "team:<id>", so a type and an id can never be mismatched.
 * Ids are validated by pattern here and re-checked against what the person can reach by the tools.
 */
import { z } from "zod";
import { ToolError } from "./errors";

export type TypedKind = "person" | "group" | "team";

export interface TypedId {
	kind: TypedKind;
	id: string;
}

/** Uids, group ids and team ids: printable, no slash, no colon at the start, at most 128 characters. */
const VALUE = /^[^\u0000-\u001f\u007f/\\][^\u0000-\u001f\u007f/\\]{0,127}$/;

export function parseTypedId(raw: string, allowed: readonly TypedKind[] = ["person", "group", "team"], field = "id"): TypedId {
	const m = /^(person|group|team):(.+)$/.exec(raw);
	if (!m) throw new ToolError("invalid_input", `${field} must look like "person:…", "group:…" or "team:…" (ids come from sharing_find_people).`, { field });
	const kind = m[1] as TypedKind;
	const id = m[2] as string;
	if (!allowed.includes(kind)) throw new ToolError("invalid_input", `${field} must be a ${allowed.join(" or ")} id.`, { field });
	if (!VALUE.test(id)) throw new ToolError("invalid_input", `${field} isn't a valid id.`, { field });
	return { kind, id };
}

export function typedId(kind: TypedKind, id: string): string {
	return `${kind}:${id}`;
}

export const typedIdSchema = z
	.string()
	.max(140)
	.regex(/^(person|group|team):.+$/, 'must look like "person:…", "group:…" or "team:…"');

/** The UUID pattern of Nourax accounts (uid = the Supabase user id). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** QA accounts exist only in local dev; production refuses them like every local account. */
export const QA_UID_RE = /^qa-t\d+[a-z]?-[a-z0-9-]{1,20}$/;

export function isUuid(s: string): boolean {
	return UUID_RE.test(s);
}

/** Opaque ids made of "<collection>/<object>" (events, tasks, contacts). */
export function splitPairId(raw: string, field: string): { collection: string; object: string } {
	const i = raw.indexOf("/");
	const collection = i > 0 ? raw.slice(0, i) : "";
	const object = i > 0 ? raw.slice(i + 1) : "";
	const ok = /^[A-Za-z0-9_.@%+=-]{1,200}$/;
	if (!ok.test(collection) || !ok.test(object) || collection === "." || collection === ".." || object === "." || object === "..") {
		throw new ToolError("invalid_input", `${field} isn't valid. Ids come from the list tools.`, { field });
	}
	return { collection, object };
}

/** Deck and share ids are positive integers. */
export function numericId(raw: unknown, field: string): number {
	const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,12}$/.test(raw) ? Number(raw) : Number.NaN;
	if (!Number.isSafeInteger(n) || n <= 0) throw new ToolError("invalid_input", `${field} isn't a valid id.`, { field });
	return n;
}
