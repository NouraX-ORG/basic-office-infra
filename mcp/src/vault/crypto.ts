/**
 * Vault cryptography (DESIGN 9.2), WebCrypto only.
 * - HKDF-SHA256 derives every key.
 * - Records are AES-256-GCM with a random 96-bit IV per write and an AAD that names the person,
 *   the connection, the record and the key version, so a record moved elsewhere fails to decrypt.
 * - A connection's data key (DEK) is wrapped twice with AES-KW: a use-wrap and a revoke-wrap.
 */
import { b64url, fromB64url, fromUtf8, randomBytes, utf8 } from "../core/bytes";

export async function hkdf(ikm: Uint8Array, salt: Uint8Array | string, info: string, length = 32): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt: typeof salt === "string" ? utf8(salt) : salt, info: utf8(info) },
		key,
		length * 8,
	);
	return new Uint8Array(bits);
}

async function gcmKey(raw: Uint8Array, usage: ("encrypt" | "decrypt")[]): Promise<CryptoKey> {
	if (raw.length !== 32) throw new Error("AES-256 key must be 32 bytes");
	return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usage);
}

/** Encrypts and returns base64url(iv || ciphertext+tag). */
export async function seal(keyBytes: Uint8Array, plaintext: Uint8Array, aad: string): Promise<string> {
	const iv = randomBytes(12);
	const key = await gcmKey(keyBytes, ["encrypt"]);
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, plaintext));
	const out = new Uint8Array(iv.length + ct.length);
	out.set(iv, 0);
	out.set(ct, iv.length);
	return b64url(out);
}

/** Decrypts seal() output. Throws on a wrong key, a wrong AAD or tampering. */
export async function open(keyBytes: Uint8Array, sealed: string, aad: string): Promise<Uint8Array> {
	const raw = fromB64url(sealed);
	if (raw.length < 12 + 16) throw new Error("sealed value too short");
	const key = await gcmKey(keyBytes, ["decrypt"]);
	const pt = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: utf8(aad) },
		key,
		raw.subarray(12),
	);
	return new Uint8Array(pt);
}

export async function sealJson(keyBytes: Uint8Array, value: unknown, aad: string): Promise<string> {
	return seal(keyBytes, utf8(JSON.stringify(value)), aad);
}

export async function openJson<T>(keyBytes: Uint8Array, sealed: string, aad: string): Promise<T> {
	return JSON.parse(fromUtf8(await open(keyBytes, sealed, aad))) as T;
}

/** AES-KW (RFC 3394) wrap of a 32-byte DEK under a 32-byte KEK. */
export async function wrapKey(kekBytes: Uint8Array, dek: Uint8Array): Promise<string> {
	const kek = await crypto.subtle.importKey("raw", kekBytes, "AES-KW", false, ["wrapKey"]);
	const dekKey = await crypto.subtle.importKey("raw", dek, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
	return b64url(new Uint8Array(await crypto.subtle.wrapKey("raw", dekKey, kek, "AES-KW")));
}

/** Unwraps a DEK. Throws when the KEK is wrong (AES-KW has an integrity check). */
export async function unwrapKey(kekBytes: Uint8Array, wrapped: string): Promise<Uint8Array> {
	const kek = await crypto.subtle.importKey("raw", kekBytes, "AES-KW", false, ["unwrapKey"]);
	const dekKey = await crypto.subtle.unwrapKey("raw", fromB64url(wrapped), kek, "AES-KW", { name: "AES-GCM" }, true, [
		"encrypt",
		"decrypt",
	]);
	return new Uint8Array((await crypto.subtle.exportKey("raw", dekKey)) as ArrayBuffer);
}

/** The use-wrap KEK: needs the token holder's vaultKey and the Worker's vault pepper. */
export function useKek(vaultKey: Uint8Array, pepper: Uint8Array, uid: string, connectionId: string): Promise<Uint8Array> {
	return hkdf(vaultKey, pepper, `nx/vault/use/v1|${uid}|${connectionId}`);
}

/**
 * NX_SECRET (the vault pepper's source) is missing or too short. A setup fault, never a reason to end
 * a connection: the call fails with 503 and every row stays as it is until the owner sets it again.
 * (A *different* valid NX_SECRET is a rotation, the kill switch: then the use-wraps stop unwrapping.)
 */
export class VaultSecretMissing extends Error {
	constructor() {
		super("NX_SECRET is missing or too short");
		this.name = "VaultSecretMissing";
	}
}

/** NX_REVOKE_SECRET is missing or too short. A setup fault: retry once the owner sets it again. */
export class RevokeSecretMissing extends Error {
	constructor() {
		super("NX_REVOKE_SECRET is missing or too short");
		this.name = "RevokeSecretMissing";
	}
}

/**
 * The revoke-wrap KEK: needs only NX_REVOKE_SECRET, and is used only to revoke and wipe.
 * Refuses a missing or short secret: HKDF over an empty key would give a KEK anyone can derive.
 */
export function revokeKek(revokeSecret: unknown, uid: string, connectionId: string): Promise<Uint8Array> {
	if (typeof revokeSecret !== "string" || revokeSecret.length < 32) return Promise.reject(new RevokeSecretMissing());
	return hkdf(utf8(revokeSecret), "nx-revoke", `nx/vault/revoke/v1|${uid}|${connectionId}`);
}

export function recordAad(uid: string, connectionId: string, recordName: string, keyVersion: number): string {
	return `nx-vault-v1|${uid}|${connectionId}|${recordName}|${keyVersion}`;
}
