/**
 * Signing out of /connections ends the page's sign-in on the server too (lane F, second review,
 * fix round 2). The session itself is a stateless HMAC cookie ({uid, exp, nonce}, 30 minutes;
 * auth/session.ts), so clearing the cookie alone left a copied cookie, or the same person's sign-in
 * in another browser, working until it expired. That matters in Drive-only mode: someone who got a
 * person to grant the page's sign-in (docs/mcp.md 7.3) kept that session even after the person
 * signed out.
 *
 * So sign-out writes one KV record per person, `pso:<hex sha-256(uid)>` = "<sign-out time in
 * seconds>:<hex sha-256 of the signing-out session's nonce, cut to 32>". Every page request that
 * carries a session reads it, and the session counts as signed out, in every browser, when it was
 * issued before that second, or when it is the session that signed out. (Sessions carry their time
 * in whole seconds, so a sign-in in the same second as a sign-out, which only a script manages,
 * stays valid; the browser that signed out is matched by its nonce instead.) The record holds no
 * secret and no plain uid, and lives as long as a session can (LIMITS.sessionSec plus two minutes).
 *
 * KV is eventually consistent: the browser that signed out is signed out at once (its cookie is
 * cleared too), other locations see the record within about a minute (Cloudflare KV docs: writes
 * are visible at once where they were made and within the read's cacheTtl elsewhere; we read with
 * the minimum, 30 s). Cost: one KV read per signed-in page request and one write per sign-out.
 * The key prefix `pso:` is ours alone: the OAuth library uses client:, grant(s):, token(s): and
 * transaction:, and core uses ct: (checked in the installed library and in src/).
 */
import type { NxEnv } from "../../env";
import { sha256Hex } from "../../core/bytes";
import { LIMITS } from "../../core/limits";
import { readSession, type Session } from "../../auth/session";

/** How long the sign-out record lives: as long as any session issued before it could. */
export const SIGN_OUT_RECORD_SEC = LIMITS.sessionSec + 120;
/** Cloudflare KV's minimum cacheTtl: other locations see a sign-out within about this long. */
const READ_CACHE_SEC = 30;
const RECORD_RE = /^(\d{1,12}):([0-9a-f]{32})$/;

export async function signOutKey(uid: string): Promise<string> {
	return `pso:${await sha256Hex(uid)}`;
}

async function nonceTag(s: Session): Promise<string> {
	return (await sha256Hex(`pso-nonce:${s.nonce}`)).slice(0, 32);
}

/** When the session was issued: sessions always live LIMITS.sessionSec (auth/session.ts issueSession). */
export function issuedAt(s: Session): number {
	return s.exp - LIMITS.sessionSec;
}

/**
 * The page session, or null when there is none, it is invalid, or the person signed out of this page
 * after it was issued (in any browser). A KV failure throws, so the page answers "busy" (fail closed).
 */
export async function currentSession(env: NxEnv, request: Request): Promise<Session | null> {
	const s = await readSession(env, request);
	if (!s) return null;
	const raw = await env.OAUTH_KV.get(await signOutKey(s.uid), { cacheTtl: READ_CACHE_SEC });
	if (raw === null) return s;
	const m = RECORD_RE.exec(raw);
	// Only a sign-out writes this record; one we can't read ends the session (fail closed).
	if (!m) return null;
	if (issuedAt(s) < Number(m[1])) return null;
	if (m[2] === (await nonceTag(s))) return null;
	return s;
}

/**
 * Records that the person signed out of this page now: every page session issued before this second
 * ends, and so does `session` itself. False when KV refused the write (it allows one write per key a
 * second, so two sign-outs in one second can meet that): the caller then says that only this browser
 * is signed out.
 */
export async function endPageSessions(env: NxEnv, session: Session): Promise<boolean> {
	try {
		const value = `${Math.floor(Date.now() / 1000)}:${await nonceTag(session)}`;
		await env.OAUTH_KV.put(await signOutKey(session.uid), value, { expirationTtl: SIGN_OUT_RECORD_SEC });
		return true;
	} catch {
		return false;
	}
}
