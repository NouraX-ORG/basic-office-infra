/**
 * The OAuth 2.1 authorization server for MCP clients (DESIGN 6), from
 * @cloudflare/workers-oauth-provider 1.2.4, built per environment and cached.
 * - resource https://mcp.nourax.org/mcp, issuer https://mcp.nourax.org;
 * - PKCE S256 only, iss in authorization responses (library);
 * - DCR with our redirect allowlist; CIMD off; token exchange off; private-use redirects off;
 * - access tokens 1 hour, rotating refresh tokens 14 days and 14 days idle, the whole connection
 *   at most 60 days (tokenExchangeCallback).
 */
import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { config, type NxEnv } from "../env";
import { LIMITS } from "../core/limits";
import { log } from "../core/log";
import { SUPPORTED_SCOPES } from "../mcp/catalog";
import { mcpApiHandler } from "../mcp/handler";
import { pagesHandler } from "../http/pages";
import { resolveDesktopKey } from "./conn-tokens";
import { registrationCallback } from "./dcr";
import { admitRegistration } from "./dcr-cap";
import { tokenExchange } from "./tokens";

const cache = new Map<string, OAuthProvider<NxEnv>>();

export function providerOptions(env: NxEnv): OAuthProviderOptions<NxEnv> {
	const cfg = config(env);
	const origin = cfg.publicOrigin;
	return {
		apiRoute: `${origin}/mcp`,
		apiHandler: mcpApiHandler as never,
		defaultHandler: pagesHandler as never,
		authorizeEndpoint: `${origin}/authorize`,
		tokenEndpoint: `${origin}/oauth/token`,
		clientRegistrationEndpoint: `${origin}/oauth/register`,
		accessTokenTTL: LIMITS.accessTokenTtlSec,
		refreshTokenTTL: LIMITS.refreshTokenTtlSec,
		refreshTokenIdleTTL: LIMITS.refreshTokenTtlSec,
		clientRegistrationTTL: LIMITS.clientRegistrationTtlSec,
		scopesSupported: [...SUPPORTED_SCOPES],
		allowTokenExchangeGrant: false,
		disallowPublicClientRegistration: false,
		allowPrivateUseRedirectUris: false,
		clientIdMetadataDocumentEnabled: false,
		cookiePrefix: "__Host-nx-oauth-",
		clientRegistrationCallback: registrationCallback(
			cfg.allowedRedirects,
			(reason) => log({ t: "auth", ev: "dcr_rejected", reason }),
			() => log({ t: "auth", ev: "dcr_ok" }),
			// The daily cap, taken only for a registration that is about to be stored (section 30.1).
			admitRegistration,
		),
		tokenExchangeCallback: tokenExchange,
		resolveExternalToken: resolveDesktopKey,
		onError: (e) => {
			// Codes, statuses and internal reasons only: descriptions might echo input.
			log({ t: "auth", ev: "oauth_error", reason: `${e.code}:${e.internal?.reason ?? "-"}`, status: e.status });
		},
		resourceMetadata: {
			resource: cfg.resource,
			authorization_servers: [origin],
			bearer_methods_supported: ["header"],
			resource_name: "Nourax Workspace",
		},
		requiredScopes: ["workspace.read"],
	};
}

export function providerFor(env: NxEnv): OAuthProvider<NxEnv> {
	const cfg = config(env);
	const key = `${cfg.publicOrigin}|${cfg.allowedRedirects.join(" ")}`;
	let p = cache.get(key);
	if (!p) {
		p = new OAuthProvider<NxEnv>(providerOptions(env));
		cache.set(key, p);
	}
	return p;
}
