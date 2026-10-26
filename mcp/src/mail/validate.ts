/**
 * Validation of NoMail's provider tools (contract v1, DESIGN 13.3). Bad tools are dropped one at a
 * time; only a hash of the name and a reason code are logged, never the tool's text.
 *
 * - Name: ^mail_[a-z0-9_]{1,59}$ (64 characters at most), unique, never one of our own.
 * - Title: present, at most 100 characters. Description: present, at most 2,000 characters,
 *   control characters and invisible Unicode (./invisible.ts) stripped, and so are the title and
 *   description texts inside the schemas (DESIGN 26.5). Any upstream brand in the title, description
 *   or schemas drops the tool (brief rule 6: clients show these texts to people); the check runs on
 *   the cleaned texts, so a zero-width character can't hide the brand from it.
 * - inputSchema: an object schema, at most 32 KB, local "#" refs only, accepted by fromJsonSchema.
 *   outputSchema is optional, with the same rules.
 * - Annotations (DESIGN 26.1): four booleans; a missing or non-boolean hint is filled in the cautious
 *   direction. The name is checked too, because scope rests on readOnlyHint (mail.read or mail.write):
 *   - a tool can be read-only only when its name starts with a reading verb (get, list, search,
 *     read, …) and holds no verb that changes mail anywhere;
 *   - a provider whose read-only claim is shown false is trusted on none of its hints for that tool:
 *     all four become the cautious ones (not read-only, destructive, not idempotent, open world);
 *   - a tool that sends (send or resend anywhere in the name; reply, forward and the like as the
 *     first word) is never idempotent, so no client repeats it on its own (caller rule 3);
 *   - a name that sends, removes, moves or exposes mail is always destructive (DESIGN 10.3 tier D),
 *     whatever the provider says. "reply" and "forward" count only as the first word:
 *     mail_create_reply_draft makes a draft and sends nothing;
 *   - every other tool that isn't read-only is destructive too, unless its name starts with an
 *     additive verb (create, save): tier D covers anything that changes existing data, and in the
 *     MCP spec destructiveHint false means "only additive updates". So mail_mark_read, mail_label and
 *     mail_attach_drive_file (it changes an existing draft) are destructive even though NoMail
 *     publishes them with destructiveHint false; clients then ask the person first. A provider's
 *     destructiveHint true is always kept.
 * - At most 30 tools are kept, sorted by name.
 */
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { brandClean } from "../core/brand";
import { utf8 } from "../core/bytes";
import { LIMITS } from "../core/limits";
import type { MailToolDef } from "../core/mail-contract";
import { catalogEntry } from "../mcp/catalog";
import { dropInvisible } from "./invisible";

export const MAIL_NAME_RE = /^mail_[a-z0-9_]{1,59}$/;
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 2_000;
const SCHEMA_DEPTH_MAX = 32;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: titles are one line
const CONTROL_LINE = /[\u0000-\u001f\u007f-\u009f]/g;

/** First words that only read. A read-only claim is kept only for names that start with one. */
export const READ_VERBS: ReadonlySet<string> = new Set(["get", "list", "search", "read", "find", "count", "preview", "show", "view", "lookup", "describe", "summarize", "summarise", "query"]);

/** Words anywhere in the name that mean the tool changes something, so it can't be read-only. */
export const WRITE_VERBS: ReadonlySet<string> = new Set([
	"send", "resend", "delete", "trash", "move", "archive", "unarchive", "create", "update", "reply", "forward", "mark", "set", "add",
	"remove", "save", "flag", "unflag", "label", "unlabel", "restore", "empty", "schedule", "write", "edit", "spam", "unspam", "junk",
	"block", "unblock", "unsubscribe", "upload", "attach", "detach", "purge", "clear", "discard", "snooze", "unsnooze", "import",
	"reorder", "approve", "accept", "decline", "reject", "rename", "copy", "star", "unstar", "mute", "unmute", "pin", "unpin", "report",
	"submit", "rsvp", "respond", "cancel", "share", "unshare", "invite", "sync", "apply", "run", "execute", "confirm", "revoke", "post",
	"deliver", "compose", "undo",
]);

/** Words that send, remove, move or expose mail: anywhere in the name they make a tool destructive. */
export const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
	"send", "resend", "delete", "trash", "purge", "empty", "discard", "remove", "spam", "junk", "archive", "move", "block",
	"unsubscribe", "revoke", "share", "invite",
]);

