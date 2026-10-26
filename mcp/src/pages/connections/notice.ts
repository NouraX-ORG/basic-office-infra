/**
 * A notice on /connections is shown only after the action that set it, in the browser that did it
 * (lane F, second review, fix round 3).
 *
 * Before, GET /connections showed the notice for any known `?n=` code, so a link anyone could send
 * (https://mcp.nourax.org/connections?n=signed-out) made the real page say "You're signed out of
 * this page, in every browser." or "The connection was ended", although nothing had happened: a
 * phishing message could have used the page to "confirm" the very sign-out docs/mcp.md 7.3 tells
 * people to use.
 *
 * Now the POST (or the sign-in callback) that did something answers its 303 to /connections?n=<code>
 * with the cookie __Host-nx-note=<code>, and the page shows the notice only when the cookie carries
 * that same code. Then it clears the cookie, so the notice shows once.
 * - The cookie can't be set by anyone else: __Host- means only this host can set it, over HTTPS,
 *   with no Domain. It is HttpOnly and SameSite=Strict, lives 60 seconds and holds only the fixed
 *   code (no secret, nothing about the person), so it needs no signature.
 * - Whatever the cookie says, a notice that says this browser is signed out (SIGNED_OUT_NOTICES) is
 *   never shown above a signed-in list.
 * - The cross-site reload (index.ts) keeps the code in the address, so the notice survives it: the
 *   reload comes from this page, and then the SameSite=Strict cookie is sent.
 */
import { clearCookie, readCookie, setCookie } from "../../http/cookies";
import { type NoticeCode, noticeOf, SIGNED_OUT_NOTICES } from "./views";

export const NOTE_COOKIE = "__Host-nx-note";
/** Long enough for the 303 and the page load that follows it. */
export const NOTE_COOKIE_SEC = 60;

/** The cookie that lets the next page load show `code`. */
export function noteCookie(code: NoticeCode): string {
	return setCookie(NOTE_COOKIE, code, { maxAge: NOTE_COOKIE_SEC, sameSite: "Strict" });
}

/** Where an action sends the browser, and the cookies that go with it (the note, when there is one). */
export function homeWith(code?: NoticeCode): { location: string; cookies: string[] } {
	return code ? { location: `/connections?n=${code}`, cookies: [noteCookie(code)] } : { location: "/connections", cookies: [] };
}

/**
 * The notice to show on this load of /connections, and the Set-Cookie that clears the note (null
 * when the browser sent none). `asked` is the `n` parameter.
 */
export function shownNotice(request: Request, asked: string | null, signedIn: boolean): { notice: NoticeCode | null; clear: string | null } {
	const code = noticeOf(asked);
	const carried = readCookie(request, NOTE_COOKIE);
	const clear = carried !== null ? clearCookie(NOTE_COOKIE) : null;
	if (code === null || carried !== code) return { notice: null, clear };
	if (signedIn && SIGNED_OUT_NOTICES.has(code)) return { notice: null, clear };
	return { notice: code, clear };
}
