/** Small byte helpers shared by every module. WebCrypto and plain JS only. */

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

export function utf8(s: string): Uint8Array {
	return enc.encode(s);
}

export function fromUtf8(b: Uint8Array): string {
	return dec.decode(b);
}

export function randomBytes(n: number): Uint8Array {
	const out = new Uint8Array(n);
	crypto.getRandomValues(out);
	return out;
}

export function toHex(b: Uint8Array): string {
	let s = "";
	for (const x of b) s += x.toString(16).padStart(2, "0");
	return s;
}

export function fromHex(s: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/i.test(s)) throw new Error("bad hex");
	const out = new Uint8Array(s.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
	return out;
}

export function b64url(b: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function b64(b: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return btoa(bin);
}

export function fromB64(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
	const bytes = typeof data === "string" ? utf8(data) : data;
	return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
	return toHex(await sha256(data));
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array | string): Promise<Uint8Array> {
	const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", k, typeof data === "string" ? utf8(data) : data));
}

/** Constant-time comparison for equal-length secrets. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}

/** JSON with sorted keys, so equal values hash equally (cursors, the duplicate guard). */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj)
		.filter((k) => obj[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** A 128-bit random id in hex. */
export function newId(): string {
	return toHex(randomBytes(16));
}
