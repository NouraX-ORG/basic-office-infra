/**
 * Revoking an app password the connector itself just received from Login Flow v2 (DESIGN 8.2 and
 * 9): no app password the connector made is ever orphaned. Login Flow v2 hands it out only once, so
 * whoever holds it when a step fails must revoke it there and then, with the credential itself
 * (DELETE /ocs/v2.php/core/apppassword, egress row ocs-apppassword).
 *
 * Fix round 3: a failed revocation is tried once more after a second, and logged as revoke_stuck
 * (with the step as reason) when NoDrive still doesn't take it, so the owner can remove it by hand.
 *
 * Fix round 4: a 401 no longer counts as "already gone" (revokeAnswerGone below).
 */
import { config, type NxEnv } from "../env";
import { b64, utf8 } from "../core/bytes";
import { egress, readCappedJson } from "../core/egress";
import { log } from "../core/log";

/**
 * Whether a failed DELETE /ocs/v2.php/core/apppassword proves the app password is already gone, so
 * nothing is left to revoke. Only NoDrive's own answer counts (NC 35.0.2,
 * core/Controller/AppPasswordController.php, read on the server 2026-10-25): a 403 with an OCS JSON
 * body (ocs.meta.statuscode 403, or 997 in OCS v1), which the controller sends only when the
 * session has no app password or the token can't be found.
 *
 * A 401 proves nothing (fix round 4). Basic auth fails before the controller runs both when the
 * password was removed and when the account is disabled: Session::completeLogin throws
 * DisabledUserException (a LoginException, which ocs/v1.php answers 401), and User::setEnabled
 * deletes no tokens, so re-enabling the account brings every app password back. Anything else
 * proves nothing either: a plain 404 from the tunnel's catch-all ingress rule (`http_status:404`), a
 * Cloudflare block page (403, HTML), an HTML error page. Those revocations are retried.
 */
export async function revokeAnswerGone(res: Response): Promise<boolean> {
	if (res.status !== 403) return false;
	const ct = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (ct !== "application/json") return false;
	try {
		const j = await readCappedJson<{ ocs?: { meta?: { statuscode?: unknown } } }>(res, 16 * 1024);
		const code = j?.ocs?.meta?.statuscode;
		return code === 403 || code === 997;
	} catch {
		return false;
	}
}

/** One DELETE; true when NoDrive revoked it, or showed it was already gone (revokeAnswerGone). */
async function deleteOnce(env: NxEnv, loginName: string, appPassword: string): Promise<boolean> {
	const cfg = config(env);
	try {
		const res = await egress({ env }, `${cfg.driveOrigin}/ocs/v2.php/core/apppassword?format=json`, {
			method: "DELETE",
			headers: { authorization: `Basic ${b64(utf8(`${loginName}:${appPassword}`))}`, "ocs-apirequest": "true", accept: "application/json" },
		});
		const gone = res.ok || (await revokeAnswerGone(res));
		await res.body?.cancel().catch(() => undefined);
		return gone;
	} catch {
		return false;
	}
}

/** Revokes an app password we just received (our own credential). One try; true when it is gone. */
export async function revokeNewAppPassword(env: NxEnv, loginName: string, appPassword: string): Promise<boolean> {
	return deleteOnce(env, loginName, appPassword);
}

/** Why a new app password is dropped, for the revoke_stuck log line. */
export type DropReason = "refused" | "session" | "error" | "flow_server";

/**
 * Revokes a new app password, once more after a second if NoDrive didn't take it, and logs
 * revoke_stuck when it still didn't. Never throws.
 */
export async function dropNewAppPassword(env: NxEnv, loginName: string, appPassword: string, reason: DropReason, rid?: string): Promise<boolean> {
	if (await deleteOnce(env, loginName, appPassword)) return true;
	await new Promise((r) => setTimeout(r, 1000));
	if (await deleteOnce(env, loginName, appPassword)) return true;
	log({ t: "auth", rid, ev: "revoke_stuck", reason });
	return false;
}
