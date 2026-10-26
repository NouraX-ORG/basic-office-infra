/**
 * Subkeys of NX_SECRET (DESIGN 4.2), derived with HKDF and cached per isolate:
 * vault-pepper, consent-memory, consent-apps, log-pseudonym, connect, session, csrf, dev and
 * quota-caller (the Quota object's caller keys, so no IP is stored).
 * Rotating NX_SECRET resets every one of them at once (the kill switch, DESIGN 9.5).
 */
import { toHex, utf8 } from "./bytes";

export type SubkeyName = "vault-pepper" | "consent-memory" | "consent-apps" | "log-pseudonym" | "connect" | "session" | "csrf" | "dev" | "quota-caller";

/** The shortest secret we accept for NX_SECRET and NX_REVOKE_SECRET (both are 43 characters today). */
export const MIN_SECRET_CHARS = 32;

export function secretOk(value: unknown): value is string {
	return typeof value === "string" && value.length >= MIN_SECRET_CHARS;
}

/** Both Worker secrets are present and long enough. Without them no connection may be made. */
export function secretsOk(env: { NX_SECRET?: unknown; NX_REVOKE_SECRET?: unknown }): boolean {
	return secretOk(env.NX_SECRET) && secretOk(env.NX_REVOKE_SECRET);
}

const cache = new Map<string, Promise<Uint8Array>>();

async function derive(secret: string, name: SubkeyName): Promise<Uint8Array> {
	const ikm = await crypto.subtle.importKey("raw", utf8(secret), "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt: utf8("nx-subkeys-v1"), info: utf8(`nx/subkey/${name}`) },
		ikm,
		256,
	);
	return new Uint8Array(bits);
}

export function subkey(env: { NX_SECRET: string }, name: SubkeyName): Promise<Uint8Array> {
	const secret = env.NX_SECRET;
	if (!secretOk(secret)) {
		return Promise.reject(new Error("NX_SECRET is missing or too short"));
	}
	const k = `${name}\u0000${secret}`;
	let p = cache.get(k);
	if (!p) {
		p = derive(secret, name);
		cache.set(k, p);
	}
	return p;
}

/** 64 hex characters, as the consent helpers ask for ("at least 32 characters"). */
export async function subkeyHex(env: { NX_SECRET: string }, name: SubkeyName): Promise<string> {
	return toHex(await subkey(env, name));
}
