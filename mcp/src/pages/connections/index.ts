/**
 * The /connections pages (lane F; DESIGN 6.6, 9.1, 9.3, 18.3 and 18.4): a person signs in, sees
 * which AI apps and desktop keys can act as them, ends any of them, tidies up ended connections
 * whose NoDrive access must be removed by hand, and makes desktop keys for ONLYOFFICE.
 *
 * Routes (core routes every /connections request here; RL_PAGES applies to all of them):
 *   GET  /connections            signed in: the list; signed out: the sign-in button
 *   POST /connections/sign-in    starts NoDrive's Login Flow v2 for a page session (purpose "session")
 *   POST /connections/sign-out   ends the page session, in every browser (session-end.ts); with no live
 *                                session in this browser it ends nothing and says so ("already-out")
 *   POST /connections/end        ends one connection: revokes its app password, wipes it, revokes its grant
 *   POST /connections/forget     clears an "ended, but not fully removed" note (Vault.clearUnrevoked)
 *   GET  /connections/new-key    the "Make a desktop key" form
 *   POST /connections/new-key    starts Login Flow v2 for a desktop key (purpose "desktop")
 *   GET  /connections/callback   back from "Log in with Nourax" (only when the upstream step is on; upstream.ts)
 *
 * Every POST: sameOrigin(), readSmallForm() (16 KB, form encoding only) and a CSRF token (forms.ts).
 * Every request that carries a page session reads it through currentSession() (session-end.ts),
 * which also honours a sign-out made in another browser.
 * The person is always the session's uid; a connection id from a form is looked up only in that
 * person's own vault, so nobody can end someone else's connection.
 * A notice after an action (?n=<code>) shows only in the browser that did it (notice.ts): the
 * action's 303 sets a short-lived cookie with the same code. A link with ?n= alone shows nothing.
 *
 * Sign-in: with "Log in with Nourax" on, the page signs in through it (upstream.ts), so no NoDrive
 * grant link exists that could be sent to someone else. In Drive-only mode it signs in through
 * NoDrive's Login Flow v2 (purpose "session"). Every start of a Login Flow v2 (that sign-in and every
 * desktop key) counts against RL_AUTHZ and the page's own exact daily cap (the Quota object,
 * "page_signin"): each one makes a NoDrive login-flow row and a ConnectFlow object. It is not the
 * "authorize" cap of GET /authorize (DESIGN 29.1): someone who uses up the day's AI-app sign-ins
 * must not also lock everybody out of this page, the one place most people can end a connection.
 */
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { setupFaultPage, startConnect } from "../../auth/connect";
import { allowedApps, allowedScopes } from "../../auth/consent";
import { devActive } from "../../auth/dev-guard";
import { checkCsrf, csrfToken, issueSession, SESSION_COOKIE, sameOrigin, type Session } from "../../auth/session";
import { config, type NxConfig, type NxEnv } from "../../env";
import { secretOk, secretsOk } from "../../core/keys";
import { LIMITS } from "../../core/limits";
import { log, pseudonym } from "../../core/log";
import { allowRate } from "../../core/ratelimit";
import { clearCookie } from "../../http/cookies";
import { errorPage, page } from "../../http/html";
import { ridOf } from "../../http/rid";
import type { AppId, Scope } from "../../mcp/catalog";
import { ipBucket, takeDaily } from "../../vault/quota";
import { vaultFor } from "../../vault/vault";
import { devCreateDesktopKey, devKeyNote, devPickedUid, devSignInExtras } from "./dev";
import { CONNECTION_ID_RE, checkPreCsrf, clearPreCookie, issuePreCsrf, parseKeyForm, readForm } from "./forms";
import { forgetDesktopKey } from "./key-record";
import { homeWith, shownNotice } from "./notice";
import { currentSession, endPageSessions } from "./session-end";
import { beginSessionUpstream, sessionCallback } from "./upstream";
import { bounceHtml, KEY_FORM_DEFAULTS, type KeyFormValues, keyFormHtml, listHtml, type NoticeCode, noticeOf, SESSION_LABEL, signInHtml } from "./views";

const TITLE = "Your AI connections";

function seeOther(location: string, cookies: string[] = []): Response {
	const h = new Headers({ location, "cache-control": "no-store" });
	for (const c of cookies) h.append("set-cookie", c);
	return new Response(null, { status: 303, headers: h });
}

