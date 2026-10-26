/**
 * Run-time guards for dev-only auth (DESIGN 16.2). These two checks are kept in production on
 * purpose: devMisconfigured() makes every request fail closed if QA credentials ever reach a public
 * deployment. Everything else dev-only lives in ./dev.ts and is stripped from the production bundle.
 */
import type { NxEnv } from "../env";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopbackIp(ip: string | null): boolean {
	return ip === null || ip === "" || ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/** Fails closed: QA credentials must never be present on a public deployment. */
export function devMisconfigured(env: NxEnv): boolean {
	if (!env.DEV_QA_ACCOUNTS) return false;
	try {
		return !LOOPBACK.has(new URL(env.PUBLIC_ORIGIN).hostname);
	} catch {
		return true;
	}
}

export function devActive(env: NxEnv, request: Request): boolean {
	if (env.NX_ENV !== "dev") return false;
	let pub: URL;
	let req: URL;
	try {
		pub = new URL(env.PUBLIC_ORIGIN);
		req = new URL(request.url);
	} catch {
		return false;
	}
	if (!LOOPBACK.has(pub.hostname) || !LOOPBACK.has(req.hostname)) return false;
	return isLoopbackIp(request.headers.get("cf-connecting-ip"));
}
