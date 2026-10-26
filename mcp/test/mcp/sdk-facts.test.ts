/** Facts the design asked core to check in workerd (DESIGN 23), kept as tests. */
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { devToken, fakeWithQa, QA } from "../helpers/index";

afterEach(() => vi.restoreAllMocks());

describe("SDK on workerd", () => {
	it("fromJsonSchema validates with the bundled validator (no eval)", async () => {
		const s = fromJsonSchema<{ q: string }>({ type: "object", properties: { q: { type: "string", maxLength: 5 } }, required: ["q"], additionalProperties: false });
		const good = await s["~standard"].validate({ q: "abc" });
		expect("issues" in good && good.issues).toBeFalsy();
		const bad = await s["~standard"].validate({ q: "toolong", x: 1 });
		expect("issues" in bad && bad.issues?.length).toBeGreaterThan(0);
	});
});

describe("OAuth library facts", () => {
	it("issues a refresh token without offline_access being granted", async () => {
		fakeWithQa();
		const t = await devToken(QA.a, { scopes: ["workspace.read"] });
		expect(t.scope.split(" ")).not.toContain("offline_access");
		expect(t.refresh_token).toBeTruthy();
	});
});
