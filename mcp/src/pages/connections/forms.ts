/**
 * Form helpers for /connections (lane F).
 *
 * Every POST here passes three checks, in this order:
 * 1. sameOrigin() (auth/session.ts): Fetch Metadata and Origin, never a bare Origin comparison.
 * 2. readSmallForm() (http/guards.ts): application/x-www-form-urlencoded only, at most 16 KB,
 *    chunked included. Never request.formData().
 * 3. A CSRF token. Signed in: HMAC(csrf subkey, session nonce) from auth/session.ts. Signed out
 *    (the sign-in button): the same HMAC over a random nonce kept in a short-lived
 *    __Host-nx-pre cookie (SameSite=Strict), so a token copied from one browser is useless in another.
 */
import type { NxEnv } from "../../env";
import { brandClean } from "../../core/brand";
import { b64url, randomBytes } from "../../core/bytes";
import { checkCsrf, csrfToken, type Session } from "../../auth/session";
import { clearCookie, readCookie, setCookie } from "../../http/cookies";
import { BodyTooLarge, NotAForm, readSmallForm } from "../../http/guards";
import { errorPage } from "../../http/html";
import type { AppId, Scope } from "../../mcp/catalog";
import { isReservedLabel } from "./reserved";
import type { KeyFormValues } from "./views";

export const PRE_COOKIE = "__Host-nx-pre";
/** Long enough to read the page and click; a fresh one is set on every visit. */
export const PRE_COOKIE_SEC = 20 * 60;
const PRE_RE = /^[A-Za-z0-9_-]{22}$/;

/** The CSRF "session" for a signed-out browser: only the nonce matters to csrfToken(). */
function preSession(nonce: string): Session {
	return { uid: "", exp: 0, nonce: `pre.${nonce}` };
}

/** A fresh pre-sign-in nonce: the Set-Cookie header and the token for the form. */
export async function issuePreCsrf(env: NxEnv): Promise<{ cookie: string; token: string }> {
	const nonce = b64url(randomBytes(16));
	return {
		cookie: setCookie(PRE_COOKIE, nonce, { maxAge: PRE_COOKIE_SEC, sameSite: "Strict" }),
		token: await csrfToken(env, preSession(nonce)),
	};
}

export async function checkPreCsrf(env: NxEnv, request: Request, token: unknown): Promise<boolean> {
	const nonce = readCookie(request, PRE_COOKIE);
	if (!nonce || !PRE_RE.test(nonce)) return false;
	return checkCsrf(env, preSession(nonce), token);
}

export function clearPreCookie(): string {
	return clearCookie(PRE_COOKIE);
}

/** Reads one of our forms, or the error page to answer instead (413, 415, 400). */
export async function readForm(request: Request): Promise<URLSearchParams | Response> {
	try {
		return await readSmallForm(request);
	} catch (e) {
		if (e instanceof BodyTooLarge) return errorPage("Too large", "The form was too large.", 413);
		if (e instanceof NotAForm) return errorPage("Not valid", "The form couldn't be read.", 415);
		return errorPage("Not valid", "The form couldn't be read.", 400);
	}
}

/** Connection ids are 128-bit hex (vault rows). */
export const CONNECTION_ID_RE = /^[0-9a-f]{32}$/;

export const KEY_LABEL_MAX = 40;
/** The characters NoDrive's app-password name keeps (connectorUserAgent in auth/connect.ts). */
const LABEL_RE = /^[A-Za-z0-9 ._-]+$/;

export type KeyFormResult = { ok: true; values: KeyFormValues } | { ok: false; values: KeyFormValues; error: string };

/**
 * Whether a name is free of the upstream product name, also with spaces and punctuation taken out
 * ("Next cloud", "Next_Cloud"). Brand rule 6 covers what the person typed too: a name that fails
 * this is never put back into the form.
 */
function labelBrandClean(label: string): boolean {
	return brandClean(label) && brandClean(label.replace(/[^A-Za-z]/g, ""));
}

/**
 * Validates the "Make a desktop key" form. Unknown scopes and apps are dropped, read is always on,
 * and mail is never offered (a key has no "Log in with Nourax" session, so mail could never work).
 * The values are returned either way, so the form can be shown again as the person filled it in,
 * except a name that carries the upstream product name: the form then comes back with the name empty.
 */
export function parseKeyForm(form: URLSearchParams, allowedScopes: readonly Scope[], allowedApps: readonly AppId[]): KeyFormResult {
	const rawLabel = String(form.get("label") ?? "").replace(/\s+/g, " ").trim();
	const wantScopes = new Set(form.getAll("scope").map(String));
	wantScopes.add("workspace.read");
	const scopes = allowedScopes.filter((s) => wantScopes.has(s));
	const wantApps = new Set(form.getAll("app").map(String));
	const apps = allowedApps.filter((a) => wantApps.has(a));
	const daysRaw = String(form.get("days") ?? "30");
	const days = daysRaw === "7" ? 7 : daysRaw === "60" ? 60 : 30;
	const shown = rawLabel.slice(0, KEY_LABEL_MAX);
	const brandOk = labelBrandClean(rawLabel);
	const values: KeyFormValues = { label: brandOk && labelBrandClean(shown) ? shown : "", scopes, apps, days, ipLock: form.get("ip_lock") === "1" };
	if (daysRaw !== "7" && daysRaw !== "30" && daysRaw !== "60") return { ok: false, values, error: "Choose 7, 30 or 60 days." };
	if (!rawLabel) return { ok: false, values, error: "Give the key a name, for example \"ONLYOFFICE on my laptop\"." };
	if (rawLabel.length > KEY_LABEL_MAX) return { ok: false, values, error: `The name is too long: ${KEY_LABEL_MAX} characters at most.` };
	if (!LABEL_RE.test(rawLabel)) return { ok: false, values, error: "Use only letters, digits, spaces, dots, dashes and underscores in the name." };
	// NoDrive's name for the access drops the upstream product name (connectorUserAgent); refuse it
	// here so the key's name on this page and in NoDrive stay the same (brand rule 6).
	if (!brandOk) return { ok: false, values, error: "Choose another name for the key." };
	// "AI app (Connections page)" is the name this page's own sign-in has in NoDrive. A key with that
	// name (or a look-alike) would make a second grant link look like the page's own sign-in.
	if (isReservedLabel(rawLabel)) return { ok: false, values, error: "That name belongs to this page's own sign-in. Choose another name for the key." };
	if (apps.length === 0) return { ok: false, values, error: "Tick at least one app." };
	return { ok: true, values };
}
