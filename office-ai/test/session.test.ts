import { describe, expect, it } from "vitest";
import { importSessionKey, SessionError, verifySession } from "../src/session";
import { deriveSessionKey, INSTANCE, sessionPayload, signToken } from "./helpers";

async function check(token: string, key?: string) {
	return verifySession(`Bearer ${token}`, await importSessionKey(key ?? (await deriveSessionKey())), INSTANCE);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof SessionError) return err.code;
		throw err;
	}
	return "accepted";
}

describe("editor session token", () => {
	it("accepts a session signed with the derived key and returns the Nextcloud user id", async () => {
		const session = await check(await signToken(sessionPayload()));
		expect(session).toEqual({ uid: "5224252b-4938-4a86-a276-54bbae5d5b49", documentKey: "doc-123" });
	});

	it("matches Document Server's derivation for a known secret", async () => {
		// HMAC-SHA256("secret", "editor-session"), worked out with Node's crypto (as DocService does) and Python's hmac.
		expect(await deriveSessionKey("secret")).toBe("fbfaa831fbd6347f73cae6f1f82ee05156b1bf7853b0c921c8ca730a6db75241");
	});

	it("refuses a token signed with the main secret instead of the derived key", async () => {
		const token = await signToken(sessionPayload(), "test-onlyoffice-secret-0123456789abcdef0123456789");
		expect(await codeOf(check(token))).toBe("bad_session");
	});

	it("refuses a tampered payload", async () => {
		const [h, , s] = (await signToken(sessionPayload())).split(".");
		const forged = btoa(JSON.stringify(sessionPayload({ editorConfig: { user: { id: `${INSTANCE}_admin` }, ds_sessionTimeConnect: 1 } })))
			.replaceAll("=", "")
			.replaceAll("+", "-")
			.replaceAll("/", "_");
		expect(await codeOf(check(`${h}.${forged}.${s}`))).toBe("bad_session");
	});

	it("refuses other algorithms, including none", async () => {
		expect(await codeOf(check(await signToken(sessionPayload(), undefined, { alg: "HS512" })))).toBe("bad_session");
		const unsigned = (await signToken(sessionPayload(), undefined, { alg: "none" })).replace(/\.[^.]+$/, ".");
		expect(await codeOf(verifySession(`Bearer ${unsigned}`, await importSessionKey(await deriveSessionKey()), INSTANCE))).toBe(
			"no_session",
		);
	});

	it("refuses expired sessions and tokens without an expiry", async () => {
		const past = Math.floor(Date.now() / 1000) - 120;
		expect(await codeOf(check(await signToken(sessionPayload({ exp: past }))))).toBe("expired");
		expect(await codeOf(check(await signToken(sessionPayload({ exp: undefined }))))).toBe("expired");
	});

	it("refuses a document open config, which has no session time", async () => {
		const payload = sessionPayload();
		delete (payload.editorConfig as Record<string, unknown>).ds_sessionTimeConnect;
		expect(await codeOf(check(await signToken(payload)))).toBe("bad_session");
	});

	it("refuses guests on share links (no Nextcloud user id)", async () => {
		const payload = sessionPayload();
		(payload.editorConfig as Record<string, unknown>).user = { id: "uid-1", name: "Guest" };
		expect(await codeOf(check(await signToken(payload)))).toBe("guest");
		(payload.editorConfig as Record<string, unknown>).user = { name: "Guest" };
		expect(await codeOf(check(await signToken(payload)))).toBe("guest");
	});

	it("refuses users of another Nextcloud instance", async () => {
		const payload = sessionPayload();
		(payload.editorConfig as Record<string, unknown>).user = { id: "ocother_5224252b", name: "X" };
		expect(await codeOf(check(await signToken(payload)))).toBe("guest");
	});

	it("refuses user ids NIG cannot take, such as emails", async () => {
		const payload = sessionPayload();
		(payload.editorConfig as Record<string, unknown>).user = { id: `${INSTANCE}_someone@example.com`, name: "X" };
		expect(await codeOf(check(await signToken(payload)))).toBe("bad_user");
	});

	it("honours the AI-off flag", async () => {
		const payload = sessionPayload();
		(payload.editorConfig as Record<string, unknown>).ds_aiDisabled = true;
		expect(await codeOf(check(await signToken(payload)))).toBe("ai_disabled");
	});

	it("needs a bearer token", async () => {
		const key = await importSessionKey(await deriveSessionKey());
		expect(await codeOf(verifySession(null, key, INSTANCE))).toBe("no_session");
		expect(await codeOf(verifySession("Bearer undefined", key, INSTANCE))).toBe("no_session");
	});
});
