/**
 * The Vault Durable Object (DESIGN 9): one per person, a row per connection.
 *
 * - Each connection has its own 32-byte data key (DEK). Records are AES-256-GCM under the DEK.
 * - The DEK is wrapped twice: the use-wrap needs the token holder's vaultKey plus the vault pepper
 *   (a subkey of NX_SECRET); the revoke-wrap needs only NX_REVOKE_SECRET and is unwrapped only
 *   inside revokeAndWipe(), which never returns plaintext.
 * - Rate limits and daily caps live here, exact and per person.
 * - Alarms end idle and expired connections, revoking their app passwords, so no app password the
 *   connector made is ever orphaned. A revocation NoDrive keeps refusing stays queued, with
 *   backoff; one that can never succeed (NX_REVOKE_SECRET rotated), and one NoDrive has refused for
 *   30 days (fix round 4), goes to the "unrevoked" list that /connections shows.
 * - A 401 to the revocation is not proof that the app password is gone (fix round 4): a disabled
 *   account answers 401 for every app password, and re-enabling it brings them all back
 *   (User::setEnabled deletes no tokens). So a 401 is retried like any refusal, and a dead
 *   credential (8.5) keeps its row, credential encrypted, with the revocation queued; it is never
 *   sent on an MCP call again.
 * - The alarm also checks, at least daily, that each OAuth connection's grant still exists in the
 *   library (a client's RFC 7009 revocation, a purge, a code never exchanged) and ends the orphans.
 *
 * The uid always comes from the decrypted grant props or the desktop-key record, never from tool
 * input. This module imports only crypto, egress, config, the schema, logging and the grant-key
 * helper.
 */
import { DurableObject } from "cloudflare:workers";
import { config, type NxEnv } from "../env";
import { revokeAnswerGone } from "../auth/app-password";
import { grantExists } from "../auth/grants";
import { b64, fromUtf8, randomBytes, sha256Hex, utf8 } from "../core/bytes";
import { egress, readCappedJson } from "../core/egress";
import { secretOk, subkey } from "../core/keys";
import { type Bucket, LIMITS, PER_DAY, PER_MINUTE } from "../core/limits";
import { log } from "../core/log";
import type { AppId } from "../mcp/catalog";
import { open, openJson, recordAad, RevokeSecretMissing, revokeKek, seal, sealJson, unwrapKey, useKek, VaultSecretMissing, wrapKey } from "./crypto";
import {
	type ConnectionSummary,
	type ConnKind,
	type ConnStatus,
	MIGRATIONS,
	type MailCacheEntry,
	type MailState,
	type NewConnection,
	type OpenFail,
	type OpenOk,
	type UnrevokedSummary,
	type UpstreamTokens,
} from "./schema";

const KEY_VERSION = 1;

/** First grant check after a connection is made: its code must have been exchanged by then (the library gives it 10 minutes). */
export const GRANT_FIRST_CHECK_SEC = 3600;
/** After a client revokes: wait out KV's 60-second edge cache before checking the grant. */
export const GRANT_AFTER_REVOKE_SEC = 120;
const GRANT_CHECK_EVERY_SEC = 86400;

/** Wait before the next revocation attempt: 10 minutes for the first hour, then doubling up to a day. */
export function revokeBackoffSec(tries: number): number {
	if (tries <= 6) return 600;
	return Math.min(600 * 2 ** (tries - 6), 86400);
}

/**
 * After this long of failed revocations (any refusal, a 401 included), the row goes to the
 * "unrevoked" list (fix round 4): the credential is wiped and /connections asks for the access to be
 * removed by hand. Until then it is retried with backoff (daily, after the first two days).
 */
export const REVOKE_GIVE_UP_SEC = 30 * 86400;

/**
 * Whether a failed DELETE proves the app password is already gone; a 401 never does (fix round 4).
 * It lives in auth/app-password.ts, which the connect step uses too.
 */
export { revokeAnswerGone };

/**
 * What a refusal from Supabase's token endpoint to a refresh means (third system review, section
 * 30.4). Read in supabase/auth v2.197.0 (internal/api/errors.go, oauthserver/handlers.go,
 * tokens/service.go, middleware.go), not guessed from the status, which is 400 for nearly every
 * failure:
 * - OAuth errors are `{"error": "<code>"}` with HTTP 400 (invalid_grant, invalid_client,
 *   invalid_request, temporarily_unavailable, server_error...);
 * - the refresh grant's own errors are HTTP errors with an error code: `{"code":400,
 *   "error_code":"refresh_token_not_found","msg":...}` in the default envelope, `{"code":
 *   "<code>","message":...}` with API version 2024-01-01, and the `x-sb-error-code` header;
 * - a wrong client secret, a client id that doesn't exist and a wrong auth method are HTTP 400
 *   "invalid_credentials" from the client check; a session made for another client is OAuth
 *   "invalid_client".
 *
 * "dead": the session itself is gone; only reconnecting helps. "client": our client id or secret is
 * wrong (a setup fault that the owner fixes; every session stays good). "transient": anything else,
 * including an answer that can't be read; the stored session is kept and the refresh fails for now.
 */
export type RefreshRefusal = { kind: "dead" | "client" | "transient"; code: string };
const SESSION_DEAD_CODES: ReadonlySet<string> = new Set([
	"invalid_grant",
	"refresh_token_not_found",
	"refresh_token_already_used",
	"session_not_found",
	"session_expired",
	"user_banned",
]);
const CLIENT_FAULT_CODES: ReadonlySet<string> = new Set(["invalid_client", "unauthorized_client", "invalid_credentials", "oauth_client_not_found"]);

