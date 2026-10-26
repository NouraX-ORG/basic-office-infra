/**
 * The connect step (DESIGN 8.2): one NoDrive app password per connection, through Login Flow v2.
 *
 * 1. Start: POST /index.php/login/v2 (open to everyone; WAF-exempt), check the answer, set the
 *    __Host-nx-connect cookie and store the pending flow encrypted in a ConnectFlow object.
 * 2. GET /connect: "Step 2 of 2". One button opens NoDrive's "Log in with Nourax" entry point with a
 *    redirect to the Login Flow v2 page; the person clicks Grant access. The page refreshes itself
 *    every 4 s (no JavaScript) and polls once per load, single-flight.
 * 3. Done: identity checks (cloud/user id equals the login name, a UUID, equal to the Supabase sub
 *    when that step ran, not in the admin group unless allowed, at most 5 connections). Any failure
 *    revokes the new app password at once.
 * 4. Complete: end earlier connections of the same client, store the connection in the vault, and
 *    finish the OAuth authorization (or show a desktop key, or start a /connections session).
 */
import { type AuthRequest, authorizationErrorRedirect, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { config, type NxConfig, type NxEnv } from "../env";
import { b64url, fromB64url, newId, randomBytes, sha256Hex } from "../core/bytes";
import { egress, readCappedJson } from "../core/egress";
import { isUuid } from "../core/ids";
import { secretsOk } from "../core/keys";
import { LIMITS } from "../core/limits";
import { type AuthEvent, log, pseudonym } from "../core/log";
import { clearCookie, readCookie, setCookie } from "../http/cookies";
import { esc, page } from "../http/html";
import type { AppId, Scope } from "../mcp/catalog";
import type { GrantProps } from "../mcp/context";
import { type CloudUser, createNcClient } from "../nc/client";
import type { ConnectFlow, ConnectRecord, FlowResult } from "../vault/connect-flow";
import { vaultFor } from "../vault/vault";
import { dropNewAppPassword } from "./app-password";
import { desktopKeyLifetimeSec, desktopVaultKey, newDesktopKey, storeDesktopKey } from "./conn-tokens";
import { grantIdFromRedirect } from "./grants";
import { redirectAllowed } from "./redirects";
import { issueSession } from "./session";

export const CONNECT_COOKIE = "__Host-nx-connect";
/**
 * The WAF pass of owner-yes item 2 (DESIGN 20; third system review, section 30.2). Rule 1 locks
 * NoDrive's Login Flow v2 pages to the owner's network; the cookie-gated change lets a browser
 * through only with these cookies. They do nothing until the owner makes that change.
 * - WAFFLOW_COOKIE is bound to one sign-in: its Path is that sign-in's landing page,
 *   /login/v2/flow/<its login token> (and the /index.php form), so the browser sends it there and
 *   nowhere else. The landing page is the only one that puts a login token into the NoDrive session
 *   (ClientFlowLoginV2Controller::landing, NC 35.0.2); the picker and grant pages act on the token in
 *   the session. A grant link for someone else's sign-in has no matching cookie, so the WAF stops it
 *   before its token reaches the session.
 * - WAFPASS_COOKIE opens the pages after the landing (/login/v2/flow and /login/v2/grant), which act
 *   only on the session's own token. Path=/login/v2, never Path=/.
 * Both are Domain=nourax.org, Secure, HttpOnly, SameSite=Lax and live as long as the flow (20
 * minutes). Any nourax.org host could plant a cookie of either name, with any path (docs/mcp.md 7.3).
 */
export const WAFFLOW_COOKIE = "__Secure-nx-wafflow";
export const WAFPASS_COOKIE = "__Secure-nx-wafpass";
const WAFPASS_PATHS = ["/login/v2", "/index.php/login/v2"] as const;

/** The landing page paths of one sign-in, plain and with /index.php. */
export function wafFlowPaths(loginToken: string): string[] {
	return [`/login/v2/flow/${loginToken}`, `/index.php/login/v2/flow/${loginToken}`];
}

function flowStub(env: NxEnv, cookieHashHex: string): DurableObjectStub<ConnectFlow> {
	return env.CONNECT.get(env.CONNECT.idFromName(`cf:${cookieHashHex}`));
}

/**
 * The User-Agent becomes the app password's name and the client name on NoDrive's grant page
 * ("You are about to grant "AI app (Claude)" access..."). It is deliberately plain, not a
 * Nourax-branded name: in Drive-only mode anyone who starts a connection could send that grant
 * link to someone else, and a trusted-looking name would make such phishing easier. NoDrive's
 * page already warns not to grant access unless you are setting up an app yourself.
 */
export function connectorUserAgent(label: string): string {
	const clean = label.replace(/[^A-Za-z0-9 ._-]/g, "").replace(/next\s*-?\s*cloud/gi, "").trim().slice(0, 40);
	return clean && clean !== "AI app" ? `AI app (${clean})` : "AI app";
}

/** The parent domain for the WAF pass cookie (owner-yes item 2), or null when not under nourax.org. */
function wafDomain(cfg: NxConfig): string | null {
	return cfg.publicHost === "nourax.org" || cfg.publicHost.endsWith(".nourax.org") ? "nourax.org" : null;
}

export type ConnectStart = Omit<ConnectRecord, "createdAt" | "pollToken" | "pollEndpoint" | "loginUrl" | "loginToken">;

/** Starts Login Flow v2 and answers with a redirect to /connect. `extra` carries cookies to keep. */
export async function startConnect(env: NxEnv, start: ConnectStart, extra?: Headers, rid?: string): Promise<Response> {
	const cfg = config(env);
	if (start.purpose !== "session" && !secretsOk(env)) {
		// Refuse before NoDrive makes an app password that the vault could never revoke.
		log({ t: "auth", rid, ev: "setup_fault", reason: "secrets" });
		return setupFaultPage();
	}
	const res = await egress({ env, rid }, `${cfg.driveOrigin}/index.php/login/v2`, {
		method: "POST",
		headers: { "user-agent": connectorUserAgent(start.clientLabel), accept: "application/json" },
		timeoutMs: 15_000,
	});
	if (!res.ok) {
		await res.body?.cancel();
		return page({ title: "NoDrive isn't answering", status: 502, body: "<h1>NoDrive isn't answering</h1><p>Try again in a minute from your AI app.</p>" });
	}
	const j = await readCappedJson<{ poll?: { token?: unknown; endpoint?: unknown }; login?: unknown }>(res, 16 * 1024);
	const login = typeof j.login === "string" ? j.login : "";
	const pollToken = typeof j.poll?.token === "string" ? j.poll.token : "";
	const pollEndpoint = typeof j.poll?.endpoint === "string" ? j.poll.endpoint : "";
	let loginToken = "";
	try {
		const lu = new URL(login);
		const pe = new URL(pollEndpoint);
		const m = /^\/(?:index\.php\/)?login\/v2\/flow\/([A-Za-z0-9]{16,256})$/.exec(lu.pathname);
		const okPoll = pe.origin === cfg.driveOrigin && /^\/(?:index\.php\/)?login\/v2\/poll$/.test(pe.pathname) && !pe.search;
		if (lu.origin !== cfg.driveOrigin || !m || !okPoll || !/^[A-Za-z0-9]{16,256}$/.test(pollToken)) throw new Error("bad flow");
		loginToken = m[1] as string;
	} catch {
		return page({ title: "Something went wrong", status: 502, body: "<h1>Something went wrong</h1><p>NoDrive's answer wasn't what we expected. Try again from your AI app.</p>" });
	}
	const cookie = randomBytes(32);
	const record: ConnectRecord = { ...start, createdAt: Date.now(), pollToken, pollEndpoint, loginUrl: login, loginToken };
	await flowStub(env, await sha256Hex(cookie)).start(cookie, record);
	const headers = new Headers();
	for (const c of extra?.getSetCookie?.() ?? []) headers.append("set-cookie", c);
	headers.append("set-cookie", setCookie(CONNECT_COOKIE, b64url(cookie), { maxAge: LIMITS.connectFlowSec, sameSite: "Lax" }));
	const domain = wafDomain(cfg);
	if (domain) {
		// loginToken was checked above: 16 to 256 letters and digits.
		for (const path of wafFlowPaths(loginToken)) headers.append("set-cookie", setCookie(WAFFLOW_COOKIE, "1", { maxAge: LIMITS.connectFlowSec, sameSite: "Lax", domain, path }));
		for (const path of WAFPASS_PATHS) headers.append("set-cookie", setCookie(WAFPASS_COOKIE, "1", { maxAge: LIMITS.connectFlowSec, sameSite: "Lax", domain, path }));
	}
	headers.set("location", "/connect");
	headers.set("cache-control", "no-store");
	return new Response(null, { status: 302, headers });
}

function readConnectCookie(request: Request): Uint8Array | null {
	const raw = readCookie(request, CONNECT_COOKIE);
	if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
	try {
		return fromB64url(raw);
	} catch {
		return null;
	}
}

/**
 * The connect cookie, and the WAF pass of the sign-in that ended when its login token is known (an
 * expired flow's record is gone, but its cookies expired with it). WAFPASS_COOKIE is left to expire:
 * another sign-in in the same browser may still need it, and it opens no sign-in by itself.
 */
function clearConnectCookies(cfg: NxConfig, loginToken?: string): string[] {
	const out = [clearCookie(CONNECT_COOKIE)];
	const domain = wafDomain(cfg);
	if (domain && loginToken) for (const path of wafFlowPaths(loginToken)) out.push(clearCookie(WAFFLOW_COOKIE, domain, path));
	return out;
}

function grantUrl(cfg: NxConfig, loginToken: string): string {
	const redirect = `/login/v2/flow/${loginToken}`;
	return `${cfg.driveOrigin}/apps/user_oidc/login/${cfg.oidcProviderId}?redirectUrl=${encodeURIComponent(redirect)}`;
}

export function setupFaultPage(): Response {
	return page({
		title: "Not available right now",
		status: 503,
		headers: { "retry-after": "300" },
		body: "<h1>Not available right now</h1><p>Nourax Workspace can't connect AI apps at the moment. Nothing was shared. Try again later.</p>",
	});
}

function waitingPage(cfg: NxConfig, record: ConnectRecord): Response {
	return page({
		title: "Allow access to NoDrive",
		refreshSec: 4,
		body: `<h1>Step 2 of 2: allow access to NoDrive</h1>
<p>Open NoDrive, sign in with your Nourax account if it asks, and click <strong>Grant access</strong>. This page carries on by itself once you have.</p>
<p class="muted">The access will be named "${esc(connectorUserAgent(record.clientLabel))}" in NoDrive.</p>
<p class="warn">Grant access only for a connection you started yourself just now. If someone sent you a NoDrive link asking you to grant access, don't: they would get into your files.</p>
<div class="actions"><a class="button" href="${esc(grantUrl(cfg, record.loginToken))}" target="_blank" rel="noopener noreferrer">Open NoDrive</a>
<a class="button secondary" href="/connect/cancel">Cancel</a></div>`,
	});
}

function plainPage(title: string, message: string, status = 200, headers?: Headers): Response {
	return page({ title, status, headers, body: `<h1>${esc(title)}</h1><p>${esc(message)}</p>` });
}

/** GET /connect */
export async function connectPage(request: Request, env: NxEnv, rid?: string): Promise<Response> {
	const cfg = config(env);
	const cookie = readConnectCookie(request);
	if (!cookie) return plainPage("Nothing to connect", "There's no connection in progress in this browser. Start again from your AI app.", 400);
	const stub = flowStub(env, await sha256Hex(cookie));
	const out = await stub.poll(cookie);
	if (out.state === "waiting") return waitingPage(cfg, out.record);
	if (out.state === "used") return plainPage("Already finished", "This connection was finished in another tab. You can close this one.");
	if (out.state === "expired") {
		log({ t: "auth", rid, ev: "connect_expired" });
		const h = new Headers();
		for (const c of clearConnectCookies(cfg)) h.append("set-cookie", c);
		return plainPage("This took too long", "Start again from your AI app.", 410, h);
	}
	return completeConnect(env, cfg, out.record, out.result, request, rid);
}

/**
 * GET /connect/cancel, the Cancel link on the waiting page (fix round 4).
 * - It changes state with a GET whose only proof is the SameSite=Lax connect cookie, which browsers
 *   also send on a top-level navigation from another site. So a Sec-Fetch-Site other than
 *   same-origin (our own Cancel link) or none (typed or bookmarked) is refused, and nothing is
 *   changed: another site the person opens during the 20 minutes can't end their connect.
 * - The redirect back to the app is checked against ALLOWED_REDIRECTS again, as /authorize does; if
 *   the list changed during the flow, the local "Cancelled" page is shown instead.
 */
export async function connectCancel(request: Request, env: NxEnv): Promise<Response> {
	const cfg = config(env);
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") {
		return plainPage("Not cancelled", "Cancel only from the Nourax Workspace page that is waiting for you. Nothing was changed.", 403);
	}
	const cookie = readConnectCookie(request);
	const headers = new Headers();
	if (!cookie) for (const c of clearConnectCookies(cfg)) headers.append("set-cookie", c);
	if (cookie) {
		const stub = flowStub(env, await sha256Hex(cookie));
		const record = await stub.peek(cookie);
		await stub.abandon();
		for (const c of clearConnectCookies(cfg, record?.loginToken)) headers.append("set-cookie", c);
		if (record?.authRequest && redirectAllowed(record.authRequest.redirectUri, cfg.allowedRedirects)) {
			headers.set("location", authorizationErrorRedirect(record.authRequest, "access_denied", "The person cancelled."));
			return new Response(null, { status: 302, headers });
		}
	}
	return plainPage("Cancelled", "Nothing was connected. You can close this tab.", 200, headers);
}