/** The 303 back to the list. A notice goes with its cookie, so only this browser sees it (notice.ts). */
function toHome(notice?: NoticeCode, cookies: string[] = []): Response {
	const to = homeWith(notice);
	return seeOther(to.location, [...cookies, ...to.cookies]);
}

function notAllowed(allow: string): Response {
	const res = errorPage("Not allowed", "That doesn't work on this page.", 405);
	res.headers.set("allow", allow);
	return res;
}

function busy(): Response {
	const res = errorPage("Try again in a minute", "Nourax Workspace is busy. Nothing was changed. Try again in a minute.", 503);
	res.headers.set("retry-after", "60");
	return res;
}

function slowDown(): Response {
	const res = errorPage("Slow down", "Too many sign-ins from your network. Try again in a minute.", 429);
	res.headers.set("retry-after", "60");
	return res;
}

function crossSite(): Response {
	return errorPage("Not allowed", "This form must be sent from the Nourax Workspace page.", 403);
}

function expiredForm(): Response {
	return errorPage("This page has expired", "Open your connections again and try once more.", 403);
}

function driveDown(): Response {
	return page({ title: "NoDrive isn't answering", status: 502, body: "<h1>NoDrive isn't answering</h1><p>Nothing was changed. Try again in a minute.</p>" });
}

/** Per-IP budget for starting NoDrive sign-ins from this page (each one is a Login Flow v2 and a ConnectFlow object). */
async function startAllowed(env: NxEnv, request: Request): Promise<boolean> {
	return allowRate(env.RL_AUTHZ, `conn:${ipBucket(request.headers.get("cf-connecting-ip") ?? "local")}`);
}

/**
 * One unit of this page's exact daily cap on sign-in starts (DESIGN 14 and 29.1, "page_signin": 30
 * per network and 20,000 in all per UTC day, with a reserve of 5 per network that the global cap
 * can't take), taken only for a checked request and before NoDrive or a ConnectFlow object is asked;
 * or the page to answer instead. The Quota object out of reach: 503 (fail closed).
 */
async function dailyStartCap(env: NxEnv, request: Request): Promise<Response | null> {
	let r: Awaited<ReturnType<typeof takeDaily>>;
	try {
		r = await takeDaily(env, "page_signin", request.headers.get("cf-connecting-ip") ?? "local");
	} catch {
		return busy();
	}
	if (r.ok) return null;
	const res =
		r.scope === "global"
			? errorPage("Too many sign-ins today", "Nourax Workspace has started too many sign-ins today. Try again tomorrow. Your connections keep working.", 429)
			: errorPage("Too many sign-ins today", "Too many sign-ins were started from your network today. Try again tomorrow. Your connections keep working.", 429);
	res.headers.set("retry-after", String(r.retryAfterSec));
	return res;
}

/** Capabilities and apps a desktop key may have: never mail (a key has no "Log in with Nourax" session). */
function keyChoices(cfg: NxConfig, env: NxEnv): { scopes: Scope[]; apps: AppId[] } {
	return {
		scopes: allowedScopes(cfg, env).filter((s) => !s.startsWith("mail.")),
		apps: allowedApps(cfg, env).filter((a) => a !== "mail"),
	};
}

/** Same origin, a small form, a live session and its CSRF token: the gate for every signed-in POST. */
async function signedInPost(request: Request, env: NxEnv, cfg: NxConfig): Promise<{ session: Session; form: URLSearchParams } | Response> {
	if (!sameOrigin(request, cfg.publicOrigin)) return crossSite();
	const form = await readForm(request);
	if (form instanceof Response) return form;
	const session = await currentSession(env, request);
	if (!session) return toHome("expired");
	if (!(await checkCsrf(env, session, form.get("csrf")))) return expiredForm();
	return { session, form };
}

