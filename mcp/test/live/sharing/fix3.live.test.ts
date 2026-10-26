/**
 * Lane B fix round 3, live sharing cases (DESIGN 17.6), as qa-t1-212 (the second person), so
 * qa-t1-211's day of share calls in sharing.live.test.ts stays as it was (the vault allows 30 a
 * day per person):
 * - shares made the way the web page makes custom ones (bits 5: read and create; bits 3: read and
 *   update) keep every other right when sharing_update is given only can_reshare, and the undo it
 *   offers gives the very same bits back;
 * - a share note longer than the tools show comes back cut short, inside a bounded answer.
 * Fixtures (folders, a file, the custom shares) are made straight over WebDAV and OCS as
 * qa-t1-212; every share made here is stopped with sharing_delete (the rule-3 exception), and the
 * clean-up fails the run if one may still be active.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { A, B, call, dav, devToken, ocsAs, ok, ROOT, stopAll } from "./live";

const FIX = `${ROOT}-fix3`;
const SUB5 = `${FIX}/Add only`;
const SUB3 = `${FIX}/Change only`;
const NOTE_FILE = `${FIX}/note.txt`;
const SHARES = "/ocs/v2.php/apps/files_sharing/api/v1/shares";
const RESULT_CHARS = 60_000;

let tokenB = "";
const made: string[] = [];

function forget(id: string): void {
	const i = made.indexOf(id);
	if (i >= 0) made.splice(i, 1);
}

beforeAll(async () => {
	tokenB = await devToken(B);
	expect(await dav(B, "MKCOL", `${FIX}/`)).toBe(201);
	expect(await dav(B, "MKCOL", `${SUB5}/`)).toBe(201);
	expect(await dav(B, "MKCOL", `${SUB3}/`)).toBe(201);
	expect([201, 204]).toContain(await dav(B, "PUT", NOTE_FILE, "Lane B fix round 3 live test file.\n"));
});

afterAll(async () => {
	const left = made.length ? await stopAll(await devToken(B), made) : [];
	if (left.length) throw new Error(`These shares made by this run may still be active; stop them with sharing_delete: ${left.join(", ")}`);
}, 300_000);

/** A share qa-t1-212 makes with qa-t1-211 with custom permissions, as the web page can. */
async function webShare(path: string, permissions: number, extra: Record<string, string> = {}): Promise<string> {
	const r = await ocsAs(B, "POST", SHARES, { path, shareType: "0", shareWith: A, permissions: String(permissions), ...extra });
	expect(r.status).toBe(200);
	const id = String(r.data.id);
	made.push(id);
	expect(r.data.permissions).toBe(permissions);
	return id;
}

async function bitsOf(id: string): Promise<number> {
	const r = await ocsAs(B, "GET", `${SHARES}/${id}`);
	const x = (Array.isArray(r.data) ? r.data[0] : r.data) as { permissions?: number };
	return Number(x.permissions);
}

async function stop(id: string): Promise<void> {
	ok(await call(tokenB, "sharing_delete", { share_id: id }), `stop share ${id}`);
	forget(id);
}

describe("live: sharing fix round 3", () => {
	it("sharing_update with only can_reshare keeps a custom share's other rights, and its undo gives the same bits back", async () => {
		const id5 = await webShare(SUB5, 5);
		const r5 = ok(await call(tokenB, "sharing_update", { share_id: id5, can_reshare: true }), "reshare on bits 5");
		// Before the fix this was 17: create was dropped without a word.
		expect(await bitsOf(id5)).toBe(21);
		expect(r5.structuredContent.share).toMatchObject({ permission: "view_and_upload", can_reshare: true, can_delete: false });
		expect(r5.structuredContent.undo).toEqual({ tool: "sharing_update", arguments: { share_id: id5, can_reshare: false } });
		ok(await call(tokenB, "sharing_update", r5.structuredContent.undo.arguments), "undo on bits 5");
		expect(await bitsOf(id5)).toBe(5);

		const id3 = await webShare(SUB3, 3);
		const r3 = ok(await call(tokenB, "sharing_update", { share_id: id3, can_reshare: true }), "reshare on bits 3");
		// Before the fix this was 23: create was added, which nobody asked for.
		expect(await bitsOf(id3)).toBe(19);
		expect(r3.structuredContent.undo).toEqual({ tool: "sharing_update", arguments: { share_id: id3, can_reshare: false } });
		ok(await call(tokenB, "sharing_update", r3.structuredContent.undo.arguments), "undo on bits 3");
		expect(await bitsOf(id3)).toBe(3);

		await stop(id5);
		await stop(id3);
	});

	it("a share note longer than the tools show comes back cut short, in a bounded answer", async () => {
		const note = `Lane B fix 3 ${"n".repeat(4_990)}`;
		const id = await webShare(NOTE_FILE, 1, { note });
		const l = ok(await call(tokenB, "sharing_list", { which: "path", path: NOTE_FILE }), "list the file's shares");
		const s = (l.structuredContent.shares as { share_id: string; note: string; note_truncated: boolean }[]).find((x) => x.share_id === id);
		expect(s?.note).toHaveLength(2_000);
		expect(s?.note.startsWith("Lane B fix 3 nnn")).toBe(true);
		expect(s?.note_truncated).toBe(true);
		expect(JSON.stringify(l.structuredContent).length).toBeLessThanOrEqual(RESULT_CHARS);
		expect(l.content[0]?.text ?? "").not.toContain("[Cut short");
		// The note on the server is whole; only the view is cut.
		const raw = await ocsAs(B, "GET", `${SHARES}/${id}`);
		const x = (Array.isArray(raw.data) ? raw.data[0] : raw.data) as { note?: string };
		expect(x.note).toHaveLength(note.length);
		await stop(id);
	});
});
