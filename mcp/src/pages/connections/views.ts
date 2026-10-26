/**
 * HTML for the /connections pages (lane F, DESIGN 6.6, 9.3 and 18.4). Zero JavaScript, no inline
 * styles (the CSP allows only our stylesheet), and every dynamic value goes through esc().
 * Labels come from AI apps (DCR client_name) or from the person, so they are never trusted.
 */
import { connectorUserAgent } from "../../auth/connect";
import type { NxConfig } from "../../env";
import { LIMITS } from "../../core/limits";
import { esc } from "../../http/html";
import { APP_WORDS, type AppId, CATALOG, type CatalogEntry, type Scope, SCOPE_WORDS } from "../../mcp/catalog";
import type { ConnectionSummary, UnrevokedSummary } from "../../vault/schema";
import { desktopKeySetting, KEY_PLACEHOLDER, ONLYOFFICE_MENU_PATH } from "./key-setting";
import { isReservedLabel, SESSION_LABEL } from "./reserved";

// Kept in their own modules so core can import them without a cycle (lane F notes); re-exported
// here because the pages and the tests use them together with the rest of this file.
export { desktopKeySetting, KEY_PLACEHOLDER, ONLYOFFICE_MENU_PATH } from "./key-setting";
export { isReservedLabel, SESSION_LABEL } from "./reserved";

/**
 * A capability in plain words, without core's part in brackets: "replace and remove", not
 * "replace and remove (most can be undone for 30 days)". These pages make no promise about undoing
 * on their own; the key form says what "Replace and remove" covers next to its checkbox (removeNote).
 */
export function scopeWords(s: Scope): string {
	return SCOPE_WORDS[s].replace(/\s*\(.*\)\s*$/, "");
}

/** What a "Replace and remove" tool leaves behind: how its result is undone, and what of it can't be. */
export interface RemoveFate {
	/** How the result can be undone, as a clause of the key form's note. */
	undo: string;
	/** The part of the tool that can't be undone, if any. docs/mcp.md quotes it word for word. */
	forGood?: string;
}

/**
 * The "Replace and remove" tools lane F knows, from each tool's own description and code (second
 * review, fix round 3: calendar_cancel_event used to count as wholly undoable, but removing one
 * occurrence of a repeating event writes an EXDATE that never reaches the trash; files_move_to_trash
 * ends a share made to the person alone for good, after end_share true).
 * test/pages/docs-mcp.test.ts reads every built tool under workspace.remove: one whose description
 * or inputs say "for good" or "can't be undone" must have `forGood` here, every one must be listed
 * here, and docs/mcp.md must quote each `forGood` in sections 3, 5 and 7.4 and in the tool's row.
 * A tool missing here makes removeNote() say "Some other removals can't be undone" instead.
 */
export const REMOVE_TOOL_FATES: Readonly<Record<string, RemoveFate>> = {
	files_overwrite_file: { undo: "replaced file content stays as an earlier version" },
	files_restore_version: { undo: "replaced file content stays as an earlier version" },
	files_move_to_trash: {
		undo: "removed files and folders stay in NoDrive's trash, normally for 30 days",
		forGood: "removing something that was shared with you alone ends that share for good",
	},
	calendar_cancel_event: {
		undo: "a cancelled event stays in its calendar, marked as cancelled, or goes to NoCalendar's trash for 30 days",
		forGood: "removing one occurrence of a repeating event is for good",
	},
};

function fateOf(name: string): RemoveFate | null {
	return Object.hasOwn(REMOVE_TOOL_FATES, name) ? (REMOVE_TOOL_FATES[name] as RemoveFate) : null;
}

/** The "Replace and remove" tools that can always be undone: known above, with nothing for good. */
export const UNDOABLE_REMOVE_TOOLS: ReadonlySet<string> = new Set(
	Object.entries(REMOVE_TOOL_FATES)
		.filter(([, f]) => !f.forGood)
		.map(([name]) => name),
);

