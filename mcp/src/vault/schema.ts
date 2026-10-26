/** Vault types and SQLite schema (DESIGN 9.1 and 9.4). Frozen by core. */
import type { AppId } from "../mcp/catalog";

export type ConnKind = "oauth" | "desktop" | "dev";

export interface UpstreamTokens {
	accessToken: string;
	refreshToken: string;
	/** Seconds since the epoch. */
	expiresAt: number;
}

export interface NewConnection {
	connectionId: string;
	uid: string;
	kind: ConnKind;
	clientId?: string;
	clientLabel: string;
	scopes: string[];
	apps: AppId[];
	cred: { loginName: string; appPassword: string };
	displayName?: string | null;
	upstream?: UpstreamTokens | null;
	/** Idle lifetime and absolute lifetime, in seconds. */
	idleSec: number;
	maxAgeSec: number;
}

export type ConnStatus = "active" | "needs_reconnect" | "revoked" | "missing";
export type MailState = "ok" | "reconnect_needed";

export interface OpenOk {
	ok: true;
	uid: string;
	kind: ConnKind;
	clientId?: string;
	clientLabel: string;
	scopes: string[];
	apps: AppId[];
	connectedAt: number;
	expiresAt: number;
	displayName: string | null;
	cred: { loginName: string; appPassword: string };
	upstream: { state: "ok" | "dead" | "none"; accessToken?: string; expiresAt?: number };
	mailState: MailState;
	/** Set when this call is over a per-person limit; the connection itself is fine. */
	limited?: { reason: "rate_limited" | "daily_limit"; retryAfterSec: number; limit?: string };
}

export type OpenFailReason = "rate_limited" | "daily_limit" | "needs_reconnect" | "revoked" | "missing";

export interface OpenFail {
	ok: false;
	reason: OpenFailReason;
	retryAfterSec?: number;
	/** For rate limits: which limit was hit, for the message. */
	limit?: string;
}

export interface ConnectionSummary {
	connectionId: string;
	kind: ConnKind;
	clientId: string | null;
	clientLabel: string;
	scopes: string[];
	apps: AppId[];
	createdAt: number;
	lastUsedAt: number;
	expiresAt: number;
	status: "active" | "needs_reconnect" | "revoking";
}

/**
 * A connection that ended but whose NoDrive app password could not be revoked automatically,
 * because its revoke-wrap can't be opened any more (NX_REVOKE_SECRET was rotated). No secret is
 * kept. /connections shows these so the owner can remove the access in NoDrive by its name
 * ("AI app (<label>)") and then clear the entry.
 */
export interface UnrevokedSummary {
	connectionId: string;
	kind: ConnKind;
	clientLabel: string;
	createdAt: number;
	endedAt: number;
	reason: string;
}

export interface MailCacheEntry {
	/** JSON text (the tool list), or null after a failure with nothing cached before. */
	value: string | null;
	failures: number;
	expiresAt: number;
}

export const MIGRATIONS: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS conn (
		id TEXT PRIMARY KEY,
		uid TEXT NOT NULL,
		kind TEXT NOT NULL,
		client_id TEXT,
		client_label TEXT NOT NULL,
		grant_id TEXT,
		scopes TEXT NOT NULL,
		apps TEXT NOT NULL,
		status TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER NOT NULL,
		idle_sec INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		key_version INTEGER NOT NULL,
		wrap_use TEXT NOT NULL,
		wrap_rev TEXT NOT NULL,
		cred TEXT NOT NULL,
		upstream TEXT,
		upstream_state TEXT NOT NULL,
		mail_state TEXT NOT NULL,
		revoke_tries INTEGER NOT NULL DEFAULT 0,
		revoke_reason TEXT
	)`,
	"CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)",
	"CREATE TABLE IF NOT EXISTS kv (conn TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, exp INTEGER NOT NULL, PRIMARY KEY (conn, k))",
	"CREATE TABLE IF NOT EXISTS gone (id TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL)",
	"CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, token TEXT NOT NULL, until INTEGER NOT NULL)",
	"CREATE TABLE IF NOT EXISTS unrevoked (id TEXT PRIMARY KEY, kind TEXT NOT NULL, client_label TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, reason TEXT NOT NULL)",
	// Small vault-wide values; today only grant_check_at (when the alarm next checks the OAuth grants).
	"CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)",
];
