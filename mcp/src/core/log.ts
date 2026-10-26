/**
 * Metadata-only logging (DESIGN 15). This is the only module allowed to call console.log; a lint
 * test enforces it. Each line type has a fixed set of keys, and string values must look like
 * identifiers or codes, so content (paths, names, titles, emails, tokens) can't slip into a log.
 */
import { hmacSha256, toHex } from "./bytes";
import { subkey } from "./keys";

export type ReqLine = {
	t: "req";
	rid: string;
	route: string;
	method: string;
	status: number;
	ms: number;
	colo?: string;
	era?: string;
	cli?: string;
	origin_scheme?: string;
};

export type ToolLine = {
	t: "tool";
	rid: string;
	who: string;
	conn: string;
	cli: string;
	tool: string;
	ok: boolean;
	code?: string;
	ms: number;
	nc_calls: number;
	nc_status?: number;
	in_bytes: number;
	out_bytes: number;
	/**
	 * The tool's ctx.log.note codes (section 30.5): short fixed codes such as "fit_cut",
	 * "recent_fallback" or "href_outside", each once, at most 10. Never user data.
	 */
	notes?: string[];
};

export type AuthEvent =
	| "consent_shown"
	| "consent_ok"
	| "consent_denied"
	| "upstream_ok"
	| "upstream_bad_token"
	| "drive_ok"
	| "uid_mismatch"
	| "admin_refused"
	| "non_uuid_refused"
	| "connect_expired"
	| "connect_cap"
	| "refresh_ok"
	| "refresh_failed"
	| "max_age"
	| "revoked"
	| "idle_revoked"
	| "replaced"
	| "key_rotated"
	| "needs_reconnect"
	| "dcr_ok"
	| "dcr_rejected"
	| "redirect_rejected"
	| "rate_limited"
	| "href_outside"
	| "egress_denied"
	| "oauth_error"
	| "dev_misconfigured"
	| "mail_toolset_changed"
	| "mail_circuit_open"
	| "mail_setup_fault"
	// A Worker secret is missing or too short: nothing can be connected until the owner fixes it.
	| "setup_fault"
	// NoDrive kept refusing a revocation; the row stays and is retried daily.
	| "revoke_stuck"
	// The revoke-wrap can't be opened (NX_REVOKE_SECRET rotated): listed for the owner to remove by hand.
	| "revoke_impossible"
	// The OAuth grant behind a vault row is gone (client revocation, purge, unexchanged code).
	| "grant_gone"
	| "client_revoked"
	| "pkce_missing"
	| "batch_refused"
	// cloud/user came back without a list of groups: the admin check can't run, so the connect step stops.
	| "groups_unreadable"
	// A daily cap on new sign-ins or client registrations was reached (Quota object; reason names which).
	| "daily_cap"
	// The MCP SDK reported an error it turned into a bare 500 (reason: the error's name only).
	| "mcp_error"
	// Vault.open() threw, so /mcp answered 503 (reason: the error's name only).
	| "vault_unavailable";

export type AuthLine = {
	t: "auth";
	rid?: string;
	ev: AuthEvent;
	who?: string;
	cli?: string;
	reason?: string;
	status?: number;
};
export type CronLine = { t: "cron"; job: string; ok: boolean; n?: number; ms: number };

const ALLOWED: Record<string, readonly string[]> = {
	req: ["t", "rid", "route", "method", "status", "ms", "colo", "era", "cli", "origin_scheme"],
	tool: ["t", "rid", "who", "conn", "cli", "tool", "ok", "code", "ms", "nc_calls", "nc_status", "in_bytes", "out_bytes", "notes"],
	auth: ["t", "rid", "ev", "who", "cli", "reason", "status"],
	cron: ["t", "job", "ok", "n", "ms"],
};

/** Strings in logs must be short codes: letters, digits and a few separators. */
const SAFE = /^[A-Za-z0-9_.:/+-]{0,64}$/;
/** A list (only the tool line's `notes`) holds lower-case codes: at most 10, each once. */
const NOTE = /^[a-z0-9_]{1,40}$/;
const NOTES_MAX = 10;

export function sanitize(line: Record<string, unknown>): Record<string, unknown> {
	const keys = ALLOWED[String(line.t)] ?? [];
	const out: Record<string, unknown> = {};
	for (const k of keys) {
		const v = line[k];
		if (v === undefined || v === null) continue;
		if (typeof v === "number") out[k] = Number.isFinite(v) ? Math.round(v) : 0;
		else if (typeof v === "boolean") out[k] = v;
		else if (typeof v === "string") out[k] = SAFE.test(v) ? v : "redacted";
		else if (Array.isArray(v) && k === "notes") {
			const codes = [...new Set(v.map((x) => (typeof x === "string" && NOTE.test(x) ? x : "redacted")))].slice(0, NOTES_MAX);
			if (codes.length) out[k] = codes;
		}
	}
	return out;
}

export function log(line: ReqLine | ToolLine | AuthLine | CronLine): void {
	console.log(JSON.stringify(sanitize(line as unknown as Record<string, unknown>)));
}

/** HMAC(log-pseudonym, value) cut to `len` hex characters. Uids and connection ids never appear raw. */
export async function pseudonym(env: { NX_SECRET: string }, value: string, len: number): Promise<string> {
	try {
		const key = await subkey(env, "log-pseudonym");
		return toHex(await hmacSha256(key, value)).slice(0, len);
	} catch {
		return "unknown";
	}
}

/** Which kind of MCP client this is, from its User-Agent and redirect host. Only these labels are logged. */
export type CliName = "claude" | "claude-code" | "chatgpt" | "onlyoffice" | "mcp-remote" | "inspector" | "other";

export function cliOf(userAgent: string | null, hint?: string): CliName {
	const ua = (userAgent ?? "").toLowerCase();
	const h = (hint ?? "").toLowerCase();
	if (ua.includes("claude-code") || ua.includes("claude code")) return "claude-code";
	if (ua.includes("mcp-remote")) return "mcp-remote";
	if (ua.includes("inspector")) return "inspector";
	if (ua.includes("onlyoffice") || ua.includes("asc desktop") || h === "onlyoffice") return "onlyoffice";
	if (ua.includes("openai") || ua.includes("chatgpt") || h.includes("chatgpt")) return "chatgpt";
	if (ua.includes("claude") || ua.includes("anthropic") || h.includes("claude")) return "claude";
	return "other";
}
