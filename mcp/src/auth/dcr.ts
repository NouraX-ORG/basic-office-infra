/**
 * Dynamic Client Registration policy and the redirect allowlist (DESIGN 6.3). The same allowlist is
 * checked again at /authorize for every client.
 *
 * ALLOWED_REDIRECTS is space-separated: exact URLs, prefixes ending in "*", and the word "loopback"
 * for http://localhost, http://127.0.0.1 and http://[::1] on any port and path (RFC 8252).
 *
 * Client names (fix round 4). An AI app names itself (client_name), and that name becomes the
 * NoDrive access's name ("AI app (name)") and is shown on the consent page. So registration refuses
 * a name that would look like the connections page's own sign-in ("Connections page" or a
 * look-alike, pages/connections/reserved.ts) or that carries the upstream product name (brand rule
 * 6), also once case, spaces, punctuation and compatibility forms are taken out. clientLabel() maps
 * such names, and names that claim to be Nourax itself, to plain "AI app", for clients registered
 * before this check too; the consent page shows that label, never the raw name.
 */
import type { ClientRegistrationCallbackOptions, ClientRegistrationCallbackResult } from "@cloudflare/workers-oauth-provider";
import { brandClean } from "../core/brand";
import { isReservedLabel } from "../pages/connections/reserved";
import { LOOPBACK_HOSTS, redirectAllowed } from "./redirects";

export { redirectAllowed };

const AUTH_METHODS = new Set(["none", "client_secret_basic", "client_secret_post"]);
const GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);

export type DcrRejectReason =
	| "redirect_uris"
	| "redirect_not_allowed"
	| "software_statement"
	| "jwks"
	| "client_name"
	| "client_name_reserved"
	| "grant_types"
	| "response_types"
	| "auth_method";

/** Returns null when the metadata is acceptable, otherwise the reason. */
export function checkClientMetadata(m: Record<string, unknown>, allowlist: readonly string[]): DcrRejectReason | null {
	const uris = m.redirect_uris;
	if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) return "redirect_uris";
	if (!uris.every((u) => redirectAllowed(u, allowlist))) return "redirect_not_allowed";
	if (m.software_statement !== undefined) return "software_statement";
	if (m.jwks_uri !== undefined || m.jwks !== undefined) return "jwks";
	if (m.client_name !== undefined) {
		const n = m.client_name;
		// biome-ignore lint/suspicious/noControlCharactersInRegex: refuse them
		if (typeof n !== "string" || n.length === 0 || n.length > 60 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(n)) return "client_name";
		if (reservedClientName(n)) return "client_name_reserved";
	}
	if (m.grant_types !== undefined) {
		if (!Array.isArray(m.grant_types) || !m.grant_types.every((g) => typeof g === "string" && GRANT_TYPES.has(g))) return "grant_types";
	}
	if (m.response_types !== undefined) {
		if (!Array.isArray(m.response_types) || !m.response_types.every((r) => r === "code")) return "response_types";
	}
	if (m.token_endpoint_auth_method !== undefined && !(typeof m.token_endpoint_auth_method === "string" && AUTH_METHODS.has(m.token_endpoint_auth_method))) {
		return "auth_method";
	}
	return null;
}

const MESSAGES: Record<DcrRejectReason, string> = {
	redirect_uris: "redirect_uris must list one to ten redirect URIs",
	redirect_not_allowed: "This redirect URI isn't allowed for Nourax Workspace",
	software_statement: "software_statement is not supported",
	jwks: "jwks and jwks_uri are not supported",
	client_name: "client_name must be 1 to 60 printable characters",
	client_name_reserved: "This client_name is reserved; choose another name",
	grant_types: "Only authorization_code and refresh_token are supported",
	response_types: "Only the code response type is supported",
	auth_method: "token_endpoint_auth_method must be none, client_secret_basic or client_secret_post",
};

/**
 * The library calls this after it has read and checked the metadata, right before it stores the
 * client. Our policy first; then `admit` (dcr-cap.ts: one unit of the daily cap), so only a
 * registration that is about to be stored is counted (DESIGN 22, section 30.1).
 */
export function registrationCallback(
	allowlist: readonly string[],
	onReject: (reason: DcrRejectReason) => void,
	onOk: () => void,
	admit: (request: Request) => Promise<ClientRegistrationCallbackResult | undefined> = async () => undefined,
) {
	return async (o: ClientRegistrationCallbackOptions): Promise<ClientRegistrationCallbackResult | undefined> => {
		const reason = checkClientMetadata(o.clientMetadata, allowlist);
		if (reason) {
			onReject(reason);
			return { code: reason.startsWith("redirect") ? "invalid_redirect_uri" : "invalid_client_metadata", description: MESSAGES[reason], status: 400 };
		}
		const refused = await admit(o.request);
		if (refused) return refused;
		onOk();
		return undefined;
	};
}

/** Free of the upstream product name, also with everything but letters taken out ("N.e.x.t cloud"). */
function brandCleanSquashed(s: string): boolean {
	return brandClean(s) && brandClean(s.replace(/[^A-Za-z]/g, ""));
}

/**
 * Whether a self-chosen client name is refused at registration: it would look like the connections
 * page's own sign-in on NoDrive's grant page, or it names the upstream product (see the top).
 * Compatibility forms (full-width letters and the like) are folded first, as clientLabel does.
 */
export function reservedClientName(name: string): boolean {
	const n = name.normalize("NFKD");
	return isReservedLabel(n) || !brandCleanSquashed(n);
}

/** A name that claims to be Nourax itself ("Nourax Workspace (official)"): never shown as given. */
function claimsNourax(s: string): boolean {
	return /nourax/i.test(s.replace(/[^A-Za-z]/g, ""));
}

/** The label of a client whose redirect host names it ("Claude", "ChatGPT"), or null. */
export function labelFromHost(redirectUri: string): string | null {
	let host = "";
	try {
		host = new URL(redirectUri).hostname;
	} catch {
		host = "";
	}
	if (host === "claude.ai" || host === "claude.com" || host.endsWith(".claude.ai")) return "Claude";
	if (host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host.endsWith(".openai.com")) return "ChatGPT";
	return null;
}

/**
 * A short ASCII label for the app password name and our pages (the consent page included):
 * [A-Za-z0-9 ._-], at most 40, no upstream brand. A name that looks like the connections page's own
 * sign-in, names the upstream product or claims to be Nourax becomes plain "AI app" (fix round 4).
 */
export function clientLabel(clientName: string | undefined, redirectUri: string): string {
	const named = labelFromHost(redirectUri);
	if (named) return named;
	let host = "";
	try {
		host = new URL(redirectUri).hostname;
	} catch {
		host = "";
	}
	const fallback = LOOPBACK_HOSTS.has(host) || host === "::1" ? "App on this computer" : "AI app";
	const raw = (clientName ?? "").normalize("NFKD");
	const label = raw.replace(/[^A-Za-z0-9 ._-]/g, "").replace(/next\s*-?\s*cloud/gi, "").replace(/\s+/g, " ").trim().slice(0, 40).trim();
	if (!label) return fallback;
	if (isReservedLabel(label) || isReservedLabel(raw) || !brandCleanSquashed(label) || !brandCleanSquashed(raw) || claimsNourax(raw)) return "AI app";
	return label;
}