export async function connectionsRoute(request: Request, env: NxEnv, ctx: ExecutionContext): Promise<Response> {
	void ctx;
	const url = new URL(request.url);
	const p = url.pathname.replace(/\/+$/, "") || "/";
	const m = request.method;
	let cfg: NxConfig;
	try {
		cfg = config(env);
	} catch {
		return busy();
	}
	// Sessions and CSRF tokens are HMACs under NX_SECRET's subkeys: without it nothing here can work.
	if (!secretOk(env.NX_SECRET)) {
		log({ t: "auth", rid: ridOf(request), ev: "setup_fault", reason: "nx_secret" });
		return setupFaultPage();
	}
	try {
		switch (p) {
			case "/connections":
				return m === "GET" || m === "HEAD" ? await showHome(request, env, cfg) : notAllowed("GET, HEAD");
			case "/connections/sign-in":
				return m === "POST" ? await signIn(request, env, cfg) : notAllowed("POST");
			case "/connections/sign-out":
				return m === "POST" ? await signOut(request, env, cfg) : notAllowed("POST");
			case "/connections/end":
				return m === "POST" ? await endConnection(request, env, cfg) : notAllowed("POST");
			case "/connections/forget":
				return m === "POST" ? await forgetUnrevoked(request, env, cfg) : notAllowed("POST");
			case "/connections/new-key":
				if (m === "GET" || m === "HEAD") return await showKeyForm(request, env, cfg);
				return m === "POST" ? await newKey(request, env, cfg) : notAllowed("GET, HEAD, POST");
			case "/connections/callback":
				return m === "GET" ? await sessionCallback(request, env, cfg, ridOf(request)) : notAllowed("GET");
			default:
				return errorPage("Not found", "There's nothing here.", 404);
		}
	} catch {
		// A Durable Object or NoDrive outage: say so plainly, never a stack or an upstream text.
		return busy();
	}
}

async function showHome(request: Request, env: NxEnv, cfg: NxConfig): Promise<Response> {
	const url = new URL(request.url);
	const asked = url.searchParams.get("n");
	const session = await currentSession(env, request);
	const https = cfg.env !== "dev";
	// The session cookie is SameSite=Strict, so a link from another site (an AI app's chat, an email)
	// arrives without it. Reload once from this page, which sends it; `b=1` stops a second round.
	// A notice code stays in the address: its note cookie (also SameSite=Strict) is sent on the reload.
	if (!session && request.headers.get("sec-fetch-site") === "cross-site" && url.searchParams.get("b") !== "1") {
		const code = noticeOf(asked);
		const target = code ? `/connections?b=1&n=${code}` : "/connections?b=1";
		return page({ title: TITLE, https, headers: { refresh: `0; url=${target}` }, body: bounceHtml(code ? target : "/connections") });
	}
	// Shown only when this browser's own action set it (notice.ts); the note is cleared either way.
	const { notice, clear } = shownNotice(request, asked, session !== null);
	const headers = new Headers();
	if (clear) headers.append("set-cookie", clear);
	if (session) {
		const vault = vaultFor(env, session.uid);
		const [connections, unrevoked] = await Promise.all([vault.listConnections(), vault.listUnrevoked()]);
		return page({ title: TITLE, https, headers, body: listHtml({ connections, unrevoked, csrf: await csrfToken(env, session), notice }) });
	}
	const pre = await issuePreCsrf(env);
	headers.append("set-cookie", pre.cookie);
	// Inline guard so the production build folds the dev picker away (DESIGN 16.2).
	const devExtras = __NX_DEV_AUTH__ && devActive(env, request) ? devSignInExtras(env) : "";
	return page({
		title: TITLE,
		https,
		headers,
		body: signInHtml({ csrf: pre.token, notice, devExtras, upstream: cfg.upstreamOn, host: cfg.publicHost }),
	});
}

async function signIn(request: Request, env: NxEnv, cfg: NxConfig): Promise<Response> {
	const rid = ridOf(request);
	if (!sameOrigin(request, cfg.publicOrigin)) return crossSite();
	const form = await readForm(request);
	if (form instanceof Response) return form;
	if (!(await checkPreCsrf(env, request, form.get("csrf")))) return errorPage("This page has expired", "Open your connections again and sign in from there.", 403);
	const dev = __NX_DEV_AUTH__ && devActive(env, request);
	if (__NX_DEV_AUTH__ && dev) {
		const uid = devPickedUid(env, form);
		if (uid) {
			const { cookie } = await issueSession(env, uid);
			return toHome(undefined, [cookie, clearPreCookie()]);
		}
	}
	if (!dev && !(await startAllowed(env, request))) {
		log({ t: "auth", rid, ev: "rate_limited", reason: "connections" });
		return slowDown();
	}
	// "Log in with Nourax" on: sign in with it. Nothing is written on our side and NoDrive is not asked.
	if (cfg.upstreamOn) return beginSessionUpstream(env, cfg, [clearPreCookie()]);
	if (!dev) {
		const capped = await dailyStartCap(env, request);
		if (capped) return capped;
	}
	const extra = new Headers();
	extra.append("set-cookie", clearPreCookie());
	try {
		// The page only needs to know who it is: the connect step asks NoDrive to revoke this app
		// password once and starts the session (auth/connect.ts, purpose "session"). It doesn't check
		// NoDrive's answer yet (lane F notes, fix round 3), so the page text never says the removal
		// worked (SESSION_GRANT_FATE in views.ts).
		return await startConnect(env, { purpose: "session", clientLabel: SESSION_LABEL, scopes: [], apps: [], cli: "other" }, extra, rid);
	} catch {
		return driveDown();
	}
}

