/**
 * Fix round 4: a 401 is not proof that an app password is gone. A disabled NoDrive account answers
 * 401 for every app password (Session::completeLogin throws DisabledUserException), and
 * User::setEnabled deletes no tokens, so re-enabling the account brings them all back. So:
 * - a dead credential (8.5) keeps its row, credential encrypted, with the revocation queued; it is
 *   never used for an MCP call again;
 * - a 401 to the revocation is retried with backoff, and once the account works again the alarm
 *   really revokes the app password;
 * - after 30 days of refusals the row goes to the unrevoked list (reason "gave_up");
 * - the connect step's dropNewAppPassword doesn't count a 401 as revoked either.
 */
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dropNewAppPassword } from "../../src/auth/app-password";
import { randomBytes } from "../../src/core/bytes";
import type { NewConnection } from "../../src/vault/schema";
import { REVOKE_GIVE_UP_SEC, type Vault, vaultFor } from "../../src/vault/vault";
import { FakeNc } from "../fake-nc/index";
import { env } from "../helpers/index";

afterEach(() => vi.restoreAllMocks());

const UID = "22222222-3333-4444-8555-666666666666";
let n = 0;
const uid = () => `${UID.slice(0, -4)}${String(++n).padStart(4, "0")}`;
const cid = () => [...randomBytes(16)].map((b) => b.toString(16).padStart(2, "0")).join("");
const PASS = "APP-PASSWORD-disabled-0123456789-abcdef";

function conn(u: string, over: Partial<NewConnection> = {}): NewConnection {
	return {
		connectionId: cid(),
		uid: u,
		kind: "oauth",
		clientId: "client-a",
		clientLabel: "Claude",
		scopes: ["workspace.read"],
		apps: ["files"],
		cred: { loginName: u, appPassword: PASS },
		displayName: null,
		upstream: null,
		idleSec: 14 * 86400,
		maxAgeSec: 60 * 86400,
		...over,
	};
}

