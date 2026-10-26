/**
 * The app choice behind a remembered consent (fix for "remembered consent grants every app").
 *
 * The library's "remember this choice" cookie keeps only the approved scopes. The apps the person
 * ticked (DESIGN 6.2) are kept here, in our own HMAC-signed cookie with the same key the library
 * uses (client, redirect URI, resource) and the same lifetime. On the remembered path the consent
 * page is skipped only when this entry is found; otherwise the page is shown again.
 */
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { NxEnv } from "../env";
import { b64url, fromB64url, fromUtf8, hmacSha256, sha256, timingSafeEqual, utf8 } from "../core/bytes";
import { subkey } from "../core/keys";
import { readCookie, setCookie } from "../http/cookies";

export const APPS_COOKIE = "__Host-nx-consent-apps";
const MAX_ENTRIES = 10;

interface Entry {
	/** sha-256 of [clientId, redirectUri, resource], base64url. */
	k: string;
	/** The apps the person ticked. */
	a: string[];
	/** Expiry, seconds since the epoch. */
	e: number;
}

async function entryKey(ar: AuthRequest): Promise<string> {
	return b64url(await sha256(JSON.stringify([ar.clientId, ar.redirectUri, ar.resource ?? null])));
}

async function read(env: NxEnv, request: Request): Promise<Entry[]> {
	const raw = readCookie(request, APPS_COOKIE);
	if (!raw || raw.length > 4096) return [];
	const [payload, mac] = raw.split(".");
	if (!payload || !mac) return [];
	try {
		const want = await hmacSha256(await subkey(env, "consent-apps"), payload);
		if (!timingSafeEqual(want, fromB64url(mac))) return [];
		const list = JSON.parse(fromUtf8(fromB64url(payload))) as unknown;
		if (!Array.isArray(list)) return [];
		return list.filter(
			(x): x is Entry =>
				!!x && typeof x === "object" && typeof (x as Entry).k === "string" && typeof (x as Entry).e === "number" && Array.isArray((x as Entry).a) && (x as Entry).a.every((s) => typeof s === "string"),
		);
	} catch {
		return [];
	}
}

/** The Set-Cookie header that remembers `apps` for this client, redirect and resource. */
export async function rememberApps(env: NxEnv, request: Request, ar: AuthRequest, apps: readonly string[], maxAgeSec: number): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const k = await entryKey(ar);
	const list = (await read(env, request)).filter((x) => x.e > now && x.k !== k);
	list.push({ k, a: [...apps], e: now + maxAgeSec });
	while (list.length > MAX_ENTRIES) list.shift();
	const payload = b64url(utf8(JSON.stringify(list)));
	const mac = b64url(await hmacSha256(await subkey(env, "consent-apps"), payload));
	const maxAge = Math.max(...list.map((x) => x.e)) - now;
	return setCookie(APPS_COOKIE, `${payload}.${mac}`, { maxAge, sameSite: "Lax" });
}

/** The remembered apps for this request, or null when there is no valid entry (show the page again). */
export async function rememberedApps(env: NxEnv, request: Request, ar: AuthRequest): Promise<string[] | null> {
	const now = Math.floor(Date.now() / 1000);
	const k = await entryKey(ar);
	const hit = (await read(env, request)).find((x) => x.k === k && x.e > now);
	return hit ? hit.a : null;
}
