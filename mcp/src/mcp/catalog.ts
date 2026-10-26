/**
 * The frozen, ordered catalogue of all 71 tools (DESIGN 10.1, 11 and 25.3: the 55 of the first design,
 * NoGantt's 15, and calendar_respond from fix round 3). Tools appear in tools/list in this order, then
 * mail tools sorted by name. Lanes implement entries; they never add, rename or reorder them. A test
 * checks every defineTool() call against its entry. With every app the list holds 71 + 29 mail tools
 * = 100, ONLYOFFICE's cap (LIMITS.mailTools).
 *
 * Tiers (10.3): R read-only, A purely additive, D changes or removes data or who can see it.
 */
import type { Bucket } from "../core/limits";

export type Scope = "workspace.read" | "workspace.write" | "workspace.remove" | "workspace.share" | "mail.read" | "mail.write";
export type AppId = "files" | "docs" | "calendar" | "contacts" | "boards" | "mail" | "gantt";
export type Tier = "R" | "A" | "D";
export type Lane = "core" | "A" | "B" | "C" | "D" | "E" | "G";
export type Flag = "heavy" | "attendees";

export interface CatalogEntry {
	name: string;
	/** null = meta tools, always on. */
	app: AppId | null;
	scope: Scope;
	tier: Tier;
	idempotent: boolean;
	openWorld: boolean;
	bucket: Bucket;
	lane: Lane;
	/** Creates without a natural key keep a 10-minute duplicate guard (10.7). */
	dedupe?: boolean;
	/** Listed only while this flag is on. */
	flag?: Flag;
}

export const ALL_SCOPES: readonly Scope[] = ["workspace.read", "workspace.write", "workspace.remove", "workspace.share", "mail.read", "mail.write"];
export const ALL_APPS: readonly AppId[] = ["files", "docs", "calendar", "contacts", "boards", "gantt", "mail"];
export const SUPPORTED_SCOPES: readonly string[] = [...ALL_SCOPES, "offline_access"];

function e(
	name: string,
	app: AppId | null,
	scope: Scope,
	tier: Tier,
	bucket: Bucket,
	lane: Lane,
	extra: { idempotent?: boolean; openWorld?: boolean; dedupe?: boolean; flag?: Flag } = {},
): CatalogEntry {
	return {
		name,
		app,
		scope,
		tier,
		bucket,
		lane,
		idempotent: extra.idempotent ?? tier === "R",
		openWorld: extra.openWorld ?? false,
		...(extra.dedupe ? { dedupe: true } : {}),
		...(extra.flag ? { flag: extra.flag } : {}),
	};
}

const R = "workspace.read";
const W = "workspace.write";
const X = "workspace.remove";
const S = "workspace.share";
const I = { idempotent: true } as const;

