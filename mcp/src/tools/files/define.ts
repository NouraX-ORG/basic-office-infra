/**
 * Lane A's tool definer. Each files tool states its result shape in code: `run` is type-checked
 * against it, and the contract tests check every result against it as zod would publish it
 * (additionalProperties false at every level, test/tools/files/conformance.test.ts).
 *
 * The shapes are not published as outputSchema in tools/list. DESIGN 10.8 keeps the whole own
 * tools/list within 60 KB, and the output schemas were 14 KB of lane A's 34 KB (the FileItem object
 * repeated in 13 of them). The MCP specification makes outputSchema optional, and every result's
 * JSON is in the framed text block as well (DESIGN 10.4). Lanes B and G do the same.
 *
 * It also guards the lane's rule for unframed texts (common.ts, at the top): an error whose message
 * or hint repeats a path, a name or a trash item id from the call gets the catalogue's plain
 * message instead (DEFAULT_MESSAGE), with the same code, field and retry facts. Lane A's own
 * messages never do that; the guard is for messages core builds (the NoDrive client's `what`).
 * Summaries are lane A's own text only; test/tools/files/echo.test.ts checks them.
 */
import type { z } from "zod";
import { DEFAULT_MESSAGE, ToolError, isToolError } from "../../core/errors";
import { normalizePath } from "../../core/paths";
import { defineTool, type ToolCtx, type ToolDef, type ToolSpec } from "../../core/tool";

/** Every files tool's result shape, by tool name, for the contract tests. */
export const FILES_OUTPUTS: Record<string, z.ZodType> = {};

/** The arguments whose text may be someone else's: paths, and names. */
const PATH_ARGS = ["path", "to_folder", "folder"] as const;
const NAME_ARGS = ["new_name", "trash_item_id"] as const;

/** Texts shorter than this can't carry an instruction and would match ordinary words (fix round 5). */
const MIN_ECHO_CHARS = 4;

/**
 * The texts an error must not repeat: each such argument as given, trimmed and (paths) normalised,
 * and each name inside a path argument, since core's name checks quote only the refused name
 * (fix round 5). Texts under MIN_ECHO_CHARS (trimmed) and the top folder are left out.
 */
export function echoTexts(args: Record<string, unknown>): string[] {
	const out = new Set<string>();
	const add = (f: string) => {
		if (f.trim().length >= MIN_ECHO_CHARS && f !== "/") out.add(f);
	};
	for (const k of [...PATH_ARGS, ...NAME_ARGS]) {
		const v = args[k];
		if (typeof v !== "string") continue;
		const forms = [v, v.trim()];
		if ((PATH_ARGS as readonly string[]).includes(k)) {
			try {
				forms.push(normalizePath(v, { field: k }));
			} catch {
				// Not a valid path: only the text as given can be repeated.
			}
			for (const seg of v.normalize("NFC").split("/")) forms.push(seg, seg.trim());
		}
		for (const f of forms) add(f);
	}
	return [...out];
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** True when `t` occurs in `s` and isn't just part of a longer word (so "that" doesn't hit "thatch"). */
export function containsWhole(s: string, t: string): boolean {
	for (let i = s.indexOf(t); i !== -1; i = s.indexOf(t, i + 1)) {
		const before = i > 0 ? (s[i - 1] ?? "") : "";
		const after = s[i + t.length] ?? "";
		const edgeOk = (edge: string, inner: string | undefined) => edge === "" || !WORD_CHAR.test(edge) || inner === undefined || !WORD_CHAR.test(inner);
		if (edgeOk(before, t[0]) && edgeOk(after, t[t.length - 1])) return true;
	}
	return false;
}

/** The same error with the catalogue's plain text where its message or hint repeats one of `texts`. */
export function withoutEcho(e: ToolError, texts: readonly string[]): ToolError {
	const has = (s: string | undefined) => s !== undefined && texts.some((t) => containsWhole(s, t));
	const badMessage = has(e.message);
	const badHint = has(e.hint);
	if (!badMessage && !badHint) return e;
	return new ToolError(e.code, badMessage ? DEFAULT_MESSAGE[e.code] : e.message, {
		hint: badHint ? undefined : e.hint,
		field: e.field,
		retryAfterSec: e.retryAfterSec,
		deadCredential: e.deadCredential,
		upstreamStatus: e.upstreamStatus,
		detail: e.detail,
	});
}

export function filesTool<I extends z.ZodObject, O extends z.ZodType>(spec: ToolSpec<I, O> & { output: O }): ToolDef {
	FILES_OUTPUTS[spec.name] = spec.output;
	const run = spec.run;
	const guarded: typeof run = async (ctx: ToolCtx, args) => {
		try {
			return await run(ctx, args);
		} catch (e) {
			if (!isToolError(e)) throw e;
			const clean = withoutEcho(e, echoTexts(args as Record<string, unknown>));
			if (clean !== e) ctx.log.note("echo_scrubbed");
			throw clean;
		}
	};
	return { ...defineTool({ ...spec, run: guarded }), output: undefined };
}
