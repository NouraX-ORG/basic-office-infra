/** Shared set-up for lane G's contract tests: the fake with NoGantt, and one tools/call. */
import { type FakeGantt, installGantt } from "../../fake-nc/gantt";
import type { FakeNc } from "../../fake-nc/index";
import { devToken, fakeWithQa, framedPayload, mcpPost, QA, rpcResult } from "../../helpers/index";

export interface CallResult {
	content: { type: string; text: string }[];
	structuredContent: Record<string, any>;
	isError?: boolean;
	_meta?: Record<string, { code: string; field?: string; retryable?: boolean }>;
}

export const ALL_WORKSPACE = ["workspace.read", "workspace.write", "workspace.remove", "workspace.share"];

export function setup(): { fake: FakeNc; g: FakeGantt } {
	const fake = fakeWithQa();
	const g = installGantt(fake);
	return { fake, g };
}

export async function token(opts: { uid?: string; scopes?: string[]; apps?: string[] } = {}): Promise<string> {
	return (await devToken(opts.uid ?? QA.a, { scopes: opts.scopes ?? ALL_WORKSPACE, ...(opts.apps ? { apps: opts.apps } : {}) })).access_token;
}

export async function tool(name: string, args: unknown, opts: { uid?: string; scopes?: string[]; apps?: string[]; token?: string } = {}): Promise<CallResult> {
	const t = opts.token ?? (await token(opts));
	const res = await mcpPost(t, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
	const body = await rpcResult(res);
	if (!body.result) throw new Error(`no result: ${JSON.stringify(body).slice(0, 400)} (HTTP ${res.status})`);
	return body.result as CallResult;
}

export function payload(r: CallResult): any {
	return JSON.parse(framedPayload(r.content[0]?.text ?? ""));
}

export function errCode(r: CallResult): string | undefined {
	return r._meta?.["nourax/error"]?.code;
}

/** Requests that reached NoGantt's API, as "METHOD path". */
export function ganttCalls(fake: FakeNc): string[] {
	return fake.driveCalls().filter((c) => c.url.pathname.includes("/apps/nc_gantt/")).map((c) => `${c.method} ${c.url.pathname.replace("/ocs/v2.php/apps/nc_gantt/api/v1", "")}`);
}

export { QA };
