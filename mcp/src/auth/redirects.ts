/**
 * The redirect allowlist check (DESIGN 6.3), on its own so that auth/connect.ts and auth/upstream.ts
 * can check a redirect again just before using it without importing auth/dcr.ts, which imports
 * pages/connections/reserved.ts, which imports auth/connect.ts. Every redirect back to the app is
 * checked again: the error and cancel ones (fix round 4), and the one that carries the code, in
 * finishConnect before the code is issued and in upstreamCallback before Supabase's code is redeemed
 * (DESIGN 29.2).
 *
 * ALLOWED_REDIRECTS is space-separated: exact URLs, prefixes ending in "*", and the word "loopback"
 * for http://localhost, http://127.0.0.1 and http://[::1] on any port and path (RFC 8252).
 */

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function redirectAllowed(raw: unknown, allowlist: readonly string[]): boolean {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return false;
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return false;
	}
	if (u.username || u.password || u.hash || raw.includes("#")) return false;
	// The parser folds dot segments (also %2e%2e); a URI that changes when parsed is refused.
	if (u.href !== raw && !(u.pathname === "/" && u.href === `${raw}/`)) return false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: refuse them
	if (/[\u0000- \u007f\\]/.test(raw)) return false;
	for (const entry of allowlist) {
		if (entry === "loopback") {
			if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.host.replace(/:\d+$/, "")) && !/%2e|%2f/i.test(u.pathname)) return true;
			continue;
		}
		if (entry.endsWith("*")) {
			const prefix = entry.slice(0, -1);
			let p: URL;
			try {
				p = new URL(prefix);
			} catch {
				continue;
			}
			if (p.protocol !== "https:") continue;
			if (u.protocol === p.protocol && u.host === p.host && raw.startsWith(prefix) && !u.pathname.includes("..") && !/%2e|%2f/i.test(u.pathname)) return true;
			continue;
		}
		if (raw === entry) return true;
	}
	return false;
}