async function signOut(request: Request, env: NxEnv, cfg: NxConfig): Promise<Response> {
	if (!sameOrigin(request, cfg.publicOrigin)) return crossSite();
	const form = await readForm(request);
	if (form instanceof Response) return form;
	const session = await currentSession(env, request);
	// No live session in this browser: it lapsed after 30 minutes (a tab left open), the cookie is
	// damaged, or this person already signed out. Nothing can be ended elsewhere then (whose sign-ins
	// would it be?), so the page says so and never claims "every browser" (second review, fix round 3).
	if (!session) return toHome("already-out", [clearCookie(SESSION_COOKIE)]);
	if (!(await checkCsrf(env, session, form.get("csrf")))) return expiredForm();
	// Ends every page session of this person issued until now, in every browser (session-end.ts),
	// not only this browser's cookie.
	const everywhere = await endPageSessions(env, session);
	log({ t: "auth", rid: ridOf(request), ev: "revoked", reason: everywhere ? "page_sign_out" : "page_sign_out_local", who: await pseudonym(env, session.uid, 12) });
	return toHome(everywhere ? "signed-out" : "signed-out-here", [clearCookie(SESSION_COOKIE)]);
}

async function endConnection(request: Request, env: NxEnv, cfg: NxConfig): Promise<Response> {
	const gate = await signedInPost(request, env, cfg);
	if (gate instanceof Response) return gate;
	const { session, form } = gate;
	const id = String(form.get("connection_id") ?? "");
	if (!CONNECTION_ID_RE.test(id)) return errorPage("Not valid", "That isn't one of your connections.", 400);
	// Only this person's own vault is asked: an id from someone else's vault is simply not found.
	const vault = vaultFor(env, session.uid);
	const row = (await vault.listConnections()).find((c) => c.connectionId === id);
	if (!row) return toHome("gone");
	if (row.status === "revoking") return toHome("ending");
	// The library grant behind an AI app's connection, so its tokens die too. Desktop keys have no
	// grant: the wiped vault row refuses the key at once (every call opens the vault). Its KV record
	// (ct:<hash>: uid, connection id, label, dates, format version, IP lock; no secret) is deleted
	// here through the index core's storeDesktopKey writes (key-record.ts) once lane F's core patch
	// "ct index" is applied. Until then there is no index: the record goes the next time the key is
	// presented and reaches the vault (core's endAccess in mcp/handler.ts deletes it when the vault
	// row is missing; a key presented from outside its IP lock is refused before that), or at its KV
	// expiry (at most 60 days). docs/mcp.md 7.6 says which, tied by the drift test in
	// test/pages/connections.test.ts.
	const grantId = row.kind === "desktop" ? null : await vault.grantOf(id);
	await vault.revokeAndWipe(id, "user");
	if (grantId) {
		try {
			await (env.OAUTH_PROVIDER as OAuthHelpers).revokeGrant(grantId, session.uid);
		} catch {
			// Best effort: the vault row is gone, so every token of this grant is already refused.
		}
	}
	if (row.kind !== "oauth") {
		try {
			await forgetDesktopKey(env, id);
		} catch {
			// Best effort as well: the vault row is gone, so the key is refused either way.
		}
	}
	log({ t: "auth", rid: ridOf(request), ev: "revoked", reason: "user", who: await pseudonym(env, session.uid, 12) });
	const [after, unrevoked] = await Promise.all([vault.listConnections(), vault.listUnrevoked()]);
	// On the unrevoked list: it can never be revoked automatically (NX_REVOKE_SECRET rotated) and is
	// never retried, so the notice says it must be removed by hand. Still listed: NoDrive didn't take
	// the revocation yet, and the vault really does keep retrying it.
	if (unrevoked.some((u) => u.connectionId === id)) return toHome("manual");
	if (after.some((c) => c.connectionId === id)) return toHome("ending");
	return toHome("ended");
}

