/**
 * Dev-only parts of /connections (DESIGN 16), for `wrangler dev --env dev` on this PC only.
 *
 * Every call site sits inside `if (__NX_DEV_AUTH__ && devActive(env, request))`, so the production
 * build drops the calls and tree-shakes this module out; the predeploy bundle check looks for the
 * dev marker. In dev, QA accounts have no browser for Login Flow v2, so:
 * - sign-in offers a QA-account picker that starts the page session directly;
 * - a desktop key is backed by the QA account's app password from the dev env file. Its vault row
 *   has kind "dev", so ending it never revokes that shared app password (the vault skips the revoke
 *   for dev rows). Like every dev row it is checked against an OAuth grant after an hour and then
 *   ends, which is plenty for live tests.
 */
import { desktopKeyLifetimeSec, desktopVaultKey, newDesktopKey, storeDesktopKey } from "../../auth/conn-tokens";
import { DEV_MARKER, devQaAccounts } from "../../auth/dev";
import type { NxConfig, NxEnv } from "../../env";
import { newId } from "../../core/bytes";
import { LIMITS } from "../../core/limits";
import { esc, page } from "../../http/html";
import { vaultFor } from "../../vault/vault";
import { desktopKeySetting, type KeyFormValues } from "./views";

/** The QA picker on the sign-in form. Never shows a password. */
export function devSignInExtras(env: NxEnv): string {
	const uids = Object.keys(devQaAccounts(env)).sort();
	if (!uids.length) return "";
	const opts = uids.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join("");
	return `<fieldset><legend>Dev only: QA account</legend>
<label><input type="checkbox" name="dev" value="1" checked>Sign in as this QA account instead of through NoDrive</label>
<select name="dev_uid">${opts}</select>
<p class="muted" data-marker="${DEV_MARKER}">Local development: this replaces the NoDrive sign-in step.</p></fieldset>`;
}

/** The uid to sign in as, when the dev picker was used with a known QA account. */
export function devPickedUid(env: NxEnv, form: URLSearchParams): string | null {
	if (form.get("dev") !== "1") return null;
	const uid = String(form.get("dev_uid") ?? "");
	return devQaAccounts(env)[uid] ? uid : null;
}

export function devKeyNote(): string {
	return `<p class="muted" data-marker="${DEV_MARKER}">Dev only: the key is made at once with the QA account's app password, without NoDrive's grant step, and works for about an hour.</p>`;
}

/**
 * Makes a desktop key for a QA account straight away. Returns null when the uid isn't a QA account
 * from the dev env file (a real account in dev goes through NoDrive like production).
 */
export async function devCreateDesktopKey(
	env: NxEnv,
	cfg: NxConfig,
	uid: string,
	v: KeyFormValues,
	ipLock: string | undefined,
): Promise<Response | null> {
	const pass = devQaAccounts(env)[uid];
	if (!pass) return null;
	const connectionId = newId();
	const key = newDesktopKey();
	const lifetime = desktopKeyLifetimeSec(v.days);
	const vault = vaultFor(env, uid);
	const created = await vault.createConnection(
		{
			connectionId,
			uid,
			kind: "dev",
			clientLabel: v.label,
			scopes: v.scopes,
			apps: v.apps,
			cred: { loginName: uid, appPassword: pass },
			displayName: null,
			upstream: null,
			idleSec: LIMITS.desktopIdleSec,
			maxAgeSec: lifetime,
		},
		await desktopVaultKey(env, key, connectionId),
	);
	if (!created.ok) {
		return page({ title: "Not made", status: 409, https: false, body: `<h1>Not made</h1><p>You already have ${LIMITS.connectionsPerPerson} connections. End one first.</p>` });
	}
	try {
		await storeDesktopKey(env, key, {
			uid,
			connectionId,
			expiresAt: Math.floor(Date.now() / 1000) + lifetime,
			label: v.label,
			...(ipLock ? { ipLock } : {}),
		});
	} catch {
		await vault.revokeAndWipe(connectionId, "not_completed").catch(() => undefined);
		return page({ title: "Not made", status: 503, https: false, body: "<h1>Not made</h1><p>The key couldn't be saved. Try again.</p>" });
	}
	const json = desktopKeySetting(cfg.publicOrigin, key);
	const headers = new Headers({ "x-nx-dev": DEV_MARKER });
	return page({
		title: "Your desktop key",
		https: false,
		headers,
		body: `<h1>Your desktop key</h1>
<p>Copy it now: it is shown only once.</p>
<p><code class="key" data-desktop-key>${esc(key)}</code></p>
<p><code class="key">${esc(json)}</code></p>
<p class="muted" data-marker="${DEV_MARKER}">Dev only: backed by the QA account's app password.</p>
<p><a href="/connections">Back to your connections</a></p>`,
	});
}
