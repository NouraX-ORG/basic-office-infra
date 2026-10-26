/**
 * "Log in with Nourax" for the /connections page itself (lane F, fix round 1). Used only when the
 * upstream step is on (SUPABASE_OAUTH_CLIENT_ID set and SUPABASE_OAUTH_CLIENT_SECRET present, DESIGN 7).
 *
 * Why: in Drive-only mode the page learns who you are from NoDrive's Login Flow v2 grant, and a
 * grant link can be sent to someone else (DESIGN 22). With "Log in with Nourax" on, the page signs
 * in with the person's own Nourax sign-in instead, like the AI apps' connections do, so there is no
 * grant link to send and NoDrive makes no app password for the page at all. The page session's uid
 * is the checked Supabase `sub`, which is the NoDrive uid (user_oidc maps uid = sub). A desktop key
 * made afterwards still goes through NoDrive's grant, bound to that uid (checkIdentity).
 *
 * The flow:
 * 1. POST /connections/sign-in (same origin, pre-sign-in CSRF, RL_AUTHZ) answers a short page that
 *    opens Supabase's authorize endpoint: confidential client, PKCE S256, state and nonce, scope
 *    "openid email profile", redirect_uri {PUBLIC_ORIGIN}/connections/callback. (A page that opens
 *    the address, not a 302 after the form POST: browsers apply the CSP's form-action to every
 *    redirect after a form submission, and NoMail's consent host is a redirect further on.)
 * 2. Nothing is stored on our side: the browser keeps __Host-nx-cup = "<random nonce>.<issued at>"
 *    (HttpOnly, Secure, SameSite=Lax, 10 minutes). The state, the PKCE verifier and the OpenID
 *    nonce are HMACs of it under the csrf subkey of NX_SECRET with their own prefixes, so the cookie
 *    alone gives away none of them, a code can only be redeemed by the browser that started, and
 *    starting costs no KV or Durable Object write (no daily cap needed for this step).
 * 3. GET /connections/callback checks the cookie's age, the state (constant time), exchanges the
 *    code (client_secret_basic, 8 s, at most 64 KB) and checks both tokens with core's jose checks:
 *    ES256 only, iss, aud, role, client_id equal to ours, not anonymous, sub a UUID; the id_token's
 *    aud, nonce and sub. Then it starts the 30-minute page session for that sub. The Supabase tokens
 *    are not kept.
 *
 * Two-step sign-in is not checked here, and can't be yet (second review, fix round 3): NoMail found
 * that tokens issued to an OAuth client carry `aal1` from the first token on, whatever the person did
 * at sign-in (docs/mcp.md 6.1, the open 2FA question). NoMail's consent page asks for the 2FA code
 * before it lets anyone allow the sign-in, but nothing in the tokens shows that it did. Refusing
 * `aal1` would lock out everyone; docs/mcp.md 4.1 and 7.3 say plainly what is left, and a docs test
 * ties those sentences to whether this file reads `aal`. Once the owner and NoMail settle it, check
 * `aal` here for people who have 2FA.
 *
 * The Supabase OAuth client therefore needs this second redirect URI registered (owner-yes item 3;
 * Supabase matches redirect URIs exactly): https://mcp.nourax.org/connections/callback.
 */
import type { NxConfig, NxEnv } from "../../env";
import { b64, b64url, randomBytes, sha256, timingSafeEqual, utf8 } from "../../core/bytes";
import { egress, readCappedJson } from "../../core/egress";
import { LIMITS } from "../../core/limits";
import { log, pseudonym } from "../../core/log";
import { checkAccessToken, checkIdToken, supabaseKeys, TokenCheckFailed } from "../../auth/jwt";
import { csrfToken, issueSession } from "../../auth/session";
import { clearCookie, readCookie, setCookie } from "../../http/cookies";
import { errorPage, esc, page } from "../../http/html";
import { homeWith } from "./notice";