/** Words that send when they come first (mail_reply_all, mail_forward_message). Later in a name they say
 *  what kind of draft is made (mail_create_reply_draft), which sends nothing. */
export const DESTRUCTIVE_LEAD: ReadonlySet<string> = new Set(["reply", "forward", "respond", "rsvp", "report", "submit", "deliver", "post", "cancel"]);

/**
 * First words of tools that only add something new: a draft (mail_create_draft), a copy saved under
 * a free name (mail_save_attachment_to_drive). Only these may keep destructiveHint false when they
 * aren't read-only (DESIGN 10.3 tier A); every other first word changes existing data (tier D).
 */
export const ADDITIVE_LEAD: ReadonlySet<string> = new Set(["create", "save"]);

/** Words that send mail anywhere in a name, and first words that send (mail_reply_all): never idempotent. */
export const SENDING_WORDS: ReadonlySet<string> = new Set(["send", "resend"]);
export const SENDING_LEAD: ReadonlySet<string> = new Set(["reply", "forward", "respond", "rsvp", "report", "submit", "deliver", "post"]);

export type DropReason =
	| "not_object"
	| "bad_name"
	| "duplicate"
	| "ours"
	| "no_title"
	| "long_title"
	| "no_description"
	| "long_description"
	| "brand"
	| "bad_input_schema"
	| "bad_output_schema"
	| "over_cap";

export interface Validated {
	tools: MailToolDef[];
	dropped: { name: string; reason: DropReason }[];
}

const CAUTIOUS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

function hint(v: unknown, fallback: boolean): boolean {
	return typeof v === "boolean" ? v : fallback;
}

export function annotationsOf(name: string, raw: unknown): MailToolDef["annotations"] {
	const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	let readOnlyHint = hint(a.readOnlyHint, CAUTIOUS.readOnlyHint);
	let destructiveHint = hint(a.destructiveHint, CAUTIOUS.destructiveHint);
	let idempotentHint = hint(a.idempotentHint, CAUTIOUS.idempotentHint);
	let openWorldHint = hint(a.openWorldHint, CAUTIOUS.openWorldHint);
	const segments = name.slice("mail_".length).split("_");
	const lead = segments[0] ?? "";
	const readsOnly = READ_VERBS.has(lead) && !segments.some((s) => WRITE_VERBS.has(s));
	if (readOnlyHint && !readsOnly) {
		// The read-only claim is shown false by the name, so none of the provider's hints for this tool
		// are trusted: it is published as changing data (clients ask the person first), as not safe to
		// repeat and as reaching outside the workspace.
		({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint } = CAUTIOUS);
	}
	if (DESTRUCTIVE_LEAD.has(lead) || segments.some((s) => DESTRUCTIVE_VERBS.has(s))) destructiveHint = true;
	// Sending twice sends two emails: a tool that sends is never published as safe to repeat.
	if (SENDING_LEAD.has(lead) || segments.some((s) => SENDING_WORDS.has(s))) idempotentHint = false;
	// Not read-only and not additive by its first word: it changes existing data (tier D).
	if (!readOnlyHint && !ADDITIVE_LEAD.has(lead)) destructiveHint = true;
	if (readOnlyHint) destructiveHint = false;
	return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint };
}

/** Local refs only, no ids or anchors that could change how refs resolve, bounded depth. */
function schemaShapeOk(node: unknown, depth = 0): boolean {
	if (depth > SCHEMA_DEPTH_MAX) return false;
	if (Array.isArray(node)) return node.every((x) => schemaShapeOk(x, depth + 1));
	if (!node || typeof node !== "object") return true;
	for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
		if (k === "$ref" || k === "$recursiveRef" || k === "$dynamicRef") {
			if (k !== "$ref" || typeof v !== "string" || !(v === "#" || v.startsWith("#/"))) return false;
		}
		if (k === "$id" || k === "$anchor" || k === "$dynamicAnchor" || k === "$recursiveAnchor") return false;
		if (!schemaShapeOk(v, depth + 1)) return false;
	}
	return true;
}

