/**
 * Paging cursors bound to their arguments (DESIGN 10.6):
 * base64url(JSON {v: 1, t: tool, o: offset or sub-cursors, q: sha-256(arguments without cursor)}).
 * A cursor sent with different arguments is refused. No signing is needed: a cursor can only move
 * within the person's own data.
 */
import { b64url, canonicalJson, fromB64url, fromUtf8, sha256Hex, utf8 } from "./bytes";
import { ToolError } from "./errors";

interface CursorBody {
	v: 1;
	t: string;
	o: unknown;
	q: string;
}

async function argsHash(args: Record<string, unknown>): Promise<string> {
	const { cursor: _ignored, ...rest } = args;
	return (await sha256Hex(canonicalJson(rest))).slice(0, 32);
}

export async function encodeCursor(tool: string, args: Record<string, unknown>, position: unknown): Promise<string> {
	const body: CursorBody = { v: 1, t: tool, o: position, q: await argsHash(args) };
	return b64url(utf8(JSON.stringify(body)));
}

/** Returns the position stored in the cursor, or null when `cursor` is absent. */
export async function decodeCursor<T = unknown>(tool: string, args: Record<string, unknown>, cursor: unknown): Promise<T | null> {
	if (cursor === undefined || cursor === null || cursor === "") return null;
	const bad = () => new ToolError("invalid_input", "This cursor isn't valid. Start again without cursor.", { field: "cursor" });
	if (typeof cursor !== "string" || cursor.length > 4096) throw bad();
	let body: CursorBody;
	try {
		body = JSON.parse(fromUtf8(fromB64url(cursor))) as CursorBody;
	} catch {
		throw bad();
	}
	if (body?.v !== 1 || body.t !== tool || typeof body.q !== "string") throw bad();
	if (body.q !== (await argsHash(args))) {
		throw new ToolError("invalid_input", "This cursor belongs to a different search. Start again without cursor.", { field: "cursor" });
	}
	return body.o as T;
}

/** Offset paging over an in-memory list. */
export async function pageOf<T>(
	tool: string,
	args: Record<string, unknown>,
	all: readonly T[],
	limit: number,
): Promise<{ items: T[]; next_cursor: string | null; has_more: boolean }> {
	const raw = await decodeCursor<number>(tool, args, args.cursor);
	const offset = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
	const items = all.slice(offset, offset + limit);
	const nextOffset = offset + items.length;
	const has_more = nextOffset < all.length;
	return { items, has_more, next_cursor: has_more ? await encodeCursor(tool, args, nextOffset) : null };
}
