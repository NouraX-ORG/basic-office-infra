/**
 * Lane B live cases for the sharing refusals reviewed after fix round 3 (DESIGN 17.6), as
 * qa-t1-212 on a connection of its own (the vault allows 30 share calls a day per connection):
 * - a password-rule refusal from sharing_update names no field that tool lacks, while
 *   sharing_create_link keeps its generate_password hint (the server refuses "password1234" as
 *   too common);
 * - a link stopped by two sharing_delete calls at the same moment: one stops it, the other gets
 *   the same "There's no share with id N" answer, whether the share was gone at its GET (getShare)
 *   or only at its DELETE (NC 35's 404 "Wrong share ID, share does not exist"); later calls on it
 *   say the same, never "There's no file or folder at ...".
 * Fixtures are made straight over WebDAV as qa-t1-212; every link made here is stopped with
 * sharing_delete (the rule-3 exception), and the clean-up fails the run if one may still be active.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { B, call, code, dav, devToken, ok, ROOT, stopAll } from "./live";

const DIR = `${ROOT}-errors`;
const FILE = `${DIR}/errors.txt`;
const gone = (id: string) => `There's no share with id ${id} (it may have been stopped already). sharing_list shows the shares.`;

let token = "";
const made: string[] = [];

beforeAll(async () => {
	token = await devToken(B);
	expect(await dav(B, "MKCOL", `${DIR}/`)).toBe(201);
	expect([201, 204]).toContain(await dav(B, "PUT", FILE, "Lane B live test file for sharing refusals.\n"));
});

afterAll(async () => {
	const left = made.length ? await stopAll(await devToken(B), made) : [];
	if (left.length) throw new Error(`These shares made by this run may still be active; stop them with sharing_delete: ${left.join(", ")}`);
}, 300_000);

async function link(): Promise<string> {
	const r = ok(await call(token, "sharing_create_link", { path: FILE, allow_duplicate: true, expires_in_days: 2 }), "make a link");
	const id = String(r.structuredContent.share_id);
	made.push(id);
	return id;
}

describe("live: sharing refusals", () => {
	it("sharing_update's password refusal gives no generate_password hint; sharing_create_link's does", async () => {
		const id = await link();
		const u = await call(token, "sharing_update", { share_id: id, password: "password1234" });
		expect(code(u)).toBe("invalid_input");
		const text = String(u.content[0]?.text);
		expect(text).toMatch(/password rules|too common|leaked/);
		expect(text).not.toContain("generate_password");
		const c = await call(token, "sharing_create_link", { path: FILE, password: "password1234", allow_duplicate: true });
		expect(code(c)).toBe("invalid_input");
		expect(String(c.content[0]?.text)).toMatch(/generate_password makes one that fits\.$/);
		console.log(`sharing_update says: ${text}`);
		ok(await call(token, "sharing_delete", { share_id: id }), "stop the link");
		made.splice(made.indexOf(id), 1);
	});

	it("a link stopped twice at the same moment: one call stops it, the other says it is gone", async () => {
		const id = await link();
		const [a, b] = await Promise.all([call(token, "sharing_delete", { share_id: id }), call(token, "sharing_delete", { share_id: id })]);
		const done = [a, b].filter((r) => !r.isError);
		const refused = [a, b].filter((r) => r.isError);
		expect(done).toHaveLength(1);
		made.splice(made.indexOf(id), 1);
		expect(refused).toHaveLength(1);
		expect(code(refused[0] as (typeof refused)[number])).toBe("not_found");
		expect(refused[0]?.content[0]?.text).toBe(gone(id));
		// Later calls on the stopped link say the same, and nothing about files.
		for (const r of [await call(token, "sharing_delete", { share_id: id }), await call(token, "sharing_update", { share_id: id, note: "late" })]) {
			expect(code(r)).toBe("not_found");
			expect(r.content[0]?.text).toBe(gone(id));
			expect(r.content[0]?.text).not.toMatch(/file or folder|files_search/);
		}
	});
});