async function forgetUnrevoked(request: Request, env: NxEnv, cfg: NxConfig): Promise<Response> {
	const gate = await signedInPost(request, env, cfg);
	if (gate instanceof Response) return gate;
	const id = String(gate.form.get("connection_id") ?? "");
	if (!CONNECTION_ID_RE.test(id)) return errorPage("Not valid", "That isn't one of your notes.", 400);
	await vaultFor(env, gate.session.uid).clearUnrevoked(id);
	return toHome("cleared");
}

/**
 * Whether a new key would be refused by the 5-connection cap. The vault replaces the least recently
 * used active connection with exactly the same label, of any kind (CAP_REPLACE_TEXT in views.ts).
 */
async function capReached(env: NxEnv, uid: string, label?: string): Promise<boolean> {
	const live = (await vaultFor(env, uid).listConnections()).filter((c) => c.status !== "revoking");
	if (live.length < LIMITS.connectionsPerPerson) return false;
	return label === undefined || !live.some((c) => c.clientLabel === label);
}

function keyFormPage(
	env: NxEnv,
	cfg: NxConfig,
	request: Request,
	csrf: string,
	values: KeyFormValues,
	error: string | null,
	full: boolean,
	status = 200,
): Response {
	const choices = keyChoices(cfg, env);
	const devNote = __NX_DEV_AUTH__ && devActive(env, request) ? devKeyNote() : "";
	return page({
		title: "Make a desktop key",
		status,
		https: cfg.env !== "dev",
		body: keyFormHtml({ cfg, csrf, values, allowedScopes: choices.scopes, allowedApps: choices.apps, error, full, devNote }),
	});
}

async function showKeyForm(request: Request, env: NxEnv, cfg: NxConfig): Promise<Response> {
	const session = await currentSession(env, request);
	if (!session) return toHome();
	if (!secretsOk(env)) return setupFaultPage();
	const values: KeyFormValues = { ...KEY_FORM_DEFAULTS, apps: keyChoices(cfg, env).apps };
	return keyFormPage(env, cfg, request, await csrfToken(env, session), values, null, await capReached(env, session.uid));
}

async function newKey(request: Request, env: NxEnv, cfg: NxConfig): Promise<Response> {
	const gate = await signedInPost(request, env, cfg);
	if (gate instanceof Response) return gate;
	const { session, form } = gate;
	// Refuse before NoDrive makes an app password that the vault could never revoke.
	if (!secretsOk(env)) return setupFaultPage();
	const rid = ridOf(request);
	const csrf = await csrfToken(env, session);
	const choices = keyChoices(cfg, env);
	const parsed = parseKeyForm(form, choices.scopes, choices.apps);
	if (!parsed.ok) return keyFormPage(env, cfg, request, csrf, parsed.values, parsed.error, false, 400);
	const v = parsed.values;
	let ipLock: string | undefined;
	if (v.ipLock) {
		const ip = request.headers.get("cf-connecting-ip");
		if (!ip) return keyFormPage(env, cfg, request, csrf, v, "Your network's address couldn't be read, so the key can't be limited to it. Untick that box, or try again.", false, 400);
		ipLock = ip;
	}
	if (await capReached(env, session.uid, v.label)) {
		const msg = `You already have ${LIMITS.connectionsPerPerson} connections. End one first, or give the key exactly the name of the connection it should replace.`;
		return keyFormPage(env, cfg, request, csrf, v, msg, true, 409);
	}
	const dev = __NX_DEV_AUTH__ && devActive(env, request);
	if (__NX_DEV_AUTH__ && dev) {
		const made = await devCreateDesktopKey(env, cfg, session.uid, v, ipLock);
		if (made) return made;
	}
	if (!dev && !(await startAllowed(env, request))) {
		log({ t: "auth", rid, ev: "rate_limited", reason: "connections" });
		return slowDown();
	}
	if (!dev) {
		const capped = await dailyStartCap(env, request);
		if (capped) return capped;
	}
	try {
		// `sub` binds the key to the signed-in person: NoDrive's grant must come from the same account
		// (checkIdentity refuses "a different NoDrive account" and revokes the new app password).
		return await startConnect(
			env,
			{
				purpose: "desktop",
				clientLabel: v.label,
				scopes: v.scopes,
				apps: v.apps,
				desktop: { label: v.label, days: v.days, ...(ipLock ? { ipLock } : {}) },
				sub: session.uid,
				cli: "onlyoffice",
			},
			undefined,
			rid,
		);
	} catch {
		return driveDown();
	}
}
