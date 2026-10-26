/**
 * Dev-only auth (DESIGN 16), for `wrangler dev --env dev` on this PC only.
 *
 * Build time: every call site sits inside `if (__NX_DEV_AUTH__)`. The production `define` sets it to
 * false, so esbuild drops the calls and tree-shakes this whole module out of the production bundle;
 * predeploy checks that the marker string below and every /dev/ route string are absent.
 *
 * Run time: even if it were compiled in, it does nothing unless ALL of these hold: NX_ENV is "dev",
 * PUBLIC_ORIGIN's host is loopback, the request's own host is loopback, and the request came from
 * a loopback address (no CF-Connecting-IP, or a loopback one). DEV_QA_ACCOUNTS outside loopback
 * makes every request fail closed (the router checks devMisconfigured()).
 *
 * It replaces "Log in with Nourax" and Login Flow v2 with a QA-account picker; OAuth, consent, tokens,
 * the vault and every tool then run for real against drive.nourax.org.
 */
import { type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { config, type NxEnv } from "../env";
import { b64url, newId, randomBytes, sha256 } from "../core/bytes";
import { QA_UID_RE } from "../core/ids";
import { LIMITS } from "../core/limits";
import { esc, errorPage } from "../http/html";
import { mockProviderFetch } from "../mail/mock-provider";
import { ALL_APPS, ALL_SCOPES, type AppId, type Scope } from "../mcp/catalog";
import type { GrantProps } from "../mcp/context";
import { createNcClient } from "../nc/client";
import type { UpstreamTokens } from "../vault/schema";
import { vaultFor } from "../vault/vault";
import { grantIdFromRedirect } from "./grants";
export { devActive, devMisconfigured } from "./dev-guard";

export const DEV_MARKER = "NX_DEV_AUTH_MARKER_7f3c";

export function devQaAccounts(env: NxEnv): Record<string, string> {
	if (!env.DEV_QA_ACCOUNTS) return {};
	try {
		const j = JSON.parse(env.DEV_QA_ACCOUNTS) as Record<string, unknown>;
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(j)) if (QA_UID_RE.test(k) && typeof v === "string" && v.length >= 20) out[k] = v;
		return out;
	} catch {
		return {};
	}
}

/** The QA picker on the consent page. Never shows a password. */
export function devConsentExtras(env: NxEnv): string {
	const uids = Object.keys(devQaAccounts(env)).sort();
	const opts = uids.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join("");
	return `<fieldset><legend>Dev only: QA account</legend><select name="dev_uid">${opts}</select><p class="muted" data-marker="${DEV_MARKER}">Local development: this replaces the Nourax and NoDrive sign-in steps.</p></fieldset>`;
}

/**
 * A made-up upstream session for live tests of the mail path through /mcp against /dev/mock-nomail
 * (lane E). QA accounts have no "Log in with Nourax" identity, so without this mail is never active
 * in dev. The tokens are random and mean nothing to Supabase; a refresh in dev always ends as "dead"
 * because dev has no Supabase client secret.
 */
function devUpstream(): UpstreamTokens {
	return {
		accessToken: `dev-upstream-${b64url(randomBytes(18))}`,
		refreshToken: `dev-refresh-${b64url(randomBytes(18))}`,
		expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
	};
}

async function seedVault(env: NxEnv, uid: string, scopes: Scope[], apps: AppId[], clientId: string, label: string, upstream: UpstreamTokens | null = null): Promise<GrantProps | null> {
	const pass = devQaAccounts(env)[uid];
	if (!pass) return null;
	const cfg = config(env);
	let displayName: string | null = null;
	try {
		displayName = (await createNcClient({ env, cfg, uid, cred: { loginName: uid, appPassword: pass } }).cloudUser()).displayName;
	} catch {
		displayName = null;
	}
	const connectionId = newId();
	const useKey = randomBytes(32);
	const vault = vaultFor(env, uid);
	await vault.revokeForClient(clientId, "replaced");
	const created = await vault.createConnection(
		{
			connectionId,
			uid,
			kind: "dev",
			clientId,
			clientLabel: label,
			scopes,
			apps,
			cred: { loginName: uid, appPassword: pass },
			displayName,
			upstream,
			idleSec: LIMITS.idleSec,
			maxAgeSec: LIMITS.maxGrantAgeSec,
		},
		useKey,
	);
	if (!created.ok) return null;
	return { v: 1, kind: "dev", uid, connectionId, vaultKey: b64url(useKey), connectedAt: Math.floor(Date.now() / 1000), clientLabel: label };
}