export const UP_COOKIE = "__Host-nx-cup";
/** Long enough to sign in at NoMail (and finish two-step sign-in there); the code itself lives far less. */
export const UP_COOKIE_SEC = 10 * 60;
const UP_RE = /^([A-Za-z0-9_-]{22})\.(\d{10})$/;
/** The path Supabase sends the person back to. Registered exactly, next to /callback (owner-yes item 3). */
export const SESSION_CALLBACK_PATH = "/connections/callback";

type Part = "state" | "verifier" | "nonce";

/** HMAC(csrf subkey, "cup.<part>.<nonce>.<issued at>"): its own prefix, so it never equals a CSRF token. */
function derive(env: NxEnv, n: string, iat: string, part: Part): Promise<string> {
	return csrfToken(env, { uid: "", exp: 0, nonce: `cup.${part}.${n}.${iat}` });
}

export function sessionRedirectUri(cfg: NxConfig): string {
	return `${cfg.publicOrigin}${SESSION_CALLBACK_PATH}`;
}

/** Step 1: the page that opens "Log in with Nourax". `clearCookies` are added (the pre-sign-in cookie). */
export async function beginSessionUpstream(env: NxEnv, cfg: NxConfig, clearCookies: string[]): Promise<Response> {
	const n = b64url(randomBytes(16));
	const iat = String(Math.floor(Date.now() / 1000));
	const [state, verifier, nonce] = await Promise.all([derive(env, n, iat, "state"), derive(env, n, iat, "verifier"), derive(env, n, iat, "nonce")]);
	const q = new URLSearchParams({
		client_id: cfg.supabaseClientId,
		redirect_uri: sessionRedirectUri(cfg),
		response_type: "code",
		scope: "openid email profile",
		code_challenge: b64url(await sha256(verifier)),
		code_challenge_method: "S256",
		state,
		nonce,
	});
	const target = `${cfg.supabaseUrl}/auth/v1/oauth/authorize?${q.toString()}`;
	const headers = new Headers({ refresh: `0; url=${target}` });
	for (const c of clearCookies) headers.append("set-cookie", c);
	headers.append("set-cookie", setCookie(UP_COOKIE, `${n}.${iat}`, { maxAge: UP_COOKIE_SEC, sameSite: "Lax" }));
	return page({
		title: "Sign in with Nourax",
		https: cfg.env !== "dev",
		headers,
		body: `<h1>Sign in with Nourax</h1>
<p>Opening the Nourax sign-in...</p>
<p><a class="button" href="${esc(target)}">Continue</a></p>`,
	});
}

function expiredSignIn(): Response {
	const res = errorPage("This sign-in has expired", "Open your connections again and sign in from there.", 400);
	res.headers.append("set-cookie", clearCookie(UP_COOKIE));
	return res;
}

function failed(status: number, message: string): Response {
	const res = errorPage("Sign-in didn't work", message, status);
	res.headers.append("set-cookie", clearCookie(UP_COOKIE));
	return res;
}

function seeOther(location: string, cookies: string[]): Response {
	const h = new Headers({ location, "cache-control": "no-store" });
	for (const c of cookies) h.append("set-cookie", c);
	return new Response(null, { status: 303, headers: h });
}

