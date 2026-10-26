/**
 * The sharing tools' refusals after the review of fix round 3 (DESIGN 17.3), with NC 35.0.2's own
 * texts (ShareAPIController, read on the server):
 * - a password-rule refusal from sharing_update gives no hint at a field that tool doesn't have
 *   (generate_password belongs to sharing_create_link, which keeps it);
 * - a share that is gone by the time of the PUT or DELETE (404 "Wrong share ID, share does not
 *   exist") gets getShare's own answer, never "There's no file or folder at ...";
 * - "Could not delete share" is busy (404, a lock) or not allowed (403), and a sentence that starts
 *   with "the shared item" starts with a capital letter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "../../../src/core/errors";
import { noShare, shareError } from "../../../src/tools/sharing/shares";
import { ocs } from "../../fake-nc/index";
import { callTool, errorCode, expectNoBrand } from "./_call";
import { callsTo, type World, world } from "./setup";

let w: World;
beforeEach(() => {
	w = world();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const SHARE = /^\/ocs\/v2\.php\/apps\/files_sharing\/api\/v1\/shares\/(\d+)$/;
const gone = (id: string) => `There's no share with id ${id} (it may have been stopped already). sharing_list shows the shares.`;

async function link(path = "/report.pdf"): Promise<string> {
	const r = await callTool("sharing_create_link", { path });
	expect(r.isError, r.content[0]?.text).toBeFalsy();
	return String(r.structuredContent.share_id);
}

/** An OCS refusal as the NoDrive client throws it (the body kept for matching only). */
function refusal(status: number, message: string, code: ToolError["code"] = status === 403 ? "permission_denied" : status === 404 ? "not_found" : "invalid_input"): ToolError {
	return new ToolError(code, "x", { upstreamStatus: status, detail: JSON.stringify({ ocs: { meta: { status: "failure", statuscode: status, message }, data: [] } }) });
}

describe("password-rule refusals point only to what the tool can do", () => {
	it("sharing_update says the rule and nothing about generate_password; sharing_create_link keeps its hint", async () => {
		const id = await link();
		w.sh.minPasswordLength = 16;
		const u = await callTool("sharing_update", { share_id: id, password: "abcdefghijkl" });
		expect(errorCode(u)).toBe("invalid_input");
		expect(u._meta?.["nourax/error"]?.field).toBe("password");
		expect(u.content[0]?.text).toBe("That password is too short for the workspace's password rules (at least 16 characters).");
		expect(u.content[0]?.text).not.toContain("generate_password");
		// generate_password is not a field of sharing_update: following such a hint would fail.
		const follow = await callTool("sharing_update", { share_id: id, generate_password: true });
		expect(errorCode(follow)).toBe("invalid_input");
		const c = await callTool("sharing_create_link", { path: "/Projects/plan.docx", password: "abcdefghijkl" });
		expect(c.content[0]?.text).toBe("That password is too short for the workspace's password rules (at least 16 characters). generate_password makes one that fits.");
		// And that hint works.
		const g = await callTool("sharing_create_link", { path: "/Projects/plan.docx", generate_password: true });
		expect(g.isError, g.content[0]?.text).toBeFalsy();
	});
});

describe("a share that is already gone", () => {
	it("sharing_delete: stopped in the gap after it was read, the answer names the share", async () => {
		const id = await link();
		// The share is stopped elsewhere between our GET and our DELETE.
		w.fake.on("DELETE", SHARE, () => ocs([], 404, "Wrong share ID, share does not exist"));
		const r = await callTool("sharing_delete", { share_id: id });
		expect(r.isError).toBe(true);
		expect(errorCode(r)).toBe("not_found");
		expect(r._meta?.["nourax/error"]?.field).toBe("share_id");
		expect(r.content[0]?.text).toBe(gone(id));
		expect(r.content[0]?.text).not.toMatch(/file or folder|files_search/);
		expectNoBrand(r);
	});

	it("sharing_update: the same, also for a plain 404 and for the server's text in another language", async () => {
		const id = await link();
		w.fake.on("PUT", SHARE, () => ocs([], 404, "Wrong share ID, share does not exist"));
		const r = await callTool("sharing_update", { share_id: id, note: "hello" });
		expect(errorCode(r)).toBe("not_found");
		expect(r.content[0]?.text).toBe(gone(id));
		w.fake.on("PUT", SHARE, () => ocs([], 404, "Falsche Freigabe-ID, Freigabe existiert nicht"));
		expect((await callTool("sharing_update", { share_id: id, note: "hello" })).content[0]?.text).toBe(gone(id));
		w.fake.on("PUT", SHARE, () => new Response("", { status: 404 }));
		expect((await callTool("sharing_update", { share_id: id, note: "hello" })).content[0]?.text).toBe(gone(id));
	});

	it("two sharing_delete calls at the same moment: one stops the link, the other says it is gone", async () => {
		const id = await link();
		const [a, b] = await Promise.all([callTool("sharing_delete", { share_id: id }), callTool("sharing_delete", { share_id: id })]);
		const ok = [a, b].filter((r) => !r.isError);
		const refused = [a, b].filter((r) => r.isError);
		expect(ok).toHaveLength(1);
		expect(refused).toHaveLength(1);
		expect(errorCode(refused[0] as (typeof refused)[number])).toBe("not_found");
		expect(refused[0]?.content[0]?.text).toBe(gone(id));
		expect(w.sh.shares.find((s) => String(s.id) === id)).toBeUndefined();
	});
});

