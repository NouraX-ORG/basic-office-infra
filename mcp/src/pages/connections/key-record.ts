/**
 * Ending a desktop key on /connections deletes its KV record at once (DESIGN 9.3, "for desktop keys
 * delete ct:"), when the record can be found from the connection id.
 *
 * The vault doesn't keep the key's hash, and the key itself is never stored, so End can't name the
 * record `ct:<hex sha-256(key)>` by itself. Lane F's core patch "ct index" makes core's
 * storeDesktopKey (auth/conn-tokens.ts) also write `ctc:<connectionId>` = that hash, with the same
 * KV lifetime (no secret: a hash of a 256-bit random key). This module reads it. Until the patch is
 * applied nothing writes the index, End finds none, and the record stays until the key is next used
 * from its own network (core's endAccess deletes it then) or until its end date; docs/mcp.md 7.6
 * says so, and a drift test in test/pages/connections.test.ts ties the docs to what End does.
 */
import { revokeDesktopKeyByHash } from "../../auth/conn-tokens";
import type { NxEnv } from "../../env";

/** The index key core writes next to `ct:<hash>` (lane F core patch "ct index"). */
export function keyIndexKey(connectionId: string): string {
	return `ctc:${connectionId}`;
}

/**
 * Deletes the desktop key's `ct:` record and its index for this connection. True when a record was
 * named by the index and deleted; false when there was no index (nothing to do, or the core patch
 * isn't applied yet). Errors are left to the caller, which treats this as best effort: the vault row
 * is already gone, so the key is refused either way.
 */
export async function forgetDesktopKey(env: NxEnv, connectionId: string): Promise<boolean> {
	if (!/^[0-9a-f]{32}$/.test(connectionId)) return false;
	const hash = await env.OAUTH_KV.get(keyIndexKey(connectionId));
	if (hash === null) return false;
	if (/^[0-9a-f]{64}$/.test(hash)) await revokeDesktopKeyByHash(env, hash);
	await env.OAUTH_KV.delete(keyIndexKey(connectionId));
	return /^[0-9a-f]{64}$/.test(hash);
}
