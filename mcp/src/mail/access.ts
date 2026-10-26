/**
 * Which NoMail tools a connection may list and call (DESIGN 13.4 and 26), lane E. One rule set,
 * used by tools/list, by tools/call, by the stand-ins and by workspace_overview's count, so the
 * three always agree.
 *
 * 1. Mail scope: a read-only tool needs mail.read, any other needs mail.write.
 * 2. NoDrive (fix round 3): some mail tools reach the person's NoDrive with NoMail's own Drive
 *    credentials (contract U1), so the Worker's own app and scope gate never sees those Drive calls.
 *    NoMail's list has two: mail_attach_drive_file reads a NoDrive file into a draft, and
 *    mail_save_attachment_to_drive writes a new NoDrive file. A mail tool that reaches NoDrive needs
 *    the Files app on the connection; one that writes there also needs workspace.write. So a
 *    connection set up without Files, or only to read, can't get round that choice through mail.
 *    - A tool reaches NoDrive when a word of its name is "drive", "nodrive", "file", "files" or
 *      "workspace"; when a word of an input's name is one of those, or "path" or "paths"; or when an
 *      input's description names Drive, NoDrive or Workspace (fix round 4, DESIGN 26.4). Inputs are
 *      read at every depth of the schema (nested objects, array items, anyOf/oneOf/allOf, local
 *      $ref, DESIGN 29.4), since contract v1 lets NoMail add a nested attachments[].path without a new
 *      version; a schema too big or too deep to read whole counts as reaching NoDrive.
 *    - This is read from words, because contract v1 has no field that says it. It errs on the
 *      cautious side: a mail tool named with "file" that never touches NoDrive is held to the same
 *      rule. NoMail's 18 tools come out as before: only mail_attach_drive_file (reads) and
 *      mail_save_attachment_to_drive (writes) reach NoDrive.
 *    - It only reads from NoDrive when its first word is "attach" or a reading verb; any other tool
 *      that reaches NoDrive is taken to write there (the cautious side).
 * 3. Share links: with as "auto" or "link", mail_attach_drive_file can send the file as a NoDrive
 *    share link, made when the email is sent. Without workspace.share only as "file" is accepted, and
 *    the listing says so in the tool's description. Every choice that offers "link", at any depth,
 *    is checked in the arguments where it sits (DESIGN 29.4).
 * 4. Room: at most 100 tools are listed in all (ONLYOFFICE Desktop Editors turns on no more than 100
 *    tools of one server, DESIGN 5.1); mail tools fill what our own tools leave, in name order.
 */
import { ToolError } from "../core/errors";
import { LIMITS } from "../core/limits";
import type { MailToolDef } from "../core/mail-contract";
import type { AppId, Scope } from "../mcp/catalog";
import { READ_VERBS } from "./validate";

/** ONLYOFFICE Desktop Editors enables at most this many tools of one MCP server (DESIGN 5.1, 25.5). */
export const CLIENT_TOOL_CAP = 100;

/** How many mail tools may be listed next to `ownCount` tools of our own. */
export function mailRoom(ownCount: number): number {
	return Math.max(0, Math.min(LIMITS.mailTools, CLIENT_TOOL_CAP - ownCount));
}

/** What the connection was granted: its scopes and its apps (both from the vault record). */
export interface MailGrant {
	scopes: readonly Scope[];
	apps: readonly AppId[];
}

/** Why a listed provider tool can't be used on this connection. */
export type MailDenial = "mail_read" | "mail_write" | "files" | "files_write";

/** How far a mail tool reaches into NoDrive. */
export type DriveReach = "none" | "read" | "write";

/** Words of a tool's name, or of an input's name, that mean it works with NoDrive files. */
const DRIVE_WORDS: ReadonlySet<string> = new Set(["drive", "nodrive", "file", "files", "workspace"]);
/** More words of an input's name only: a path names a file (mail_attach_drive_file's `path`). */
const DRIVE_INPUT_NAME_WORDS: ReadonlySet<string> = new Set([...DRIVE_WORDS, "path", "paths"]);
/** First words of tools that take a NoDrive file into mail and write nothing to NoDrive. */
const DRIVE_READ_LEAD: ReadonlySet<string> = new Set(["attach", ...READ_VERBS]);
/** An input described as a path or file in the Drive or the Workspace. */
const DRIVE_INPUT_WORDS = /\b(?:(?:No)?Drive|Workspace)\b/i;

