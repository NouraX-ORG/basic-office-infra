/**
 * The ConnectFlow Durable Object (DESIGN 8.2 and 9.4): one per connect cookie, for at most 20
 * minutes (Login Flow v2's own limit). It holds the approved request and the Login Flow v2 poll
 * token, encrypted with a key derived from the browser's cookie, and polls single-flight: Login
 * Flow v2 hands the app password out only once, so two tabs can't lose it.
 */
import { DurableObject } from "cloudflare:workers";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { dropNewAppPassword } from "../auth/app-password";
import { config, type NxEnv } from "../env";
import { egress, readCappedJson } from "../core/egress";
import { subkey } from "../core/keys";
import { LIMITS } from "../core/limits";
import type { AppId } from "../mcp/catalog";
import { hkdf, openJson, sealJson } from "./crypto";
import type { UpstreamTokens } from "./schema";

export type ConnectPurpose = "oauth" | "desktop" | "session";

export interface ConnectRecord {
	purpose: ConnectPurpose;
	createdAt: number;
	pollToken: string;
	pollEndpoint: string;
	loginUrl: string;
	/** The token in the login URL (/login/v2/flow/<token>). */
	loginToken: string;
	clientLabel: string;
	clientId?: string;
	authRequest?: AuthRequest;
	scopes: string[];
	apps: AppId[];
	/** Set when the upstream "Log in with Nourax" step ran. */
	sub?: string;
	upstream?: UpstreamTokens;
	desktop?: { label: string; days: number; ipLock?: string };
	/** The client kind label for logs (claude, chatgpt, ...). */
	cli?: string;
}

export interface FlowResult {
	server: string;
	loginName: string;
	appPassword: string;
}

export type PollOutcome =
	| { state: "waiting"; record: ConnectRecord }
	| { state: "expired" }
	| { state: "used" }
	| { state: "done"; record: ConnectRecord; result: FlowResult };

export class ConnectFlow extends DurableObject<NxEnv> {
	private inflight: Promise<PollOutcome> | null = null;

	private async key(cookieKey: Uint8Array): Promise<Uint8Array> {
		return hkdf(cookieKey, await subkey(this.env, "vault-pepper"), "nx/connect/v1");
	}

	async start(cookieKey: Uint8Array, record: ConnectRecord): Promise<void> {
		const sealed = await sealJson(await this.key(cookieKey), record, "nx-connect-v1|record");
		await this.ctx.storage.put("record", sealed);
		await this.ctx.storage.delete("used");
		await this.ctx.storage.setAlarm(Date.now() + LIMITS.connectFlowSec * 1000);
	}

	private async read(cookieKey: Uint8Array): Promise<ConnectRecord | null> {
		const sealed = await this.ctx.storage.get<string>("record");
		if (!sealed) return null;
		try {
			const r = await openJson<ConnectRecord>(await this.key(cookieKey), sealed, "nx-connect-v1|record");
			if (Date.now() - r.createdAt > LIMITS.connectFlowSec * 1000) return null;
			return r;
		} catch {
			return null;
		}
	}

	/** The pending record, without polling (for rendering). */
	async peek(cookieKey: Uint8Array): Promise<ConnectRecord | null> {
		return this.read(cookieKey);
	}

	async poll(cookieKey: Uint8Array): Promise<PollOutcome> {
		if (await this.ctx.storage.get<boolean>("used")) return { state: "used" };
		const record = await this.read(cookieKey);
		if (!record) return { state: "expired" };
		// A second tab polling at the same time just keeps waiting; only one caller gets the result.
		if (this.inflight) return { state: "waiting", record };
		this.inflight = this.pollOnce(record).finally(() => {
			this.inflight = null;
		});
		return this.inflight;
	}

	private async pollOnce(record: ConnectRecord): Promise<PollOutcome> {
		const cfg = config(this.env);
		const res = await egress({ env: this.env }, record.pollEndpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body: new URLSearchParams({ token: record.pollToken }).toString(),
			timeoutMs: 10_000,
		});
		if (res.status === 404) {
			await res.body?.cancel();
			return { state: "waiting", record };
		}
		if (!res.ok) {
			await res.body?.cancel();
			return { state: "waiting", record };
		}
		const j = await readCappedJson<{ server?: unknown; loginName?: unknown; appPassword?: unknown }>(res, 16 * 1024);
		if (typeof j.loginName !== "string" || typeof j.appPassword !== "string" || typeof j.server !== "string") {
			return { state: "waiting", record };
		}
		let serverOrigin: string | null;
		try {
			serverOrigin = new URL(j.server).origin;
		} catch {
			serverOrigin = null;
		}
		if (serverOrigin !== cfg.driveOrigin) {
			// The answer names another server (or none we can read), so it isn't used. The poll endpoint
			// itself is on DRIVE_ORIGIN (checked when the flow started), so the app password is ours:
			// revoke it there before the flow is wiped, so it is never orphaned (fix round 3).
			await this.ctx.storage.put("used", true);
			await dropNewAppPassword(this.env, j.loginName, j.appPassword, "flow_server");
			await this.wipe();
			return { state: "expired" };
		}
		await this.ctx.storage.put("used", true);
		await this.ctx.storage.delete("record");
		return { state: "done", record, result: { server: j.server, loginName: j.loginName, appPassword: j.appPassword } };
	}

	async abandon(): Promise<void> {
		await this.wipe();
	}

	private async wipe(): Promise<void> {
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
	}

	async alarm(): Promise<void> {
		await this.wipe();
	}
}
