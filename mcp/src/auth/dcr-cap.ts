/**
 * The daily cap on client registrations (DESIGN 14 and 22; third system review, section 30.1).
 *
 * A unit is taken inside the library's registration callback, after the library has read the JSON
 * and checked the metadata (resolveDynamicClientRegistrationMetadata in
 * @cloudflare/workers-oauth-provider 1.2.4) and after our own policy (dcr.ts), and right before its
 * one KV write (putRegisteredClient). So a malformed body, a refused redirect or any other refused
 * registration never uses the cap: it is counted only for registrations that are stored.
 *
 * The callback gets only a clone of the request, so the router hands it the request's env and caller
 * through a random id in an internal header (set by the router after it drops any header of that
 * name the caller sent). The callback answers the cap in OAuth JSON; the router adds Retry-After.
 */
import type { ClientRegistrationCallbackResult } from "@cloudflare/workers-oauth-provider";
import type { NxEnv } from "../env";
import { newId } from "../core/bytes";
import { takeDaily } from "../vault/quota";

export const ADMIT_HEADER = "x-nx-dcr-admit";

interface Admission {
	env: NxEnv;
	ip: string;
	/** Set when the cap refused the registration (or couldn't be read): what the router adds. */
	retryAfterSec?: number;
}

const pending = new Map<string, Admission>();
/** A request that never comes back to the router can't make this grow for ever. */
const PENDING_MAX = 1_000;

/** Called by the router before the library runs: the id to put in ADMIT_HEADER. */
export function beginAdmission(env: NxEnv, ip: string): string {
	// The oldest first (a Map keeps insertion order); one that is dropped while still in flight is
	// refused (fail closed), never counted twice.
	while (pending.size >= PENDING_MAX) {
		const oldest = pending.keys().next().value;
		if (oldest === undefined) break;
		pending.delete(oldest);
	}
	const id = newId();
	pending.set(id, { env, ip });
	return id;
}

/** Called by the router once the library answered: Retry-After seconds when the cap refused, else null. */
export function endAdmission(id: string): number | null {
	const a = pending.get(id);
	pending.delete(id);
	return a?.retryAfterSec ?? null;
}

/**
 * The registration callback's last step: one unit of the daily cap, or the refusal to send. Without
 * the router's admission (never the case through the Worker) it fails closed, as an unreachable
 * Quota object does: nothing is written without a count.
 */
export async function admitRegistration(request: Request): Promise<ClientRegistrationCallbackResult | undefined> {
	const id = request.headers.get(ADMIT_HEADER) ?? "";
	const a = /^[0-9a-f]{32}$/.test(id) ? pending.get(id) : undefined;
	if (!a) return { code: "temporarily_unavailable", description: "Try again in a minute.", status: 503 };
	let r: Awaited<ReturnType<typeof takeDaily>>;
	try {
		r = await takeDaily(a.env, "register", a.ip);
	} catch {
		// No count, no write: fail closed.
		a.retryAfterSec = 60;
		return { code: "temporarily_unavailable", description: "Try again in a minute.", status: 503 };
	}
	if (r.ok) return undefined;
	a.retryAfterSec = r.retryAfterSec;
	return { code: "slow_down", description: "Too many app registrations today. Try again tomorrow.", status: 429 };
}
