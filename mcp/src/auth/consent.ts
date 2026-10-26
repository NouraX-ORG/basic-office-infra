/**
 * The consent page at /authorize (DESIGN 6.4). Zero JavaScript; every client string is escaped.
 * GET: parse and check the request (PKCE S256 for every client, public or confidential; the
 * redirect allowlist again, for every client), then show the capabilities and apps with our
 * defaults (sharing and mail sending unticked).
 * POST: same-origin only (sameOrigin); approve or deny through the library's consent helpers, then
 * go to "Log in with Nourax" (when on) or straight to the NoDrive step.
 * Remembered consent skips the page only when both the scopes (library cookie) and the apps (our
 * cookie, consent-memory.ts) are remembered.
 */
import { type AuthRequest, AuthorizationError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { config, type NxConfig, type NxEnv } from "../env";
import { secretsOk, subkeyHex } from "../core/keys";
import { LIMITS } from "../core/limits";
import { cliOf, log } from "../core/log";
import { BodyTooLarge, NotAForm, readSmallForm } from "../http/guards";
import { cspOrigin, errorPage, esc, page } from "../http/html";
import { ALL_APPS, ALL_SCOPES, APP_WORDS, type AppId, type Scope, SCOPE_WORDS } from "../mcp/catalog";
import { takeDaily } from "../vault/quota";
import { cleanChoice, setupFaultPage, startConnect } from "./connect";
import { rememberApps, rememberedApps } from "./consent-memory";
import { clientLabel, labelFromHost, redirectAllowed } from "./dcr";
import { devConsentExtras, devCompleteConsent } from "./dev";
import { devActive } from "./dev-guard";
import { sameOrigin } from "./session";
import { beginUpstreamRedirect } from "./upstream";

/** Mail can be chosen only when the upstream step and the provider are both configured. */
export function mailAvailable(cfg: NxConfig, env: NxEnv): boolean {
	return cfg.upstreamOn && cfg.nomailToolsUrl !== null && Boolean(env.NOMAIL_TOOLS_KEY);
}

export function allowedScopes(cfg: NxConfig, env: NxEnv): Scope[] {
	return mailAvailable(cfg, env) ? [...ALL_SCOPES] : ALL_SCOPES.filter((s) => !s.startsWith("mail."));
}

export function allowedApps(cfg: NxConfig, env: NxEnv): AppId[] {
	const apps = mailAvailable(cfg, env) ? [...ALL_APPS] : ALL_APPS.filter((a) => a !== "mail");
	return cfg.heavyTools ? apps : apps.filter((a) => a !== "docs");
}

const DEFAULT_TICKED: ReadonlySet<Scope> = new Set(["workspace.read", "workspace.write", "workspace.remove", "mail.read"]);

function redirect(location: string, headers?: Headers): Response {
	const h = new Headers(headers);
	h.set("location", location);
	h.set("cache-control", "no-store");
	return new Response(null, { status: 302, headers: h });
}

/**
 * PKCE with S256 for every client. The library requires PKCE only for public clients, but anyone
 * can register a confidential client through DCR, so its secret proves nothing about who it is.
 */
export function pkceOk(ar: Pick<AuthRequest, "codeChallenge" | "codeChallengeMethod">): boolean {
	return typeof ar.codeChallenge === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(ar.codeChallenge) && ar.codeChallengeMethod === "S256";
}

function pkceRefused(rid?: string): Response {
	log({ t: "auth", rid, ev: "pkce_missing" });
	return errorPage("This app can't connect here", "It didn't use the secure sign-in method (PKCE with S256) that Nourax Workspace requires. Nothing was shared.", 400);
}

/** The redirect's origin, for the consent page's form-action (Cancel redirects there). */
function redirectOrigin(redirectUri: string): string | null {
	try {
		return cspOrigin(new URL(redirectUri).origin);
	} catch {
		return null;
	}
}

/**
 * The library's request checks. Some failures (a public client without PKCE, an unknown resource)
 * come with an RFC 6749 error redirect to the client's registered redirect URI, carrying no code.
 * That redirect is followed only while the URI is still on our allowlist (ALLOWED_REDIRECTS may
 * have shrunk since the client registered); otherwise, and for every other failure, a local page.
 */
async function parse(helpers: OAuthHelpers, request: Request, cfg: NxConfig, rid?: string): Promise<AuthRequest | Response> {
	try {
		return await helpers.parseAuthRequest(request);
	} catch (e) {
		if (e instanceof AuthorizationError && e.redirectTo) {
			if (redirectAllowed(e.redirectUri, cfg.allowedRedirects)) return redirect(e.redirectTo);
			log({ t: "auth", rid, ev: "redirect_rejected" });
		}
		return errorPage("This sign-in link isn't valid", "Start again from your AI app.", 400);
	}
}

/** One unit of the daily cap on new sign-ins (DESIGN 14), or the page to show instead. */
async function dailySignInCap(env: NxEnv, request: Request): Promise<Response | null> {
	let r: Awaited<ReturnType<typeof takeDaily>>;
	try {
		r = await takeDaily(env, "authorize", request.headers.get("cf-connecting-ip") ?? "local");
	} catch {
		// No count, no write: fail closed.
		const busy = errorPage("Try again in a minute", "Nourax Workspace is busy. Nothing was shared. Try again in a minute.", 503);
		busy.headers.set("retry-after", "60");
		return busy;
	}
	if (r.ok) return null;
	const res =
		r.scope === "global"
			? errorPage("Too many new connections today", "Nourax Workspace has started too many new connections today. Try again tomorrow. Connections you already have keep working.", 429)
			: errorPage("Too many new connections today", "Too many new connections were started from your network today. Try again tomorrow. Connections you already have keep working.", 429);
	res.headers.set("retry-after", String(r.retryAfterSec));
	return res;
}

function consentHtml(o: {
	clientName: string;
	unverified: boolean;
	redirectHost: string;
	loopback: boolean;
	handle: string;
	scopes: Scope[];
	apps: AppId[];
	upstreamOn: boolean;
	offlineRequested: boolean;
	devExtras: string;
}): string {
	const scopeBoxes = o.scopes
		.map((s) => {
			const locked = s === "workspace.read";
			const checked = DEFAULT_TICKED.has(s) ? " checked" : "";
			const label = s === "workspace.read" ? "Read (always on)" : SCOPE_WORDS[s].charAt(0).toUpperCase() + SCOPE_WORDS[s].slice(1);
			return locked
				? `<label><input type="checkbox" checked disabled>${esc(label)}</label><input type="hidden" name="scope" value="workspace.read">`
				: `<label><input type="checkbox" name="scope" value="${esc(s)}"${checked}>${esc(label)}</label>`;
		})
		.join("\n");
	const appBoxes = o.apps.map((a) => `<label><input type="checkbox" name="app" value="${esc(a)}" checked>${esc(APP_WORDS[a])}</label>`).join("\n");
	const next = o.upstreamOn ? "Next: sign in with your Nourax account, then allow access to NoDrive." : "Next: allow access to NoDrive.";
	return `<h1>Connect ${esc(o.clientName)} to Nourax Workspace</h1>
<p><strong>${esc(o.clientName)}</strong>${o.unverified ? ' <span class="muted">(name given by the app, not checked)</span>' : ""} wants to work in Nourax Workspace as you.</p>
<p>Access will be sent to: <strong>${esc(o.redirectHost)}</strong></p>
${o.loopback ? '<p class="warn">This app runs on your own computer. Continue only if you started it just now.</p>' : ""}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${esc(o.handle)}">
${o.offlineRequested ? '<input type="hidden" name="offline" value="1">' : ""}
<fieldset><legend>What it may do</legend>
${scopeBoxes}
<p class="muted">Sharing and sending mail stay off unless you tick them. Items moved to the trash and replaced file content can be brought back for 30 days; some other changes can't be undone.</p>
</fieldset>
<fieldset><legend>Which apps</legend>
${appBoxes}
</fieldset>
${o.devExtras}
<label><input type="checkbox" name="remember" value="1">Remember this choice for 7 days on this browser</label>
<p class="muted">${esc(next)}</p>
<div class="actions"><button type="submit" name="action" value="approve">Continue</button>
<button type="submit" name="action" value="deny" class="secondary">Cancel</button></div>
</form>`;
}

/** GET /authorize */
export async function authorizeGet(request: Request, env: NxEnv, rid?: string): Promise<Response> {
	const cfg = config(env);
	if (!secretsOk(env)) {
		log({ t: "auth", rid, ev: "setup_fault", reason: "secrets" });
		return setupFaultPage();
	}
	const helpers = env.OAUTH_PROVIDER as OAuthHelpers;
	const parsed = await parse(helpers, request, cfg, rid);
	if (parsed instanceof Response) return parsed;
	const ar = parsed;
	if (!redirectAllowed(ar.redirectUri, cfg.allowedRedirects)) {
		log({ t: "auth", rid, ev: "redirect_rejected" });
		return errorPage("This app can't connect here", "Its return address isn't on Nourax Workspace's list. Nothing was shared.", 400);
	}
	if (!pkceOk(ar)) return pkceRefused(rid);
	// Counted only for a valid request, before anything is written: both the consent page and a
	// remembered consent write a transaction to KV.
	const capped = await dailySignInCap(env, request);
	if (capped) return capped;
	const desc = await helpers.describeConsent(ar);
	const client = await helpers.lookupClient(ar.clientId);
	const label = clientLabel(client?.clientName, ar.redirectUri);
	const secret = await subkeyHex(env, "consent-memory");
	// Inline guard so the production build folds it away (DESIGN 16.2).
	const devExtras = __NX_DEV_AUTH__ && devActive(env, request) ? devConsentExtras(env) : "";
	const dev = devExtras !== "";

	if (!dev && (await helpers.isConsentRemembered(request, ar, { secret }))) {
		// The same client, redirect, resource and a subset of the scopes approved in the last 7 days,
		// and the apps ticked then. Without the remembered apps, the page is shown again.
		const apps = await rememberedApps(env, request, ar);
		if (apps !== null) {
			const choice = cleanChoice(ar.scope, apps, allowedScopes(cfg, env), allowedApps(cfg, env));
			return nextStep(env, ar, choice.scopes, choice.apps, label, new Headers(), cliOf(request.headers.get("user-agent"), desc.redirectHost), rid);
		}
	}
	const tx = await helpers.beginConsent(ar);
	log({ t: "auth", rid, ev: "consent_shown", cli: cliOf(null, desc.redirectHost) });
	const back = redirectOrigin(ar.redirectUri);
	return page({
		title: "Connect an AI app",
		headers: tx.headers,
		// Chromium applies form-action to the redirect after a form POST: Continue may go to
		// Supabase, and Cancel goes back to the app's own (allowlisted) redirect.
		formAction: [cfg.supabaseUrl, ...(back ? [back] : [])],
		https: cfg.env !== "dev",
		body: consentHtml({
			// The cleaned label (dcr.ts clientLabel), never the library's raw name: a self-registered
			// name such as the upstream product's or "Nourax Workspace (official)" is shown as "AI app"
			// (fix round 4, brand rule 6). A label from the redirect host ("Claude") was checked.
			clientName: label,
			unverified: !desc.clientDomain && labelFromHost(ar.redirectUri) === null,
			redirectHost: desc.redirectHost,
			loopback: desc.redirectIsLoopback,
			handle: tx.handle,
			scopes: allowedScopes(cfg, env),
			apps: allowedApps(cfg, env),
			upstreamOn: cfg.upstreamOn,
			offlineRequested: ar.scope.includes("offline_access"),
			devExtras,
		}),
	});
}

/** POST /authorize */
export async function authorizePost(request: Request, env: NxEnv, rid?: string): Promise<Response> {
	const cfg = config(env);
	const helpers = env.OAUTH_PROVIDER as OAuthHelpers;
	if (!sameOrigin(request, cfg.publicOrigin)) return errorPage("Not allowed", "This form must be sent from the Nourax Workspace page.", 403);
	// At most 16 KB, chunked included: never request.formData(), which reads any size.
	let form: URLSearchParams;
	try {
		form = await readSmallForm(request);
	} catch (e) {
		if (e instanceof BodyTooLarge) return errorPage("Too large", "The form was too large.", 413);
		if (e instanceof NotAForm) return errorPage("Not valid", "The form couldn't be read.", 415);
		return errorPage("Not valid", "The form couldn't be read.", 400);
	}
	const handle = String(form.get("handle") ?? "");
	if (!handle || handle.length > 512) return errorPage("This page has expired", "Start again from your AI app.", 400);
	if (form.get("action") !== "approve") {
		let denied: Awaited<ReturnType<OAuthHelpers["denyConsent"]>>;
		try {
			denied = await helpers.denyConsent(request, handle);
		} catch {
			return errorPage("This page has expired", "Start again from your AI app.", 400);
		}
		log({ t: "auth", rid, ev: "consent_denied" });
		// Back to the app only while its redirect is still on the allowlist, as every other redirect
		// back is (DESIGN 29.2; third system review, section 30.3): ALLOWED_REDIRECTS may have shrunk
		// since the page was shown. The handle is used up either way; its cookie is cleared.
		if (!redirectAllowed(denied.request.redirectUri, cfg.allowedRedirects)) {
			log({ t: "auth", rid, ev: "redirect_rejected" });
			const h = new Headers(denied.headers);
			h.delete("location");
			return page({ title: "Sign-in cancelled", status: 400, headers: h, body: `<h1>Sign-in cancelled</h1><p>${esc("Nothing was connected. You can close this tab.")}</p>` });
		}
		return redirect(denied.redirectTo, denied.headers);
	}
	const choice = cleanChoice(
		form.getAll("scope").map(String),
		form.getAll("app").map(String),
		allowedScopes(cfg, env),
		allowedApps(cfg, env),
	);
	const grantedScopes: string[] = [...choice.scopes];
	if (form.get("offline") === "1") grantedScopes.push("offline_access");
	const remember = form.get("remember") === "1" ? { secret: await subkeyHex(env, "consent-memory"), maxAgeSeconds: LIMITS.consentRememberSec } : undefined;
	let approved: { request: AuthRequest; headers: Headers };
	try {
		approved = await helpers.approveConsent(request, handle, { scope: grantedScopes, ...(remember ? { remember } : {}) });
	} catch {
		return errorPage("This page has expired", "Start again from your AI app.", 400);
	}
	const ar = approved.request;
	if (!redirectAllowed(ar.redirectUri, cfg.allowedRedirects)) {
		log({ t: "auth", rid, ev: "redirect_rejected" });
		return errorPage("This app can't connect here", "Its return address isn't on Nourax Workspace's list. Nothing was shared.", 400);
	}
	// The GET already refused this; checked again because the POST is what completes the grant.
	if (!pkceOk(ar)) return pkceRefused(rid);
	if (remember) approved.headers.append("set-cookie", await rememberApps(env, request, ar, choice.apps, LIMITS.consentRememberSec));
	const client = await helpers.lookupClient(ar.clientId);
	const label = clientLabel(client?.clientName, ar.redirectUri);
	const cli = cliOf(request.headers.get("user-agent"), (() => {
		try {
			return new URL(ar.redirectUri).hostname;
		} catch {
			return "";
		}
	})());
	if (__NX_DEV_AUTH__ && devActive(env, request)) {
		return devCompleteConsent(env, ar, choice.scopes, choice.apps, label, String(form.get("dev_uid") ?? ""), approved.headers);
	}
	return nextStep(env, ar, choice.scopes, choice.apps, label, approved.headers, cli, rid);
}

async function nextStep(env: NxEnv, ar: AuthRequest, scopes: Scope[], apps: AppId[], label: string, headers: Headers, cli: string, rid?: string): Promise<Response> {
	const cfg = config(env);
	if (cfg.upstreamOn) {
		return beginUpstreamRedirect(env, ar, headers, { scopes, apps, clientLabel: label, clientId: ar.clientId, cli });
	}
	return startConnect(env, { purpose: "oauth", clientLabel: label, clientId: ar.clientId, authRequest: ar, scopes, apps, cli }, headers, rid);
}
