/**
 * Registers tools on a per-request McpServer and wraps every call (DESIGN 10.2):
 * 1. a Vault limit that blocked this call answers first;
 * 2. input validation with our own messages (the SDK sees a pass-through schema that still
 *    publishes the real JSON Schema, so its terse text never reaches people);
 * 3. the 10-minute duplicate guard;
 * 4. run, with a 60 s AbortSignal; when it fires, the NoDrive client of this request stops too
 *    (rc.ncAbort), so a timed-out tool sends nothing more. A tool that reads times first looks up
 *    the person's time zone, inside that budget (fix round 4, zone.ts);
 * 5. error mapping (no upstream text leaks). A tool that changes data and isn't idempotent, whose
 *    timeout or upstream failure came while a change it sent had no answer from NoDrive (a failed or
 *    cancelled fetch, a 5xx, or still in flight), says the outcome is unknown and is not retryable,
 *    as the mail lane does, unless the tool itself stated the outcome (fix round 3);
 * 6. result building: framing, the 60,000-character cap, undo, warnings (also when the person's time
 *    zone couldn't be read), _meta;
 * 7. one log line.
 */
import type { McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";
import { canonicalJson } from "../core/bytes";
import { decodeCursor, encodeCursor, pageOf } from "../core/cursor";
import { asToolError, type ErrorCode, ToolError } from "../core/errors";
import { LIMITS } from "../core/limits";
import { log, pseudonym } from "../core/log";
import { dropInvisible, dropInvisibleDeep } from "../core/invisible";
import { compactJson, errorResult, frame, oneLine, payloadBudget } from "../core/result";
import { timeApi } from "../core/time";
import type { ConnectionInfo, PageApi, ToolCtx, ToolDef, ToolOutcome } from "../core/tool";
import { annotationsFor } from "./catalog";
import type { RequestCtx } from "./context";
import { needsZone, resolveZone, ZONE_APPS } from "./zone";

type CallResult = {
	content: { type: "text"; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	_meta?: Record<string, unknown>;
};

/**
 * A published JSON Schema without its `$schema` line: MCP reads a schema without one as JSON Schema
 * 2020-12 (MCP 2025-11-25, "JSON Schema Usage"), which is what zod writes, and the 70 copies of that
 * line cost about 4.6 KB of every tools/list (fix round 3, DESIGN 10.8).
 */
function withoutDialect(js: Record<string, unknown>): Record<string, unknown> {
	if (!js || typeof js !== "object" || !("$schema" in js)) return js;
	const { $schema: _dialect, ...rest } = js;
	return rest;
}

/** A Standard Schema that accepts anything but publishes `schema`'s JSON Schema for tools/list. */
export function passThroughSchema(schema: z.ZodType): StandardSchemaWithJSON<Record<string, unknown>> {
	const std = (schema as unknown as { "~standard": StandardSchemaWithJSON["~standard"] })["~standard"];
	return {
		"~standard": {
			version: 1,
			vendor: "nourax",
			validate: (value: unknown) => ({ value: (value ?? {}) as Record<string, unknown> }),
			jsonSchema: {
				input: (o) => withoutDialect(std.jsonSchema.input(o) as Record<string, unknown>),
				output: (o) => withoutDialect(std.jsonSchema.input(o) as Record<string, unknown>),
			},
		},
	} as StandardSchemaWithJSON<Record<string, unknown>>;
}

/** An output schema as published: zod validates as before; the JSON Schema has no `$schema` line. */
function publishedOutput(schema: z.ZodType): StandardSchemaWithJSON {
	const std = (schema as unknown as { "~standard": StandardSchemaWithJSON["~standard"] })["~standard"];
	return {
		"~standard": {
			version: 1,
			vendor: std.vendor,
			validate: (value: unknown) => std.validate(value),
			jsonSchema: {
				input: (o) => withoutDialect(std.jsonSchema.input(o) as Record<string, unknown>),
				output: (o) => withoutDialect(std.jsonSchema.output(o) as Record<string, unknown>),
			},
		},
	} as StandardSchemaWithJSON;
}

/** The first problem in plain words, naming the field. */
export function describeIssue(err: z.ZodError): { message: string; field?: string } {
	const issue = err.issues[0];
	if (!issue) return { message: "The input isn't valid." };
	const field = issue.path.map(String).join(".") || undefined;
	const where = field ? `${field}: ` : "";
	let what: string;
	switch (issue.code) {
		case "unrecognized_keys":
			what = `unknown input ${(issue as { keys?: string[] }).keys?.map((k) => `"${k}"`).join(", ") ?? ""}`.trim();
			break;
		case "invalid_type":
			what = issue.input === undefined ? "is required" : `must be ${(issue as { expected?: string }).expected ?? "a different type"}`;
			break;
		case "too_big":
			what = `is too long or too large (at most ${String((issue as { maximum?: number | bigint }).maximum)})`;
			break;
		case "too_small":
			what = `is too short or too small (at least ${String((issue as { minimum?: number | bigint }).minimum)})`;
			break;
		case "invalid_value":
			what = `must be one of ${((issue as { values?: unknown[] }).values ?? []).map((v) => JSON.stringify(v)).join(", ")}`;
			break;
		default:
			what = issue.message;
	}
	return { message: oneLine(`${where}${what}.`), field };
}

function connectionInfo(rc: RequestCtx): ConnectionInfo {
	return {
		connectionId: rc.connectionId,
		kind: rc.open.kind,
		client: rc.open.clientLabel,
		cli: rc.cli,
		scopes: rc.scopes,
		apps: rc.apps,
		connectedAt: new Date(rc.open.connectedAt * 1000).toISOString(),
		expiresAt: new Date(rc.open.expiresAt * 1000).toISOString(),
		mail: rc.mail.state,
	};
}

/**
 * What a fitted page may take as structuredContent carries it (third system review, section 30.7):
 * JSON with nulls kept (outcomeToResult sends every null; compactJson, which the framed text uses,
 * drops them), within the payload budget left by the longest summary core allows (300 characters).
 * The framed text is the same JSON without its nulls, so it fits too.
 */
export const FIT_CHARS = Math.min(payloadBudget("x".repeat(300)), LIMITS.resultChars);

function pageApi(tool: string, args: Record<string, unknown>, budgetChars: number): PageApi {
	const room = Math.min(budgetChars, FIT_CHARS);
	return {
		slice: (all, limit) => pageOf(tool, args, all, limit),
		encode: (position) => encodeCursor(tool, args, position),
		decode: <T>() => decodeCursor<T>(tool, args, args.cursor),
		fit<T>(items: readonly T[], render: (items: T[]) => unknown) {
			let lo = 0;
			let hi = items.length;
			const fits = (n: number) => (JSON.stringify(render(items.slice(0, n))) ?? "").length <= room;
			if (fits(hi)) return { items: items.slice(), cut: false };
			while (lo < hi) {
				const mid = Math.ceil((lo + hi) / 2);
				if (fits(mid)) lo = mid;
				else hi = mid - 1;
			}
			return { items: items.slice(0, lo), cut: true };
		},
	};
}

function buildCtx(rc: RequestCtx, def: ToolDef, args: Record<string, unknown>, signal: AbortSignal, notes: string[], warnings: string[]): ToolCtx {
	const budgetChars = payloadBudget("x".repeat(120));
	return {
		uid: rc.uid,
		displayName: rc.open.displayName,
		connection: connectionInfo(rc),
		nc: rc.nc,
		mail: rc.mail,
		time: timeApi(rc.zone),
		budget: { chars: budgetChars },
		page: pageApi(def.name, args, budgetChars),
		signal,
		rid: rc.rid,
		env: rc.env,
		cfg: rc.cfg,
		log: { note: (c) => notes.push(c) },
		warn: (m) => {
			if (!warnings.includes(m)) warnings.push(m);
		},
		fail(code: ErrorCode, message?: string, hint?: string): never {
			throw new ToolError(code, message, { hint });
		},
		async charge(bucket, weight = 1, bytes = 0) {
			const r = await rc.vault.charge(bucket, weight, bytes);
			if (!r.ok) {
				throw new ToolError(r.reason === "daily_limit" ? "daily_limit" : "rate_limited", limitMessage(r.reason, r.limit), { retryAfterSec: r.retryAfterSec });
			}
		},
	};
}

export function limitMessage(reason: string, limit?: string): string {
	if (reason === "daily_limit") {
		if (limit === "upload") return "This connection reached today's upload limit (200 MB). It resets at midnight UTC.";
		if (limit && limit !== "calls") return `This connection reached today's limit for ${limit === "remove" ? "moving things to the trash" : limit} actions. It resets at midnight UTC.`;
		return "This connection reached today's limit of calls. It resets at midnight UTC.";
	}
	return limit ? `Too many requests in a short time (${limit}). Try again shortly.` : "Too many requests in a short time. Try again shortly.";
}

/**
 * `_meta["mcp/www_authenticate"]` for a result that needs the person to connect again. ChatGPT shows
 * its re-link prompt only when the challenge has both error and error_description (OpenAI Apps SDK,
 * "Triggering authentication UI"); the value may be a string or a list, and a list is sent.
 */
export function wwwAuthenticate(cfg: { publicOrigin: string }, description = "This connection has ended. Connect again"): string[] {
	return [`Bearer error="invalid_token", error_description="${description}", resource_metadata="${cfg.publicOrigin}/.well-known/oauth-protected-resource/mcp"`];
}

const warningsOk = new Map<string, boolean>();

/**
 * Whether a tool's published output schema lets structuredContent carry `warnings`. zod publishes a
 * plain object with additionalProperties false, and clients (the MCP TypeScript SDK among them)
 * check structuredContent against it, so a warning the schema doesn't name must not be added.
 */
export function outputTakesWarnings(def: ToolDef): boolean {
	if (!def.output) return true;
	let ok = warningsOk.get(def.name);
	if (ok === undefined) {
		const js = z.toJSONSchema(def.output, { io: "output", unrepresentable: "any" }) as { properties?: Record<string, unknown>; additionalProperties?: unknown };
		ok = Boolean(js.properties && "warnings" in js.properties) || js.additionalProperties !== false;
		warningsOk.set(def.name, ok);
	}
	return ok;
}

/**
 * A timeout or an upstream failure after a change was sent: whether it was done isn't known, so the
 * assistant must look before it tries again (caller rule 3, as for mail).
 */
export function unsureOutcome(e: ToolError): ToolError {
	const message =
		e.code === "timeout"
			? "That took too long, and it isn't known whether it was done. Check before trying again, so nothing is made twice."
			: "Nourax Workspace didn't answer properly, and it isn't known whether this was done. Check before trying again, so nothing is made twice.";
	return new ToolError(e.code, message, { retryable: false, upstreamStatus: e.upstreamStatus, deadCredential: e.deadCredential });
}

/**
 * Turns an outcome into a CallToolResult (framed text plus structuredContent). When the payload is
 * text of its own (files_read_text), structuredContent carries the same framed block as `text`, so a
 * client that reads only structuredContent still gets the text, and still inside the data markers
 * (fix round 3; MCP 2025-11-25 "Structured Content": both should hold the same result).
 *
 * Fix round 4: every string in it loses invisible Unicode first (core/invisible.ts; names, paths and
 * ids keep the joiners they need to name the same item again), and so does the text payload, so the
 * framed text and structuredContent say the same and neither carries hidden text.
 */
export function outcomeToResult(outcome: ToolOutcome<unknown>): CallResult {
	const data = (outcome.data ?? {}) as Record<string, unknown>;
	let structured: Record<string, unknown> = { ...data };
	if (outcome.undo !== undefined && structured.undo === undefined) structured.undo = outcome.undo;
	if (outcome.warnings?.length && structured.warnings === undefined) structured.warnings = outcome.warnings;
	structured = dropInvisibleDeep(structured);
	const payload = outcome.text !== undefined ? dropInvisible(outcome.text) : compactJson(structured);
	const text = frame(outcome.summary, payload, outcome.notice ? { notice: outcome.notice } : {});
	if (outcome.text !== undefined) structured.text = text;
	return {
		content: [{ type: "text", text }],
		structuredContent: structured,
	};
}

/**
 * The tool's log line, with the codes it noted through ctx.log.note (third system review, section
 * 30.5: they were collected and never written). They are short fixed codes, never user data; each is
 * logged once. "href_outside" (NoDrive answered with an address outside the person's own files) is
 * also an auth event of its own (DESIGN 15), once per call, so the monitoring query finds it.
 */
async function logTool(rc: RequestCtx, tool: string, ok: boolean, code: string | undefined, started: number, outBytes: number, notes: readonly string[] = []): Promise<void> {
	const who = await pseudonym(rc.env, rc.uid, 12);
	const unique = [...new Set(notes)];
	log({
		t: "tool",
		rid: rc.rid,
		who,
		conn: await pseudonym(rc.env, rc.connectionId, 8),
		cli: rc.cli,
		tool,
		ok,
		code,
		ms: Date.now() - started,
		nc_calls: rc.stats.calls,
		nc_status: rc.stats.lastStatus,
		in_bytes: rc.inBytes,
		out_bytes: outBytes,
		notes: unique.length ? unique.slice(0, 10) : undefined,
	});
	if (unique.includes("href_outside")) log({ t: "auth", rid: rc.rid, ev: "href_outside", who, cli: rc.cli });
}

export async function runTool(rc: RequestCtx, def: ToolDef, rawArgs: unknown): Promise<CallResult> {
	const started = Date.now();
	const notes: string[] = [];
	const finish = async (result: CallResult, ok: boolean, code?: string): Promise<CallResult> => {
		await logTool(rc, def.name, ok, code, started, JSON.stringify(result).length, notes);
		return result;
	};
	const failWith = async (e: ToolError): Promise<CallResult> => {
		if (e.deadCredential) rc.deadCredential = true;
		const extra = e.code === "reconnect_required" ? { "mcp/www_authenticate": wwwAuthenticate(rc.cfg) } : {};
		return finish(errorResult(e, extra), false, e.code);
	};
	if (rc.blocked) return failWith(rc.blocked);

	const parsed = def.input.safeParse(rawArgs ?? {});
	if (!parsed.success) {
		const { message, field } = describeIssue(parsed.error);
		return failWith(new ToolError("invalid_input", message, { field }));
	}
	const args = parsed.data as Record<string, unknown>;

	let dedupeKey: string | null = null;
	if (def.entry.dedupe && args.allow_duplicate !== true) {
		const { allow_duplicate: _a, ...rest } = args;
		dedupeKey = `${def.name}|${canonicalJson(rest)}`;
		try {
			const raw = await rc.vault.dedupe(rc.connectionId, rc.useKey, dedupeKey, "get");
			const prev = raw ? (JSON.parse(raw) as { at: number; result: CallResult }) : null;
			if (prev?.result) {
				const mins = Math.max(1, Math.round((Date.now() - prev.at) / 60000));
				const note = `This matches a call made ${mins} minute${mins === 1 ? "" : "s"} ago; the item made then is returned. allow_duplicate makes a second one.`;
				const again: CallResult = {
					...prev.result,
					content: prev.result.content.map((c, i) => (i === 0 ? { type: "text" as const, text: `${note}\n${c.text}` } : c)),
				};
				return finish(again, true, "duplicate");
			}
		} catch {
			// The guard is a convenience; a vault hiccup must not block the call.
		}
	}

	const controller = new AbortController();
	const uncertainBefore = rc.stats.uncertainWrites ?? 0;
	const timer = setTimeout(() => {
		const reason = new DOMException("timeout", "TimeoutError");
		controller.abort(reason);
		// The run is abandoned: its NoDrive calls in flight are cancelled and no new one starts.
		rc.ncAbort?.abort(reason);
	}, LIMITS.toolTimeoutMs);
	try {
		// The person's zone, only for a tool that reads times, inside this budget and under its
		// signal, with 5 s of its own and no retry (fix round 4, zone.ts).
		if (needsZone(def, args)) {
			const z = await resolveZone(rc.nc, rc.cfg, rc.uid);
			rc.zone = z.zone;
			rc.zoneKnown = z.known;
			if (controller.signal.aborted) throw new ToolError("timeout");
		}
		const warned: string[] = [];
		const ctx = buildCtx(rc, def, args, controller.signal, notes, warned);
		const outcome = await Promise.race([
			def.run(ctx, args),
			new Promise<never>((_, reject) => {
				controller.signal.addEventListener("abort", () => reject(new ToolError("timeout")), { once: true });
			}),
		]);
		if (rc.zoneKnown === false && def.entry.app !== null && ZONE_APPS.has(def.entry.app)) {
			warned.push(`NoDrive didn't say which time zone this person uses, so times without a zone were read in ${rc.cfg.defaultTimeZone}. Check them, or give times with a zone.`);
		}
		if (warned.length && outputTakesWarnings(def)) {
			const data = (outcome.data ?? {}) as Record<string, unknown>;
			if (Array.isArray(data.warnings)) outcome.data = { ...data, warnings: [...(data.warnings as string[]), ...warned] };
			else outcome.warnings = [...(outcome.warnings ?? []), ...warned];
		}
		const result = outcomeToResult(outcome);
		if (dedupeKey) {
			try {
				await rc.vault.dedupe(rc.connectionId, rc.useKey, dedupeKey, "put", JSON.stringify({ at: Date.now(), result }), LIMITS.dedupeSec);
			} catch {
				// see above
			}
		}
		return finish(result, true);
	} catch (e) {
		const err = asToolError(e);
		// Unknown only when a change was sent and NoDrive didn't answer about it (a failed or cancelled
		// fetch, a 5xx, or still in flight at the timeout), and the tool didn't say what happened.
		const changes = def.entry.tier !== "R" && !def.entry.idempotent;
		const unanswered = (rc.stats.uncertainWrites ?? 0) > uncertainBefore || (rc.stats.writesInFlight ?? 0) > 0;
		if (changes && unanswered && (err.code === "timeout" || err.code === "upstream_unavailable") && err.statedRetryable === undefined) {
			return failWith(unsureOutcome(err));
		}
		return failWith(err);
	} finally {
		clearTimeout(timer);
	}
}

export function registerOwnTool(server: McpServer, def: ToolDef, rc: RequestCtx): void {
	server.registerTool(
		def.name,
		{
			title: def.title,
			description: def.description,
			inputSchema: passThroughSchema(def.input),
			...(def.output ? { outputSchema: publishedOutput(def.output) } : {}),
			annotations: { title: def.title, ...annotationsFor(def.entry) },
			_meta: { securitySchemes: [{ type: "oauth2", scopes: [def.entry.scope] }] },
		},
		async (args: Record<string, unknown>) => (await runTool(rc, def, args)) as never,
	);
}

/** A known tool hidden by app or flag, called anyway: answer not_available (never listed). */
export function registerGatedStub(server: McpServer, name: string, error: ToolError, rc: RequestCtx): void {
	server.registerTool(
		name,
		{ description: "Not available on this connection.", inputSchema: passThroughSchema(z.object({}).passthrough()) },
		async () => {
			const started = Date.now();
			const result = errorResult(error);
			await logTool(rc, name, false, error.code, started, JSON.stringify(result).length);
			return result as never;
		},
	);
}

