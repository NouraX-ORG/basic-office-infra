/**
 * tokenExchangeCallback (DESIGN 6.5).
 * - authorization_code: bind the grant id into the vault record and the props.
 * - refresh_token: end connections older than 60 days, refuse dead or missing vault records,
 *   honour STRICT_UPSTREAM_SESSION, and keep the grant (503) when the vault itself is down.
 */
import { OAuthError, type TokenExchangeCallbackOptions, type TokenExchangeCallbackResult } from "@cloudflare/workers-oauth-provider";
import { config, type NxEnv } from "../env";
import { LIMITS } from "../core/limits";
import { log } from "../core/log";
import type { GrantProps } from "../mcp/context";
import { vaultFor } from "../vault/vault";

export async function tokenExchange(o: TokenExchangeCallbackOptions<NxEnv>): Promise<TokenExchangeCallbackResult | undefined> {
	const props = o.props as GrantProps;
	if (!props || props.v !== 1 || typeof props.uid !== "string" || typeof props.connectionId !== "string") {
		throw new OAuthError("invalid_grant", { description: "This connection is no longer valid. Connect again." });
	}
	if (o.userId !== props.uid) throw new OAuthError("invalid_grant", { description: "This connection is no longer valid. Connect again." });
	const vault = vaultFor(o.env, props.uid);

	if (o.grantType === "authorization_code") {
		try {
			await vault.bindGrant(props.connectionId, o.grantId);
		} catch {
			throw new OAuthError("temporarily_unavailable", { description: "Try again in a minute.", statusCode: 503, headers: { "Retry-After": "30" } });
		}
		return { newProps: { ...props, grantId: o.grantId } };
	}

	if (o.grantType === "refresh_token") {
		const now = Math.floor(Date.now() / 1000);
		if (now - props.connectedAt > LIMITS.maxGrantAgeSec) {
			try {
				await vault.revokeAndWipe(props.connectionId, "max_age");
			} catch {
				// The vault alarm ends it anyway.
			}
			log({ t: "auth", ev: "max_age" });
			throw new OAuthError("invalid_grant", { description: "This connection reached its 60-day limit. Connect again." });
		}
		let status: string;
		try {
			status = await vault.status(props.connectionId);
		} catch {
			throw new OAuthError("temporarily_unavailable", { description: "Try again in a minute.", statusCode: 503, headers: { "Retry-After": "30" } });
		}
		if (status !== "active") {
			log({ t: "auth", ev: "refresh_failed", reason: status });
			throw new OAuthError("invalid_grant", { description: "This connection has ended. Connect again." });
		}
		if (config(o.env).strictUpstreamSession) {
			// With the strict policy, a dead upstream session ends the whole connection (7.2).
			const ups = await vault.upstreamState(props.connectionId).catch(() => "unknown" as const);
			if (ups === "dead") {
				await vault.revokeAndWipe(props.connectionId, "upstream_dead").catch(() => undefined);
				throw new OAuthError("invalid_grant", { description: "Your Nourax sign-in has ended. Connect again." });
			}
		}
		log({ t: "auth", ev: "refresh_ok" });
		return undefined;
	}
	throw new OAuthError("unsupported_grant_type", { description: "Unsupported grant type." });
}
