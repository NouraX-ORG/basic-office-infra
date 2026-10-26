/**
 * The OAuth library's grant records, seen from outside the library (fix for "client revocation
 * doesn't wipe the vault"). No imports, so the Vault Durable Object can use it.
 *
 * workers-oauth-provider 1.2.4 keeps a grant at `grant:<userId>:<grantId>` in OAUTH_KV, and its
 * codes and tokens are `<userId>:<grantId>:<secret>`. test/auth/grants.test.ts pins both against
 * the real library, so a library update that changes them fails the tests instead of the check.
 */

/** The library's grant ids: 16 characters of its URL-safe alphabet. */
export const GRANT_ID_RE = /^[A-Za-z0-9_-]{16}$/;

/** Uids that can own a grant: Nourax UUIDs, and QA accounts in local dev. */
const OWNER_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|qa-t\d+[a-z]?-[a-z0-9-]{1,20})$/;

export function grantKvKey(uid: string, grantId: string): string {
	return `grant:${uid}:${grantId}`;
}

/** The owner and grant id inside an authorization code, access token or refresh token, or null. */
export function grantOfToken(token: unknown): { uid: string; grantId: string } | null {
	if (typeof token !== "string" || token.length > 512) return null;
	const parts = token.split(":");
	if (parts.length !== 3) return null;
	const [uid, grantId] = parts as [string, string, string];
	if (!OWNER_RE.test(uid) || !GRANT_ID_RE.test(grantId)) return null;
	return { uid, grantId };
}

/** The grant id from the `code` in completeAuthorization()'s redirect, or null. */
export function grantIdFromRedirect(redirectTo: string, uid: string): string | null {
	try {
		const g = grantOfToken(new URL(redirectTo).searchParams.get("code"));
		return g && g.uid === uid ? g.grantId : null;
	} catch {
		return null;
	}
}

/** Whether the grant still exists. Throws when KV can't be read, so callers never act on a guess. */
export async function grantExists(kv: KVNamespace, uid: string, grantId: string): Promise<boolean> {
	if (!GRANT_ID_RE.test(grantId)) return false;
	return (await kv.get(grantKvKey(uid, grantId))) !== null;
}
