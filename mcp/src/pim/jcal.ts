/**
 * jCal (RFC 7265) helpers for lane D (DESIGN 11.5). NoCalendar speaks jCal both ways: we send
 * `application/calendar+json` and the server does all ICS escaping, folding and validation, so
 * user text can never break out of a property (an injected "BEGIN:VALARM" stays inside SUMMARY,
 * checked live on 2026-10-25).
 *
 * A component is [name, properties, components]; a property is [name, params, type, ...values].
 * Names are lower case. Everything here is plain JSON, so a copy is JSON.parse(JSON.stringify()).
 */
import { ToolError } from "../core/errors";

export type JParams = Record<string, string | string[]>;
export type JProp = [string, JParams, string, ...unknown[]];
export type JComp = [string, JProp[], JComp[]];

export const PRODID = "-//Nourax//Nourax Workspace MCP//EN";

const MAX_DEPTH = 8;
const MAX_ITEMS = 100_000;

function bad(): ToolError {
	return new ToolError("upstream_unavailable", "NoCalendar's answer couldn't be read.");
}

function checkComp(x: unknown, depth: number, budget: { n: number }): x is JComp {
	if (!Array.isArray(x) || x.length !== 3 || typeof x[0] !== "string" || !Array.isArray(x[1]) || !Array.isArray(x[2])) return false;
	if (depth > MAX_DEPTH) return false;
	for (const p of x[1] as unknown[]) {
		if (--budget.n < 0) return false;
		if (!Array.isArray(p) || p.length < 3 || typeof p[0] !== "string" || typeof p[2] !== "string") return false;
		if (typeof p[1] !== "object" || p[1] === null || Array.isArray(p[1])) return false;
	}
	for (const c of x[2] as unknown[]) {
		if (--budget.n < 0) return false;
		if (!checkComp(c, depth + 1, budget)) return false;
	}
	return true;
}

/** Parses and checks jCal text from the server. Anything malformed is an upstream fault. */
export function parseJcal(text: string): JComp {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw bad();
	}
	if (!checkComp(raw, 0, { n: MAX_ITEMS }) || raw[0].toLowerCase() !== "vcalendar") throw bad();
	return raw;
}

export function cloneComp(c: JComp): JComp {
	return JSON.parse(JSON.stringify(c)) as JComp;
}

export function props(c: JComp, name: string): JProp[] {
	return c[1].filter((p) => p[0].toLowerCase() === name);
}

export function prop(c: JComp, name: string): JProp | undefined {
	return c[1].find((p) => p[0].toLowerCase() === name);
}

export function subs(c: JComp, name: string): JComp[] {
	return c[2].filter((s) => s[0].toLowerCase() === name);
}

/** The first value of a property as a string, or null. */
export function text(c: JComp, name: string): string | null {
	const p = prop(c, name);
	const v = p?.[3];
	if (typeof v === "string") return v;
	if (typeof v === "number") return String(v);
	return null;
}

export function num(c: JComp, name: string): number | null {
	const v = prop(c, name)?.[3];
	const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d{1,9}$/.test(v) ? Number(v) : Number.NaN;
	return Number.isFinite(n) ? n : null;
}

/** A parameter of a property as one string (the first one when it is a list). */
export function param(p: JProp, key: string): string | null {
	const v = p[1][key] ?? p[1][key.toLowerCase()];
	if (typeof v === "string") return v;
	if (Array.isArray(v) && typeof v[0] === "string") return v[0];
	return null;
}

export function removeProp(c: JComp, name: string): void {
	c[1] = c[1].filter((p) => p[0].toLowerCase() !== name);
}

/** Replaces every `name` property with one new property. */
export function setProp(c: JComp, name: string, params: JParams, type: string, ...values: unknown[]): void {
	removeProp(c, name);
	c[1].push([name, params, type, ...values] as JProp);
}

export function addProp(c: JComp, name: string, params: JParams, type: string, ...values: unknown[]): void {
	c[1].push([name, params, type, ...values] as JProp);
}

export function removeSubs(c: JComp, name: string): void {
	c[2] = c[2].filter((s) => s[0].toLowerCase() !== name);
}

/** A new VCALENDAR with our PRODID. */
export function vcalendar(children: JComp[] = []): JComp {
	return [
		"vcalendar",
		[
			["version", {}, "text", "2.0"],
			["prodid", {}, "text", PRODID],
		],
		children,
	];
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Text we write: no control characters but newline and tab, line ends made "\n". */
export function cleanText(s: string): string {
	return s.replace(/\r\n?/g, "\n").replace(CONTROL, "");
}

/** A one-line text (titles, locations): newlines become spaces. */
export function cleanLine(s: string): string {
	return cleanText(s).replace(/[\n\t]+/g, " ").trim();
}

/** "2026-10-25T11:00:00Z" for an instant. */
export function utcStamp(ms: number): string {
	return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/** The main components of a calendar object: VEVENT or VTODO, master first, then overrides. */
export function mainComps(cal: JComp, kind: "vevent" | "vtodo"): { master: JComp | null; overrides: JComp[] } {
	const all = subs(cal, kind);
	const master = all.find((c) => !prop(c, "recurrence-id")) ?? null;
	return { master, overrides: all.filter((c) => c !== master) };
}

/** Whether a component repeats (an RRULE or RDATE on the master). */
export function repeats(c: JComp | null): boolean {
	return Boolean(c && (prop(c, "rrule") || prop(c, "rdate")));
}
