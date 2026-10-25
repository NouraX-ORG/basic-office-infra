// Upload tickets: AES-256-GCM sealed JSON that NoMail's server mints and this Worker opens.
// The browser carries the ticket but cannot read it, so the user's Drive app password never
// reaches the browser. Format: "v1." + base64url(12-byte IV || ciphertext+tag).
// SPDX-License-Identifier: AGPL-3.0-or-later

export const TICKET_PREFIX = "v1.";
const AAD = new TextEncoder().encode("nodrive-upload-v1");

export interface Ticket {
	v: 1;
	/** Nextcloud user id, used in DAV paths (from GET /ocs/v2.php/cloud/user). */
	uid: string;
	/** Login name for HTTP Basic auth (may differ from uid). */
	login: string;
	/** The user's Drive app password (from Login Flow v2). */
	pass: string;
	/** Destination path inside the user's Drive, must start with /NoMail/. */
	path: string;
	/** Total file size in bytes. */
	size: number;
	/** Chunk size in bytes. Every chunk except the last must be exactly this size. */
	chunk: number;
	/** Upload id chosen by NoMail: 8-64 characters of A-Z a-z 0-9 and "-". */
	upload: string;
	/** Expiry, unix seconds. */
	exp: number;
	/** Optional modification time for the finished file, unix seconds. */
	mtime?: number;
}

export function base64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64urlDecode(text: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
	const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
	const binary = atob(padded);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/** Imports the shared secret: 32 random bytes, base64url encoded (43 characters). */
export async function importTicketKey(secret: string | undefined): Promise<CryptoKey> {
	if (!secret) throw new Error("UPLOAD_TICKET_KEY is not set");
	let raw: Uint8Array;
	try {
		raw = base64urlDecode(secret.trim());
	} catch {
		raw = new Uint8Array(0);
	}
	if (raw.length !== 32) throw new Error("UPLOAD_TICKET_KEY must be 32 bytes, base64url encoded");
	return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealTicket(ticket: Ticket, key: CryptoKey): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plain = new TextEncoder().encode(JSON.stringify(ticket));
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, plain));
	const out = new Uint8Array(iv.length + sealed.length);
	out.set(iv, 0);
	out.set(sealed, iv.length);
	return TICKET_PREFIX + base64urlEncode(out);
}

export class TicketError extends Error {}

/** Opens and validates a ticket. Throws TicketError with a safe message on any problem. */
export async function openTicket(
	text: string | null,
	key: CryptoKey,
	limits: { maxChunk: number; maxBytes: number; now?: number },
): Promise<Ticket> {
	if (!text || !text.startsWith(TICKET_PREFIX)) throw new TicketError("missing or malformed upload ticket");
	let ticket: Ticket;
	try {
		const raw = base64urlDecode(text.slice(TICKET_PREFIX.length));
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: AAD },
			key,
			raw.slice(12),
		);
		ticket = JSON.parse(new TextDecoder().decode(plain)) as Ticket;
	} catch {
		throw new TicketError("upload ticket is not valid");
	}
	const now = limits.now ?? Math.floor(Date.now() / 1000);
	if (ticket.v !== 1) throw new TicketError("unsupported ticket version");
	if (!Number.isInteger(ticket.exp) || ticket.exp <= now) throw new TicketError("upload ticket has expired");
	if (ticket.exp > now + 24 * 3600) throw new TicketError("upload ticket lives longer than 24 hours");
	// A user id of only dots would be "." or ".." in the DAV paths.
	if (typeof ticket.uid !== "string" || !/^[A-Za-z0-9._@-]{1,64}$/.test(ticket.uid) || /^\.+$/.test(ticket.uid)) {
		throw new TicketError("bad user id");
	}
	if (typeof ticket.login !== "string" || ticket.login.length === 0 || ticket.login.length > 256) throw new TicketError("bad login");
	if (typeof ticket.pass !== "string" || ticket.pass.length === 0) throw new TicketError("bad app password");
	if (typeof ticket.upload !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(ticket.upload)) throw new TicketError("bad upload id");
	checkPath(ticket.path);
	if (!Number.isSafeInteger(ticket.size) || ticket.size < 1 || ticket.size > limits.maxBytes) {
		throw new TicketError(`file size must be 1..${limits.maxBytes} bytes`);
	}
	const minChunk = 5 * 1024 * 1024;
	if (!Number.isSafeInteger(ticket.chunk) || ticket.chunk < minChunk || ticket.chunk > limits.maxChunk) {
		throw new TicketError(`chunk size must be ${minChunk}..${limits.maxChunk} bytes`);
	}
	if (chunkCount(ticket) > 10000) throw new TicketError("more than 10000 chunks - use a bigger chunk size");
	if (ticket.mtime !== undefined && !Number.isInteger(ticket.mtime)) throw new TicketError("bad mtime");
	return ticket;
}

function checkPath(path: unknown): asserts path is string {
	if (typeof path !== "string" || !path.startsWith("/NoMail/")) throw new TicketError("path must start with /NoMail/");
	const parts = path.split("/").slice(1);
	if (parts.length < 2 || parts.some((p) => p === "" || p === "." || p === ".." || p.length > 250)) {
		throw new TicketError("path has an empty, '.' or '..' segment");
	}
	if (/[\u0000-\u001f\\]/.test(path)) throw new TicketError("path has control characters or backslashes");
}

export function chunkCount(t: Pick<Ticket, "size" | "chunk">): number {
	return Math.ceil(t.size / t.chunk);
}

/** R2 needs every part except the last to be the same size, so each chunk has one exact length. */
export function expectedChunkLength(t: Pick<Ticket, "size" | "chunk">, n: number): number | null {
	const count = chunkCount(t);
	if (!Number.isInteger(n) || n < 1 || n > count) return null;
	return n < count ? t.chunk : t.size - (count - 1) * t.chunk;
}