/** A fake NoDrive whose account can be disabled: every request then answers 401, as NC 35 does. */
function nodrive(u: string) {
	const fake = new FakeNc();
	const user = fake.addUser({ uid: u, password: PASS });
	let disabled = false;
	const deletes: number[] = [];
	fake.on("DELETE", /^\/ocs\/v2\.php\/core\/apppassword$/, (req) => {
		if (disabled || !req.auth) {
			deletes.push(401);
			return new Response(JSON.stringify({ ocs: { meta: { status: "failure", statuscode: 997, message: "Unauthorised" }, data: [] } }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		}
		fake.revokePassword(req.headers);
		deletes.push(200);
		return Response.json({ ocs: { meta: { status: "ok", statuscode: 200 }, data: [] } });
	});
	fake.install();
	return {
		fake,
		user,
		deletes,
		setDisabled(d: boolean) {
			disabled = d;
		},
	};
}

/** Moves the row's clock back, so the alarm's next retry is due now. */
async function dueNow(v: DurableObjectStub<Vault>, extraSec = 0): Promise<void> {
	await runInDurableObject(v, async (_i: Vault, state) => {
		state.storage.sql.exec("UPDATE conn SET last_used_at = last_used_at - ?, revoke_since = revoke_since - ?", 86_401, extraSec);
	});
}

describe("a disabled account (401 for every app password)", () => {
	it("a dead credential keeps its row and queued revocation; it is never used again; re-enabled, the alarm revokes it", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const nd = nodrive(u);
		const c = conn(u);
		const key = randomBytes(32);
		await v.createConnection(c, key);
		nd.setDisabled(true);
		await v.markNeedsReconnect(c.connectionId, "dead_credential");
		// Nothing sent yet; the row is kept, ending, and refused for MCP calls.
		expect(nd.deletes).toEqual([]);
		expect((await v.listConnections()).map((r) => r.status)).toEqual(["revoking"]);
		expect(await v.open(c.connectionId, key)).toEqual({ ok: false, reason: "revoked" });
		// While the account is disabled, the alarm's DELETE gets 401: the row stays queued.
		await dueNow(v);
		await runDurableObjectAlarm(v);
		expect(nd.deletes).toEqual([401]);
		expect((await v.listConnections()).map((r) => r.status)).toEqual(["revoking"]);
		expect(await v.listUnrevoked()).toEqual([]);
		// The owner re-enables the account: the app password works again, and the next try revokes it.
		nd.setDisabled(false);
		expect(nd.user.passwords.has(PASS)).toBe(true);
		await dueNow(v);
		await runDurableObjectAlarm(v);
		expect(nd.deletes).toEqual([401, 200]);
		expect(nd.user.passwords.has(PASS)).toBe(false);
		expect(await v.listConnections()).toEqual([]);
		expect(await v.status(c.connectionId)).toBe("revoked");
	});

	it("an idle or ended connection whose DELETE gets 401 is kept queued, not wiped unrevoked", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const nd = nodrive(u);
		const c = conn(u);
		await v.createConnection(c, randomBytes(32));
		nd.setDisabled(true);
		expect(await v.revokeAndWipe(c.connectionId, "idle")).toEqual({ revoked: false });
		expect((await v.listConnections()).map((r) => r.status)).toEqual(["revoking"]);
		// A 401 is a failed login for NoDrive's brute-force protection: the next try is a day away,
		// not 10 minutes.
		await runInDurableObject(v, async (_i: Vault, state) => {
			state.storage.sql.exec("UPDATE conn SET last_used_at = last_used_at - 601");
		});
		await runDurableObjectAlarm(v);
		expect(nd.deletes).toEqual([401]);
		await dueNow(v);
		await runDurableObjectAlarm(v);
		expect(nd.deletes).toEqual([401, 401]);
	});

	it("after 30 days of refusals the row goes to the unrevoked list (reason gave_up) and its secrets are wiped", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		const nd = nodrive(u);
		const c = conn(u, { clientLabel: "Cursor" });
		await v.createConnection(c, randomBytes(32));
		nd.setDisabled(true);
		await v.revokeAndWipe(c.connectionId, "user");
		await dueNow(v, REVOKE_GIVE_UP_SEC);
		await runDurableObjectAlarm(v);
		expect(await v.listConnections()).toEqual([]);
		const un = await v.listUnrevoked();
		expect(un.map((x) => ({ id: x.connectionId, label: x.clientLabel, reason: x.reason }))).toEqual([{ id: c.connectionId, label: "Cursor", reason: "gave_up" }]);
		await runInDurableObject(v, async (_i: Vault, state) => {
			expect(state.storage.sql.exec("SELECT COUNT(*) AS c FROM conn").one().c).toBe(0);
		});
	});

	it("the connect step doesn't count a 401 as revoked: it tries again and logs revoke_stuck", async () => {
		const u = uid();
		const nd = nodrive(u);
		nd.setDisabled(true);
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line: unknown) => {
			logs.push(String(line));
		});
		expect(await dropNewAppPassword(env, u, PASS, "error")).toBe(false);
		expect(nd.deletes).toEqual([401, 401]);
		expect(logs.some((l) => l.includes('"ev":"revoke_stuck"') && l.includes('"reason":"error"'))).toBe(true);
		nd.setDisabled(false);
		expect(await dropNewAppPassword(env, u, PASS, "error")).toBe(true);
	});

	it("the schema gained revoke_since once, and a vault built again keeps working", async () => {
		const u = uid();
		const v = vaultFor(env, u);
		nodrive(u);
		await v.createConnection(conn(u), randomBytes(32));
		await runInDurableObject(v, async (_i: Vault, state) => {
			const cols = state.storage.sql.exec<{ name: string }>("PRAGMA table_info(conn)").toArray().map((r) => r.name);
			expect(cols.filter((x) => x === "revoke_since")).toHaveLength(1);
			expect(state.storage.sql.exec<{ v: number }>("SELECT v FROM meta WHERE k = 'schema_v'").one().v).toBe(2);
		});
	});
});
