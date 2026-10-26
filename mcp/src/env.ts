import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { ConnectFlow } from "./vault/connect-flow";
import type { Quota } from "./vault/quota";
import type { Vault } from "./vault/vault";
import { log } from "./core/log";

/**
 * The Worker's bindings, vars and secrets. Vars are plain strings (wrangler.jsonc); secrets are set
 * with `wrangler secret put` and, in local dev only, with `wrangler dev --env-file <scratchpad file>`.
 */
export interface NxEnv {
	OAUTH_KV: KVNamespace;
	VAULT: DurableObjectNamespace<Vault>;
	CONNECT: DurableObjectNamespace<ConnectFlow>;
	RL_PAGES: RateLimit;
	RL_REGISTER: RateLimit;
	RL_TOKEN: RateLimit;
	RL_MCP: RateLimit;
	/** Per IP, before any token check: /mcp and /oauth/token. */
	RL_IP: RateLimit;
	/** Per IP (IPv6 by /64): /authorize, GET and POST (fix round 2). */
	RL_AUTHZ: RateLimit;
	/** One object: exact daily caps on sign-ins started and client registrations (fix round 2). */
	QUOTA: DurableObjectNamespace<Quota>;

	NX_ENV: string;
	PUBLIC_ORIGIN: string;
	DRIVE_ORIGIN: string;
	NC_OIDC_PROVIDER_ID: string;
	SUPABASE_URL: string;
	SUPABASE_OAUTH_CLIENT_ID: string;
	NOMAIL_TOOLS_URL: string;
	ALLOW_ADMIN_UIDS: string;
	ALLOWED_REDIRECTS: string;
	CALENDAR_ATTENDEES: string;
	HEAVY_TOOLS: string;
	STRICT_UPSTREAM_SESSION: string;
	MAX_LINK_DAYS: string;
	DEFAULT_TIME_ZONE: string;

	NX_SECRET: string;
	NX_REVOKE_SECRET: string;
	SUPABASE_OAUTH_CLIENT_SECRET?: string;
	NOMAIL_TOOLS_KEY?: string;
	/** Dev only: JSON map from QA uid to app password. Its presence outside loopback fails closed. */
	DEV_QA_ACCOUNTS?: string;

	/** Set by the OAuth provider before it calls our handlers. */
	OAUTH_PROVIDER?: OAuthHelpers;
}

/** Parsed, validated configuration. Built once per isolate per distinct var set. */
export interface NxConfig {
	env: "production" | "dev";
	publicOrigin: string;
	publicHost: string;
	resource: string;
	driveOrigin: string;
	driveHost: string;
	oidcProviderId: string;
	supabaseUrl: string;
	supabaseHost: string;
	supabaseClientId: string;
	/** True only when the client id is set and the secret exists. */
	upstreamOn: boolean;
	nomailToolsUrl: string | null;
	nomailHost: string | null;
	/** NOMAIL_TOOLS_URL is set but can't be used: mail stays off and the fault is logged. */
	nomailUrlInvalid: boolean;
	allowAdminUids: ReadonlySet<string>;
	allowedRedirects: readonly string[];
	calendarAttendees: "internal" | "off";
	heavyTools: boolean;
	strictUpstreamSession: boolean;
	maxLinkDays: number;
	defaultTimeZone: string;
}

const cache = new Map<string, NxConfig>();

function hostOf(origin: string): string {
	return new URL(origin).host;
}

/**
 * NOMAIL_TOOLS_URL as a plain https base URL that isn't the drive or MCP host (plain http on
 * localhost in dev only). Null when it isn't set, "invalid" when it can't be used. The same rules are
 * checked before a deploy (scripts/predeploy.mjs), so a typo fails the deploy, not production.
 */