describe("Could not delete share", () => {
	it("is busy when the item is locked (404), with a capital letter, and not allowed on 403", async () => {
		const id = await link();
		w.fake.on("DELETE", SHARE, () => ocs([], 404, "Could not delete share"));
		const busy = await callTool("sharing_delete", { share_id: id });
		expect(errorCode(busy)).toBe("locked");
		expect(busy._meta?.["nourax/error"]?.retryable).toBe(true);
		expect(busy.content[0]?.text).toBe("The shared item is busy right now. Try again in a moment.");
		w.fake.on("DELETE", SHARE, () => ocs([], 403, "Could not delete share"));
		const no = await callTool("sharing_delete", { share_id: id });
		expect(errorCode(no)).toBe("permission_denied");
		expect(no.content[0]?.text).toBe("The person isn't allowed to stop this share.");
		// The link was never stopped by these refusals.
		expect(w.sh.shares.some((s) => String(s.id) === id)).toBe(true);
		expect(callsTo(w.fake, "DELETE", SHARE)).toHaveLength(2);
	});
});

describe("shareError", () => {
	it("maps a missing share before the path texts, with or without an id", () => {
		const e = refusal(404, "Wrong share ID, share does not exist");
		expect(shareError(e, "the shared item", { shareId: "41" })).toMatchObject({ code: "not_found", message: gone("41"), field: "share_id", upstreamStatus: 404 });
		expect(shareError(e, "/Projects")).toMatchObject({ code: "not_found", message: "That share doesn't exist (it may have been stopped already). sharing_list shows the shares." });
		expect(noShare("7").message).toBe(gone("7"));
		// A path that is missing keeps its own words where there is no share id.
		const p = shareError(refusal(404, "Wrong path, file/folder does not exist"), "/Nope.txt") as ToolError;
		expect(p.message).toBe("There's no file or folder at /Nope.txt.");
		expect(p.hint).toBe("files_search can find it by name.");
		expect((shareError(refusal(404, "Wrong path, file/folder does not exist"), "the shared item", { shareId: "9" }) as ToolError).message).toBe(gone("9"));
	});

	it("adds the password hint only when the tool gives one", () => {
		const e = refusal(403, "Password needs to be at least 16 characters long.");
		expect((shareError(e, "/a") as ToolError).message).toBe("That password is too short for the workspace's password rules (at least 16 characters).");
		expect((shareError(e, "/a", { passwordHint: "generate_password makes one that fits." }) as ToolError).message).toBe(
			"That password is too short for the workspace's password rules (at least 16 characters). generate_password makes one that fits.",
		);
	});

	it("starts sentences with a capital letter, and leaves a path as it is", () => {
		expect((shareError(refusal(404, "Could not lock node"), "the shared item") as ToolError).message).toBe("The shared item is busy right now. Try again in a moment.");
		expect((shareError(refusal(404, "Could not lock node"), "/Projects") as ToolError).message).toBe("/Projects is busy right now. Try again in a moment.");
		expect((shareError(refusal(403, "Path is already shared with this user"), "the shared item") as ToolError).message).toMatch(/^The shared item is already shared with them\./);
	});

	it("passes through what it doesn't own", () => {
		const dead = new ToolError("reconnect_required", undefined, { deadCredential: true });
		expect(shareError(dead, "/a")).toBe(dead);
		const bug = new TypeError("x");
		expect(shareError(bug, "/a")).toBe(bug);
	});
});
