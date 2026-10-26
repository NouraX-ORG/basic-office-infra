/**
 * Supabase token checks (DESIGN 7.1), with jose pinned to ES256. The JWKS is fetched through the
 * egress module (never by jose itself) and cached in memory per isolate (DESIGN 29.5):
 * - for an hour, but for 60 s only when it holds no ES256 signing key (an empty or partial answer
 *   must not stop every sign-in for an hour);
 * - a token whose key id isn't in the cached set (Supabase rotated or added a signing key) reloads
 *   the set once and is checked again, as jose's own remote key set does; at most one such reload a
 *   minute per isolate, so made-up key ids can't flood Supabase's JWKS endpoint.
 *
 * Access token: iss exactly {SUPABASE_URL}/auth/v1, aud "authenticated", role "authenticated",
 * client_id equal to ours (Supabase gives every client aud "authenticated", so this is the claim
 * that tells clients apart), exp and iat within 60 s, is_anonymous false, sub a UUID.
 * id_token: ES256, aud our client id, nonce matches, sub equal to the access token's sub.
 */
import { createLocalJWKSet, type JSONWebKeySet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { NxEnv } from "../env";
import { egress, readCappedJson } from "../core/egress";
import { isUuid } from "../core/ids";
import { LIMITS } from "../core/limits";

export class TokenCheckFailed extends Error {
	constructor(readonly reason: string) {
		super(`token check failed: ${reason}`);
		this.name = "TokenCheckFailed";
	}
}

/** How long a key set is kept: an hour, or 60 s when it holds no ES256 signing key. */
export const JWKS_CACHE_MS = 3600_000;
export const JWKS_SHORT_CACHE_MS = 60_000;
/** At most one reload for an unknown key id per this long, per isolate (from the last fetch). */
export const JWKS_RELOAD_GAP_MS = 60_000;

type LocalSet = ReturnType<typeof createLocalJWKSet>;
const jwksCache = new Map<string, { at: number; ttl: number; set: LocalSet }>();
/** When the key set of each Supabase URL was last fetched (or tried), for the reload gap. */
const lastFetch = new Map<string, number>();

/** A key jose would take for an ES256 signature: EC on P-256, for signing, with no other alg. */
function hasEs256Key(jwks: JSONWebKeySet): boolean {
	return jwks.keys.some((k) => k && typeof k === "object" && k.kty === "EC" && k.crv === "P-256" && (k.alg === undefined || k.alg === "ES256") && (k.use === undefined || k.use === "sig"));
}

async function fetchKeys(env: NxEnv, supabaseUrl: string): Promise<LocalSet> {
	lastFetch.set(supabaseUrl, Date.now());
	const res = await egress({ env }, `${supabaseUrl}/auth/v1/.well-known/jwks.json`, { method: "GET", headers: { accept: "application/json" }, timeoutMs: LIMITS.supabaseTimeoutMs });
	if (!res.ok) {
		await res.body?.cancel();
		throw new TokenCheckFailed("jwks_unavailable");
	}
	const jwks = await readCappedJson<JSONWebKeySet>(res, 64 * 1024);
	if (!jwks || !Array.isArray(jwks.keys)) throw new TokenCheckFailed("jwks_invalid");
	let set: LocalSet;
	try {
		set = createLocalJWKSet(jwks);
	} catch {
		throw new TokenCheckFailed("jwks_invalid");
	}
	jwksCache.set(supabaseUrl, { at: Date.now(), ttl: hasEs256Key(jwks) ? JWKS_CACHE_MS : JWKS_SHORT_CACHE_MS, set });
	return set;
}

/**
 * The key resolver for Supabase's tokens. The set is loaded (or taken from the cache) now, so an
 * unreachable JWKS fails here as before. The resolver always uses the newest cached set, and on a key
 * id that isn't in it reloads once (within the reload gap) and tries again.
 */
export async function supabaseKeys(env: NxEnv, supabaseUrl: string, forceReload = false): Promise<JWTVerifyGetKey> {
	const hit = jwksCache.get(supabaseUrl);
	const first = hit && !forceReload && Date.now() - hit.at < hit.ttl ? hit.set : await fetchKeys(env, supabaseUrl);
	const resolve: JWTVerifyGetKey = async (header, token) => {
		const current = jwksCache.get(supabaseUrl)?.set ?? first;
		try {
			return await current(header, token);
		} catch (e) {
			if ((e as { code?: unknown })?.code !== "ERR_JWKS_NO_MATCHING_KEY") throw e;
			if (Date.now() - (lastFetch.get(supabaseUrl) ?? 0) < JWKS_RELOAD_GAP_MS) throw e;
			const fresh = await fetchKeys(env, supabaseUrl);
			return fresh(header, token);
		}
	};
	return resolve;
}

/** Tests only: forget the cached key sets and the reload gap. */
export function _resetJwksCache(): void {
	jwksCache.clear();
	lastFetch.clear();
}

export interface CheckOptions {
	supabaseUrl: string;
	clientId: string;
	keys: JWTVerifyGetKey;
	nowSec?: number;
}

/** jose's error code, or our own reason when the key set itself failed (TokenCheckFailed). */
function failure(e: unknown): TokenCheckFailed {
	if (e instanceof TokenCheckFailed) return e;
	return new TokenCheckFailed(e instanceof Error ? (e as { code?: string }).code ?? "verify" : "verify");
}

export interface CheckedAccessToken {
	sub: string;
	exp: number;
	claims: JWTPayload;
}

export async function checkAccessToken(token: string, o: CheckOptions): Promise<CheckedAccessToken> {
	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(token, o.keys, {
			algorithms: ["ES256"],
			issuer: `${o.supabaseUrl}/auth/v1`,
			audience: "authenticated",
			clockTolerance: 60,
			...(o.nowSec ? { currentDate: new Date(o.nowSec * 1000) } : {}),
		}));
	} catch (e) {
		throw failure(e);
	}
	const now = o.nowSec ?? Math.floor(Date.now() / 1000);
	if (payload.role !== "authenticated") throw new TokenCheckFailed("role");
	if (payload.client_id !== o.clientId) throw new TokenCheckFailed("client_id");
	if (payload.is_anonymous === true) throw new TokenCheckFailed("anonymous");
	if (typeof payload.sub !== "string" || !isUuid(payload.sub)) throw new TokenCheckFailed("sub");
	if (typeof payload.exp !== "number") throw new TokenCheckFailed("exp");
	if (typeof payload.iat !== "number" || payload.iat > now + 60) throw new TokenCheckFailed("iat");
	return { sub: payload.sub, exp: payload.exp, claims: payload };
}

export async function checkIdToken(token: string, o: CheckOptions & { nonce: string; sub: string }): Promise<{ email: string | null }> {
	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(token, o.keys, {
			algorithms: ["ES256"],
			issuer: `${o.supabaseUrl}/auth/v1`,
			audience: o.clientId,
			clockTolerance: 60,
			...(o.nowSec ? { currentDate: new Date(o.nowSec * 1000) } : {}),
		}));
	} catch (e) {
		throw failure(e);
	}
	if (payload.nonce !== o.nonce) throw new TokenCheckFailed("nonce");
	if (payload.sub !== o.sub) throw new TokenCheckFailed("id_sub");
	return { email: typeof payload.email === "string" ? payload.email : null };
}