export function schemaOk(schema: unknown): boolean {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
	const s = schema as Record<string, unknown>;
	if (s.type !== "object") return false;
	let text: string;
	try {
		text = JSON.stringify(schema);
	} catch {
		return false;
	}
	if (utf8(text).byteLength > LIMITS.mailSchemaBytes) return false;
	if (!schemaShapeOk(schema)) return false;
	try {
		const std = fromJsonSchema(schema as never) as { "~standard": { validate(v: unknown): unknown } };
		// Compiles and runs once; a broken schema throws here rather than on a person's call.
		std["~standard"].validate({});
		return true;
	} catch {
		return false;
	}
}

function oneLine(s: string): string {
	return dropInvisible(s).replace(CONTROL_LINE, " ").replace(/\s+/g, " ").trim();
}

/** A provider text as people see it: invisible Unicode and control characters (but \n and \t) removed. */
function cleanText(s: string): string {
	return dropInvisible(s).replace(CONTROL, "").trim();
}

/**
 * A copy of a schema with its "title" and "description" texts cleaned (cleanText). Only those two
 * keys are touched, so what the schema accepts stays exactly the same; a property that happens to be
 * named "title" holds a schema object, not a string, and is walked like any other.
 */
export function cleanSchemaTexts(node: unknown, depth = 0): unknown {
	if (depth > SCHEMA_DEPTH_MAX + 2 || !node || typeof node !== "object") return node;
	if (Array.isArray(node)) return node.map((x) => cleanSchemaTexts(x, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
		out[k] = (k === "title" || k === "description") && typeof v === "string" ? cleanText(v) : cleanSchemaTexts(v, depth + 1);
	}
	return out;
}

export function validateProviderTools(raw: unknown): Validated {
	const dropped: Validated["dropped"] = [];
	const kept = new Map<string, MailToolDef>();
	const seen = new Set<string>();
	const list = Array.isArray(raw) ? raw : [];
	for (const item of list) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			dropped.push({ name: "", reason: "not_object" });
			continue;
		}
		const t = item as Record<string, unknown>;
		const name = typeof t.name === "string" ? t.name : "";
		if (!MAIL_NAME_RE.test(name) || name.length > 64) {
			dropped.push({ name, reason: "bad_name" });
			continue;
		}
		if (seen.has(name)) {
			kept.delete(name);
			dropped.push({ name, reason: "duplicate" });
			continue;
		}
		seen.add(name);
		if (catalogEntry(name)) {
			dropped.push({ name, reason: "ours" });
			continue;
		}
		const title = typeof t.title === "string" ? oneLine(t.title) : "";
		if (!title) {
			dropped.push({ name, reason: "no_title" });
			continue;
		}
		if (title.length > TITLE_MAX) {
			dropped.push({ name, reason: "long_title" });
			continue;
		}
		const description = typeof t.description === "string" ? cleanText(t.description) : "";
		if (!description) {
			dropped.push({ name, reason: "no_description" });
			continue;
		}
		if (description.length > DESCRIPTION_MAX) {
			dropped.push({ name, reason: "long_description" });
			continue;
		}
		if (!schemaOk(t.inputSchema)) {
			dropped.push({ name, reason: "bad_input_schema" });
			continue;
		}
		const hasOutput = t.outputSchema !== undefined && t.outputSchema !== null;
		if (hasOutput && !schemaOk(t.outputSchema)) {
			dropped.push({ name, reason: "bad_output_schema" });
			continue;
		}
		const inputSchema = cleanSchemaTexts(t.inputSchema) as Record<string, unknown>;
		const outputSchema = hasOutput ? (cleanSchemaTexts(t.outputSchema) as Record<string, unknown>) : undefined;
		const visible = `${title}\n${description}\n${JSON.stringify(inputSchema)}\n${outputSchema ? JSON.stringify(outputSchema) : ""}`;
		if (!brandClean(visible)) {
			dropped.push({ name, reason: "brand" });
			continue;
		}
		kept.set(name, {
			name,
			title,
			description,
			inputSchema,
			...(outputSchema ? { outputSchema } : {}),
			annotations: annotationsOf(name, t.annotations),
		});
	}
	const sorted = [...kept.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const t of sorted.slice(LIMITS.mailTools)) dropped.push({ name: t.name, reason: "over_cap" });
	return { tools: sorted.slice(0, LIMITS.mailTools), dropped };
}