// Revoking an app password we just received (our own credential), whenever a step fails.
export { revokeNewAppPassword } from "./app-password";

export type IdentityCheck = { ok: true } | { ok: false; ev: AuthEvent; message: string; status?: number };

/** The identity checks of 8.2 step 3, in order. */
export function checkIdentity(cfg: NxConfig, user: CloudUser, result: FlowResult, record: Pick<ConnectRecord, "sub">): IdentityCheck {
	if (!user.id || user.id !== result.loginName) {
		return { ok: false, ev: "uid_mismatch", message: "NoDrive answered for a different account than the one that granted access. Try again." };
	}
	if (!isUuid(user.id)) {
		return { ok: false, ev: "non_uuid_refused", message: "Only Nourax accounts (signed in with \"Log in with Nourax\") can be connected to AI assistants." };
	}
	if (record.sub !== undefined && record.sub !== user.id) {
		return { ok: false, ev: "uid_mismatch", message: "You approved with a different NoDrive account. Sign out of NoDrive and try again." };
	}
	// The admin refusal fails closed: without a readable group list nobody is connected.
	if (user.groups === null) {
		return {
			ok: false,
			ev: "groups_unreadable",
			status: 502,
			message: "NoDrive didn't say which groups this account is in, so it couldn't be checked. Nothing was connected. Tell the person who runs Nourax Workspace.",
		};
	}
	if (user.groups.includes("admin") && !cfg.allowAdminUids.has(user.id)) {
		return { ok: false, ev: "admin_refused", message: "Admin accounts can't be connected to AI assistants. Use a normal Nourax account." };
	}
	return { ok: true };
}