/**
 * The note under "Replace and remove" on the key form, built from the catalogue for the apps the
 * key may have: how the known tools are undone, what of them is for good, and plainly that any
 * other removal can't be undone.
 */
export function removeNote(apps: readonly AppId[], catalog: readonly CatalogEntry[] = CATALOG): string {
	const tools = catalog.filter((c) => c.scope === "workspace.remove" && (c.app === null || apps.includes(c.app)));
	if (!tools.length) return "";
	const fates = tools.map((c) => fateOf(c.name)).filter((f): f is RemoveFate => f !== null);
	const undo = [...new Set(fates.map((f) => f.undo))];
	const forGood = [...new Set(fates.flatMap((f) => (f.forGood ? [f.forGood] : [])))];
	const parts: string[] = [];
	if (undo.length) {
		const first = undo.join("; ");
		parts.push(`${first.charAt(0).toUpperCase()}${first.slice(1)}. These can be undone.`);
	}
	if (forGood.length) parts.push(`Not everything can be undone: ${forGood.join("; ")}.`);
	if (tools.some((c) => c.app === "gantt" && !fateOf(c.name))) parts.push("Deleting a NoGantt task is for good: NoGantt has no trash.");
	if (tools.some((c) => c.app !== "gantt" && !fateOf(c.name))) parts.push("Some other removals can't be undone.");
	return parts.join(" ");
}

/**
 * Fixed notices after an action. Only these codes are read from the query string, nothing is
 * echoed, and a code is shown only when the action that set it also set its cookie in this browser
 * (notice.ts), so a link anyone can send shows none of them.
 */
export const NOTICES = {
	ended: "The connection was ended. Its access to NoDrive was removed.",
	// Only for a row the vault still retries (status "revoking"): it really does keep trying.
	ending: "The connection was ended. Removing its access to NoDrive didn't work yet; Nourax Workspace keeps trying by itself.",
	// A row moved to the unrevoked list is never retried (NX_REVOKE_SECRET was rotated).
	manual: "The connection was ended, but its access to NoDrive couldn't be removed automatically and must be removed by hand. See \"Ended, but not fully removed\" below.",
	gone: "That connection had already ended.",
	cleared: "The note was cleared.",
	"signed-out": "You're signed out of this page, in every browser.",
	// The sign-out record couldn't be written (session-end.ts): only this browser's cookie is gone.
	"signed-out-here": "You're signed out of this page in this browser. Signing out everywhere didn't work just now: if you signed in somewhere else, that sign-in lasts at most 30 minutes, or sign in and out again.",
	// Sign-out with no live sign-in in this browser (a tab left open past 30 minutes): nothing could be
	// ended anywhere else, so the page never claims "every browser" then (index.ts signOut).
	"already-out": "This browser was already signed out of this page, so nothing was signed out anywhere else. To end a sign-in in another browser, sign in here, then sign out.",
	expired: "Your sign-in on this page ended. Sign in again.",
	cancelled: "The sign-in didn't finish. Nothing was changed.",
} as const;
export type NoticeCode = keyof typeof NOTICES;

export function noticeOf(code: string | null): NoticeCode | null {
	return code !== null && Object.hasOwn(NOTICES, code) ? (code as NoticeCode) : null;
}

/** Notices about this browser being signed out, or a sign-in not finishing: never shown above a signed-in list. */
export const SIGNED_OUT_NOTICES: ReadonlySet<NoticeCode> = new Set<NoticeCode>(["signed-out", "signed-out-here", "already-out", "expired", "cancelled"]);

const WARN_NOTICES: ReadonlySet<NoticeCode> = new Set<NoticeCode>(["ending", "manual", "expired", "cancelled", "signed-out-here", "already-out"]);

function noticeHtml(code: NoticeCode | null): string {
	if (!code) return "";
	return `<p class="${WARN_NOTICES.has(code) ? "warn" : "muted"}" role="status">${esc(NOTICES[code])}</p>`;
}

