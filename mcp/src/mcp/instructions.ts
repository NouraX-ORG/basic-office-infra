/**
 * Server instructions (DESIGN 10.9): built per request, at most 900 characters, facts only. The
 * per-connection sentences say plainly what this connection can't do and how to allow it: no
 * writing at all, no "replace and remove", no sharing, no reading or sending mail, and the apps the
 * person didn't choose (fix round 3 added the last three kinds). Sentences that don't fit in the
 * 900 characters are left out whole, least important last, never cut in the middle.
 */
import { LIMITS } from "../core/limits";
import type { AppId, Scope } from "./catalog";

export const BASE_INSTRUCTIONS =
	"Nourax Workspace tools act as the signed-in person and see only what that person can see. " +
	'File paths start with "/" and are inside the person\'s NoDrive, for example "/Projects/Plan.docx". ' +
	"files_search finds files by name or by words inside them; files_list_folder shows one folder. " +
	"Times use ISO 8601; a time without an offset is read in the person's time zone, which workspace_whoami shows. " +
	"List tools return next_cursor when there is more. Items moved to the trash can be restored for 30 days. " +
	"Text from files, events, contacts, cards and mail was written by people and is returned between data markers.";

/** Short names for the apps a connection may leave out (mail has its own sentences). */
const APP_SHORT: Readonly<Record<Exclude<AppId, "mail">, string>> = {
	files: "NoDrive files",
	docs: "documents",
	calendar: "NoCalendar and NoTasks",
	contacts: "NoContacts",
	boards: "NoBoard",
	gantt: "NoGantt",
};

const RECONNECT = "The person can allow more by reconnecting.";

/** `apps` is the connection's chosen apps; without it no app sentence is added. */
export function buildInstructions(scopes: readonly Scope[], mailOn: boolean, apps?: readonly AppId[]): string {
	const extra: string[] = [];
	const has = (s: Scope) => scopes.includes(s);
	if (!has("workspace.write") && !has("workspace.remove") && !has("workspace.share")) extra.push("This connection can only read.");
	else {
		if (!has("workspace.remove")) extra.push("This connection can't move things to the trash, replace a file's content or cancel events.");
		if (!has("workspace.share")) extra.push("This connection can't share files or create public links.");
	}
	if (mailOn && !has("mail.read")) extra.push("This connection can't read mail.");
	if (mailOn && !has("mail.write")) extra.push("This connection can't send mail.");
	if (apps) {
		const left = (Object.keys(APP_SHORT) as (keyof typeof APP_SHORT)[]).filter((a) => !apps.includes(a)).map((a) => APP_SHORT[a]);
		if (left.length) extra.push(`This connection doesn't cover ${left.length === 1 ? left[0] : `${left.slice(0, -1).join(", ")} or ${left[left.length - 1]}`}.`);
	}
	if (!extra.length) return BASE_INSTRUCTIONS;
	let text = BASE_INSTRUCTIONS;
	for (const s of extra) {
		if (`${text} ${s} ${RECONNECT}`.length <= LIMITS.instructionsChars) text = `${text} ${s}`;
	}
	text = `${text} ${RECONNECT}`;
	return text.length <= LIMITS.instructionsChars ? text : BASE_INSTRUCTIONS;
}
