/**
 * Shared setup for lane D's contract tests: the fake with CalDAV, QA people in one group, tool calls.
 * Every successful call is checked against the tool's result shape (src/tools/calendar/outputs.ts)
 * as zod would publish it, with no extra keys at any level, using the MCP SDK's own validator.
 */
import { runInDurableObject } from "cloudflare:test";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { z } from "zod";
import { brandViolations } from "../../../src/core/brand";
import type { JComp } from "../../../src/pim/jcal";
import { LANE_D_OUTPUTS } from "../../../src/tools/calendar/outputs";
import { type Vault, vaultFor } from "../../../src/vault/vault";
import { type FakeCalDav, installCalDav } from "../../fake-nc/caldav";
import type { FakeNc, Recorded } from "../../fake-nc/index";
import { devToken, env as nxEnv, fakeWithQa, framedPayload, mcpPost, QA, QA_PASS, rpcResult } from "../../helpers/index";

export const ALL_SCOPES = ["workspace.read", "workspace.write", "workspace.remove", "workspace.share"];
export const OUTSIDER = "qa-t1-93";

export interface Setup {
	fake: FakeNc;
	cal: FakeCalDav;
}

/** QA.a and QA.b share the group "qa-team"; OUTSIDER (no password known to dev mode) shares none. */
export function setup(): Setup {
	const fake = fakeWithQa();
	const a = fake.users.get(QA.a);
	const b = fake.users.get(QA.b);
	if (a) a.groups = ["qa-team"];
	if (b) b.groups = ["qa-team"];
	fake.addUser({ uid: OUTSIDER, password: "FAKEAPPPASS-qa-t1-93-0123456789abcdef", displayName: "QA t1 93", email: "qa-t1-93@example.invalid", groups: ["other"] });
	const cal = installCalDav(fake);
	return { fake, cal };
}

export interface CallResult {
	content: { type: string; text: string }[];
	structuredContent: Record<string, unknown>;
	isError?: boolean;
	_meta?: Record<string, { code: string; field?: string; retryable?: boolean }>;
}

const tokens = new Map<string, string>();

/** A dev token per uid and scope set, made once per test file run. */
export async function tokenFor(uid: string = QA.a, scopes: string[] = ALL_SCOPES): Promise<string> {
	const k = `${uid}|${scopes.join(",")}`;
	let t = tokens.get(k);
	if (!t) {
		t = (await devToken(uid, { scopes })).access_token;
		tokens.set(k, t);
	}
	return t;
}

/**
 * Fresh tokens, and fresh per-minute counters for the QA people: the tests of one file share each
 * person's vault storage, so the per-minute limits (DESIGN 9.4, e.g. 10 a minute for invitations)
 * would otherwise add up across tests.
 */
export async function resetTokens(): Promise<void> {
	tokens.clear();
	for (const uid of [QA.a, QA.b]) {
		await runInDurableObject(vaultFor(nxEnv, uid), async (_i: Vault, state) => {
			state.storage.sql.exec("DELETE FROM counters WHERE k LIKE 'm:%'");
		});
	}
}

type Validator = ReturnType<typeof fromJsonSchema>;
const validators = new Map<string, Validator>();

/** Throws when structuredContent doesn't match the tool's result shape exactly. */
export async function assertShape(name: string, value: unknown): Promise<void> {
	const shape = LANE_D_OUTPUTS[name];
	if (!shape) throw new Error(`${name} has no result shape in LANE_D_OUTPUTS`);
	let v = validators.get(name);
	if (!v) {
		v = fromJsonSchema(z.toJSONSchema(shape, { io: "output" }) as never);
		validators.set(name, v);
	}
	const r = await v["~standard"].validate(value);
	if ("issues" in r && r.issues) throw new Error(`${name}: result doesn't match its shape: ${JSON.stringify(r.issues).slice(0, 600)}`);
}

export async function callTool(name: string, args: Record<string, unknown> = {}, opts: { uid?: string; scopes?: string[]; token?: string } = {}): Promise<CallResult> {
	const token = opts.token ?? (await tokenFor(opts.uid, opts.scopes));
	const res = await mcpPost(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
	const body = await rpcResult(res);
	if (body.error) throw new Error(`JSON-RPC error: ${JSON.stringify(body.error)}`);
	const r = body.result as CallResult;
	const text = r.content?.map((c) => c.text).join("\n") ?? "";
	const brand = brandViolations(text + JSON.stringify(r.structuredContent ?? {}));
	if (brand.length) throw new Error(`brand rule 6: ${name} output matches ${brand.join(", ")}`);
	if (!r.isError && name in LANE_D_OUTPUTS) await assertShape(name, r.structuredContent);
	return r;
}

export function errCode(r: CallResult): string | undefined {
	return r._meta?.["nourax/error"]?.code;
}

export function payload(r: CallResult): Record<string, unknown> {
	return JSON.parse(framedPayload(r.content[0]?.text ?? "")) as Record<string, unknown>;
}

/** Drive calls to calendar paths only (no cloud/user, principal or capabilities noise). */
export function calCalls(fake: FakeNc, method?: string): Recorded[] {
	return fake.driveCalls().filter((c) => c.url.pathname.startsWith("/remote.php/dav/calendars/") && (!method || c.method === method));
}

/** A small jCal event for seeding the fake. */
export function vevent(uid: string, start: string, end: string, extra: JComp[1] = [], subs: JComp[] = []): JComp {
	const type = start.length === 10 ? "date" : "date-time";
	return [
		"vcalendar",
		[
			["version", {}, "text", "2.0"],
			["prodid", {}, "text", "-//test//EN"],
		],
		[
			[
				"vevent",
				[["uid", {}, "text", uid], ["dtstamp", {}, "date-time", "2026-10-01T00:00:00Z"], ["dtstart", {}, type, start], ["dtend", {}, type, end], ["summary", {}, "text", `Event ${uid}`], ...extra],
				subs,
			],
		],
	];
}

export function vtodo(uid: string, extra: JComp[1] = []): JComp {
	return [
		"vcalendar",
		[
			["version", {}, "text", "2.0"],
			["prodid", {}, "text", "-//test//EN"],
		],
		[["vtodo", [["uid", {}, "text", uid], ["dtstamp", {}, "date-time", "2026-10-01T00:00:00Z"], ["summary", {}, "text", `Task ${uid}`], ...extra], []]],
	];
}

export function propOf(cal: JComp, comp: string, name: string): JComp[1][number] | undefined {
	return cal[2].find((c) => c[0] === comp)?.[1].find((p) => p[0] === name);
}

export { QA, QA_PASS };
