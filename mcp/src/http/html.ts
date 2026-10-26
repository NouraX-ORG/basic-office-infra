/**
 * The HTML shell for our pages (DESIGN 6.4): zero JavaScript, every dynamic string escaped, one
 * stylesheet of our own in the Nourax colours, and strict security headers on every page.
 */
import { fromB64 } from "../core/bytes";
import { LOGO_PNG_BASE64 } from "./logo";

export function esc(s: unknown): string {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** A CSP host-source for an origin we already checked, or null when it can't be one (IPv6, odd characters). */
export function cspOrigin(origin: string): string | null {
	return /^https?:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/.test(origin) ? origin : null;
}

/**
 * Security headers for every page and asset.
 * Referrer-Policy is "same-origin", not "no-referrer": under no-referrer browsers send
 * `Origin: null` on our own form POSTs (Fetch spec, "serializing a request origin"), which the
 * consent page's Origin check would refuse. same-origin still sends nothing to other sites.
 */
export function securityHeaders(opts: { formAction?: string[]; https?: boolean } = {}): Record<string, string> {
	const formAction = ["'self'", ...(opts.formAction ?? [])].join(" ");
	const h: Record<string, string> = {
		"content-security-policy": `default-src 'none'; img-src 'self'; style-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
		"referrer-policy": "same-origin",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"cross-origin-opener-policy": "same-origin",
		"x-frame-options": "DENY",
	};
	if (opts.https !== false) h["strict-transport-security"] = "max-age=31536000";
	return h;
}

export interface PageOptions {
	title: string;
	/** Already-escaped HTML. Build it with esc() for every dynamic value. */
	body: string;
	status?: number;
	headers?: HeadersInit;
	/** Seconds for a <meta http-equiv="refresh"> (the /connect page polls this way). */
	refreshSec?: number;
	formAction?: string[];
	https?: boolean;
}

export function page(o: PageOptions): Response {
	const refresh = o.refreshSec ? `<meta http-equiv="refresh" content="${Math.max(1, Math.floor(o.refreshSec))}">` : "";
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh}<title>${esc(o.title)} - Nourax Workspace</title>
<link rel="stylesheet" href="/assets/nourax.css">
<link rel="icon" href="/assets/nourax-logo.png">
</head>
<body>
<main class="card">
<header class="brand"><img src="/assets/nourax-logo.png" alt="Nourax" width="40" height="40"><span>Nourax Workspace</span></header>
${o.body}
</main>
</body>
</html>`;
	const headers = new Headers(o.headers);
	headers.set("content-type", "text/html; charset=utf-8");
	for (const [k, v] of Object.entries(securityHeaders({ formAction: o.formAction, https: o.https }))) headers.set(k, v);
	return new Response(html, { status: o.status ?? 200, headers });
}

/** A plain error page, never a redirect (for refused redirects and broken requests). */
export function errorPage(title: string, message: string, status = 400): Response {
	return page({ title, status, body: `<h1>${esc(title)}</h1><p>${esc(message)}</p>` });
}

export const CSS = `:root{--cobalt:#2563EB;--cobalt-light:#3B82F6;--accent:#F97316;--accent-dark:#EA580C;--bg:#F8FAFC;--surface:#FFFFFF;--text:#0F172A;--muted:#475569;--line:#E2E8F0}
@media (prefers-color-scheme:dark){:root{--bg:#0B1220;--surface:#0F172A;--text:#E2E8F0;--muted:#94A3B8;--line:#1E293B}}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.card{max-width:640px;margin:40px auto;padding:28px 24px;background:var(--surface);border:1px solid var(--line);border-radius:14px}
@media (max-width:680px){.card{margin:16px;padding:20px 16px}}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;margin-bottom:16px}
.brand img{border-radius:8px}
h1{font-size:1.4rem;margin:0 0 12px}
h2{font-size:1.05rem;margin:20px 0 8px}
p,li{color:var(--text)}
.muted{color:var(--muted);font-size:.92rem}
.warn{border-left:4px solid var(--accent);padding:8px 12px;background:rgba(249,115,22,.08);border-radius:6px}
fieldset{border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:12px 0}
legend{font-weight:600;padding:0 6px}
label{display:block;margin:6px 0}
input[type=checkbox]{margin-right:8px;accent-color:var(--cobalt)}
select,input[type=text]{width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text)}
.actions{display:flex;gap:12px;margin-top:18px;flex-wrap:wrap}
button,.button{display:inline-block;padding:10px 18px;border-radius:8px;border:1px solid var(--cobalt);background:var(--cobalt);color:#fff;font-weight:600;text-decoration:none;cursor:pointer}
button.secondary,.button.secondary{background:transparent;color:var(--cobalt)}
button:hover,.button:hover{background:var(--cobalt-light);border-color:var(--cobalt-light);color:#fff}
code,.key{font-family:ui-monospace,Consolas,monospace;word-break:break-all;background:rgba(37,99,235,.08);padding:2px 6px;border-radius:6px}
a{color:var(--cobalt)}
`;

let logoBytes: Uint8Array | null = null;

export function assetResponse(path: string): Response | null {
	if (path === "/assets/nourax.css") {
		return new Response(CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" } });
	}
	if (path === "/assets/nourax-logo.png" || path === "/favicon.ico") {
		logoBytes ??= fromB64(LOGO_PNG_BASE64);
		return new Response(logoBytes, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
	}
	return null;
}
