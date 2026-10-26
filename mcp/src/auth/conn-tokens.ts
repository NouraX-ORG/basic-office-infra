/**
 * Desktop keys for ONLYOFFICE Desktop Editors (DESIGN 6.6), which can't do OAuth in its HTTP client.
 * - Format: "nxw_ct_" plus 43 base64url characters (256 bits). Shown once.
 * - KV holds ct:<hex sha-256(key)> = {v, uid, connectionId, expiresAt, label, ipLock?} with a TTL,
 *   and no secret material.
 * - The vault use key is HKDF(key, vault-pepper, "nx/ct/v1|" + connectionId), so KV plus the
 *   Durable Object data reveal nothing without the key.
 * - resolveExternalToken checks the prefix, the hash lookup, the expiry and the IP lock.
 * Lane F's /connections pages create and revoke keys with these helpers.
 */
import type { ResolveExternalTokenInput, ResolveExternalTokenResult } from "@cloudflare/workers-oauth-provider";
import { config, type NxEnv } from "../env";
import { b64url, randomBytes, sha256Hex, utf8 } from "../core/bytes";
import { subkey } from "../core/keys";
import { LIMITS } from "../core/limits";
import type { GrantProps } from "../mcp/context";
import { hkdf } from "../vault/crypto";

export const DESKTOP_KEY_PREFIX = "nxw_ct_";
const KEY_RE = /^nxw_ct_[A-Za-z0-9_-]{43}$/;

export interface DesktopKeyRecord {
	v: 1;
	uid: string;
	connectionId: string;
	/** Seconds since the epoch. */
	expiresAt: number;
	label: string;
	ipLock?: string;
	createdAt: number;
}

export function newDesktopKey(): string {
	return DESKTOP_KEY_PREFIX + b64url(randomBytes(32));
}

export async function desktopKeyHash(key: string): Promise<string> {
	return sha256Hex(key);
}

/** The vault use key for a desktop-key connection. */
export async function desktopVaultKey(env: NxEnv, key: string, connectionId: string): Promise<Uint8Array> {
	return hkdf(utf8(key), await subkey(env, "vault-pepper"), `nx/ct/v1|${connectionId}`);
}

/** Stores the KV record for a new desktop key. The key itself is never stored. */
export async function storeDesktopKey(env: NxEnv, key: string, rec: Omit<DesktopKeyRecord, "v" | "createdAt">): Promise<string> {
	const hash = await desktopKeyHash(key);
	const record: DesktopKeyRecord = { v: 1, ...rec, createdAt: Math.floor(Date.now() / 1000) };
	const ttl = Math.max(60, rec.expiresAt - Math.floor(Date.now() / 1000));
	await env.OAUTH_KV.put(`ct:${hash}`, JSON.stringify(record), { expirationTtl: ttl });
	return hash;
}

export async function revokeDesktopKeyByHash(env: NxEnv, hash: string): Promise<void> {
	if (!/^[0-9a-f]{64}$/.test(hash)) return;
	await env.OAUTH_KV.delete(`ct:${hash}`);
}

/** Days a key may live: 7, 30 (default) or 60. */
export function desktopKeyLifetimeSec(days: number): number {
	const d = days === 7 || days === 60 ? days : 30;
	return d * 86400;
}

export const DESKTOP_IDLE_SEC = LIMITS.desktopIdleSec;

/** resolveExternalToken for the OAuth provider: desktop keys only; anything else is not ours. */
export async function resolveDesktopKey(input: ResolveExternalTokenInput<NxEnv>): Promise<ResolveExternalTokenResult | null> {
	const { token, request, env } = input;
	if (!token.startsWith(DESKTOP_KEY_PREFIX) || !KEY_RE.test(token)) return null;
	const raw = await env.OAUTH_KV.get(`ct:${await desktopKeyHash(token)}`);
	if (!raw) return null;
	let rec: DesktopKeyRecord;
	try {
		rec = JSON.parse(raw) as DesktopKeyRecord;
	} catch {
		return null;
	}
	if (rec.v !== 1 || typeof rec.uid !== "string" || !/^[0-9a-f]{32}$/.test(rec.connectionId)) return null;
	if (Math.floor(Date.now() / 1000) > rec.expiresAt) return null;
	if (rec.ipLock) {
		const ip = request.headers.get("cf-connecting-ip");
		if (!ip || ip !== rec.ipLock) return null;
	}
	const vaultKey = await desktopVaultKey(env, token, rec.connectionId);
	const props: GrantProps = {
		v: 1,
		kind: "desktop",
		uid: rec.uid,
		connectionId: rec.connectionId,
		vaultKey: b64url(vaultKey),
		connectedAt: rec.createdAt,
		clientLabel: rec.label,
	};
	return { props, audience: config(env).resource };
}
