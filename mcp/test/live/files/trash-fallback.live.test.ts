/**
 * Lane A's live case for NoDrive's delete-for-good fallback (DESIGN 17.6): when the move to the
 * trash fails, files_trashbin's Storage::doDelete deletes the item outright, and files_move_to_trash
 * must say so instead of "Moved ... to the trash". One reliable way to make the move fail is a
 * per-person trash size limit: Trashbin::move2trash returns false for an item at least that big.
 *
 * Skipped unless NX_LIVE_A_TRASHBIN_SIZE is set. The operator sets the limit for the QA account
 * first, on the server under the deploy lock, and sets it back to -1 (no limit) afterwards:
 *   occ user:setting qa-t1-a-files-1 files_trashbin trashbin_size 1000
 *   occ user:setting qa-t1-a-files-1 files_trashbin trashbin_size -- -1
 * Only this case may run while the limit is set (the other live cases trash and restore bigger
 * items), so run it on its own:
 *   NX_LIVE_A_TRASHBIN_SIZE=1000 NX_LIVE_BASE=http://localhost:8800 npx vitest run \
 *     --config test/live/files/vitest.lane-a.config.ts test/live/files/trash-fallback.live.test.ts
 *
 * Everything happens in /MCP-QA-A-tf-<run>/, a folder this case makes. The big file is deleted for
 * good by NoDrive itself (the rule-3 exception: a QA file this case made, to test the delete path).
 * The trash check over DAV needs the account's app password from the netrc file NX_LIVE_NETRC_A.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brandScan } from "../_shared/client";

const LIMIT = Number(process.env.NX_LIVE_A_TRASHBIN_SIZE ?? "0");
const BASE = process.env.NX_LIVE_BASE ?? "http://localhost:8787";
const UID = process.env.NX_LIVE_UID_A ?? "qa-t1-a-files-1";
const NETRC = process.env.NX_LIVE_NETRC_A;
const DRIVE = "https://drive.nourax.org";
const RUN = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
const ROOT = `/MCP-QA-A-tf-${RUN}`;

interface Result {
	isError?: boolean;
	content: { type: string; text: string }[];
	structuredContent?: Record<string, unknown>;
	_meta?: Record<string, { code?: string }>;
}

let token = "";
let rid = 1;

async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
	const res = await fetch(`${BASE}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
		body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method: "tools/call", params: { name, arguments: args } }),
	});
	const raw = await res.text();
	expect(res.status, name).toBe(200);
	brandScan(name, raw);
	let json: Record<string, unknown> = {};
	if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
		for (const line of raw.split(/\r?\n/)) if (line.startsWith("data:")) json = JSON.parse(line.slice(5)) as Record<string, unknown>;
	} else json = JSON.parse(raw) as Record<string, unknown>;
	const result = json.result as Result | undefined;
	if (!result) throw new Error(`${name}: no result (${raw.slice(0, 300)})`);
	return result;
}

/** Basic auth for the QA account, from the netrc file (the value is never printed). */
function basicAuth(): string {
	if (!NETRC) throw new Error("NX_LIVE_NETRC_A isn't set: this case checks the trash over DAV and needs it.");
	const words = readFileSync(NETRC, "utf8").split(/\s+/).filter(Boolean);
	for (let i = 0; i < words.length; i++) {
		if (words[i] !== "machine" || words[i + 1] !== "drive.nourax.org") continue;
		let login: string | undefined;
		let password: string | undefined;
		for (let j = i + 2; j < words.length && words[j] !== "machine"; j += 2) {
			if (words[j] === "login") login = words[j + 1];
			if (words[j] === "password") password = words[j + 1];
		}
		if (login === UID && password) return `Basic ${btoa(`${UID}:${password}`)}`;
	}
	throw new Error(`the netrc file has no drive.nourax.org entry for ${UID}`);
}

/** The original locations in the account's trash, straight from NoDrive. */
async function trashLocations(): Promise<string[]> {
	const res = await fetch(`${DRIVE}/remote.php/dav/trashbin/${encodeURIComponent(UID)}/trash/`, {
		method: "PROPFIND",
		headers: { authorization: basicAuth(), depth: "1", "content-type": "application/xml" },
		body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:prop><nc:trashbin-original-location/></d:prop></d:propfind>',
	});
	expect(res.status).toBe(207);
	const body = await res.text();
	return [...body.matchAll(/<nc:trashbin-original-location>([^<]*)<\/nc:trashbin-original-location>/g)].map((m) => `/${(m[1] ?? "").replace(/&amp;/g, "&")}`);
}

describe.runIf(LIMIT > 0)(`live: NoDrive's delete-for-good fallback, as ${UID} with trashbin_size ${LIMIT}`, () => {
	beforeAll(async () => {
		const res = await fetch(`${BASE}/dev/token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ uid: UID, scopes: ["workspace.read", "workspace.write", "workspace.remove"] }),
		});
		if (!res.ok) throw new Error(`dev token for ${UID}: ${res.status}`);
		token = ((await res.json()) as { access_token: string }).access_token;
		const made = await call("files_create_folder", { path: ROOT });
		expect(made.isError, made.content[0]?.text).toBeFalsy();
	});

	afterAll(async () => {
		if (!token) return;
		// The folder is small by now (the big file is gone), so it goes to the trash as usual.
		const r = await call("files_move_to_trash", { path: ROOT });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
	});

	it("an item over the limit: NoDrive deletes it outright, and the result says it may be gone for good", async () => {
		const big = `${ROOT}/big.txt`;
		const c = await call("files_create_file", { path: big, content: "b".repeat(LIMIT * 2) });
		expect(c.isError, c.content[0]?.text).toBeFalsy();
		const r = await call("files_move_to_trash", { path: big });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		expect(r.structuredContent).toMatchObject({ trash_item_id: null, in_trash: false, undo: null });
		// The path is in the data; the summary doesn't repeat it (fix round 3, src/tools/files/common.ts).
		expect(r.content[0]?.text.split("\n")[0]).toBe("NoDrive removed the file, but it isn't in the person's trash, so it may be gone for good.");
		expect(r.content[0]?.text).not.toContain("Moved the file");
		// Checked straight with NoDrive: gone from the folder and not in the trash.
		const info = await call("files_get_info", { path: big });
		expect(info._meta?.["nourax/error"]?.code).toBe("not_found");
		expect(await trashLocations()).not.toContain(big);
	});

	it("an item under the limit still goes to the trash and gets its undo", async () => {
		const small = `${ROOT}/small.txt`;
		await call("files_create_file", { path: small, content: "s" });
		const r = await call("files_move_to_trash", { path: small });
		expect(r.isError, r.content[0]?.text).toBeFalsy();
		expect(r.structuredContent).toMatchObject({ in_trash: true });
		expect((r.structuredContent as { undo: { tool: string } | null }).undo?.tool).toBe("files_restore_from_trash");
		expect(await trashLocations()).toContain(small);
	});
});