/** Step 3: GET /connections/callback. */
export async function sessionCallback(request: Request, env: NxEnv, cfg: NxConfig, rid: string): Promise<Response> {
	if (!cfg.upstreamOn) return errorPage("Not found", "There's nothing here.", 404);
	const url = new URL(request.url);
	const raw = readCookie(request, UP_COOKIE);
	const m = raw ? UP_RE.exec(raw) : null;
	const now = Math.floor(Date.now() / 1000);
	if (!m || now - Number(m[2]) > UP_COOKIE_SEC || Number(m[2]) > now + 60) {
		log({ t: "auth", rid, ev: "upstream_bad_token", reason: "connections_expired" });
		return expiredSignIn();
	}
	const n = m[1] as string;
	const iat = m[2] as string;
	const gotState = url.searchParams.get("state") ?? "";
	const wantState = await derive(env, n, iat, "state");
	if (gotState.length !== wantState.length || !timingSafeEqual(utf8(gotState), utf8(wantState))) {
		log({ t: "auth", rid, ev: "upstream_bad_token", reason: "connections_state" });
		// The cookie stays: a link from another site with a made-up state must not cancel a real
		// sign-in that is still on its way back.
		return errorPage("This sign-in has expired", "Open your connections again and sign in from there.", 400);
	}
	// The person said no at NoMail's consent page (or Supabase refused): nothing was changed. The
	// notice goes with its cookie, so only this browser sees it (notice.ts).
	if (url.searchParams.get("error")) {
		const to = homeWith("cancelled");
		return seeOther(to.location, [clearCookie(UP_COOKIE), ...to.cookies]);
	}
	const code = url.searchParams.get("code") ?? "";
	if (!code || code.length > 1024) return failed(400, "The sign-in answer was incomplete. Open your connections again and sign in once more.");

	const secret = env.SUPABASE_OAUTH_CLIENT_SECRET as string;
	let res: Response;
	try {
		res = await egress({ env, rid }, `${cfg.supabaseUrl}/auth/v1/oauth/token`, {
			method: "POST",
			headers: {
				authorization: `Basic ${b64(utf8(`${encodeURIComponent(cfg.supabaseClientId)}:${encodeURIComponent(secret)}`))}`,
				"content-type": "application/x-www-form-urlencoded",
				accept: "application/json",
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: sessionRedirectUri(cfg),
				code_verifier: await derive(env, n, iat, "verifier"),
			}).toString(),
			timeoutMs: LIMITS.supabaseTimeoutMs,
		});
	} catch {
		log({ t: "auth", rid, ev: "upstream_bad_token", reason: "connections_unreachable" });
		return failed(502, "The Nourax sign-in didn't answer. Try again in a minute.");
	}
	if (!res.ok) {
		await res.body?.cancel();
		log({ t: "auth", rid, ev: "upstream_bad_token", reason: `connections_token_${res.status}` });
		return failed(502, "The Nourax sign-in didn't finish. Open your connections again and sign in once more.");
	}
	let j: { access_token?: unknown; id_token?: unknown };
	try {
		j = await readCappedJson<{ access_token?: unknown; id_token?: unknown }>(res, 64 * 1024);
	} catch {
		log({ t: "auth", rid, ev: "upstream_bad_token", reason: "connections_shape" });
		return failed(502, "The Nourax sign-in didn't finish. Open your connections again and sign in once more.");
	}
	if (typeof j.access_token !== "string" || typeof j.id_token !== "string") {
		log({ t: "auth", rid, ev: "upstream_bad_token", reason: "connections_shape" });
		return failed(502, "The Nourax sign-in didn't finish. Open your connections again and sign in once more.");
	}
	let sub: string;
	try {
		const keys = await supabaseKeys(env, cfg.supabaseUrl);
		const at = await checkAccessToken(j.access_token, { supabaseUrl: cfg.supabaseUrl, clientId: cfg.supabaseClientId, keys });
		await checkIdToken(j.id_token, { supabaseUrl: cfg.supabaseUrl, clientId: cfg.supabaseClientId, keys, nonce: await derive(env, n, iat, "nonce"), sub: at.sub });
		sub = at.sub;
	} catch (e) {
		log({ t: "auth", rid, ev: "upstream_bad_token", reason: `connections_${e instanceof TokenCheckFailed ? e.reason : "check"}`.slice(0, 64) });
		return failed(403, "The Nourax sign-in couldn't be checked. Open your connections again and sign in once more.");
	}
	log({ t: "auth", rid, ev: "upstream_ok", reason: "connections", who: await pseudonym(env, sub, 12) });
	const { cookie } = await issueSession(env, sub);
	// The browser arrives here from NoMail's site, so the SameSite=Strict session cookie is not sent
	// on this redirect; /connections reloads itself once from our own page (index.ts) and then has it.
	return seeOther("/connections", [cookie, clearCookie(UP_COOKIE)]);
}
