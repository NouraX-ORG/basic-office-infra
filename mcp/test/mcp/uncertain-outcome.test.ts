/**
 * Fix round 3 (src/mcp/register.ts, src/nc/client.ts):
 * - a tool that changes data and isn't idempotent, whose timeout or upstream failure came after it
 *   had sent a change, says the outcome is unknown and is not retryable (so a retry can't make a
 *   second copy, card, event or share); before any change was sent, "try again" still holds;
 * - an idempotent write stays retryable;
 * - once the tool budget is over (the request's abort signal), the NoDrive client sends nothing more.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../../src/env";
import { createNcClient } from "../../src/nc/client";
import { env, QA, QA_PASS } from "../helpers/index";
import { code, setup, text } from "../tools/files/helpers";

afterEach(() => vi.restoreAllMocks());

const meta = (r: { _meta?: Record<string, unknown> }) => r._meta?.["nourax/error"] as { code?: string; retryable?: boolean } | undefined;

describe("an outcome that isn't known", () => {
	it("files_copy whose COPY got a 502: not retryable, and says to check first", async () => {
		const e = await setup();
		e.files.write(QA.a, "/a.txt", "x");
		e.files.mkdir(QA.a, "/B");
		e.fake.on("COPY", /^\/remote\.php\/dav\/files\//, () => new Response("bad gateway", { status: 502 }));
		const r = await e.call("files_copy", { path: "/a.txt", to_folder: "/B" });
		expect(code(r)).toBe("upstream_unavailable");
		expect(meta(r)?.retryable).toBe(false);
		expect(text(r)).toContain("it isn't known whether this was done. Check before trying again");
	});
	it("the same failure before anything was sent stays retryable", async () => {
		const e = await setup();
		e.files.write(QA.a, "/a.txt", "x");
		e.fake.on("PROPFIND", /^\/remote\.php\/dav\/files\//, () => new Response("busy", { status: 503 }));
		const r = await e.call("files_copy", { path: "/a.txt", to_folder: "/B" });
		expect(code(r)).toBe("upstream_unavailable");
		expect(meta(r)?.retryable).toBe(true);
		expect(e.davCalls().filter((c) => c.method === "COPY")).toHaveLength(0);
	});
	it("an idempotent write (files_set_favorite) stays retryable after a 502", async () => {
		const e = await setup();
		e.files.write(QA.a, "/a.txt", "x");
		e.fake.on("PROPPATCH", /^\/remote\.php\/dav\/files\//, () => new Response("bad gateway", { status: 502 }));
		const r = await e.call("files_set_favorite", { path: "/a.txt", favorite: true });
		expect(r.isError).toBe(true);
		expect(meta(r)?.retryable).toBe(true);
	});
});

describe("the tool budget's abort signal", () => {
	it("stops the NoDrive client: nothing is sent once it has fired", async () => {
		const e = await setup();
		const abort = new AbortController();
		const nc = createNcClient({ env, cfg: config(env), uid: QA.a, cred: { loginName: QA.a, appPassword: QA_PASS[QA.a] as string }, signal: abort.signal });
		const before = e.fake.requests.length;
		await nc.request("PROPFIND", `/remote.php/dav/files/${QA.a}/`, { headers: { depth: "0" } }).then((r) => r.body?.cancel());
		expect(e.fake.requests.length).toBe(before + 1);
		abort.abort(new DOMException("timeout", "TimeoutError"));
		await expect(nc.request("PUT", `/remote.php/dav/files/${QA.a}/late.txt`, { body: "x" })).rejects.toMatchObject({ code: "timeout" });
		expect(e.fake.requests.length).toBe(before + 1);
		expect(e.files.get(QA.a, "/late.txt")).toBeUndefined();
	});
});
