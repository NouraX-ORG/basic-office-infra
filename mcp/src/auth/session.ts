/**
 * Session and CSRF helpers for lane F's /connections pages (DESIGN 9.1).
 * The session cookie __Host-nx-session holds an HMAC-signed {uid, exp (30 min), nonce} with
 * SameSite=Strict. CSRF tokens are HMAC(csrf subkey, nonce), checked in constant time.
 */
import type { NxEnv } from "../env";
import { b64url, fromB64url, fromUtf8, hmacSha256, randomBytes, timingSafeEqual, utf8 } from "../core/bytes";
import { subkey } from "../core/keys";
import { LIMITS } from "../core/limits";
import { readCookie, setCookie } from "../http/cookies";

export const SESSION_COOKIE = "__Host-nx-session";

export interface Session {
	uid: string;
	exp: number;
	nonce: string;
}

export async function issueSession(env: NxEnv, uid: string): Promise<{ cookie: string; session: Session }> {
	const session: Session = { uid, exp: Math.floor(Date.now() / 1000) + LIMITS.sessionSec, nonce: b64url(randomBytes(16)) };
	const payload = b64url(utf8(JSON.stringify(session)));
	const mac = b64url(await hmacSha256(await subkey(env, "session"), payload));
	return { cookie: setCookie(SESSION_COOKIE, `${payload}.${mac}`, { maxAge: LIMITS.sessionSec, sameSite: "Strict" }), session };
}

export async function readSession(env: NxEnv, request: Request): Promise<Session | null> {
	const raw = readCookie(request, SESSION_COOKIE);
	if (!raw) return null;
	const [payload, mac] = raw.split(".");
	if (!payload || !mac) return null;
	try {
		const want = await hmacSha256(await subkey(env, "session"), payload);
		if (!timingSafeEqual(want, fromB64url(mac))) return null;
		const s = JSON.parse(fromUtf8(fromB64url(payload))) as Session;
		if (typeof s.uid !== "string" || typeof s.nonce !== "string" || typeof s.exp !== "number") return null;
		if (Math.floor(Date.now() / 1000) > s.exp) return null;
		return s;
	} catch {
		return null;
	}
}

export async function csrfToken(env: NxEnv, session: Session): Promise<string> {
	return b64url(await hmacSha256(await subkey(env, "csrf"), session.nonce));
}

export async function checkCsrf(env: NxEnv, session: Session, token: unknown): Promise<boolean> {
	if (typeof token !== "string" || token.length > 100) return false;
	try {
		return timingSafeEqual(fromB64url(await csrfToken(env, session)), fromB64url(token));
	} catch {
		return false;
	}
}

/**
 * For POSTs to our own pages (the consent form and lane F's /connections forms).
 * - A browser's Sec-Fetch-Site, when sent, must be "same-origin".
 * - Then the Origin must be ours, or, only together with Sec-Fetch-Site: same-origin, "null" or
 *   absent (a privacy setting or an older referrer policy can blank it). A page on another site
 *   can make its own POSTs carry `Origin: null` too, so "null" alone is never enough.
 * The library's browser-bound transaction cookie (consent) or our CSRF token (/connections) is the
 * second check behind this one.
 */
export function sameOrigin(request: Request, publicOrigin: string): boolean {
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin") return false;
	const origin = request.headers.get("origin");
	if (origin === publicOrigin) return true;
	return (origin === null || origin === "null") && site === "same-origin";
}