export function refreshRefusal(status: number, body: unknown, headerCode: string | null): RefreshRefusal {
	const j = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
	const codes = [j.error, j.error_code, j.code, headerCode].filter((c): c is string => typeof c === "string" && /^[a-z0-9_]{1,48}$/.test(c));
	if (status === 400 || status === 401) {
		for (const c of codes) if (CLIENT_FAULT_CODES.has(c)) return { kind: "client", code: c };
		for (const c of codes) if (SESSION_DEAD_CODES.has(c)) return { kind: "dead", code: c };
	}
	return { kind: "transient", code: codes[0] ?? `http_${status}` };
}

/**
 * revoke_tries for a revocation NoDrive answered 401: revokeBackoffSec(DEAD_RETRY_TRIES) is a day,
 * so such a credential (a disabled account's, or one removed in NoDrive) is tried once a day, not
 * every 10 minutes (fix round 4). A failed login counts towards NoDrive's brute-force protection.
 */
export const DEAD_RETRY_TRIES = 14;

/** The schema version kept in `meta` (k = "schema_v"); 2 added conn.revoke_since (fix round 4). */
const SCHEMA_VERSION = 2;

interface ConnRow {
	id: string;
	uid: string;
	kind: ConnKind;
	client_id: string | null;
	client_label: string;
	grant_id: string | null;
	scopes: string;
	apps: string;
	status: "active" | "needs_reconnect" | "revoking";
	created_at: number;
	last_used_at: number;
	idle_sec: number;
	expires_at: number;
	key_version: number;
	wrap_use: string;
	wrap_rev: string;
	cred: string;
	upstream: string | null;
	upstream_state: "ok" | "dead" | "none";
	mail_state: MailState;
	revoke_tries: number;
	revoke_reason: string | null;
	/** When the first failed revocation of this row was (fix round 4), or null. */
	revoke_since: number | null;
}

interface CredRecord {
	loginName: string;
	appPassword: string;
	displayName: string | null;
}

const now = () => Math.floor(Date.now() / 1000);

function secondsToNextMinute(t: number): number {
	return 60 - (t % 60);
}

function secondsToUtcMidnight(t: number): number {
	return 86400 - (t % 86400);
}

export class Vault extends DurableObject<NxEnv> {
	private readonly sql: SqlStorage;
	private readonly refreshing = new Map<string, { force: boolean; p: Promise<{ accessToken: string; expiresAt: number } | { dead: true }> }>();