/** "2026-10-25 14:03 UTC": plain, the same for everyone, and never a guess at the reader's zone. */
export function when(sec: number): string {
	if (!Number.isFinite(sec) || sec <= 0) return "unknown";
	const iso = new Date(sec * 1000).toISOString();
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const KIND_WORDS: Record<ConnectionSummary["kind"], string> = {
	oauth: "AI app",
	desktop: "Desktop key",
	dev: "Dev connection (local testing only)",
};

function scopeList(scopes: readonly string[]): string {
	const known = scopes.filter((s): s is Scope => Object.hasOwn(SCOPE_WORDS, s));
	return known.length ? known.map((s) => scopeWords(s)).join("; ") : "nothing";
}

function appList(apps: readonly string[]): string {
	const known = apps.filter((a): a is AppId => Object.hasOwn(APP_WORDS, a));
	return known.length ? known.map((a) => APP_WORDS[a]).join("; ") : "none";
}

/**
 * The latest end of a connection, when the vault reports it. ConnectionSummary.expiresAt is the
 * nearer of the end chosen at creation and "last use plus the idle time", so a 60-day key shows 30
 * days out until it is used. The vault keeps the chosen end (its expires_at column) but doesn't
 * return it yet: lane F's core patch "ends by" adds `hardExpiresAt` to listConnections().
 */
function hardEnd(c: ConnectionSummary): number | null {
	const v = (c as ConnectionSummary & { hardExpiresAt?: unknown }).hardExpiresAt;
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** Days, for the end-date rules ("30 days after its last use"). */
function days(sec: number): number {
	return Math.round(sec / 86400);
}

/**
 * When a connection ends, in words. With the chosen end known: both dates when using it can still
 * move the end on ("ends A if it isn't used before then, and B at the latest"), else that one date.
 * Without it: the nearer date and the rule that made it, so a 60-day key's 30-day date is explained.
 */
export function endsText(c: ConnectionSummary): string {
	const hard = hardEnd(c);
	if (hard !== null && hard > c.expiresAt) return `ends ${when(c.expiresAt)} if it isn't used before then, and ${when(hard)} at the latest`;
	if (hard !== null) return `ends ${when(hard)}`;
	return `ends ${when(c.expiresAt)} (${endRule(c)})`;
}

const APP_RULE = `whichever comes first: ${days(LIMITS.idleSec)} days after its last use, or ${days(LIMITS.maxGrantAgeSec)} days after it was connected`;
const KEY_RULE = `whichever comes first: ${days(LIMITS.desktopIdleSec)} days after its last use, or the end of the time chosen for it`;

/**
 * The rule behind a connection's nearer end date. A dev row (local testing only) follows the rules
 * it was made with: an AI app's for the dev consent and /dev/token (14 days idle), a desktop key's
 * for a dev key from this page (30 days idle). The summary has no idle time, so it is read from the
 * row: while the idle end is the nearer one, expiresAt is exactly lastUsedAt plus the idle time;
 * otherwise the end chosen at creation came first (second review, fix round 3, live finding).
 */
function endRule(c: ConnectionSummary): string {
	if (c.kind === "oauth") return APP_RULE;
	if (c.kind === "desktop") return KEY_RULE;
	const idle = c.expiresAt - c.lastUsedAt;
	if (idle === LIMITS.idleSec) return APP_RULE;
	if (idle === LIMITS.desktopIdleSec) return KEY_RULE;
	return "the end of the time chosen for it";
}

function statusWords(s: ConnectionSummary["status"]): string {
	if (s === "revoking") return "Ending: its NoDrive access is still being removed";
	if (s === "needs_reconnect") return "Needs reconnecting in the AI app";
	return "Active";
}

function connectionHtml(c: ConnectionSummary, csrf: string): string {
	const label = c.clientLabel || "AI app";
	const nodriveName = c.kind === "dev" ? null : connectorUserAgent(label);
	const end =
		c.status === "revoking"
			? ""
			: `<form method="post" action="/connections/end" class="actions">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="connection_id" value="${esc(c.connectionId)}">
<button type="submit" class="secondary">End this connection</button>
</form>`;
	// An AI app names itself (DCR client_name), so it can take this page's own sign-in name. Its
	// NoDrive grant then looked like the page's sign-in: say so, in case it was granted from a link.
	const lookAlike =
		c.kind === "oauth" && isReservedLabel(label)
			? `<p class="warn">This AI app gave itself the name of this page's own sign-in. If you didn't connect it yourself, end it now.</p>\n`
			: "";
	return `<fieldset>
<legend>${esc(label)}</legend>
<p><strong>${esc(KIND_WORDS[c.kind])}</strong> · ${esc(statusWords(c.status))}</p>
${lookAlike}<p>May: ${esc(scopeList(c.scopes))}</p>
<p>Apps: ${esc(appList(c.apps))}</p>
<p class="muted">Connected ${esc(when(c.createdAt))} · last used ${esc(when(c.lastUsedAt))} · ${esc(endsText(c))}</p>
${nodriveName ? `<p class="muted">In NoDrive's list of devices and sessions it is called "${esc(nodriveName)}".</p>` : ""}
${end}
</fieldset>`;
}

function unrevokedHtml(u: UnrevokedSummary, csrf: string): string {
	const name = connectorUserAgent(u.clientLabel || "AI app");
	return `<fieldset>
<legend>${esc(u.clientLabel || "AI app")}</legend>
<p class="warn">This connection ended on ${esc(when(u.endedAt))}, but its access to NoDrive, named "${esc(name)}", couldn't be removed automatically. Ask the person who runs Nourax Workspace to remove it. When it is gone, clear this note.</p>
<form method="post" action="/connections/forget" class="actions">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="connection_id" value="${esc(u.connectionId)}">
<button type="submit" class="secondary">It has been removed: clear this note</button>
</form>
</fieldset>`;
}

/** The page for a person who is signed in: their connections, ended ones to tidy up, and desktop keys. */
export function listHtml(o: { connections: ConnectionSummary[]; unrevoked: UnrevokedSummary[]; csrf: string; notice: NoticeCode | null }): string {
	const active = o.connections.filter((c) => c.status !== "revoking").length;
	const conns = o.connections.length
		? o.connections.map((c) => connectionHtml(c, o.csrf)).join("\n")
		: "<p>No AI app is connected to your Nourax Workspace.</p>";
	const unrevoked = o.unrevoked.length
		? `<h2>Ended, but not fully removed</h2>
${o.unrevoked.map((u) => unrevokedHtml(u, o.csrf)).join("\n")}`
		: "";
	return `<h1>Your AI connections</h1>
${noticeHtml(o.notice)}
<p class="muted">These AI apps and desktop keys can work in your Nourax Workspace as you. Ending one stops it at once and removes its access to NoDrive.</p>
<h2>Connected now (${active} of ${LIMITS.connectionsPerPerson})</h2>
${conns}
<p class="muted">A connection ends after 60 days, or after 14 days without use. A desktop key ends after the time chosen for it, or after 30 days without use.</p>
${unrevoked}
<h2>Desktop keys for ONLYOFFICE</h2>
<p>ONLYOFFICE Desktop Editors can't sign in by itself. A desktop key lets it connect as you.</p>
<div class="actions"><a class="button" href="/connections/new-key">Make a desktop key</a></div>
<form method="post" action="/connections/sign-out" class="actions">
<input type="hidden" name="csrf" value="${esc(o.csrf)}">
<button type="submit" class="secondary">Sign out of this page</button>
</form>
<p class="muted">You stay signed in to this page for at most ${LIMITS.sessionSec / 60} minutes. Signing out ends this page's sign-in in every browser: here at once, elsewhere within about a minute.</p>`;
}

/**
 * The page for a person who isn't signed in. `devExtras` is the dev-only QA picker (empty in
 * production). With "Log in with Nourax" on (`upstream`), the page signs in through it and NoDrive
 * makes no app password at all; in Drive-only mode it signs in through NoDrive's grant step.
 * `host` is this page's own host, so the person can check where they clicked.
 */
export function signInHtml(o: { csrf: string; notice: NoticeCode | null; devExtras: string; upstream: boolean; host: string }): string {
	const how = o.upstream
		? `<div class="actions"><button type="submit">Sign in with Nourax</button></div>
</form>
<p class="muted">You sign in with your Nourax account ("Log in with Nourax"). This page only learns who you are; it gets no access to your files.</p>`
		: `<div class="actions"><button type="submit">Sign in with NoDrive</button></div>
</form>
<p class="muted">NoDrive opens and asks you to grant access to "${esc(connectorUserAgent(SESSION_LABEL))}". Grant it only if you clicked Sign in on ${esc(o.host)} yourself just now. If you started it here, that access only tells this page who you are. ${esc(SESSION_GRANT_FATE)}</p>
<p class="warn">Never grant access from a link someone sent you, whatever name NoDrive shows: that name is chosen by whoever started the sign-in, so it proves nothing.</p>`;
	return `<h1>Your AI connections</h1>
${noticeHtml(o.notice)}
<p>See which AI apps can use your Nourax Workspace, end any of them, or make a desktop key for ONLYOFFICE.</p>
<form method="post" action="/connections/sign-in">
<input type="hidden" name="csrf" value="${esc(o.csrf)}">
${o.devExtras}
${how}`;
}

/**
 * What happens to the page sign-in's app password, on the sign-in page (docs/mcp.md 4.1 says the
 * same). The connect step (auth/connect.ts, purpose "session") asks NoDrive to remove it once and
 * starts the session whatever NoDrive answers, so this never promises that the removal worked: when
 * NoDrive doesn't take it, "AI app (Connections page)" stays in NoDrive until the owner removes it.
 * The Worker never stores that password (ConnectFlow drops the poll result) and nobody ever sees it.
 */
export const SESSION_GRANT_FATE =
	"Nourax Workspace never stores it and removes it again at once. If NoDrive doesn't confirm that removal, it can stay in NoDrive's list of devices and sessions until the person who runs Nourax Workspace removes it. Nobody has its password: it was never stored or shown.";

/**
 * A short "please wait" page that reloads itself once, for people who arrive from another site
 * (see index.ts). `target` is where it goes: /connections, or the reload address with a notice code.
 */
export function bounceHtml(target = "/connections"): string {
	return `<h1>Your AI connections</h1>
<p>Opening your connections...</p>
<p><a href="${esc(target)}">Continue</a></p>`;
}

export interface KeyFormValues {
	label: string;
	scopes: Scope[];
	apps: AppId[];
	days: 7 | 30 | 60;
	ipLock: boolean;
}

/**
 * What the vault does at the cap (Vault.createConnection): with 5 connections, a new one replaces
 * the least recently used active connection whose name is exactly the same, whatever its kind, so a
 * key named like an AI app ("Claude") ends that app's connection. capReached() in index.ts uses the
 * same rule to decide whether to refuse before NoDrive is asked.
 */
export const CAP_REPLACE_TEXT = `You already have ${LIMITS.connectionsPerPerson} connections. A new key replaces the least recently used connection with exactly the same name, an AI app's too. With a new name, end a connection first.`;

export const KEY_FORM_DEFAULTS: KeyFormValues = {
	label: "ONLYOFFICE Desktop",
	scopes: ["workspace.read"],
	apps: [],
	days: 30,
	ipLock: false,
};

/** The "Make a desktop key" form. `allowedScopes` and `allowedApps` never include mail (keys have no mail sign-in). */
export function keyFormHtml(o: {
	cfg: NxConfig;
	csrf: string;
	values: KeyFormValues;
	allowedScopes: readonly Scope[];
	allowedApps: readonly AppId[];
	error: string | null;
	full: boolean;
	devNote: string;
}): string {
	const scopeBoxes = o.allowedScopes
		.map((s) => {
			if (s === "workspace.read") {
				return '<label><input type="checkbox" checked disabled>Read (always on)</label><input type="hidden" name="scope" value="workspace.read">';
			}
			const checked = o.values.scopes.includes(s) ? " checked" : "";
			const words = scopeWords(s);
			const box = `<label><input type="checkbox" name="scope" value="${esc(s)}"${checked}>${esc(words.charAt(0).toUpperCase() + words.slice(1))}</label>`;
			const note = s === "workspace.remove" ? removeNote(o.allowedApps) : "";
			return note ? `${box}\n<p class="muted">${esc(note)}</p>` : box;
		})
		.join("\n");
	const appBoxes = o.allowedApps
		.map((a) => `<label><input type="checkbox" name="app" value="${esc(a)}"${o.values.apps.includes(a) ? " checked" : ""}>${esc(APP_WORDS[a])}</label>`)
		.join("\n");
	const dayBoxes = ([7, 30, 60] as const)
		.map((d) => `<label><input type="radio" name="days" value="${d}"${o.values.days === d ? " checked" : ""}>${d} days</label>`)
		.join("\n");
	const bridge = `npx -y mcp-remote@0.15.2 ${o.cfg.publicOrigin}/mcp`;
	return `<h1>Make a desktop key</h1>
${o.error ? `<p class="warn" role="alert">${esc(o.error)}</p>` : ""}
${o.full ? `<p class="warn">${esc(CAP_REPLACE_TEXT)}</p>` : ""}
<p>A desktop key lets ONLYOFFICE Desktop Editors work in your Nourax Workspace as you. It is shown once, after you allow access in NoDrive.</p>
<p class="muted">Where it goes: ${esc(ONLYOFFICE_MENU_PATH)}. With no other servers there, the whole configuration looks like this, with your key in place of ${esc(KEY_PLACEHOLDER)}: <code>${esc(desktopKeySetting(o.cfg.publicOrigin, KEY_PLACEHOLDER))}</code> With other servers, add the "nourax" entry inside your existing "mcpServers".</p>
<p class="muted">Safer, if Node.js is installed on the computer: add <code>${esc(bridge)}</code> as a server in ONLYOFFICE instead. It signs in like Claude does and needs no key.</p>
<form method="post" action="/connections/new-key">
<input type="hidden" name="csrf" value="${esc(o.csrf)}">
<fieldset><legend>Name</legend>
<label>Name of the key (letters, digits, spaces, dots, dashes and underscores; at most 40)
<input type="text" name="label" maxlength="40" required value="${esc(o.values.label)}"></label>
</fieldset>
<fieldset><legend>What it may do</legend>
${scopeBoxes}
<p class="warn">ONLYOFFICE may run a tool without asking you first. A key that can only read is the safest choice.</p>
</fieldset>
<fieldset><legend>Which apps</legend>
${appBoxes}
<p class="muted">Mail can't be used with a desktop key.</p>
</fieldset>
<fieldset><legend>How long it lasts</legend>
${dayBoxes}
<p class="muted">It also ends after 30 days without use, and you can end it here at any time.</p>
</fieldset>
<fieldset><legend>Network</legend>
<label><input type="checkbox" name="ip_lock" value="1"${o.values.ipLock ? " checked" : ""}>Only from the network I'm on now</label>
<p class="muted">Home and mobile networks change their address from time to time. The key then stops working and you make a new one.</p>
</fieldset>
${o.devNote}
<div class="actions"><button type="submit">Continue to NoDrive</button>
<a class="button secondary" href="/connections">Cancel</a></div>
</form>`;
}
