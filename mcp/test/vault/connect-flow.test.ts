import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, sha256Hex } from "../../src/core/bytes";
import type { ConnectRecord } from "../../src/vault/connect-flow";
import { DRIVE, FakeNc } from "../fake-nc/index";
import { env } from "../helpers/index";

afterEach(() => vi.restoreAllMocks());

async function newFlow(fake: FakeNc) {
	const init = await fake.fetch(`${DRIVE}/index.php/login/v2`, { method: "POST" });
	const j = (await init.json()) as { poll: { token: string; endpoint: string }; login: string };
	const cookie = randomBytes(32);
	const stub = env.CONNECT.get(env.CONNECT.idFromName(`cf:${await sha256Hex(cookie)}`));
	const loginToken = j.login.split("/").pop() as string;
	const record: ConnectRecord = {
		purpose: "oauth",
		createdAt: Date.now(),
		pollToken: j.poll.token,
		pollEndpoint: j.poll.endpoint,
		loginUrl: j.login,
		loginToken,
		clientLabel: "Claude",
		scopes: ["workspace.read"],
		apps: ["files"],
	};
	await stub.start(cookie, record);
	return { stub, cookie, loginToken };
}

describe("ConnectFlow", () => {
	it("waits, then hands out the app password exactly once", async () => {
		const fake = new FakeNc();
		fake.addUser({ uid: "11111111-2222-4333-8444-000000000001", password: "x".repeat(30) });
		fake.install();
		const { stub, cookie, loginToken } = await newFlow(fake);
		expect((await stub.poll(cookie)).state).toBe("waiting");
		fake.grantFlow(loginToken, "11111111-2222-4333-8444-000000000001");
		const done = await stub.poll(cookie);
		expect(done.state).toBe("done");
		if (done.state === "done") expect(done.result.loginName).toBe("11111111-2222-4333-8444-000000000001");
		expect((await stub.poll(cookie)).state).toBe("used");
	});
	it("can't be read with another cookie", async () => {
		const fake = new FakeNc();
		fake.install();
		const { stub } = await newFlow(fake);
		expect((await stub.poll(randomBytes(32))).state).toBe("expired");
		expect(await stub.peek(randomBytes(32))).toBeNull();
	});
	it("two tabs polling at once: only one gets the result", async () => {
		const fake = new FakeNc();
		fake.addUser({ uid: "11111111-2222-4333-8444-000000000002", password: "x".repeat(30) });
		fake.install();
		const { stub, cookie, loginToken } = await newFlow(fake);
		fake.grantFlow(loginToken, "11111111-2222-4333-8444-000000000002");
		const [a, b] = await Promise.all([stub.poll(cookie), stub.poll(cookie)]);
		expect([a.state, b.state].filter((s) => s === "done")).toHaveLength(1);
	});
	it("the alarm wipes it after 20 minutes", async () => {
		const fake = new FakeNc();
		fake.install();
		const { stub, cookie } = await newFlow(fake);
		await runDurableObjectAlarm(stub);
		expect((await stub.poll(cookie)).state).toBe("expired");
	});
});