	constructor(ctx: DurableObjectState, env: NxEnv) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => {
			for (const m of MIGRATIONS) this.sql.exec(m);
			// Versioned steps after the CREATE TABLEs (ALTER TABLE can't be repeated, so it runs once).
			const v = this.metaGet("schema_v") ?? 1;
			if (v < 2) this.sql.exec("ALTER TABLE conn ADD COLUMN revoke_since INTEGER");
			if (v < SCHEMA_VERSION) this.metaSet("schema_v", SCHEMA_VERSION);
		});
	}

	// ---------- helpers ----------

	private row(connectionId: string): ConnRow | null {
		const rows = this.sql.exec("SELECT * FROM conn WHERE id = ?", connectionId).toArray() as unknown as ConnRow[];
		return rows[0] ?? null;
	}

	/**
	 * The vault pepper. A missing or short NX_SECRET throws VaultSecretMissing (logged as a setup
	 * fault) before anything is unwrapped, so a setup slip never looks like a rotated key.
	 */
	private async pepper(): Promise<Uint8Array> {
		if (!secretOk(this.env.NX_SECRET)) {
			log({ t: "auth", ev: "setup_fault", reason: "nx_secret" });
			throw new VaultSecretMissing();
		}
		return subkey(this.env, "vault-pepper");
	}

	/** Unwraps the DEK with the token holder's key. Throws when the key or the pepper is wrong. */
	private async dekForUse(r: ConnRow, useKey: Uint8Array, pepper?: Uint8Array): Promise<Uint8Array> {
		const kek = await useKek(useKey, pepper ?? (await this.pepper()), r.uid, r.id);
		return unwrapKey(kek, r.wrap_use);
	}

	private async dekForRevoke(r: ConnRow): Promise<Uint8Array> {
		const kek = await revokeKek(this.env.NX_REVOKE_SECRET, r.uid, r.id);
		return unwrapKey(kek, r.wrap_rev);
	}

	private aad(r: { uid: string; id: string; key_version: number }, record: string): string {
		return recordAad(r.uid, r.id, record, r.key_version);
	}

	private bump(k: string, by: number, exp: number): number {
		this.sql.exec(
			"INSERT INTO counters (k, n, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n",
			k,
			by,
			exp,
		);
		const r = this.sql.exec<{ n: number }>("SELECT n FROM counters WHERE k = ?", k).one();
		return Number(r.n);
	}

	private count(k: string): number {
		const rows = this.sql.exec<{ n: number }>("SELECT n FROM counters WHERE k = ?", k).toArray();
		return rows[0] ? Number(rows[0].n) : 0;
	}

	private metaGet(k: string): number | null {
		const rows = this.sql.exec<{ v: number }>("SELECT v FROM meta WHERE k = ?", k).toArray();
		return rows[0] ? Number(rows[0].v) : null;
	}

	private metaSet(k: string, v: number): void {
		this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
	}

	/** Moves the next grant check earlier (never later). */
	private wantGrantCheck(at: number): void {
		const cur = this.metaGet("grant_check_at");
		if (cur === null || at < cur) this.metaSet("grant_check_at", at);
	}

	private scheduleAlarm(): void {
		const rows = this.sql
			.exec<{ status: string; last_used_at: number; idle_sec: number; expires_at: number; revoke_tries: number }>(
				"SELECT status, last_used_at, idle_sec, expires_at, revoke_tries FROM conn",
			)
			.toArray();
		const times: number[] = [];
		for (const r of rows) {
			if (r.status === "revoking") times.push(Number(r.last_used_at) + revokeBackoffSec(Number(r.revoke_tries)));
			else times.push(Math.min(Number(r.last_used_at) + Number(r.idle_sec), Number(r.expires_at)));
		}
		const gc = this.metaGet("grant_check_at");
		if (gc !== null) times.push(gc);
		// Also once a day for counter and cache clean-up while anything is stored.
		const any = Number(this.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM counters").one().c) > 0;
		if (any) times.push(now() + 86400);
		const valid = times.filter((t) => Number.isFinite(t) && t > 0);
		if (valid.length === 0) return;
		const at = Math.max(Math.min(...valid), now() + 1) * 1000;
		void this.ctx.storage.setAlarm(at);
	}

	// ---------- RPC ----------

	/** Stores a new connection. When the person already has 5, the least recently used one with the
	 *  same client label is replaced; otherwise the call is refused with reason "cap". */
	async createConnection(c: NewConnection, useKey: Uint8Array): Promise<{ ok: true; replaced: number } | { ok: false; reason: "cap" }> {
		if (!/^[0-9a-f]{32}$/.test(c.connectionId)) throw new Error("bad connection id");
		if (useKey.length !== 32) throw new Error("bad use key");
		// Checked before anything changes: without the revoke secret the new row could never be revoked.
		if (!secretOk(this.env.NX_REVOKE_SECRET)) {
			log({ t: "auth", ev: "setup_fault", reason: "revoke_secret" });
			throw new RevokeSecretMissing();
		}
		// The same for NX_SECRET: checked before an older connection is replaced below.
		const pepper = await this.pepper();
		let replaced = 0;
		const active = this.sql.exec<{ id: string; client_label: string; last_used_at: number }>(
			"SELECT id, client_label, last_used_at FROM conn WHERE status != 'revoking' ORDER BY last_used_at ASC",
		).toArray();
		if (active.length >= LIMITS.connectionsPerPerson) {
			const same = active.find((a) => a.client_label === c.clientLabel);
			if (!same) return { ok: false, reason: "cap" };
			await this.revokeAndWipe(String(same.id), "replaced");
			replaced = 1;
		}
		const t = now();
		const dek = randomBytes(32);
		const base = { uid: c.uid, id: c.connectionId, key_version: KEY_VERSION };
		const wrapUse = await wrapKey(await useKek(useKey, pepper, c.uid, c.connectionId), dek);
		const wrapRev = await wrapKey(await revokeKek(this.env.NX_REVOKE_SECRET, c.uid, c.connectionId), dek);
		const cred: CredRecord = { loginName: c.cred.loginName, appPassword: c.cred.appPassword, displayName: c.displayName ?? null };
		const credSealed = await sealJson(dek, cred, this.aad(base, "cred"));
		const upstreamSealed = c.upstream ? await sealJson(dek, c.upstream, this.aad(base, "upstream")) : null;
		this.sql.exec(
			`INSERT INTO conn (id, uid, kind, client_id, client_label, grant_id, scopes, apps, status, created_at, last_used_at, idle_sec, expires_at,
				key_version, wrap_use, wrap_rev, cred, upstream, upstream_state, mail_state, revoke_tries, revoke_reason)
			 VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', 0, NULL)`,
			c.connectionId,
			c.uid,
			c.kind,
			c.clientId ?? null,
			c.clientLabel,
			c.scopes.join(" "),
			c.apps.join(" "),
			t,
			t,
			c.idleSec,
			t + c.maxAgeSec,
			KEY_VERSION,
			wrapUse,
			wrapRev,
			credSealed,
			upstreamSealed,
			c.upstream ? "ok" : "none",
		);
		// OAuth and dev connections live on a library grant: check it once its code must be used.
		if (c.kind !== "desktop") this.wantGrantCheck(t + GRANT_FIRST_CHECK_SEC);
		this.scheduleAlarm();
		return { ok: true, replaced };
	}

	/** Records the library grant behind a connection (right after completeAuthorization, and again at the code exchange). */
	async bindGrant(connectionId: string, grantId: string): Promise<void> {
		this.sql.exec("UPDATE conn SET grant_id = ? WHERE id = ? AND (grant_id IS NULL OR grant_id = ?)", grantId, connectionId, grantId);
	}

	/**
	 * A client revoked a token of this grant (RFC 7009). The grant may be gone now; check it once
	 * KV's edge cache has expired, and end the connection if so. Returns whether a row uses it.
	 */
	async grantMayHaveEnded(grantId: string): Promise<boolean> {
		const rows = this.sql.exec("SELECT id FROM conn WHERE grant_id = ? AND status = 'active'", grantId).toArray();
		if (!rows.length) return false;
		this.wantGrantCheck(now() + GRANT_AFTER_REVOKE_SEC);
		this.scheduleAlarm();
		return true;
	}

	/** Ends OAuth and dev connections whose library grant no longer exists. */
	private async reconcileGrants(t: number): Promise<number> {
		const rows = this.sql
			.exec<{ id: string; uid: string; grant_id: string | null; created_at: number }>(
				"SELECT id, uid, grant_id, created_at FROM conn WHERE status = 'active' AND kind != 'desktop'",
			)
			.toArray();
		let ended = 0;
		let next = t + GRANT_CHECK_EVERY_SEC;
		for (const r of rows) {
			let gone: boolean;
			if (r.grant_id === null) {
				// Never bound: once its code can no longer be exchanged, its grant has expired.
				const due = Number(r.created_at) + GRANT_FIRST_CHECK_SEC;
				gone = t >= due;
				if (!gone) next = Math.min(next, due);
			} else {
				try {
					gone = !(await grantExists(this.env.OAUTH_KV, String(r.uid), String(r.grant_id)));
				} catch {
					// KV unreadable: never act on a guess; look again in 10 minutes.
					next = Math.min(next, t + 600);
					continue;
				}
			}
			if (gone) {
				await this.revokeAndWipe(String(r.id), "grant_gone");
				log({ t: "auth", ev: "grant_gone" });
				ended++;
			}
		}
		const left = Number(this.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM conn WHERE status = 'active' AND kind != 'desktop'").one().c);
		if (left > 0) this.metaSet("grant_check_at", next);
		else this.sql.exec("DELETE FROM meta WHERE k = 'grant_check_at'");
		return ended;
	}

	async grantOf(connectionId: string): Promise<string | null> {
		return this.row(connectionId)?.grant_id ?? null;
	}

	async status(connectionId: string): Promise<ConnStatus> {
		const r = this.row(connectionId);
		if (r) {
			if (r.status === "revoking") return "revoked";
			if (now() > r.expires_at || now() > r.last_used_at + r.idle_sec) return "revoked";
			return r.status;
		}
		const g = this.sql.exec("SELECT id FROM gone WHERE id = ?", connectionId).toArray();
		return g.length ? "revoked" : "missing";
	}

	/** Opens a connection for one MCP request: checks it, counts the call, returns the credential. */
	async open(
		connectionId: string,
		useKey: Uint8Array,
		opts: { bucket?: Bucket; weight?: number; bytes?: number } = {},
	): Promise<OpenOk | OpenFail> {
		const r = this.row(connectionId);
		if (!r) {
			const g = this.sql.exec("SELECT id FROM gone WHERE id = ?", connectionId).toArray();
			return { ok: false, reason: g.length ? "revoked" : "missing" };
		}
		if (r.status === "revoking") return { ok: false, reason: "revoked" };
		const t = now();
		if (t > r.expires_at) {
			await this.revokeAndWipe(r.id, "max_age");
			return { ok: false, reason: "revoked" };
		}
		if (t > r.last_used_at + r.idle_sec) {
			await this.revokeAndWipe(r.id, "idle");
			return { ok: false, reason: "revoked" };
		}
		if (r.status === "needs_reconnect") return { ok: false, reason: "needs_reconnect" };
		// Outside the try: a missing or short NX_SECRET throws here (the handler answers 503) and
		// changes nothing. Only a failed unwrap under a valid pepper means a rotated key.
		const pepper = await this.pepper();
		let dek: Uint8Array;
		try {
			dek = await this.dekForUse(r, useKey, pepper);
		} catch {
			// The pepper was rotated (kill switch) or the key is wrong: end this connection for good.
			await this.revokeAndWipe(r.id, "key_rotated");
			return { ok: false, reason: "revoked" };
		}
		const weight = opts.weight ?? 0;
		let limited: OpenOk["limited"];
		if (weight > 0) {
			const blocked = this.checkLimits(opts.bucket ?? "read", weight, opts.bytes ?? 0, t);
			if (blocked && (blocked.reason === "rate_limited" || blocked.reason === "daily_limit")) {
				limited = { reason: blocked.reason, retryAfterSec: blocked.retryAfterSec ?? 60, ...(blocked.limit ? { limit: blocked.limit } : {}) };
			}
		}
		const cred = await openJson<CredRecord>(dek, r.cred, this.aad(r, "cred"));
		let upstream: OpenOk["upstream"] = { state: r.upstream_state };
		if (r.upstream && r.upstream_state === "ok") {
			const u = await openJson<UpstreamTokens>(dek, r.upstream, this.aad(r, "upstream"));
			upstream = { state: "ok", accessToken: u.accessToken, expiresAt: u.expiresAt };
		}
		this.sql.exec("UPDATE conn SET last_used_at = ? WHERE id = ?", t, r.id);
		return {
			ok: true,
			uid: r.uid,
			kind: r.kind,
			...(r.client_id ? { clientId: r.client_id } : {}),
			clientLabel: r.client_label,
			scopes: r.scopes.split(" ").filter(Boolean),
			apps: r.apps.split(" ").filter(Boolean) as AppId[],
			connectedAt: r.created_at,
			expiresAt: Math.min(r.expires_at, t + r.idle_sec),
			displayName: cred.displayName,
			cred: { loginName: cred.loginName, appPassword: cred.appPassword },
			upstream,
			mailState: r.mail_state,
			...(limited ? { limited } : {}),
		};
	}

	/** Exact per-person limits (DESIGN 9.4). Counts the call when allowed. */
	private checkLimits(bucket: Bucket, weight: number, bytes: number, t: number): OpenFail | null {
		const minute = Math.floor(t / 60);
		const day = Math.floor(t / 86400);
		const mKey = `m:${bucket}:${minute}`;
		const dCalls = `d:calls:${day}`;
		const dBucket = `d:${bucket}:${day}`;
		const dBytes = `d:bytes:${day}`;
		if (this.count(mKey) + weight > PER_MINUTE[bucket]) {
			return { ok: false, reason: "rate_limited", retryAfterSec: secondsToNextMinute(t), limit: `${PER_MINUTE[bucket]}/min ${bucket}` };
		}
		if (this.count(dCalls) + weight > PER_DAY.calls) {
			return { ok: false, reason: "daily_limit", retryAfterSec: secondsToUtcMidnight(t), limit: "calls" };
		}
		const dayCap = (PER_DAY as Record<string, number>)[bucket];
		if (dayCap !== undefined && bucket !== "read" && this.count(dBucket) + weight > dayCap) {
			return { ok: false, reason: "daily_limit", retryAfterSec: secondsToUtcMidnight(t), limit: bucket };
		}
		if (bytes > 0 && this.count(dBytes) + bytes > PER_DAY.uploadBytes) {
			return { ok: false, reason: "daily_limit", retryAfterSec: secondsToUtcMidnight(t), limit: "upload" };
		}
		this.bump(mKey, weight, (minute + 2) * 60);
		this.bump(dCalls, weight, (day + 2) * 86400);
		if (dayCap !== undefined && bucket !== "read") this.bump(dBucket, weight, (day + 2) * 86400);
		if (bytes > 0) this.bump(dBytes, bytes, (day + 2) * 86400);
		this.scheduleAlarm();
		return null;
	}

	/** Extra charges inside one tool call (content search counts as heavy, upload bytes). */
	async charge(bucket: Bucket, weight: number, bytes = 0): Promise<{ ok: true } | OpenFail> {
		const t = now();
		const minute = Math.floor(t / 60);
		const day = Math.floor(t / 86400);
		const mKey = `m:${bucket}:${minute}`;
		if (weight > 0 && this.count(mKey) + weight > PER_MINUTE[bucket]) {
			return { ok: false, reason: "rate_limited", retryAfterSec: secondsToNextMinute(t), limit: `${PER_MINUTE[bucket]}/min ${bucket}` };
		}
		const dayCap = (PER_DAY as Record<string, number>)[bucket];
		if (weight > 0 && dayCap !== undefined && bucket !== "read" && this.count(`d:${bucket}:${day}`) + weight > dayCap) {
			return { ok: false, reason: "daily_limit", retryAfterSec: secondsToUtcMidnight(t), limit: bucket };
		}
		if (bytes > 0 && this.count(`d:bytes:${day}`) + bytes > PER_DAY.uploadBytes) {
			return { ok: false, reason: "daily_limit", retryAfterSec: secondsToUtcMidnight(t), limit: "upload" };
		}
		if (weight > 0) this.bump(mKey, weight, (minute + 2) * 60);
		if (weight > 0 && dayCap !== undefined && bucket !== "read") this.bump(`d:${bucket}:${day}`, weight, (day + 2) * 86400);
		if (bytes > 0) this.bump(`d:bytes:${day}`, bytes, (day + 2) * 86400);
		return { ok: true };
	}

	/** One holder at a time per name, and at most `perHour` grants an hour (conversions: 1 and 20). */
	async lease(name: string, ttlSec: number, perHour: number): Promise<{ ok: true; token: string } | { ok: false; reason: "busy" | "hourly"; retryAfterSec: number }> {
		const t = now();
		const cur = this.sql.exec<{ token: string; until: number }>("SELECT token, until FROM leases WHERE name = ?", name).toArray();
		if (cur[0] && Number(cur[0].until) > t) return { ok: false, reason: "busy", retryAfterSec: Math.max(1, Number(cur[0].until) - t) };
		const hour = Math.floor(t / 3600);
		const hKey = `h:${name}:${hour}`;
		if (this.count(hKey) >= perHour) return { ok: false, reason: "hourly", retryAfterSec: 3600 - (t % 3600) };
		this.bump(hKey, 1, (hour + 2) * 3600);
		const token = b64(randomBytes(12));
		this.sql.exec("INSERT INTO leases (name, token, until) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET token = excluded.token, until = excluded.until", name, token, t + ttlSec);
		return { ok: true, token };
	}

	async releaseLease(name: string, token: string): Promise<void> {
		this.sql.exec("DELETE FROM leases WHERE name = ? AND token = ?", name, token);
	}

	/**
	 * Refreshes the upstream Supabase token for a connection, single-flight: two concurrent callers
	 * share one refresh, because Supabase revokes the whole token family when a rotated-out refresh
	 * token is reused. The rotated refresh token is saved before returning.
	 *
	 * `used` (lane E, brief 5 caller rule 2) is the access token that NoMail just refused. If the stored
	 * token is already a different, fresh one, another request refreshed after that 401 and finished
	 * before this call: its token is returned and nothing is rotated again.
	 *
	 * Calls share a running refresh only when it is at least as strong (fix round 3): a forced call
	 * never takes a non-forced one's answer, which may be the very token NoMail just refused. It waits
	 * for that one, then runs its own; the `used` check still stops a second rotation.
	 *
	 * `{ dead: true }` only when there is no live session, or Supabase says the session is gone
	 * (refreshRefusal "dead"). A missing or wrong client id or secret (logged `setup_fault`), an
	 * outage or an answer that can't be read throws and keeps the stored session (section 30.4).
	 */
	async refreshUpstream(connectionId: string, useKey: Uint8Array, force: boolean, used?: string): Promise<{ accessToken: string; expiresAt: number } | { dead: true }> {
		const running = this.refreshing.get(connectionId);
		if (running) {
			if (running.force || !force) return running.p;
			await running.p.catch(() => undefined);
			return this.refreshUpstream(connectionId, useKey, force, used);
		}
		const p: Promise<{ accessToken: string; expiresAt: number } | { dead: true }> = this.doRefresh(connectionId, useKey, force, used).finally(() => {
			if (this.refreshing.get(connectionId)?.p === p) this.refreshing.delete(connectionId);
		});
		this.refreshing.set(connectionId, { force, p });
		return p;
	}

	private async doRefresh(connectionId: string, useKey: Uint8Array, force: boolean, used?: string): Promise<{ accessToken: string; expiresAt: number } | { dead: true }> {
		const r = this.row(connectionId);
		if (!r || !r.upstream || r.upstream_state !== "ok") return { dead: true };
		const dek = await this.dekForUse(r, useKey);
		const u = await openJson<UpstreamTokens>(dek, r.upstream, this.aad(r, "upstream"));
		const fresh = u.expiresAt - now() > LIMITS.upstreamRefreshMarginSec;
		if (fresh && (!force || (used !== undefined && u.accessToken !== used))) return { accessToken: u.accessToken, expiresAt: u.expiresAt };
		const cfg = config(this.env);
		const secret = this.env.SUPABASE_OAUTH_CLIENT_SECRET;
		if (!cfg.supabaseClientId || !secret) {
			// A setup fault, not a dead session: reconnecting can't help, and the session stays good for
			// when the owner sets the client again (section 30.4).
			log({ t: "auth", ev: "setup_fault", reason: "supabase_client_missing" });
			throw new Error("upstream refresh not set up");
		}
		let res: Response;
		try {
			res = await egress({ env: this.env }, `${cfg.supabaseUrl}/auth/v1/oauth/token`, {
				method: "POST",
				headers: {
					authorization: `Basic ${b64(utf8(`${encodeURIComponent(cfg.supabaseClientId)}:${encodeURIComponent(secret)}`))}`,
					"content-type": "application/x-www-form-urlencoded",
					accept: "application/json",
				},
				body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: u.refreshToken }).toString(),
				timeoutMs: LIMITS.supabaseTimeoutMs,
			});
		} catch {
			throw new Error("upstream refresh failed");
		}
		if (!res.ok) {
			// Only Supabase saying the session itself is gone ends it; a wrong client id or secret, an
			// outage or an unreadable answer keeps the stored session (section 30.4).
			let body: unknown = null;
			try {
				body = await readCappedJson<unknown>(res, 64 * 1024);
			} catch {
				await res.body?.cancel().catch(() => undefined);
			}
			const refusal = refreshRefusal(res.status, body, res.headers.get("x-sb-error-code"));
			if (refusal.kind === "dead") {
				this.sql.exec("UPDATE conn SET upstream_state = 'dead', upstream = NULL, mail_state = 'reconnect_needed' WHERE id = ?", r.id);
				log({ t: "auth", ev: "refresh_failed", reason: `upstream_dead:${refusal.code}`, status: res.status });
				return { dead: true };
			}
			if (refusal.kind === "client") log({ t: "auth", ev: "setup_fault", reason: "supabase_client", status: res.status });
			else log({ t: "auth", ev: "refresh_failed", reason: `upstream_kept:${refusal.code}`, status: res.status });
			throw new Error("upstream refresh failed");
		}
		const j = await readCappedJson<{ access_token?: string; refresh_token?: string; expires_in?: number }>(res, 64 * 1024);
		if (typeof j.access_token !== "string" || typeof j.refresh_token !== "string") throw new Error("upstream refresh answer");
		const next: UpstreamTokens = {
			accessToken: j.access_token,
			refreshToken: j.refresh_token,
			expiresAt: now() + (typeof j.expires_in === "number" ? Math.min(j.expires_in, 86400) : 3600),
		};
		this.sql.exec("UPDATE conn SET upstream = ?, upstream_state = 'ok', mail_state = 'ok' WHERE id = ?", await sealJson(dek, next, this.aad(r, "upstream")), r.id);
		return { accessToken: next.accessToken, expiresAt: next.expiresAt };
	}

	async upstreamState(connectionId: string): Promise<"ok" | "dead" | "none" | "missing"> {
		const r = this.row(connectionId);
		return r ? r.upstream_state : "missing";
	}

	async setMailState(connectionId: string, state: MailState): Promise<void> {
		this.sql.exec("UPDATE conn SET mail_state = ? WHERE id = ?", state, connectionId);
		if (state === "reconnect_needed") this.sql.exec("DELETE FROM kv WHERE conn = ? AND k = 'mail:list'", connectionId);
	}

	/**
	 * The credential is dead (8.5): it is never sent on an MCP call again (open() refuses a row that
	 * is being revoked), but its revocation is queued, not skipped (fix round 4). NoDrive answers 401
	 * both for a removed app password and for every app password of a disabled account, and
	 * re-enabling the account brings those back; so the row keeps the credential, encrypted, and the
	 * alarm tries the DELETE with backoff, then after REVOKE_GIVE_UP_SEC moves it to the unrevoked
	 * list. The connection's caches are dropped now. Dev rows share the QA password: wiped as before.
	 */
	async markNeedsReconnect(connectionId: string, reason: string): Promise<void> {
		const r = this.row(connectionId);
		if (!r) return;
		if (r.kind === "dev") {
			await this.revokeAndWipe(connectionId, `dead:${reason}`, { skipRevoke: true });
			return;
		}
		if (r.status === "revoking") return;
		const t = now();
		// The first try a day from now, then daily (DEAD_RETRY_TRIES): the credential just got 401.
		this.sql.exec(
			"UPDATE conn SET status = 'revoking', revoke_tries = ?, revoke_reason = ?, revoke_since = COALESCE(revoke_since, ?), last_used_at = ? WHERE id = ?",
			DEAD_RETRY_TRIES,
			`dead:${reason}`.slice(0, 40),
			t,
			t,
			connectionId,
		);
		this.sql.exec("DELETE FROM kv WHERE conn = ?", connectionId);
		this.scheduleAlarm();
	}

	/**
	 * Revokes the connection's app password with its own credential and wipes the record.
	 * Unwraps with the revoke-wrap only; takes no caller data and never returns plaintext.
	 * - NoDrive can't be reached or refuses (a 401 included, which a disabled account gives too; fix
	 *   round 4): the row waits (status "revoking") and the alarm tries again with backoff
	 *   (revokeBackoffSec). After REVOKE_GIVE_UP_SEC of refusals the secret material is wiped and the
	 *   connection goes to the "unrevoked" list (reason "gave_up"), so the owner removes it by hand.
	 * - NX_REVOKE_SECRET missing: a setup fault; the row waits the same way until it is set again,
	 *   however long that takes.
	 * - The revoke-wrap can't be opened (NX_REVOKE_SECRET rotated): it can never succeed. The secret
	 *   material is wiped and the connection goes to the "unrevoked" list (listUnrevoked), which
	 *   /connections shows so the owner can remove the access in NoDrive by hand.
	 */
	async revokeAndWipe(connectionId: string, reason: string, opts: { skipRevoke?: boolean } = {}): Promise<{ revoked: boolean }> {
		const r = this.row(connectionId);
		if (!r) return { revoked: false };
		let revoked = false;
		// Dev connections share one QA app password from the env file: never revoke it.
		const skip = opts.skipRevoke === true || r.kind === "dev";
		if (!skip) {
			let outcome: "done" | "gone" | "retry" | "impossible" = "retry";
			let cred: CredRecord | null = null;
			// NoDrive answered 401: a failed login, which its brute-force protection counts per address.
			let unauthorized = false;
			try {
				const dek = await this.dekForRevoke(r);
				cred = await openJson<CredRecord>(dek, r.cred, this.aad(r, "cred"));
			} catch (e) {
				if (e instanceof RevokeSecretMissing) {
					log({ t: "auth", ev: "setup_fault", reason: "revoke_secret" });
					outcome = "retry";
				} else {
					outcome = "impossible";
				}
			}
			if (cred) {
				try {
					const cfg = config(this.env);
					const res = await egress({ env: this.env, uid: r.uid }, `${cfg.driveOrigin}/ocs/v2.php/core/apppassword?format=json`, {
						method: "DELETE",
						headers: {
							authorization: `Basic ${b64(utf8(`${cred.loginName}:${cred.appPassword}`))}`,
							"ocs-apirequest": "true",
							accept: "application/json",
						},
					});
					if (res.ok) outcome = "done";
					else if (await revokeAnswerGone(res)) outcome = "gone";
					else outcome = "retry";
					unauthorized = res.status === 401;
					await res.body?.cancel().catch(() => undefined);
				} catch {
					outcome = "retry";
				}
			}
			const t = now();
			const since = r.revoke_since === null || r.revoke_since === undefined ? t : Number(r.revoke_since);
			// Only NoDrive's refusals count towards giving up, not a missing NX_REVOKE_SECRET (setup fault).
			if (outcome === "retry" && cred !== null && t - since >= REVOKE_GIVE_UP_SEC) {
				// Refused for 30 days (a disabled account answers 401 to every try, fix round 4): the
				// owner is told instead, through the unrevoked list, and the credential is wiped below.
				outcome = "impossible";
				reason = "gave_up";
				log({ t: "auth", ev: "revoke_stuck", reason: "gave_up" });
			}
			if (outcome === "retry") {
				// A 401 is retried once a day only (DEAD_RETRY_TRIES): each try is a failed login that
				// NoDrive's brute-force protection counts against this Worker's address (8.5).
				const tries = Math.max(Number(r.revoke_tries) + 1, unauthorized ? DEAD_RETRY_TRIES : 0);
				this.sql.exec(
					"UPDATE conn SET status = 'revoking', revoke_tries = ?, revoke_reason = COALESCE(revoke_reason, ?), revoke_since = COALESCE(revoke_since, ?), last_used_at = ? WHERE id = ?",
					tries,
					reason.slice(0, 40),
					t,
					t,
					r.id,
				);
				// After about a day of failures, and then once a week, say so as a setup fault.
				if (tries === 24 || (tries > 24 && (tries - 24) % 7 === 0)) log({ t: "auth", ev: "revoke_stuck", reason: `tries_${tries}` });
				this.scheduleAlarm();
				return { revoked: false };
			}
			if (outcome === "impossible") {
				this.sql.exec(
					"INSERT INTO unrevoked (id, kind, client_label, created_at, ended_at, reason) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
					r.id,
					r.kind,
					r.client_label,
					r.created_at,
					t,
					reason.slice(0, 40),
				);
				if (reason !== "gave_up") log({ t: "auth", ev: "revoke_impossible" });
			}
			revoked = outcome === "done";
		}
		this.sql.exec("DELETE FROM conn WHERE id = ?", r.id);
		this.sql.exec("DELETE FROM kv WHERE conn = ?", r.id);
		this.sql.exec("INSERT INTO gone (id, reason, at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING", r.id, reason.slice(0, 40), now());
		this.scheduleAlarm();
		return { revoked };
	}

	async listConnections(): Promise<ConnectionSummary[]> {
		const rows = this.sql.exec("SELECT * FROM conn ORDER BY created_at DESC").toArray() as unknown as ConnRow[];
		return rows.map((r) => ({
			connectionId: r.id,
			kind: r.kind,
			clientId: r.client_id,
			clientLabel: r.client_label,
			scopes: r.scopes.split(" ").filter(Boolean),
			apps: r.apps.split(" ").filter(Boolean) as AppId[],
			createdAt: r.created_at,
			lastUsedAt: r.last_used_at,
			expiresAt: Math.min(r.expires_at, r.last_used_at + r.idle_sec),
			status: r.status,
		}));
	}

	/** Ends every connection of one OAuth client (the same client connecting again, 6.5). */
	async revokeForClient(clientId: string, reason: string): Promise<number> {
		const ids = this.sql.exec<{ id: string }>("SELECT id FROM conn WHERE client_id = ? AND status != 'revoking'", clientId).toArray();
		for (const { id } of ids) await this.revokeAndWipe(String(id), reason);
		return ids.length;
	}

	/** The 10-minute duplicate guard (10.7), encrypted with the connection's DEK. Values are JSON text. */
	async dedupe(connectionId: string, useKey: Uint8Array, key: string, op: "get" | "put", value?: string, ttlSec: number = LIMITS.dedupeSec): Promise<string | null> {
		return (await this.kvOp(connectionId, useKey, `dedupe:${await sha256Hex(key)}`, op, value, ttlSec)) as string | null;
	}

	/** The per-connection mail tool-list cache (13.2). "fail" counts a failure and caches it briefly. */
	async mailCache(connectionId: string, useKey: Uint8Array, op: "get" | "put" | "fail", value?: string, ttlSec: number = LIMITS.mailCacheSec): Promise<MailCacheEntry | null> {
		const read = async () => {
			const raw = (await this.kvOp(connectionId, useKey, "mail:list", "get")) as string | null;
			return raw ? (JSON.parse(raw) as MailCacheEntry) : null;
		};
		if (op === "get") return read();
		const prev = await read();
		const entry: MailCacheEntry =
			op === "put"
				? { value: value ?? null, failures: 0, expiresAt: now() + ttlSec }
				: { value: prev?.value ?? null, failures: (prev?.failures ?? 0) + 1, expiresAt: now() + LIMITS.mailFailCacheSec };
		await this.kvOp(connectionId, useKey, "mail:list", "put", JSON.stringify(entry), op === "put" ? ttlSec : LIMITS.mailFailCacheSec);
		return entry;
	}

	private async kvOp(connectionId: string, useKey: Uint8Array, k: string, op: "get" | "put", value?: string, ttlSec = 600): Promise<string | null> {
		const r = this.row(connectionId);
		if (!r || r.status !== "active") return null;
		const dek = await this.dekForUse(r, useKey);
		if (op === "get") {
			const rows = this.sql.exec<{ v: string; exp: number }>("SELECT v, exp FROM kv WHERE conn = ? AND k = ?", r.id, k).toArray();
			const hit = rows[0];
			if (!hit || Number(hit.exp) < now()) return null;
			return fromUtf8(await open(dek, String(hit.v), this.aad(r, `kv:${k}`)));
		}
		const sealed = await seal(dek, utf8(value ?? "null"), this.aad(r, `kv:${k}`));
		this.sql.exec(
			"INSERT INTO kv (conn, k, v, exp) VALUES (?, ?, ?, ?) ON CONFLICT(conn, k) DO UPDATE SET v = excluded.v, exp = excluded.exp",
			r.id,
			k,
			sealed,
			now() + ttlSec,
		);
		return value ?? null;
	}

	/** Connections that ended without their app password being revoked (see revokeAndWipe). No secrets. */
	async listUnrevoked(): Promise<UnrevokedSummary[]> {
		const rows = this.sql
			.exec<{ id: string; kind: ConnKind; client_label: string; created_at: number; ended_at: number; reason: string }>(
				"SELECT id, kind, client_label, created_at, ended_at, reason FROM unrevoked ORDER BY ended_at DESC",
			)
			.toArray();
		return rows.map((r) => ({
			connectionId: String(r.id),
			kind: r.kind,
			clientLabel: String(r.client_label),
			createdAt: Number(r.created_at),
			endedAt: Number(r.ended_at),
			reason: String(r.reason),
		}));
	}

	/** The owner removed that access in NoDrive by hand: forget the entry. */
	async clearUnrevoked(connectionId: string): Promise<boolean> {
		const before = this.sql.exec("SELECT id FROM unrevoked WHERE id = ?", connectionId).toArray().length;
		this.sql.exec("DELETE FROM unrevoked WHERE id = ?", connectionId);
		return before > 0;
	}

	/** Ends idle and expired connections, retries due revocations, checks grants and cleans up. */
	async alarm(): Promise<void> {
		const t = now();
		const rows = this.sql.exec("SELECT * FROM conn").toArray() as unknown as ConnRow[];
		for (const r of rows) {
			if (r.status === "revoking") {
				if (t >= Number(r.last_used_at) + revokeBackoffSec(Number(r.revoke_tries))) await this.revokeAndWipe(r.id, r.revoke_reason ?? "retry");
			} else if (t > r.expires_at) await this.revokeAndWipe(r.id, "max_age");
			else if (t > r.last_used_at + r.idle_sec) await this.revokeAndWipe(r.id, "idle");
		}
		const gc = this.metaGet("grant_check_at");
		if (gc !== null && t >= gc) await this.reconcileGrants(t);
		this.sql.exec("DELETE FROM counters WHERE exp < ?", t);
		this.sql.exec("DELETE FROM kv WHERE exp < ?", t);
		this.sql.exec("DELETE FROM gone WHERE at < ?", t - 90 * 86400);
		this.sql.exec("DELETE FROM leases WHERE until < ?", t);
		this.scheduleAlarm();
	}
}

/** The person's vault stub. The uid comes from props or a desktop-key record, never from tool input. */
export function vaultFor(env: NxEnv, uid: string): DurableObjectStub<Vault> {
	return env.VAULT.get(env.VAULT.idFromName(`vault:v1:${uid}`));
}