/**
 * The last step of a connect (8.2 step 3 on): checks, then the vault record, then the grant. Login
 * Flow v2 handed out the app password once, so until the vault holds it (or it was dropped on
 * purpose) this function owns it: any refusal, and since fix round 3 any exception too (a Vault RPC
 * that throws, a storage error), revokes it before answering, so it is never orphaned.
 */
async function completeConnect(env: NxEnv, cfg: NxConfig, record: ConnectRecord, result: FlowResult, request: Request, rid?: string): Promise<Response> {
	const headers = new Headers();
	for (const c of clearConnectCookies(cfg, record.loginToken)) headers.append("set-cookie", c);
	const state = { owned: true };
	try {
		return await finishConnect(env, cfg, record, result, request, headers, state, rid);
	} catch {
		if (state.owned) await dropNewAppPassword(env, result.loginName, result.appPassword, "error", rid);
		log({ t: "auth", rid, ev: "setup_fault", reason: "connect_exception", cli: record.cli });
		return plainPage("Not connected", "Something went wrong while connecting. Nothing was shared. Try again in a minute.", 500, headers);
	}
}

async function finishConnect(
	env: NxEnv,
	cfg: NxConfig,
	record: ConnectRecord,
	result: FlowResult,
	request: Request,
	headers: Headers,
	state: { owned: boolean },
	rid?: string,
): Promise<Response> {
	const refuse = async (ev: AuthEvent, message: string, status = 403) => {
		state.owned = false;
		await dropNewAppPassword(env, result.loginName, result.appPassword, "refused", rid);
		log({ t: "auth", rid, ev, cli: record.cli });
		return plainPage("Not connected", message, status, headers);
	};

	// The code goes to the app's redirect only while it is still on the allowlist: ALLOWED_REDIRECTS
	// may have shrunk (and been deployed) in the 20 minutes since consent (DESIGN 29.2). Checked before
	// anything else, so nothing is stored, no earlier connection is ended and the new app password is
	// revoked.
	if (record.authRequest && !redirectAllowed(record.authRequest.redirectUri, cfg.allowedRedirects)) {
		return refuse("redirect_rejected", "This app's return address is no longer allowed. Nothing was shared.", 400);
	}

	let user: CloudUser;
	try {
		const nc = createNcClient({ env, cfg, uid: result.loginName, cred: { loginName: result.loginName, appPassword: result.appPassword }, rid });
		user = await nc.cloudUser();
	} catch {
		return refuse("uid_mismatch", "NoDrive couldn't confirm the account. Try again from your AI app.", 502);
	}
	const check = checkIdentity(cfg, user, result, record);
	if (!check.ok) return refuse(check.ev, check.message, check.status);
	const uid = user.id;
	log({ t: "auth", rid, ev: "drive_ok", who: await pseudonym(env, uid, 12), cli: record.cli });

	if (record.purpose === "session") {
		// /connections sign-in: we only needed to know who it is. Drop the new app password.
		state.owned = false;
		await dropNewAppPassword(env, result.loginName, result.appPassword, "session", rid);
		const { cookie } = await issueSession(env, uid);
		headers.append("set-cookie", cookie);
		headers.set("location", "/connections");
		return new Response(null, { status: 302, headers });
	}

	const vault = vaultFor(env, uid);
	const connectionId = newId();
	const isDesktop = record.purpose === "desktop";
	let useKey: Uint8Array;
	let desktopKey: string | null = null;
	if (isDesktop) {
		desktopKey = newDesktopKey();
		useKey = await desktopVaultKey(env, desktopKey, connectionId);
	} else {
		useKey = randomBytes(32);
	}
	if (!secretsOk(env)) {
		return refuse("setup_fault", "Nourax Workspace can't connect AI apps at the moment. Nothing was shared. Try again later.", 503);
	}
	if (!isDesktop && record.clientId) await vault.revokeForClient(record.clientId, "replaced");
	const lifetime = isDesktop ? desktopKeyLifetimeSec(record.desktop?.days ?? 30) : LIMITS.maxGrantAgeSec;
	let created: Awaited<ReturnType<typeof vault.createConnection>>;
	try {
		created = await vault.createConnection(
			{
				connectionId,
				uid,
				kind: isDesktop ? "desktop" : "oauth",
				clientId: record.clientId,
				clientLabel: record.clientLabel,
				scopes: record.scopes,
				apps: record.apps,
				cred: { loginName: result.loginName, appPassword: result.appPassword },
				displayName: user.displayName,
				upstream: record.upstream ?? null,
				idleSec: isDesktop ? LIMITS.desktopIdleSec : LIMITS.idleSec,
				maxAgeSec: lifetime,
			},
			useKey,
		);
	} catch {
		// Not stored, so nothing could ever revoke it later: revoke it now.
		return refuse("setup_fault", "Nourax Workspace couldn't save this connection. Nothing was shared. Try again in a minute.", 503);
	}
	if (!created.ok) {
		return refuse("connect_cap", `You already have ${LIMITS.connectionsPerPerson} AI connections. End one at ${cfg.publicOrigin}/connections and try again.`, 409);
	}
	// From here the vault holds the app password: ending the connection revokes it.
	state.owned = false;
	if (created.replaced) log({ t: "auth", rid, ev: "replaced" });

	if (isDesktop && desktopKey) {
		const now = Math.floor(Date.now() / 1000);
		try {
			await storeDesktopKey(env, desktopKey, {
				uid,
				connectionId,
				expiresAt: now + lifetime,
				label: record.desktop?.label ?? record.clientLabel,
				...(record.desktop?.ipLock ? { ipLock: record.desktop.ipLock } : {}),
			});
		} catch {
			// The key can't be looked up, so the connection is unusable: end it (this revokes the app password).
			await vault.revokeAndWipe(connectionId, "not_completed").catch(() => undefined);
			return plainPage("Not connected", "The desktop key couldn't be saved. Nothing was shared. Try again in a minute.", 503, headers);
		}
		return desktopKeyPage(cfg, desktopKey, headers);
	}

	const helpers = env.OAUTH_PROVIDER as OAuthHelpers;
	const ar = record.authRequest as AuthRequest;
	const props: GrantProps = {
		v: 1,
		kind: "oauth",
		uid,
		connectionId,
		vaultKey: b64url(useKey),
		connectedAt: Math.floor(Date.now() / 1000),
		clientLabel: record.clientLabel,
	};
	let redirectTo: string;
	try {
		({ redirectTo } = await helpers.completeAuthorization({
			request: ar,
			userId: uid,
			scope: record.scopes,
			props,
			metadata: { connectionId, clientLabel: record.clientLabel, kind: "oauth", connectedAt: props.connectedAt },
		}));
	} catch {
		// No grant, so no token will ever reach this connection: end it (this revokes the app password).
		await vault.revokeAndWipe(connectionId, "not_completed").catch(() => undefined);
		return plainPage("Not connected", "The sign-in couldn't be finished. Nothing was shared. Start again from your AI app.", 400, headers);
	}
	// Bind the grant now (the code exchange binds it again), so the vault's grant check can end
	// this connection if the client revokes it or never exchanges the code.
	const grantId = grantIdFromRedirect(redirectTo, uid);
	if (grantId) await vault.bindGrant(connectionId, grantId).catch(() => undefined);
	log({ t: "auth", rid, ev: "consent_ok", who: await pseudonym(env, uid, 12), cli: record.cli });
	headers.set("location", redirectTo);
	return new Response(null, { status: 302, headers });
}

