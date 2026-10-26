/**
 * Builds the MailContext for one request (DESIGN 13.1): when mail is active and why it isn't.
 *
 * mail_state "reconnect_needed" with a live upstream session (upstream_state "ok") doesn't switch
 * mail off on its own (DESIGN 29.6): it was set by an earlier answer, and only a dead upstream
 * session can't come back. Such a request starts with one forced refresh, passing the token it holds
 * so that two requests at once rotate the refresh token only once; a refresh that works sets
 * mail_state back to "ok" in the vault, and one the vault calls dead marks it again.
 */
import type { NxConfig, NxEnv } from "../env";
import type { MailContext } from "../core/mail-contract";
import type { OpenOk } from "../vault/schema";
import type { Vault } from "../vault/vault";
import type { AppId, Scope } from "./catalog";

export function mailContext(o: {
	env: NxEnv;
	cfg: NxConfig;
	rid: string;
	open: OpenOk;
	scopes: readonly Scope[];
	apps: readonly AppId[];
	vault: DurableObjectStub<Vault>;
	connectionId: string;
	useKey: Uint8Array;
}): MailContext {
	const configured = o.cfg.nomailToolsUrl !== null && Boolean(o.env.NOMAIL_TOOLS_KEY);
	const read = o.scopes.includes("mail.read");
	const write = o.scopes.includes("mail.write");
	let state: MailContext["state"];
	if (!configured || o.open.upstream.state === "none") state = "not_set_up";
	else if (o.open.upstream.state === "dead") state = "reconnect_needed";
	else if (!(read || write) || !o.apps.includes("mail")) state = "off";
	else state = "on";
	let token = o.open.upstream.accessToken ?? null;
	let expiresAt = o.open.upstream.expiresAt ?? 0;
	// The live session behind an earlier "reconnect_needed": refresh once before using it.
	let recheck = o.open.mailState === "reconnect_needed" && o.open.upstream.state === "ok";
	return {
		env: o.env,
		cfg: o.cfg,
		rid: o.rid,
		active: state === "on",
		state,
		scopes: { read, write },
		async upstreamToken() {
			if (!recheck && token && expiresAt - Math.floor(Date.now() / 1000) > 300) return token;
			const force = recheck;
			recheck = false;
			const r = await o.vault.refreshUpstream(o.connectionId, o.useKey, force, force ? (token ?? undefined) : undefined);
			if ("dead" in r) return null;
			token = r.accessToken;
			expiresAt = r.expiresAt;
			return token;
		},
		async refreshUpstream(used?: string) {
			const r = await o.vault.refreshUpstream(o.connectionId, o.useKey, true, used);
			if ("dead" in r) return null;
			token = r.accessToken;
			expiresAt = r.expiresAt;
			return token;
		},
		cache: {
			get: () => o.vault.mailCache(o.connectionId, o.useKey, "get"),
			put: async (value, ttlSec) => {
				await o.vault.mailCache(o.connectionId, o.useKey, "put", value, ttlSec);
			},
			fail: () => o.vault.mailCache(o.connectionId, o.useKey, "fail"),
		},
		setState: (s) => o.vault.setMailState(o.connectionId, s),
	};
}
