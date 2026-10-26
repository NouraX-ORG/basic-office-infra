/**
 * Cookie helpers. Our cookies are HttpOnly and Secure, and use the __Host- prefix (host-only,
 * Path=/). On http://localhost in dev, browsers treat localhost as a secure context, so the same
 * attributes work there.
 */
export function readCookie(request: Request, name: string): string | null {
	const header = request.headers.get("cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const i = part.indexOf("=");
		if (i < 0) continue;
		if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
	}
	return null;
}

export interface CookieOptions {
	maxAge: number;
	sameSite?: "Lax" | "Strict";
	domain?: string;
	httpOnly?: boolean;
	/**
	 * Path=/ by default. Another path makes the browser send the cookie only to that path and the
	 * paths below it (RFC 6265 5.1.4); the WAF pass cookies of one sign-in use this (auth/connect.ts).
	 * A __Host- cookie always has Path=/.
	 */
	path?: string;
}

export function setCookie(name: string, value: string, o: CookieOptions): string {
	if (!/^[A-Za-z0-9_-]+$/.test(name.replace(/^__(Host|Secure)-/, ""))) throw new Error("bad cookie name");
	if (!/^[A-Za-z0-9._~=-]*$/.test(value)) throw new Error("bad cookie value");
	const path = o.path ?? "/";
	if (!/^\/[A-Za-z0-9._~/-]{0,512}$/.test(path) || (name.startsWith("__Host-") && path !== "/")) throw new Error("bad cookie path");
	const parts = [`${name}=${value}`, `Path=${path}`, `Max-Age=${Math.max(0, Math.floor(o.maxAge))}`, "Secure", `SameSite=${o.sameSite ?? "Lax"}`];
	if (o.httpOnly !== false) parts.push("HttpOnly");
	if (o.domain && !name.startsWith("__Host-")) parts.push(`Domain=${o.domain}`);
	return parts.join("; ");
}

/** Clears a cookie: the name, domain and path must be the ones it was set with. */
export function clearCookie(name: string, domain?: string, path?: string): string {
	return setCookie(name, "", { maxAge: 0, domain, path });
}