/** snake_case and camelCase words, lower case. */
function words(s: string): string[] {
	return s
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/**
 * One step from a value to a part of it: a property, any item of an array, one position of an array,
 * or any value of an object (additionalProperties, patternProperties).
 */
type Step = { prop: string } | { item: true } | { index: number } | { value: true };

/** An input whose choices include "link", wherever it sits in the schema, and how to reach it in the arguments. */
export interface LinkSpot {
	path: Step[];
	/** The path as people read it: "as", "attachments[].as". */
	label: string;
	/** Its choices that never make a share link. */
	safe: string[];
	/** Its default, which the provider uses when the input is left out. */
	fallback: string | null;
}

interface SchemaFacts {
	/** A word of an input's name, at any depth, or a description that names Drive, NoDrive or Workspace. */
	driveWord: boolean;
	links: LinkSpot[];
	/** The walk couldn't see everything (too deep or too big, a $ref that can't be followed, or a $ref loop with a link choice): the cautious side. */
	unsure: boolean;
}

/** validate.ts allows 32 levels and 32 KB; $ref targets add their own levels. */
const WALK_DEPTH_MAX = 64;
const WALK_NODES_MAX = 4_000;

function record(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** A local JSON pointer ("#" or "#/a/b") in the schema, or undefined when it doesn't resolve. */
function pointer(root: unknown, ref: string): unknown {
	if (ref === "#") return root;
	if (!ref.startsWith("#/")) return undefined;
	let node: unknown = root;
	for (const raw of ref.slice(2).split("/")) {
		let seg: string;
		try {
			seg = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
		} catch {
			return undefined;
		}
		if (Array.isArray(node) && /^(?:0|[1-9]\d{0,5})$/.test(seg)) node = node[Number(seg)];
		else if (node && typeof node === "object" && !Array.isArray(node) && Object.hasOwn(node, seg)) node = (node as Record<string, unknown>)[seg];
		else return undefined;
	}
	return node;
}

function labelOf(path: readonly Step[]): string {
	let out = "";
	for (const s of path) {
		if ("prop" in s) out += out ? `.${s.prop}` : s.prop;
		else if ("item" in s) out += "[]";
		else if ("index" in s) out += `[${s.index}]`;
		else out += out ? ".*" : "*";
	}
	return out || "the input";
}

/**
 * Everything gating needs from an input schema (DESIGN 29.4), read from the whole schema: nested
 * properties, array items (items, prefixItems, contains), additionalProperties and patternProperties,
 * anyOf, oneOf, allOf, if/then/else, dependentSchemas, and local $ref (followed, loops stopped). Contract
 * v1 lets NoMail add inputs without a new version, so a Drive path inside attachments[] must count as
 * much as one at the top. $defs are read for their words only (a value reaches them through a $ref);
 * `not` likewise, since it holds what is refused, not a choice.
 */
function walkSchema(root: Record<string, unknown>): SchemaFacts {
	const choices = new Map<string, { path: Step[]; values: Set<string>; fallback: string | null }>();
	let driveWord = false;
	let unsure = false;
	let loop = false;
	let nodes = 0;
	const visit = (node: unknown, path: Step[] | null, depth: number, refs: readonly string[]): void => {
		if (unsure || !node || typeof node !== "object" || Array.isArray(node)) return;
		if (++nodes > WALK_NODES_MAX || depth > WALK_DEPTH_MAX) {
			unsure = true;
			return;
		}
		const s = node as Record<string, unknown>;
		const next = (step: Step): Step[] | null => (path ? [...path, step] : null);
		if (typeof s.description === "string" && DRIVE_INPUT_WORDS.test(s.description)) driveWord = true;
		if (path) {
			const values = [...(Array.isArray(s.enum) ? s.enum : []), ...("const" in s ? [s.const] : [])].filter((v): v is string => typeof v === "string");
			const fallback = typeof s.default === "string" ? s.default : null;
			if (values.length || fallback !== null) {
				const key = JSON.stringify(path);
				const c = choices.get(key) ?? { path, values: new Set<string>(), fallback: null };
				for (const v of values) c.values.add(v);
				if (c.fallback === null) c.fallback = fallback;
				choices.set(key, c);
			}
		}
		if (typeof s.$ref === "string") {
			if (refs.includes(s.$ref)) loop = true;
			else {
				const target = pointer(root, s.$ref);
				if (target === undefined) unsure = true;
				else visit(target, path, depth + 1, [...refs, s.$ref]);
			}
		}
		for (const [k, v] of Object.entries(record(s.properties))) {
			if (words(k).some((w) => DRIVE_INPUT_NAME_WORDS.has(w))) driveWord = true;
			visit(v, next({ prop: k }), depth + 1, refs);
		}
		for (const [k, v] of Object.entries(record(s.patternProperties))) {
			if (words(k).some((w) => DRIVE_INPUT_NAME_WORDS.has(w))) driveWord = true;
			visit(v, next({ value: true }), depth + 1, refs);
		}
		for (const k of ["additionalProperties", "unevaluatedProperties"]) visit(s[k], next({ value: true }), depth + 1, refs);
		// Tuples: prefixItems (2020-12) or an items array (older drafts) give one schema per position.
		if (Array.isArray(s.prefixItems)) s.prefixItems.forEach((v, i) => visit(v, next({ index: i }), depth + 1, refs));
		if (Array.isArray(s.items)) s.items.forEach((v, i) => visit(v, next({ index: i }), depth + 1, refs));
		else visit(s.items, next({ item: true }), depth + 1, refs);
		for (const k of ["additionalItems", "unevaluatedItems", "contains"]) visit(s[k], next({ item: true }), depth + 1, refs);
		for (const k of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(s[k])) for (const v of s[k] as unknown[]) visit(v, path, depth + 1, refs);
		for (const k of ["if", "then", "else"]) visit(s[k], path, depth + 1, refs);
		for (const k of ["dependentSchemas", "dependencies"]) for (const v of Object.values(record(s[k]))) visit(v, path, depth + 1, refs);
		for (const k of ["$defs", "definitions"]) for (const v of Object.values(record(s[k]))) visit(v, null, depth + 1, refs);
		visit(s.not, null, depth + 1, refs);
	};
	visit(root, [], 0, []);
	const links = [...choices.values()]
		.filter((c) => c.values.has("link"))
		.map((c) => ({ path: c.path, label: labelOf(c.path), safe: [...c.values].filter((v) => !LINK_VALUES.has(v)), fallback: c.fallback }));
	// A loop can nest a link choice deeper than any path walked here, so then nothing is assumed safe.
	return { driveWord, links, unsure: unsure || (loop && links.length > 0) };
}

const factsMemo = new WeakMap<MailToolDef, SchemaFacts>();

function facts(t: MailToolDef): SchemaFacts {
	let f = factsMemo.get(t);
	if (!f) {
		f = walkSchema(t.inputSchema);
		factsMemo.set(t, f);
	}
	return f;
}

export function driveReach(t: MailToolDef): DriveReach {
	const nameWords = t.name.slice("mail_".length).split("_");
	const f = facts(t);
	// A schema that couldn't be read whole is taken to reach NoDrive (the cautious side).
	const reaches = nameWords.some((w) => DRIVE_WORDS.has(w)) || f.driveWord || f.unsure;
	if (!reaches) return "none";
	return DRIVE_READ_LEAD.has(nameWords[0] ?? "") ? "read" : "write";
}

/** The first reason this connection may not use the tool, or null when it may. */
export function mailDenial(t: MailToolDef, g: MailGrant): MailDenial | null {
	if (t.annotations.readOnlyHint ? !g.scopes.includes("mail.read") : !g.scopes.includes("mail.write")) return t.annotations.readOnlyHint ? "mail_read" : "mail_write";
	const reach = driveReach(t);
	if (reach === "none") return null;
	if (!g.apps.includes("files") || !g.scopes.includes("workspace.read")) return "files";
	if (reach === "write" && !g.scopes.includes("workspace.write")) return "files_write";
	return null;
}

export const DENIAL_MESSAGES: Readonly<Record<MailDenial, string>> = {
	mail_read: "This connection wasn't allowed to read mail. The person can allow it by reconnecting the assistant.",
	mail_write: "This connection wasn't allowed to write or send mail. The person can allow it by reconnecting the assistant.",
	files:
		"This mail tool works with files in NoDrive, and this connection was set up without NoDrive files. The person can add Files by reconnecting the assistant.",
	files_write:
		"This mail tool saves files into NoDrive, and this connection may only read in Nourax Workspace. The person can allow creating and editing by reconnecting the assistant.",
};

/** The tools this request may list or call, in name order, within the 100-tool room. */
export function shownMailTools(tools: readonly MailToolDef[], g: MailGrant, ownCount: number): MailToolDef[] {
	return tools.filter((t) => mailDenial(t, g) === null).slice(0, mailRoom(ownCount));
}

/** Values of an input that never make a share link: everything except "link" and "auto". */
const LINK_VALUES: ReadonlySet<string> = new Set(["link", "auto"]);

/**
 * Every input of a NoDrive tool that can send a file as a share link (mail_attach_drive_file's `as`,
 * whose choices are "auto", "file" and "link"), at any depth of the schema (DESIGN 29.4), with the
 * values that never make one. Empty for every tool that doesn't reach NoDrive.
 */
export function linkChoices(t: MailToolDef): LinkSpot[] {
	return driveReach(t) === "none" ? [] : facts(t).links;
}

/** The first of linkChoices(), as `prop` (its label), or null. */
export function linkChoice(t: MailToolDef): { prop: string; safe: string[]; fallback: string | null } | null {
	const c = linkChoices(t)[0];
	return c ? { prop: c.label, safe: c.safe, fallback: c.fallback } : null;
}

/**
 * The values at `path` in the arguments: each one found, or `undefined` where the last step's object
 * exists but leaves the input out (the provider then uses its default). Nothing where an earlier part
 * is missing, since then no such input is sent at all.
 */
function valuesAt(value: unknown, path: readonly Step[]): unknown[] {
	let here: unknown[] = [value];
	for (const [i, step] of path.entries()) {
		const last = i === path.length - 1;
		const out: unknown[] = [];
		for (const v of here) {
			if ("prop" in step) {
				if (!v || typeof v !== "object" || Array.isArray(v)) continue;
				if (Object.hasOwn(v, step.prop)) out.push((v as Record<string, unknown>)[step.prop]);
				else if (last) out.push(undefined);
			} else if ("item" in step) {
				if (Array.isArray(v)) out.push(...v);
			} else if ("index" in step) {
				if (Array.isArray(v) && step.index < v.length) out.push(v[step.index]);
			} else if (v && typeof v === "object" && !Array.isArray(v)) {
				out.push(...Object.values(v));
			}
		}
		here = out;
	}
	return here;
}

function quoted(values: readonly string[]): string {
	return values.map((v) => `"${v}"`).join(" or ");
}

function linkError(message: string, field: string): ToolError {
	return new ToolError("not_available", message, { field, hint: "The person can allow sharing by reconnecting the assistant." });
}

/**
 * Without workspace.share, a call whose choice could make a share link is refused before anything is
 * sent: every link choice in the schema is checked where the arguments hold it, also inside arrays
 * and nested objects, and an input left out takes the provider's default ("auto"), which can become
 * a link too. A NoDrive tool whose schema couldn't be read whole is refused (the cautious side).
 */
export function linkRefusal(t: MailToolDef, g: MailGrant, args: Record<string, unknown>): ToolError | null {
	if (g.scopes.includes("workspace.share")) return null;
	if (driveReach(t) === "none") return null;
	if (facts(t).unsure) {
		return linkError("This connection can't share files or create links, and this mail tool's input couldn't be checked for share links, so it can't be used here.", "arguments");
	}
	for (const c of facts(t).links) {
		for (const given of valuesAt(args, c.path)) {
			const value = typeof given === "string" ? given : c.fallback;
			if (value !== null && c.safe.includes(value)) continue;
			const what = value === null ? `Without ${c.label}` : `With ${c.label} "${value}"`;
			const instead = c.safe.length ? ` ${c.label} ${quoted(c.safe)} attaches the file itself.` : "";
			return linkError(`This connection can't share files or create links. ${what}, the file may be sent as a NoDrive share link.${instead}`, c.label);
		}
	}
	return null;
}

/** The description clients see for this connection: the provider's, plus the link rule when it applies. */
export function shownDescription(t: MailToolDef, g: MailGrant): string {
	if (g.scopes.includes("workspace.share")) return t.description;
	if (driveReach(t) === "none") return t.description;
	const f = facts(t);
	if (f.unsure) return `${t.description} This connection can't create share links, so this tool can't be used here.`;
	if (f.links.length === 0) return t.description;
	const unsafe = f.links.filter((c) => c.safe.length === 0);
	const safe = f.links.filter((c) => c.safe.length > 0).map((c) => `${c.label} ${quoted(c.safe)}`);
	// A top-level choice with no safe value can't be left out either (its default applies), so the
	// whole tool is out; a nested one only rules out the part that holds it.
	if (unsafe.some((c) => c.path.length === 1)) return `${t.description} This connection can't create share links, so this tool can't be used here.`;
	const parts: string[] = [];
	if (safe.length) parts.push(`On this connection only ${safe.join(" and ")} ${safe.length === 1 ? "works" : "work"}: it can't create share links.`);
	if (unsafe.length) parts.push(`This connection can't create share links, so ${unsafe.map((c) => c.label).join(" and ")} can't be used here.`);
	return `${t.description} ${parts.join(" ")}`;
}

/** The grant a caller that passes none is held to: its mail scopes only, and no NoDrive (fails closed). */
export function mailOnlyGrant(scopes: { read: boolean; write: boolean }): MailGrant {
	const s: Scope[] = ["workspace.read"];
	if (scopes.read) s.push("mail.read");
	if (scopes.write) s.push("mail.write");
	return { scopes: s, apps: ["mail"] };
}
