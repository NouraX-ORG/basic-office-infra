// Checks the editor-session token that ONLYOFFICE Docs gives each open document.
//
// The AI plugin sends it as "Authorization: Bearer <token>". Document Server 10 signs it (HS256)
// with a key derived from its session secret: HMAC-SHA256(secret, "editor-session") as a hex
// string, used as the key's UTF-8 bytes (DocService fillJwtByConnection, Common utils.deriveSecret).
// This Worker holds only that derived key, which cannot sign document, conversion or command
// requests. Payload: { document: { key }, editorConfig: { user: { id, name }, ds_sessionTimeConnect,
// ds_aiDisabled? }, exp }.
// SPDX-License-Identifier: AGPL-3.0-or-later

export class SessionError extends Error {
	constructor(
		readonly code: "no_session" | "bad_session" | "expired" | "guest" | "ai_disabled" | "bad_user",
		message: string,
	) {
		super(message);
	}
}

export interface EditorSession {
	/** The Nextcloud user id (with Nourax sign-in, the account's id), sent to NIG as `user`. */
	uid: string;
	documentKey: string;
}

/** NIG's rule for `user`: letters, digits and . _ : - (so no emails or names). */
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLOCK_SKEW_SECONDS = 30;

export async function importSessionKey(derivedHex: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", new TextEncoder().encode(derivedHex), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
		"verify",
	]);
}

/**
 * @param authorization the Authorization header
 * @param instanceId Nextcloud's instanceid: the connector sends signed-in users as "<instanceid>_<uid>";
 *   guests on share links get no such id
 */
export async function verifySession(
	authorization: string | null,
	key: CryptoKey,
	instanceId: string,
	now = Date.now() / 1000,
): Promise<EditorSession> {
	const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? "")?.[1];
	if (!token) throw new SessionError("no_session", "missing editor session");
	const [head, body, signature] = token.split(".") as [string, string, string];

	const header = parseJson(head);
	if (header?.alg !== "HS256") throw new SessionError("bad_session", "unexpected token type");
	let mac: Uint8Array<ArrayBuffer>;
	try {
		mac = base64urlDecode(signature);
	} catch {
		throw new SessionError("bad_session", "invalid signature");
	}
	const valid = await crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode(`${head}.${body}`));
	if (!valid) throw new SessionError("bad_session", "invalid signature");

	const payload = parseJson(body);
	if (typeof payload?.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS < now) {
		throw new SessionError("expired", "editor session expired");
	}
	if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_SECONDS > now) {
		throw new SessionError("bad_session", "editor session not valid yet");
	}
	const doc = asObject(payload.document);
	const editor = asObject(payload.editorConfig);
	const connectedAt = editor?.ds_sessionTimeConnect;
	// Only session tokens carry ds_sessionTimeConnect; it tells them apart from a document's open config.
	if (typeof doc?.key !== "string" || doc.key === "" || typeof connectedAt !== "number" || !(connectedAt > 0)) {
		throw new SessionError("bad_session", "not an editor session");
	}
	if (editor?.ds_aiDisabled === true) throw new SessionError("ai_disabled", "AI is switched off for this document");

	const userId = asObject(editor?.user)?.id;
	const prefix = `${instanceId}_`;
	if (typeof userId !== "string" || !userId.startsWith(prefix)) {
		throw new SessionError("guest", "sign in to use AI");
	}
	const uid = userId.slice(prefix.length);
	if (!USER_ID.test(uid)) throw new SessionError("bad_user", "this account id cannot be used for AI");
	return { uid, documentKey: doc.key };
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function parseJson(part: string): Json | undefined {
	try {
		return asObject(JSON.parse(new TextDecoder().decode(base64urlDecode(part))));
	} catch {
		return undefined;
	}
}

export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
	const b64 = text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4);
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function base64urlEncode(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