export function parseNomailUrl(raw: string | undefined, dev: boolean, driveOrigin: string, publicOrigin: string): { url: string; host: string } | "invalid" | null {
	const text = (raw ?? "").trim();
	if (!text) return null;
	let u: URL;
	try {
		u = new URL(text);
	} catch {
		return "invalid";
	}
	const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
	const devLoopback = dev && loopback && u.protocol === "http:";
	if (u.protocol !== "https:" && !devLoopback) return "invalid";
	if ((u.host === hostOf(driveOrigin) || u.host === hostOf(publicOrigin)) && !devLoopback) return "invalid";
	// A bare "?" or "#" leaves search and hash empty, so the raw text is checked too.
	if (u.search || u.hash || u.username || u.password || /[?#]/.test(text)) return "invalid";
	return { url: u.href.replace(/\/+$/, ""), host: u.host };
}

/** Reads and checks the vars. Throws on a broken config, which the router turns into a 503. */
export function config(env: NxEnv): NxConfig {
	const key = [
		env.NX_ENV,
		env.PUBLIC_ORIGIN,
		env.DRIVE_ORIGIN,
		env.SUPABASE_URL,
		env.SUPABASE_OAUTH_CLIENT_ID,
		env.SUPABASE_OAUTH_CLIENT_SECRET ? "s" : "-",
		env.NOMAIL_TOOLS_URL,
		env.ALLOW_ADMIN_UIDS,
		env.ALLOWED_REDIRECTS,
		env.CALENDAR_ATTENDEES,
		env.HEAVY_TOOLS,
		env.STRICT_UPSTREAM_SESSION,
		env.MAX_LINK_DAYS,
		env.DEFAULT_TIME_ZONE,
		env.NC_OIDC_PROVIDER_ID,
	].join("\u0001");
	const hit = cache.get(key);
	if (hit) return hit;

	const publicOrigin = new URL(env.PUBLIC_ORIGIN).origin;
	const driveOrigin = new URL(env.DRIVE_ORIGIN).origin;
	const supabaseUrl = new URL(env.SUPABASE_URL).origin;
	if (new URL(driveOrigin).protocol !== "https:") throw new Error("DRIVE_ORIGIN must be https");
	if (new URL(supabaseUrl).protocol !== "https:") throw new Error("SUPABASE_URL must be https");
	// A bad NOMAIL_TOOLS_URL hides the mail tools and nothing else (brief section 5): it is logged as
	// a setup fault, never thrown, so Drive tools and sign-in keep working (fix round 3).
	const nomail = parseNomailUrl(env.NOMAIL_TOOLS_URL, env.NX_ENV === "dev", driveOrigin, publicOrigin);
	if (nomail === "invalid") log({ t: "auth", ev: "mail_setup_fault", reason: "nomail_url_invalid" });
	const nomailToolsUrl = nomail && nomail !== "invalid" ? nomail.url : null;
	const nomailHost = nomail && nomail !== "invalid" ? nomail.host : null;
	const maxLinkDays = Number.parseInt(env.MAX_LINK_DAYS || "90", 10);
	const cfg: NxConfig = {
		env: env.NX_ENV === "dev" ? "dev" : "production",
		publicOrigin,
		publicHost: hostOf(publicOrigin),
		resource: `${publicOrigin}/mcp`,
		driveOrigin,
		driveHost: hostOf(driveOrigin),
		oidcProviderId: /^\d{1,6}$/.test(env.NC_OIDC_PROVIDER_ID ?? "") ? env.NC_OIDC_PROVIDER_ID : "1",
		supabaseUrl,
		supabaseHost: hostOf(supabaseUrl),
		supabaseClientId: (env.SUPABASE_OAUTH_CLIENT_ID ?? "").trim(),
		upstreamOn: Boolean((env.SUPABASE_OAUTH_CLIENT_ID ?? "").trim() && env.SUPABASE_OAUTH_CLIENT_SECRET),
		nomailToolsUrl,
		nomailHost,
		nomailUrlInvalid: nomail === "invalid",
		allowAdminUids: new Set((env.ALLOW_ADMIN_UIDS ?? "").split(/\s+/).filter(Boolean)),
		allowedRedirects: (env.ALLOWED_REDIRECTS ?? "").split(/\s+/).filter(Boolean),
		calendarAttendees: env.CALENDAR_ATTENDEES === "off" ? "off" : "internal",
		heavyTools: env.HEAVY_TOOLS !== "off",
		strictUpstreamSession: env.STRICT_UPSTREAM_SESSION === "true",
		maxLinkDays: Number.isFinite(maxLinkDays) && maxLinkDays >= 1 && maxLinkDays <= 365 ? maxLinkDays : 90,
		defaultTimeZone: env.DEFAULT_TIME_ZONE || "UTC",
	};
	cache.set(key, cfg);
	return cfg;
}