function desktopKeyPage(cfg: NxConfig, key: string, headers: Headers): Response {
	const json = JSON.stringify({ url: `${cfg.publicOrigin}/mcp`, headers: { Authorization: `Bearer ${key}` } });
	return page({
		title: "Your desktop key",
		headers,
		body: `<h1>Your desktop key</h1>
<p>Copy it now: it is shown only once. Anyone who has it can use this connection until it ends.</p>
<p><code class="key">${esc(key)}</code></p>
<h2>In ONLYOFFICE Desktop Editors</h2>
<p>AI Tools, then Settings, then MCP Servers: add a server named <code>nourax</code> with this setting:</p>
<p><code class="key">${esc(json)}</code></p>`,
	});
}

/** The scopes and apps from a consent form, cleaned: workspace.read is always kept. */
export function cleanChoice(scopes: readonly string[], apps: readonly string[], allowedScopes: readonly Scope[], allowedApps: readonly AppId[]): { scopes: Scope[]; apps: AppId[] } {
	const s = new Set<Scope>(["workspace.read"]);
	for (const x of scopes) if ((allowedScopes as readonly string[]).includes(x)) s.add(x as Scope);
	const a = new Set<AppId>();
	for (const x of apps) if ((allowedApps as readonly string[]).includes(x)) a.add(x as AppId);
	return { scopes: allowedScopes.filter((x) => s.has(x)), apps: allowedApps.filter((x) => a.has(x)) };
}
