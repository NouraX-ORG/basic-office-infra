import { afterEach, describe, expect, it, vi } from "vitest";
import { call, CHAT, envelope, errorOf, mockNig, nigError, sessionPayload, signToken, testEnv } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const UID = "5224252b-4938-4a86-a276-54bbae5d5b49";

describe("routes and configuration", () => {
	it("serves a health check without a session", async () => {
		const res = await call("/health", { method: "GET", token: null });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});

	it("knows no other paths", async () => {
		const calls = mockNig([]);
		expect((await call("/v1/chat/completions", { body: envelope(CHAT) })).status).toBe(404);
		expect((await call("/proxy", { method: "GET" })).status).toBe(405);
		expect(calls).toHaveLength(0);
	});

	it("reports a missing secret without calling NIG", async () => {
		const calls = mockNig([]);
		for (const missing of ["EDITOR_SESSION_KEY", "NEXTCLOUD_INSTANCE_ID", "NIG_SERVICE_KEY"] as const) {
			const res = await call("/proxy", { body: envelope(CHAT), env: await testEnv({ [missing]: undefined }) });
			expect(res.status).toBe(503);
			expect((await errorOf(res)).code).toBe("not_configured");
		}
		expect(calls).toHaveLength(0);
	});

	it("checks the session before the NIG key, so the editor side can be tested first", async () => {
		const res = await call("/proxy", { body: envelope(CHAT), token: null, env: await testEnv({ NIG_SERVICE_KEY: undefined }) });
		expect(res.status).toBe(401);
	});
});

describe("who may use it", () => {
	it("needs an editor session", async () => {
		const calls = mockNig([]);
		const res = await call("/proxy", { body: envelope(CHAT), token: null });
		expect(res.status).toBe(401);
		expect((await errorOf(res)).message).toContain("reopen the document");
		expect(calls).toHaveLength(0);
	});

	it("refuses a session signed with another key", async () => {
		const calls = mockNig([]);
		const res = await call("/proxy", { body: envelope(CHAT), token: await signToken(sessionPayload(), "some-other-key") });
		expect(res.status).toBe(401);
		expect(calls).toHaveLength(0);
	});

	it("refuses guests with a sign-in message", async () => {
		const calls = mockNig([]);
		const payload = sessionPayload();
		(payload.editorConfig as Record<string, unknown>).user = { name: "Guest" };
		const res = await call("/proxy", { body: envelope(CHAT), token: await signToken(payload) });
		expect(res.status).toBe(403);
		expect(await errorOf(res)).toEqual({ code: "guest", message: "Sign in to Nourax Workspace to use Nourax AI." });
		expect(calls).toHaveLength(0);
	});
});

describe("what it forwards", () => {
	it("sends the chat to NIG as the signed-in user with the service key", async () => {
		const calls = mockNig([Response.json({ choices: [{ message: { content: "Done" } }] })]);
		const res = await call("/proxy", { body: envelope({ ...CHAT, temperature: 0.2 }) });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ choices: [{ message: { content: "Done" } }] });
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(calls).toHaveLength(1);
		const [nig] = calls;
		expect(nig!.url).toBe("https://nig.test/v1/chat/completions");
		expect(nig!.headers.get("Authorization")).toBe("Bearer nig-office-service-key");
		expect(nig!.headers.get("X-Nourax-Feature")).toBe("office");
		expect(nig!.body).toEqual({ ...CHAT, temperature: 0.2, user: UID });
	});

	it("sets the user itself and drops fields it does not pass on", async () => {
		const calls = mockNig([Response.json({ choices: [] })]);
		await call("/proxy", { body: envelope({ ...CHAT, user: "someone-else", n: 5, logit_bias: { 1: 100 } }) });
		expect(calls[0]!.body).toEqual({ ...CHAT, user: UID });
	});

	it("streams the reply through unchanged", async () => {
		const sse = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
		const calls = mockNig([new Response(sse, { headers: { "Content-Type": "text/event-stream" } })]);
		const res = await call("/proxy", { body: envelope({ ...CHAT, stream: true }) });
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
		expect(await res.text()).toBe(sse);
		expect(calls[0]!.body.stream).toBe(true);
	});

	it("accepts the data as an object as well as a JSON string", async () => {
		const calls = mockNig([Response.json({ choices: [] })]);
		const body = JSON.stringify({ target: "/nourax-ai/v1/chat/completions", method: "POST", data: CHAT });
		expect((await call("/proxy", { body })).status).toBe(200);
		expect(calls[0]!.body.model).toBe("nourax-smart");
	});

	it("offers chat only: images, audio and other endpoints are refused", async () => {
		const calls = mockNig([]);
		const res = await call("/proxy", { body: envelope({ model: "nourax-smart", prompt: "a cat" }, "/nourax-ai/v1/images/generations") });
		expect(res.status).toBe(400);
		expect((await errorOf(res)).code).toBe("unsupported");
		expect(calls).toHaveLength(0);
	});

	it("refuses models that are not on the list", async () => {
		const calls = mockNig([]);
		const res = await call("/proxy", { body: envelope({ ...CHAT, model: "gpt-5" }) });
		expect(res.status).toBe(403);
		expect((await errorOf(res)).code).toBe("model_not_allowed");
		expect(calls).toHaveLength(0);
	});

	it("refuses bodies that are not the plugin's envelope", async () => {
		const calls = mockNig([]);
		expect((await call("/proxy", { body: "not json" })).status).toBe(400);
		expect((await call("/proxy", { body: JSON.stringify({ target: "/v1/chat/completions", data: "{}" }) })).status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it("refuses requests over the size limit", async () => {
		const calls = mockNig([]);
		const big = envelope({ ...CHAT, messages: [{ role: "user", content: "x".repeat(5000) }] });
		const res = await call("/proxy", { body: big });
		expect(res.status).toBe(413);
		expect(calls).toHaveLength(0);
	});
});

describe("NIG's answers", () => {
	it("turns a used-up budget into a plain message", async () => {
		mockNig([nigError(429, "budget_exceeded", "Spend limit exceeded")]);
		const res = await call("/proxy", { body: envelope(CHAT) });
		expect(res.status).toBe(429);
		expect(await errorOf(res)).toEqual({
			code: "budget_exceeded",
			message: "You have reached your Nourax AI limit for now. Please try again later.",
		});
	});

	it("hides a refused service key from the user", async () => {
		mockNig([nigError(401, "unauthorized")]);
		const res = await call("/proxy", { body: envelope(CHAT) });
		expect(res.status).toBe(503);
		expect((await errorOf(res)).message).toBe("Nourax AI is not available yet.");
	});

	it("passes on why a provider refused the request", async () => {
		mockNig([nigError(400, "upstream_rejected", "context too long")]);
		const res = await call("/proxy", { body: envelope(CHAT) });
		expect(res.status).toBe(400);
		expect((await errorOf(res)).message).toBe("Nourax AI could not process this request: context too long");
	});

	it("says busy when NIG fails or cannot be reached", async () => {
		mockNig([nigError(502, "upstream_unavailable"), new TypeError("network down")]);
		for (let i = 0; i < 2; i++) {
			const res = await call("/proxy", { body: envelope(CHAT) });
			expect(res.status).toBe(502);
			expect((await errorOf(res)).code).toBe("busy");
		}
	});
});
