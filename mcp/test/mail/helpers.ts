/**
 * Lane E mail test helpers: a MailContext built by hand (so the upstream token, the refresh and the
 * mail state can be steered), a cache with exactly the vault's mailCache semantics, and the mock
 * provider installed as the fetch spy.
 */
import { vi } from "vitest";
import { config, type NxEnv } from "../../src/env";
import type { MailContext } from "../../src/core/mail-contract";
import { LIMITS } from "../../src/core/limits";
import { createMockProvider } from "../../src/mail/mock-provider";
import { resetMailState } from "../../src/mail/index";
import type { MailCacheEntry } from "../../src/vault/schema";
import { env } from "../helpers/index";

export const BASE = "https://mail-tools.nomail.test/functions/v1/mcp-tools";
export const TEST_KEY = "test-tools-key-0123456789abcdef0123456789abcd";
export const RID = "0123456789abcdef0123456789abcdef";

const nowSec = () => Math.floor(Date.now() / 1000);

/** The vault's mailCache (src/vault/vault.ts) without the encryption: same TTLs and failure counting. */
export class MemCache {
	private row: { entry: MailCacheEntry; exp: number } | null = null;
	ops: string[] = [];
	private live(): MailCacheEntry | null {
		return this.row && this.row.exp >= nowSec() ? this.row.entry : null;
	}
	async get(): Promise<MailCacheEntry | null> {
		this.ops.push("get");
		return this.live();
	}
	async put(value: string, ttlSec: number): Promise<void> {
		this.ops.push("put");
		this.row = { entry: { value, failures: 0, expiresAt: nowSec() + ttlSec }, exp: nowSec() + ttlSec };
	}
	async fail(): Promise<MailCacheEntry> {
		this.ops.push("fail");
		const prev = this.live();
		const entry = { value: prev?.value ?? null, failures: (prev?.failures ?? 0) + 1, expiresAt: nowSec() + LIMITS.mailFailCacheSec };
		this.row = { entry, exp: nowSec() + LIMITS.mailFailCacheSec };
		return entry;
	}
	clear(): void {
		this.row = null;
	}
}

export interface CtxOptions {
	scenario?: string;
	token?: string | null;
	/** What a forced refresh gives: a new token, null (session dead) or "throw" (network). */
	refreshTo?: string | null | "throw";
	read?: boolean;
	write?: boolean;
	active?: boolean;
	state?: MailContext["state"];
	key?: string;
	cache?: MemCache;
	refreshDelayMs?: number;
}

export function mailEnv(scenario?: string, key = TEST_KEY): NxEnv {
	return { ...env, NOMAIL_TOOLS_URL: scenario ? `${BASE}/s/${scenario}` : BASE, NOMAIL_TOOLS_KEY: key } as NxEnv;
}

export function makeCtx(o: CtxOptions = {}) {
	const e = mailEnv(o.scenario, o.key);
	const cache = o.cache ?? new MemCache();
	let token: string | null = o.token === undefined ? "good-token-1" : o.token;
	const counts = { refresh: 0, upstream: 0, states: [] as string[], used: [] as (string | undefined)[] };
	const ctx: MailContext = {
		env: e,
		cfg: config(e),
		rid: RID,
		active: o.active ?? true,
		state: o.state ?? "on",
		scopes: { read: o.read ?? true, write: o.write ?? true },
		async upstreamToken() {
			counts.upstream++;
			return token;
		},
		async refreshUpstream(used?: string) {
			counts.refresh++;
			counts.used.push(used);
			if (o.refreshDelayMs) await new Promise((r) => setTimeout(r, o.refreshDelayMs));
			if (o.refreshTo === "throw") throw new Error("network");
			if (o.refreshTo === null) return null;
			token = o.refreshTo ?? "good-token-2";
			return token;
		},
		cache: {
			get: () => cache.get(),
			put: (v, ttl) => cache.put(v, ttl),
			fail: () => cache.fail(),
		},
		async setState(s) {
			counts.states.push(s);
		},
	};
	return { ctx, cache, counts };
}

/** A fresh MailContext object over the same cache (the next request). */
export function nextRequest(prev: ReturnType<typeof makeCtx>, o: CtxOptions = {}) {
	return makeCtx({ ...o, cache: prev.cache });
}

export function installMock() {
	resetMailState();
	const mock = createMockProvider();
	const spy = vi.spyOn(globalThis, "fetch").mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => mock.handle(new Request(input as RequestInfo, init))) as typeof fetch);
	return { mock, spy };
}

/** Our JSON log lines, parsed. */
export function logLines(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
	return spy.mock.calls
		.map((c: unknown[]) => {
			try {
				return JSON.parse(String(c[0])) as Record<string, unknown>;
			} catch {
				return null;
			}
		})
		.filter((x: Record<string, unknown> | null): x is Record<string, unknown> => x !== null);
}
