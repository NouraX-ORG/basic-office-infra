/** Contract test for workspace_whoami against the fake (DESIGN 17.3). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeNc } from "../../fake-nc/index";
import { devToken, fakeWithQa, framedPayload, mcpPost, QA, rpcResult } from "../../helpers/index";

let fake: FakeNc;
beforeEach(() => {
	fake = fakeWithQa();
});
afterEach(() => vi.restoreAllMocks());

async function whoami(args: unknown = {}, scopes?: string[], uid: string = QA.a) {
	const t = await devToken(uid, scopes ? { scopes } : {});
	const res = await mcpPost(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspace_whoami", arguments: args } });
	return (await rpcResult(res)).result as { content: { text: string }[]; structuredContent: Record<string, unknown>; isError?: boolean; _meta?: Record<string, { code: string; field?: string }> };
}

describe("workspace_whoami", () => {
	it("sends exactly the request it should", async () => {
		fake.requests.length = 0;
		await whoami();
		const r = fake.driveCalls().filter((c) => c.url.pathname === "/ocs/v2.php/cloud/user").pop();
		expect(r?.method).toBe("GET");
		expect(r?.url.searchParams.get("format")).toBe("json");
		expect(r?.headers.get("authorization")).toMatch(/^Basic /);
		expect(r?.auth).toBe(QA.a);
		expect(r?.headers.get("ocs-apirequest")).toBe("true");
		expect(r?.headers.get("user-agent")).toBe("Nourax-Workspace-MCP/0.1.0");
		expect(r?.headers.get("x-request-id")).toMatch(/^[0-9a-f]{32}$/);
		expect(r?.headers.get("cookie")).toBeNull();
	});
	it("returns the person, storage, connection and mail state, framed", async () => {
		const r = await whoami();
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent).toMatchObject({
			user_id: QA.a,
			display_name: "QA t1 91",
			email: "qa-t1-91@example.invalid",
			language: "en",
			time_zone: "UTC",
			mail: "not_set_up",
			connection: { kind: "dev", client: "Dev runner" },
		});
		const storage = r.structuredContent.storage as Record<string, number | null>;
		expect(storage.used_bytes).toBe(1024);
		expect(storage.free_bytes).toBe(1024 * 1024 * 1024);
		const text = r.content[0]?.text ?? "";
		expect(text.split("\n")[0]).toBe("This connection acts as QA t1 91 in Nourax Workspace.");
		expect(JSON.parse(framedPayload(text)).user_id).toBe(QA.a);
	});
	it("shows unlimited storage as nulls and uses the person's time zone", async () => {
		const u = fake.users.get(QA.b);
		if (u) {
			u.quota = { used: 5, free: -3, total: -3, relative: 0, quota: -3 };
			u.timezone = "Europe/London";
		}
		const r = await whoami({}, undefined, QA.b);
		expect(r.structuredContent.storage).toEqual({ used_bytes: 5, free_bytes: null, total_bytes: null, used_percent: null });
		expect(r.structuredContent.time_zone).toBe("Europe/London");
	});
	it("refuses unknown input with a plain message naming the field", async () => {
		const r = await whoami({ surprise: 1 });
		expect(r.isError).toBe(true);
		expect(r._meta?.["nourax/error"]?.code).toBe("invalid_input");
		expect(r.content[0]?.text).toContain("unknown input");
	});
	it("maps a NoDrive failure to a plain error with no server text", async () => {
		fake.on("GET", /^\/ocs\/v2\.php\/cloud\/user$/, () => new Response("Sabre\\DAV\\Exception at /var/www/html/lib/... upstream trace", { status: 500 }));
		const r = await whoami();
		expect(r.isError).toBe(true);
		expect(r._meta?.["nourax/error"]?.code).toBe("upstream_unavailable");
		expect(r.content[0]?.text).not.toMatch(/sabre|exception|var\/www/i);
	});
});
