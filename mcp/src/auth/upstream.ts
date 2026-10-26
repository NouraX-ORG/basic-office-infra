/**
 * Upstream "Log in with Nourax" (DESIGN 7): optional. It runs only when SUPABASE_OAUTH_CLIENT_ID is
 * set and the SUPABASE_OAUTH_CLIENT_SECRET secret exists; otherwise the Worker is in Drive-only mode.
 *
 * The Worker is a confidential client of NoMail's Supabase OAuth 2.1 server with PKCE (S256), state
 * (the library's upstream transaction, bound to this browser) and a nonce. Tokens are checked with
 * jose against ES256 only. The tokens are kept only in the vault, encrypted.
 */
import { type AuthRequest, authorizationErrorRedirect, AuthorizationError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { config, type NxEnv } from "../env";
import { b64, b64url, randomBytes, sha256, utf8 } from "../core/bytes";
import { egress, readCappedJson } from "../core/egress";
import { LIMITS } from "../core/limits";
import { log } from "../core/log";
import { errorPage } from "../http/html";
import type { AppId, Scope } from "../mcp/catalog";
import { checkAccessToken, checkIdToken, supabaseKeys, TokenCheckFailed } from "./jwt";
import { startConnect } from "./connect";
import { redirectAllowed } from "./redirects";

interface UpstreamData {
	verifier: string;
	nonce: string;
	scopes: Scope[];
	apps: AppId[];
	clientLabel: string;
	clientId: string;
	cli?: string;
}

/** After consent: save the approved request and go to Supabase's authorize endpoint. */
export async function beginUpstreamRedirect(
	env: NxEnv,
	approved: AuthRequest,
	approvedHeaders: Headers,
	d: Omit<UpstreamData, "verifier" | "nonce">,
): Promise<Response> {
	const cfg = config(env);
	const helpers = env.OAUTH_PROVIDER as OAuthHelpers;
	const verifier = b64url(randomBytes(32));
	const challenge = b64url(await sha256(verifier));
	const nonce = b64url(randomBytes(16));
	const { state, headers } = await helpers.beginUpstream(approved, { data: { ...d, verifier, nonce } satisfies UpstreamData, headers: approvedHeaders });
	const q = new URLSearchParams({
		client_id: cfg.supabaseClientId,
		redirect_uri: `${cfg.publicOrigin}/callback`,
		response_type: "code",
		scope: "openid email profile",
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		nonce,
	});
	const out = new Headers(headers);
	out.set("location", `${cfg.supabaseUrl}/auth/v1/oauth/authorize?${q.toString()}`);
	out.set("cache-control", "no-store");
	return new Response(null, { status: 302, headers: out });
}

/** GET /callback: Supabase sends the person back here. */
export async function upstreamCallback(request: Request, env: NxEnv, rid?: string): Promise<Response> {
	const cfg = config(env);
	if (!cfg.upstreamOn) return errorPage("Not available", "This sign-in step isn't switched on.", 404);
	const helpers = env.OAUTH_PROVIDER as OAuthHelpers;
	let resumed: { request: AuthRequest; data: UpstreamData; headers: Headers };
	try {
		resumed = await helpers.finishUpstream<UpstreamData>(request);
	} catch (e) {
		// Back to the app only while its redirect is still on the allowlist (it may have shrunk since
		// the sign-in started; fix round 4, as /authorize and /connect/cancel do).
		if (e instanceof AuthorizationError && e.redirectTo) {
			if (redirectAllowed(e.redirectUri, cfg.allowedRedirects)) return Response.redirect(e.redirectTo, 302);
			log({ t: "auth", rid, ev: "redirect_rejected" });
		}
		return errorPage("This sign-in link has expired", "Start again from your AI app.", 400);
	}
	const url = new URL(request.url);
	const ar = resumed.request;
	if (url.searchParams.get("error")) {
		if (!redirectAllowed(ar.redirectUri, cfg.allowedRedirects)) {
			log({ t: "auth", rid, ev: "redirect_rejected" });
			return errorPage("Sign-in cancelled", "Nothing was connected. You can close this tab.", 400);
		}
		const h = new Headers(resumed.headers);
		h.set("location", authorizationErrorRedirect(ar, "access_denied"));
		return new Response(null, { status: 302, headers: h });
	}
	// The success path too (DESIGN 29.2): the list may have shrunk since consent. Checked before the
	// code is redeemed, so no Supabase tokens are fetched, and nothing goes on to the NoDrive step
	// (finishConnect checks once more before the code is issued).
	if (!redirectAllowed(ar.redirectUri, cfg.allowedRedirects)) {
		log({ t: "auth", rid, ev: "redirect_rejected" });
		return errorPage("Not connected", "This app's return address is no longer allowed. Nothing was shared.", 400);
	}
	const code = url.searchParams.get("code");
	if (!code || code.length > 1024) return errorPage("Sign-in failed", "The sign-in answer was incomplete. Start again from your AI app.", 400);
	const secret = env.SUPABASE_OAUTH_CLIENT_SECRET as string;
	const res = await egress({ env, rid }, `${cfg.supabaseUrl}/auth/v1/oauth/token`, {
		method: "POST",
		headers: {
			authorization: `Basic ${b64(utf8(`${encodeURIComponent(cfg.supabaseClientId)}:${encodeURIComponent(secret)}`))}`,
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
		},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: `${cfg.publicOrigin}/callback`,
			code_verifier: resumed.data.verifier,
		}).toString(),
		timeoutMs: LIMITS.supabaseTimeoutMs,
	});
	if (!res.ok) {
		await res.body?.cancel();
		log({ t: "auth", rid, ev: "upstream_bad_token", reason: `token_${res.status}` });
		return errorPage("Sign-in failed", "Nourax sign-in didn't finish. Start again from your AI app.", 502);
	}
	const j = await readCappedJson<{ access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; id_token?: unknown }>(res, 64 * 1024);
	if (typeof j.access_token !== "string" || typeof j.refresh_token !== "string" || typeof j.id_token !== "string") {
		log({ t: "auth", rid, ev: "upstream_bad_token", reason: "shape" });
		return errorPage("Sign-in failed", "Nourax sign-in didn't finish. Start again from your AI app.", 502);
	}
	let sub: string;
	let exp: number;
	try {
		const keys = await supabaseKeys(env, cfg.supabaseUrl);
		const at = await checkAccessToken(j.access_token, { supabaseUrl: cfg.supabaseUrl, clientId: cfg.supabaseClientId, keys });
		await checkIdToken(j.id_token, { supabaseUrl: cfg.supabaseUrl, clientId: cfg.supabaseClientId, keys, nonce: resumed.data.nonce, sub: at.sub });
		sub = at.sub;
		exp = at.exp;
	} catch (e) {
		log({ t: "auth", rid, ev: "upstream_bad_token", reason: e instanceof TokenCheckFailed ? e.reason : "check" });
		return errorPage("Sign-in failed", "The Nourax sign-in couldn't be checked. Start again from your AI app.", 403);
	}
	log({ t: "auth", rid, ev: "upstream_ok" });
	return startConnect(
		env,
		{
			purpose: "oauth",
			clientLabel: resumed.data.clientLabel,
			clientId: resumed.data.clientId,
			authRequest: ar,
			scopes: resumed.data.scopes,
			apps: resumed.data.apps,
			sub,
			upstream: { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: exp },
			cli: resumed.data.cli,
		},
		resumed.headers,
		rid,
	);
}