export const CATALOG: readonly CatalogEntry[] = Object.freeze([
	// 11.1 Meta (always on)
	e("workspace_whoami", null, R, "R", "read", "core"),
	e("workspace_overview", null, R, "R", "read", "E"),
	// 11.2 Files
	e("files_list_folder", "files", R, "R", "read", "A"),
	e("files_search", "files", R, "R", "read", "A"),
	e("files_get_info", "files", R, "R", "read", "A"),
	e("files_read_text", "files", R, "R", "read", "C"),
	e("files_create_file", "files", W, "A", "write", "A"),
	e("files_overwrite_file", "files", X, "D", "remove", "A", I),
	e("files_create_folder", "files", W, "A", "write", "A", I),
	e("files_move", "files", W, "D", "write", "A"),
	e("files_copy", "files", W, "A", "write", "A"),
	e("files_rename", "files", W, "D", "write", "A"),
	e("files_move_to_trash", "files", X, "D", "remove", "A", I),
	e("files_list_trash", "files", R, "R", "read", "A"),
	e("files_restore_from_trash", "files", W, "A", "write", "A"),
	e("files_list_versions", "files", R, "R", "read", "A"),
	e("files_restore_version", "files", X, "D", "remove", "A"),
	e("files_list_favorites", "files", R, "R", "read", "A"),
	e("files_set_favorite", "files", W, "D", "write", "A", I),
	e("files_list_recent", "files", R, "R", "read", "A"),
	// 11.3 Sharing
	e("sharing_find_people", "files", S, "R", "read", "B"),
	e("sharing_create_link", "files", S, "D", "share", "B", { openWorld: true, dedupe: true }),
	e("sharing_share_with", "files", S, "D", "share", "B"),
	e("sharing_list", "files", R, "R", "read", "B"),
	e("sharing_update", "files", S, "D", "share", "B", I),
	e("sharing_delete", "files", S, "D", "share", "B", I),
	// 11.4 Documents (hidden when HEAVY_TOOLS=off)
	e("docs_create_document", "docs", W, "A", "heavy", "C", { flag: "heavy" }),
	e("docs_create_spreadsheet", "docs", W, "A", "heavy", "C", { flag: "heavy" }),
	e("docs_create_presentation", "docs", W, "A", "heavy", "C", { flag: "heavy" }),
	e("docs_convert", "docs", W, "A", "heavy", "C", { flag: "heavy" }),
	e("docs_list_template_fields", "docs", R, "R", "heavy", "C", { flag: "heavy" }),
	e("docs_fill_template", "docs", W, "A", "heavy", "C", { flag: "heavy" }),
	// 11.5 Calendar
	e("calendar_list_calendars", "calendar", R, "R", "read", "D"),
	e("calendar_list_events", "calendar", R, "R", "read", "D"),
	e("calendar_find_free_time", "calendar", R, "R", "read", "D"),
	e("calendar_create_event", "calendar", W, "A", "write", "D", { dedupe: true }),
	e("calendar_update_event", "calendar", W, "D", "write", "D"),
	e("calendar_cancel_event", "calendar", X, "D", "remove", "D", I),
	e("calendar_add_attendees", "calendar", S, "D", "share", "D", { flag: "attendees" }),
	// Fix round 3: the invited person's answer (the other half of calendar_add_attendees).
	e("calendar_respond", "calendar", W, "D", "write", "D", I),
	// 11.6 Tasks
	e("tasks_list", "calendar", R, "R", "read", "D"),
	e("tasks_create", "calendar", W, "A", "write", "D", { dedupe: true }),
	e("tasks_complete", "calendar", W, "D", "write", "D", I),
	e("tasks_set_due_date", "calendar", W, "D", "write", "D", I),
	// 11.7 Contacts
	e("contacts_search", "contacts", R, "R", "read", "B"),
	e("contacts_get", "contacts", R, "R", "read", "B"),
	e("contacts_add", "contacts", W, "A", "write", "B", { dedupe: true }),
	e("contacts_update", "contacts", W, "D", "write", "B"),
	// 11.8 Boards
	e("boards_list", "boards", R, "R", "read", "E"),
	e("boards_get_board", "boards", R, "R", "read", "E"),
	e("boards_get_card", "boards", R, "R", "read", "E"),
	e("boards_create_card", "boards", W, "A", "write", "E", { dedupe: true }),
	e("boards_move_card", "boards", W, "D", "write", "E"),
	e("boards_set_due_date", "boards", W, "D", "write", "E", I),
	e("boards_assign_card", "boards", W, "D", "write", "E", I),
	e("boards_add_comment", "boards", W, "A", "write", "E", { dedupe: true }),
	// 25.3 NoGantt (lane G, added 2026-10-25 after the 55; DESIGN section 25)
	e("gantt_list_projects", "gantt", R, "R", "read", "G"),
	e("gantt_get_project", "gantt", R, "R", "read", "G"),
	e("gantt_my_tasks", "gantt", R, "R", "read", "G"),
	e("gantt_create_project", "gantt", W, "A", "write", "G", { dedupe: true }),
	e("gantt_update_project", "gantt", W, "D", "write", "G", I),
	e("gantt_import_plan", "gantt", W, "A", "write", "G", { dedupe: true }),
	e("gantt_add_task", "gantt", W, "A", "write", "G", { dedupe: true }),
	e("gantt_update_task", "gantt", W, "D", "write", "G", I),
	e("gantt_add_milestone", "gantt", W, "A", "write", "G", { dedupe: true }),
	e("gantt_link_tasks", "gantt", W, "D", "write", "G", I),
	e("gantt_critical_path", "gantt", R, "R", "read", "G"),
	e("gantt_project_report", "gantt", R, "R", "read", "G"),
	e("gantt_link_board_card", "gantt", W, "D", "write", "G"),
	e("gantt_share_project", "gantt", S, "D", "share", "G"),
	e("gantt_undo_change", "gantt", W, "D", "write", "G"),
]);

const BY_NAME = new Map(CATALOG.map((c) => [c.name, c]));

export function catalogEntry(name: string): CatalogEntry | undefined {
	return BY_NAME.get(name);
}

export function catalogIndex(name: string): number {
	return CATALOG.findIndex((c) => c.name === name);
}

/** The MCP annotations for an entry: all four hints are always set (10.3). */
export function annotationsFor(c: CatalogEntry): { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } {
	return {
		readOnlyHint: c.tier === "R",
		destructiveHint: c.tier === "D",
		idempotentHint: c.idempotent,
		openWorldHint: c.openWorld,
	};
}

/** Plain words for what each scope allows, used by the consent page, instructions and whoami. */
export const SCOPE_WORDS: Readonly<Record<Scope, string>> = {
	"workspace.read": "read",
	"workspace.write": "create and edit",
	"workspace.remove": "replace and remove (most can be undone for 30 days)",
	"workspace.share": "share and invite",
	"mail.read": "read mail",
	"mail.write": "write and send mail",
};

export const APP_WORDS: Readonly<Record<AppId, string>> = {
	files: "Files and sharing (NoDrive)",
	docs: "Documents (ONLYOFFICE)",
	calendar: "Calendar and tasks (NoCalendar, NoTasks)",
	contacts: "Contacts (NoContacts)",
	boards: "Boards (NoBoard)",
	gantt: "Projects (NoGantt)",
	mail: "Mail (NoMail)",
};
