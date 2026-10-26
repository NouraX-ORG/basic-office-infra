/**
 * A two-step confirmation token, in the spirit of NoMail's draft-then-send: a first call changes
 * nothing and hands out a confirm_token; only a second call that brings it back acts. The token is
 * an HMAC, valid 10 minutes, bound to the person, the connection and the parts given (for a task:
 * the project, the task and the task's last change), so it can't be reused for another item, by
 * another connection, or after the item changed.
 *
 * Since fix round 1 no tool uses it: gantt_delete_task was taken out (DESIGN 25.6). It is kept,
 * with its unit tests, for the owner's decision on a separate "delete for good" choice (25.6); it
 * isn't in the Worker bundle until a tool imports it.
 *
 * Its key is derived from NX_SECRET with HKDF under lane G's own label, so rotating NX_SECRET (the
 * kill switch, 9.5) also voids every open token. No state is stored.
 */
import { b64url, fromB64url, hmacSha256, timingSafeEqual, utf8 } from "../../core/bytes";
import { ToolError } from "../../core/errors";
import { secretOk } from "../../core/keys";

export const CONFIRM_TTL_SEC = 600;

const keys = new Map<string, Promise<Uint8Array>>();

function keyFor(secret: string): Promise<Uint8Array> {
	let p = keys.get(secret);
	if (!p) {
		p = (async () => {
			const ikm = await crypto.subtle.importKey("raw", utf8(secret), "HKDF", false, ["deriveBits"]);
			const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: utf8("nx-gantt-v1"), info: utf8("nx/gantt/delete-confirm/v1") }, ikm, 256);
			return new Uint8Array(bits);
		})();
		keys.set(secret, p);
		if (keys.size > 8) keys.delete(keys.keys().next().value as string);
	}
	return p;
}

function secretOf(env: { NX_SECRET?: string }): string {
	const s = env.NX_SECRET;
	if (!secretOk(s)) throw new ToolError("upstream_unavailable", "Nourax Workspace isn't set up to confirm deletions right now. Try again later.");
	return s;
}

function message(exp: number, parts: readonly (string | number)[]): string {
	return ["gantt-delete", "v1", String(exp), ...parts.map((p) => String(p).replaceAll("|", "%7C"))].join("|");
}

export async function makeConfirmToken(env: { NX_SECRET?: string }, parts: readonly (string | number)[], nowMs = Date.now()): Promise<{ token: string; expires_at: string }> {
	const exp = Math.floor(nowMs / 1000) + CONFIRM_TTL_SEC;
	const mac = await hmacSha256(await keyFor(secretOf(env)), message(exp, parts));
	return { token: `gd1.${exp}.${b64url(mac)}`, expires_at: new Date(exp * 1000).toISOString() };
}

export type ConfirmCheck = "ok" | "expired" | "invalid";

export async function checkConfirmToken(env: { NX_SECRET?: string }, token: string, parts: readonly (string | number)[], nowMs = Date.now()): Promise<ConfirmCheck> {
	const m = /^gd1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
	if (!m) return "invalid";
	const exp = Number(m[1]);
	let given: Uint8Array;
	try {
		given = fromB64url(m[2] as string);
	} catch {
		return "invalid";
	}
	const want = await hmacSha256(await keyFor(secretOf(env)), message(exp, parts));
	if (!timingSafeEqual(given, want)) return "invalid";
	if (Math.floor(nowMs / 1000) > exp) return "expired";
	return "ok";
}
