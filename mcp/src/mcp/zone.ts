/**
 * The person's time zone (DESIGN 10.6): NoDrive's setting, else the default calendar's, else
 * DEFAULT_TIME_ZONE.
 *
 * Fix round 4: it is looked up only for a tool that reads or writes times (needsZone), inside the
 * tool's 60 s budget (runTool, src/mcp/register.ts) and under its abort signal (the NoDrive client
 * of the request stops when the budget is over), with a 5 s budget of its own and no retry. Before,
 * the handler ran it before every tools/call, outside any budget: up to three 20 s requests, each
 * retried once on 502/503/504, in front of files and mail tools that never read the zone.
 *
 * `known` is false when NoDrive didn't answer in time, so the default stands in (with a warning for
 * the time apps). Only an answer is cached (10 minutes): one slow or failing lookup must not pin the
 * person to the default for that long (fix round 3). A dead credential found here is seen by the
 * handler through nc.isDead() after the tool, which ends the connection (8.5).
 */
import type { NxConfig } from "../env";
import { sha256Hex } from "../core/bytes";
import { isToolError, ToolError } from "../core/errors";
import { LIMITS } from "../core/limits";
import { isValidZone } from "../core/time";
import type { ToolDef } from "../core/tool";
import { type Nc, NS, propHrefs } from "../nc/index";
import { parseMultistatus } from "../nc/multistatus";

const zoneCache = new Map<string, { at: number; zone: string }>();

/** Apps whose tools read or write times in the person's zone (calendar includes NoTasks). */
export const ZONE_APPS: ReadonlySet<string> = new Set(["calendar", "gantt", "boards"]);

/** Other tools that show times in the person's zone: whoami says the zone, sharing dates its shares. */
const ZONE_TOOLS: ReadonlySet<string> = new Set(["workspace_whoami"]);

/** A date or a date-time without an offset (read in the person's zone, core/time.ts parseTime). */
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)?$/;

function hasLocalTime(v: unknown, depth = 0): boolean {
	if (typeof v === "string") return v.length <= 40 && LOCAL_TIME.test(v.trim());
	if (depth > 4 || !v || typeof v !== "object") return false;
	return Object.values(v as Record<string, unknown>).some((x) => hasLocalTime(x, depth + 1));
}

/**
 * Whether a call needs the person's zone: a tool of a time app, whoami, a sharing tool (they show
 * when a share was made), or any call whose arguments hold a date or time without an offset (a date
 * filter of files_search, for example). Every other call never waits for the lookup.
 */
export function needsZone(def: Pick<ToolDef, "name" | "entry">, args: unknown): boolean {
	if (def.entry.app !== null && ZONE_APPS.has(def.entry.app)) return true;
	if (ZONE_TOOLS.has(def.name) || def.name.startsWith("sharing_")) return true;
	return hasLocalTime(args);
}

export async function resolveZone(nc: Nc, cfg: NxConfig, uid: string, budgetMs: number = LIMITS.zoneLookupMs): Promise<{ zone: string; known: boolean }> {
	const key = (await sha256Hex(uid)).slice(0, 24);
	const hit = zoneCache.get(key);
	if (hit && Date.now() - hit.at < 600_000) return { zone: hit.zone, known: true };
	let zone = cfg.defaultTimeZone;
	const deadline = Date.now() + budgetMs;
	// Each request gets what is left of the budget, and none is retried.
	const opts = () => {
		const left = deadline - Date.now();
		if (left <= 0) throw new ToolError("timeout");
		return { timeoutMs: left, noRetry: true };
	};
	try {
		const me = await nc.cloudUser(opts());
		if (me.timezone && isValidZone(me.timezone)) zone = me.timezone;
		else {
			const principal = `/remote.php/dav/principals/users/${encodeURIComponent(uid)}/`;
			const ps = await nc.dav.propfind(
				principal,
				0,
				'<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:prop><cal:schedule-default-calendar-URL/></d:prop></d:propfind>',
				opts(),
			);
			const href = ps[0] ? propHrefs(ps[0], NS.cal, "schedule-default-calendar-URL")[0] : undefined;
			const calPrefix = `/remote.php/dav/calendars/${encodeURIComponent(uid)}/`;
			if (href && new URL(href, cfg.driveOrigin).pathname.startsWith(calPrefix)) {
				const res = await nc.request("PROPFIND", new URL(href, cfg.driveOrigin).pathname, {
					headers: { depth: "0", "content-type": "application/xml; charset=utf-8" },
					body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:prop><cal:calendar-timezone/></d:prop></d:propfind>',
					...opts(),
				});
				const cal = parseMultistatus(await nc.readText(res));
				const ics = cal[0]?.props.get(`{${NS.cal}}calendar-timezone`)?.text ?? "";
				const m = /^TZID:([^\r\n]{1,64})$/m.exec(ics);
				if (m?.[1] && isValidZone(m[1].trim())) zone = m[1].trim();
			}
		}
	} catch (e) {
		// A default calendar that isn't there (any more) is an answer: the default zone, cached.
		// Anything else (a timeout, a 5xx, a dead credential) leaves the zone unknown, uncached; the
		// tool itself reports NoDrive errors.
		if (!(isToolError(e) && e.code === "not_found")) return { zone: cfg.defaultTimeZone, known: false };
	}
	if (zoneCache.size > 5000) zoneCache.clear();
	zoneCache.set(key, { at: Date.now(), zone });
	return { zone, known: true };
}