/** Consent POST in dev: seed the vault with the picked QA account and finish the authorization. */
export async function devCompleteConsent(env: NxEnv, ar: AuthRequest, scopes: Scope[], apps: AppId[], label: string, uid: string, headers: Headers): Promise<Response> {
	const helpers = env.OAUTH_PROVIDER as OAuthHelpers;
	const props = await seedVault(env, uid, scopes, apps, ar.clientId, label);
	if (!props) return errorPage("Dev sign-in failed", "Pick a QA account listed in the dev env file.", 400);
	const { redirectTo } = await helpers.completeAuthorization({
		request: ar,
		userId: uid,
		scope: scopes,
		props,
		metadata: { connectionId: props.connectionId, clientLabel: label, kind: "dev", connectedAt: props.connectedAt },
	});
	const grantId = grantIdFromRedirect(redirectTo, uid);
	if (grantId) await vaultFor(env, uid).bindGrant(props.connectionId, grantId);
	const h = new Headers(headers);
	h.set("location", redirectTo);
	h.set("x-nx-dev", DEV_MARKER);
	return new Response(null, { status: 302, headers: h });
}

const DEV_CLIENT_KEY = "dev:client:v1";
const DEV_REDIRECT = "http://localhost:8787/dev/callback";

async function devClientId(helpers: OAuthHelpers, env: NxEnv): Promise<string> {
	const existing = await env.OAUTH_KV.get(DEV_CLIENT_KEY);
	if (existing && (await helpers.lookupClient(existing))) return existing;
	const c = await helpers.createClient({
		redirectUris: [DEV_REDIRECT],
		clientName: "Nourax dev runner",
		tokenEndpointAuthMethod: "none",
		grantTypes: ["authorization_code", "refresh_token"],
		responseTypes: ["code"],
	});
	await env.OAUTH_KV.put(DEV_CLIENT_KEY, c.clientId);
	return c.clientId;
}

/**
 * POST /dev/token {uid, scopes?, apps?, upstream?}: runs the whole code-and-PKCE flow in-process
 * through the provider and returns {access_token, refresh_token, expires_in}. The live tests use it.
 * upstream: true seeds a made-up upstream session (devUpstream), so mail can be tested through /mcp.
 */
export async function devToken(request: Request, env: NxEnv, ctx: ExecutionContext, providerFetch: (r: Request) => Promise<Response>): Promise<Response> {
	const helpers = env.OAUTH_PROVIDER as OAuthHelpers;
	const cfg = config(env);
	// JSON only: a cross-site "simple" POST (text/plain, no preflight) is refused before it can act.
	const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (type !== "application/json") return Response.json({ error: "unsupported_media_type" }, { status: 415 });
	let body: { uid?: unknown; scopes?: unknown; apps?: unknown; upstream?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return Response.json({ error: "invalid_request" }, { status: 400 });
	}
	const uid = typeof body.uid === "string" ? body.uid : "";
	if (!devQaAccounts(env)[uid]) return Response.json({ error: "unknown_qa_account" }, { status: 400 });
	const scopes = (Array.isArray(body.scopes) ? body.scopes : ["workspace.read", "workspace.write", "workspace.remove"]).filter(
		(s): s is Scope => typeof s === "string" && (ALL_SCOPES as readonly string[]).includes(s),
	);
	if (!scopes.includes("workspace.read")) scopes.unshift("workspace.read");
	const apps = (Array.isArray(body.apps) ? body.apps : [...ALL_APPS]).filter((a): a is AppId => typeof a === "string" && (ALL_APPS as readonly string[]).includes(a));
	const clientId = await devClientId(helpers, env);
	const verifier = b64url(randomBytes(32));
	const challenge = b64url(await sha256(verifier));
	const q = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: DEV_REDIRECT,
		scope: scopes.join(" "),
		state: b64url(randomBytes(12)),
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: cfg.resource,
	});
	const ar = await helpers.parseAuthRequest(new Request(`${cfg.publicOrigin}/authorize?${q.toString()}`));
	const props = await seedVault(env, uid, scopes, apps, clientId, "Dev runner", body.upstream === true ? devUpstream() : null);
	if (!props) return Response.json({ error: "seed_failed" }, { status: 500 });
	const { redirectTo } = await helpers.completeAuthorization({
		request: ar,
		userId: uid,
		scope: scopes,
		props,
		metadata: { connectionId: props.connectionId, clientLabel: "Dev runner", kind: "dev", connectedAt: props.connectedAt },
	});
	const code = new URL(redirectTo).searchParams.get("code");
	if (!code) return Response.json({ error: "no_code" }, { status: 500 });
	const tokenRes = await providerFetch(
		new Request(`${cfg.publicOrigin}/oauth/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: DEV_REDIRECT, client_id: clientId, code_verifier: verifier, resource: cfg.resource }).toString(),
		}),
	);
	const tokens = await tokenRes.json();
	void ctx;
	return Response.json({ ...(tokens as object), connection_id: props.connectionId }, { status: tokenRes.status, headers: { "x-nx-dev": DEV_MARKER } });
}

/** /dev/mock-nomail/* goes to lane E's mock provider with the prefix removed. */
export async function devMockNomail(request: Request): Promise<Response> {
	const url = new URL(request.url);
	url.pathname = url.pathname.replace(/^\/dev\/mock-nomail/, "") || "/";
	return mockProviderFetch(new Request(url.toString(), request));
}
