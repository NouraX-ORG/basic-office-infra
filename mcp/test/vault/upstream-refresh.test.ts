/**
 * What a refused upstream refresh does to the stored "Log in with Nourax" session (third system
 * review, section 30.4). Supabase answers nearly every failure with HTTP 400, so the vault reads the
 * answer: only "the session is gone" ends mail; a wrong client id or secret, an outage or an answer
 * it can't read keeps the session (and its sealed refresh token) as it was.
 */
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "../../src/core/bytes";
import type { NxEnv } from "../../src/env";
import type { NewConnection } from "../../src/vault/schema";
import { refreshRefusal, type Vault, vaultFor } from "../../src/vault/vault";
import { FakeNc, SUPABASE } from "../fake-nc/index";
import { env } from "../helpers/index";

afterEach(() => vi.restoreAllMocks());

const SET_UP = { ...env, SUPABASE_OAUTH_CLIENT_ID: "cid", SUPABASE_OAUTH_CLIENT_SECRET: "csecret" } as NxEnv;
const cid = () => [...randomBytes(16)].map((b) => b.toString(16).padStart(2, "0")).join("");

function conn(u: string): NewConnection {
	return {
		connectionId: cid(),
		uid: u,
		kind: "oauth",
		clientId: "client-a",
		clientLabel: "Claude",
		scopes: ["workspace.read", "mail.read"],
		apps: ["files", "mail"],
		cred: { loginName: u, appPassword: "APP-PASSWORD-0123456789-abcdefghij" },
		displayName: "Test Person",
		// Close to its end, so a refresh goes to Supabase.
		upstream: { accessToken: "old-access", refreshToken: "refresh-1", expiresAt: Math.floor(Date.now() / 1000) + 30 },
		idleSec: 14 * 86400,
		maxAgeSec: 60 * 86400,
	};
}

type Row = { upstream: string | null; upstream_state: string; mail_state: string };

/** A connection whose next refresh Supabase answers with `answer`; then one more refresh that works. */
async function refuse(answer: () => Response, testEnv: NxEnv = SET_UP) {
	const u = crypto.randomUUID();
	const v = vaultFor(env, u);
	const c = conn(u);
	const key = randomBytes(32);
	await v.createConnection(c, key);
	const sent: (string | null)[] = [];
	let ok = false;
	const fake = new FakeNc();
	fake.on(
		"POST",
		/^\/auth\/v1\/oauth\/token$/,
		(req) => {
			sent.push(new URLSearchParams(req.body).get("refresh_token"));
			return ok ? Response.json({ access_token: "new-access", refresh_token: "refresh-2", expires_in: 3600 }) : answer();
		},
		new URL(SUPABASE).host,
	);
	fake.install();
	const lines: Record<string, unknown>[] = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		try {
			lines.push(JSON.parse(a.map(String).join(" ")) as Record<string, unknown>);
		} catch {
			// not one of our JSON lines
		}
	});
	return runInDurableObject(v, async (instance: Vault) => {
		(instance as unknown as { env: unknown }).env = testEnv;
		const sql = (instance as unknown as { sql: SqlStorage }).sql;
		const row = () => sql.exec<Row>("SELECT upstream, upstream_state, mail_state FROM conn WHERE id = ?", c.connectionId).toArray()[0] as Row;
		const before = row();
		let outcome: unknown;
		let threw = false;
		try {
			outcome = await instance.refreshUpstream(c.connectionId, key, true);
		} catch {
			threw = true;
		}
		const after = row();
		const auth = lines.filter((l) => l.t === "auth");
		// Then Supabase works again (the owner fixed the secret, the outage ended): which token is sent?
		ok = true;
		const next = after.upstream_state === "ok" ? await instance.refreshUpstream(c.connectionId, key, true).catch(() => null) : null;
		return { before, after, threw, outcome, auth, sent, next, state: await instance.upstreamState(c.connectionId) };
	});
}

describe("refreshRefusal reads Supabase's answer, not only its status", () => {
	it.each([
		[400, { error: "invalid_grant", error_description: "x" }, null, "dead"],
		[400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" }, "refresh_token_not_found", "dead"],
		[400, { code: 400, error_code: "refresh_token_already_used", msg: "x" }, null, "dead"],
		[400, { code: "session_expired", message: "Invalid Refresh Token: Session Expired" }, null, "dead"],
		[400, { code: 400, error_code: "session_not_found", msg: "x" }, null, "dead"],
		[400, { code: 400, error_code: "user_banned", msg: "x" }, null, "dead"],
		[400, { error: "invalid_client", error_description: "Client does not match the session's OAuth client" }, null, "client"],
		[400, { code: 400, error_code: "invalid_credentials", msg: "invalid client credentials" }, "invalid_credentials", "client"],
		[401, { error: "unauthorized_client" }, null, "client"],
		[400, { error: "server_error" }, null, "transient"],
		[400, { error: "temporarily_unavailable" }, null, "transient"],
		[400, { error: "invalid_request", error_description: "refresh_token is required" }, null, "transient"],
		[400, null, null, "transient"],
		[401, {}, null, "transient"],
		[409, { code: 409, error_code: "conflict", msg: "Too many concurrent token refresh requests" }, null, "transient"],
		[500, { error: "invalid_grant" }, null, "transient"],
		[503, null, null, "transient"],
	])("%i %j (header %s) is %s", (status, body, header, kind) => {
		expect(refreshRefusal(status, body, header).kind).toBe(kind);
	});
	it("a code only in the x-sb-error-code header still counts", () => {
		expect(refreshRefusal(400, null, "session_expired")).toEqual({ kind: "dead", code: "session_expired" });
		expect(refreshRefusal(400, null, "invalid_credentials")).toEqual({ kind: "client", code: "invalid_credentials" });
	});
});

describe("a refused refresh keeps the session unless Supabase says it is gone", () => {
	it("400 invalid_client (a wrong or rotated client secret): a setup fault; session, sealed refresh token and mail state kept", async () => {
		const r = await refuse(() => Response.json({ error: "invalid_client", error_description: "Client authentication failed" }, { status: 400 }));
		expect(r.threw).toBe(true);
		expect(r.after).toEqual(r.before);
		expect(r.after.upstream_state).toBe("ok");
		expect(r.auth).toContainEqual(expect.objectContaining({ ev: "setup_fault", reason: "supabase_client", status: 400 }));
		// Once the secret is fixed, the same refresh token is used: nobody has to reconnect.
		expect(r.sent).toEqual(["refresh-1", "refresh-1"]);
		expect(r.next).toMatchObject({ accessToken: "new-access" });
	});
	it("400 invalid_credentials (what Supabase's client check really answers for a wrong secret): the same", async () => {
		const r = await refuse(
			() => Response.json({ code: 400, error_code: "invalid_credentials", msg: "invalid client credentials" }, { status: 400, headers: { "x-sb-error-code": "invalid_credentials" } }),
		);
		expect(r.threw).toBe(true);
		expect(r.after).toEqual(r.before);
		expect(r.auth).toContainEqual(expect.objectContaining({ ev: "setup_fault", reason: "supabase_client" }));
		expect(r.sent).toEqual(["refresh-1", "refresh-1"]);
	});
	it("400 server_error: transient; nothing changes and it is logged as kept", async () => {
		const r = await refuse(() => Response.json({ error: "server_error", error_description: "boom" }, { status: 400 }));
		expect(r.threw).toBe(true);
		expect(r.after).toEqual(r.before);
		expect(r.state).toBe("ok");
		expect(r.auth).toContainEqual(expect.objectContaining({ ev: "refresh_failed", reason: "upstream_kept:server_error" }));
		expect(r.sent).toEqual(["refresh-1", "refresh-1"]);
	});
	it.each([
		["a 400 that isn't JSON", () => new Response("<html>bad gateway</html>", { status: 400 })],
		["an empty 401", () => new Response("", { status: 401 })],
		["a 503", () => new Response("down", { status: 503 })],
		["a 429", () => Response.json({ error: "slow_down" }, { status: 429 })],
	])("%s: transient, kept", async (_name, answer) => {
		const r = await refuse(answer);
		expect(r.threw).toBe(true);
		expect(r.after).toEqual(r.before);
		expect(r.sent).toEqual(["refresh-1", "refresh-1"]);
	});
	it.each([
		["400 invalid_grant", () => Response.json({ error: "invalid_grant" }, { status: 400 }), "invalid_grant"],
		["400 refresh_token_not_found (default envelope)", () => Response.json({ code: 400, error_code: "refresh_token_not_found", msg: "x" }, { status: 400 }), "refresh_token_not_found"],
		["400 session_expired (2024-01-01 envelope)", () => Response.json({ code: "session_expired", message: "x" }, { status: 400 }), "session_expired"],
	])("%s: the session is gone; mail needs a reconnect", async (_name, answer, code) => {
		const r = await refuse(answer);
		expect(r.threw).toBe(false);
		expect(r.outcome).toEqual({ dead: true });
		expect(r.after).toEqual({ upstream: null, upstream_state: "dead", mail_state: "reconnect_needed" });
		expect(r.auth).toContainEqual(expect.objectContaining({ ev: "refresh_failed", reason: `upstream_dead:${code}`, status: 400 }));
		expect(r.sent).toEqual(["refresh-1"]);
	});
	it("no client id or secret set: a setup fault, logged; Supabase isn't asked and the session is kept", async () => {
		const r = await refuse(() => Response.json({ error: "invalid_grant" }, { status: 400 }), { ...env, SUPABASE_OAUTH_CLIENT_ID: "", SUPABASE_OAUTH_CLIENT_SECRET: "" } as NxEnv);
		expect(r.threw).toBe(true);
		expect(r.after).toEqual(r.before);
		expect(r.auth).toContainEqual(expect.objectContaining({ ev: "setup_fault", reason: "supabase_client_missing" }));
		expect(r.sent).toEqual([]);
	});
});
