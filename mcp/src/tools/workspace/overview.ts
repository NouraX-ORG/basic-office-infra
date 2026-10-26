/**
 * workspace_overview (DESIGN 11.1), lane E: which Nourax Workspace apps and features this person
 * has right now, the size limits, and what this connection can't do.
 *
 * Sources: GET /ocs/v2.php/cloud/capabilities (trash, versions, sharing, deck), GET
 * /ocs/v2.php/core/navigation/apps (which apps are on for the person), GET
 * /ocs/v2.php/search/providers (is search inside files there), our flags, the registry and the
 * vault record. The three server answers are cached per person (hashed uid) for 10 minutes by core.
 * App ids are mapped to our product names; raw ids are never shown. A failed source is reported
 * as unknown (null) instead of failing the whole overview, except a dead credential.
 *
 * Every app's `tools` counts what this connection lists. For mail that is the same count tools/list
 * gives (fix round 3): NoMail's tools that this connection's scopes and apps allow, within the room
 * our own tools leave in the 100 (src/mail/access.ts); `offered` is NoMail's whole list of valid
 * tools, before the cap of 30 (fix round 4).
 *
 * Documents (DESIGN 26.7): docx, xlsx and pptx are made in the Worker, so `documents.available`
 * follows HEAVY_TOOLS only. PDF conversion goes through the ONLYOFFICE connector (DESIGN 12.5), not
 * the server's own conversion API: `files.file_conversions` is [] on drive.nourax.org (read live,
 * 2026-10-25) and says nothing about it. NoDrive names the connector neither in its capabilities nor
 * in the navigation; only the Direct Editing list does, and core's egress allowlist doesn't include
 * that route. So `pdf_conversion` says whether docs_convert is offered (HEAVY_TOOLS on and the tool
 * built); a connector that is off shows up as docs_convert's own plain error.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import { defineTool, type ToolCtx } from "../../core/tool";
import { type MailOverview, mailOverview } from "../../mail/index";
import { ALL_APPS, APP_WORDS, type CatalogEntry, SCOPE_WORDS, type Scope } from "../../mcp/catalog";
import type { ToolDef } from "../../core/tool";

/** Loaded lazily: the registry imports this module, so a static import would be a cycle. */
async function builtTools(): Promise<readonly ToolDef[]> {
	return (await import("../registry")).TOOLS;
}

const avail = z.boolean().nullable();

/** What tools/list publishes: the main fields, open to the rest (keeps tools/list small, DESIGN 10.8). */
const output = z.looseObject({
	apps: z.record(z.string(), z.looseObject({ available: avail.optional() })),
	limits: z.record(z.string(), z.number()),
	connection: z.looseObject({ can: z.array(z.string()), cannot: z.array(z.string()), apps: z.array(z.string()) }),
	notes: z.array(z.string()),
});

type AppStatus = {
	available: boolean | null;
	in_this_connection: boolean;
	tools: number;
};

type Output = {
	apps: {
		files: AppStatus & { trash: boolean | null; versions: boolean | null };
		sharing: { available: boolean | null; allowed: boolean; public_links: boolean | null; tools: number };
		documents: AppStatus & { pdf_conversion: boolean };
		content_search: { available: boolean | null };
		calendar: AppStatus & { attendees: "internal" | "off" };
		tasks: AppStatus;
		contacts: AppStatus;
		boards: AppStatus;
		gantt: AppStatus;
		mail: { status: "on" | "off" | "reconnect_needed" | "not_set_up"; tools: number | null; offered?: number; note: string | null };
	};
	limits: Record<string, number>;
	connection: { kind: "oauth" | "desktop" | "dev"; can: string[]; cannot: string[]; apps: string[] };
	notes: string[];
};


/** Our product names for the app ids NoDrive reports. Raw ids never reach a person. */
const NAV: Record<string, string> = {
	files: "files",
	calendar: "calendar",
	contacts: "contacts",
	deck: "boards",
	tasks: "tasks",
	nc_gantt: "gantt",
};

function settled<T>(r: PromiseSettledResult<T>): T | null {
	if (r.status === "fulfilled") return r.value;
	// A dead credential must still end the connection (8.5); everything else is just "unknown".
	if (r.reason instanceof ToolError && (r.reason.deadCredential || r.reason.code === "reconnect_required")) throw r.reason;
	return null;
}

function visible(ctx: ToolCtx, e: CatalogEntry): boolean {
	if (!ctx.connection.scopes.includes(e.scope)) return false;
	if (e.app !== null && !ctx.connection.apps.includes(e.app)) return false;
	if (e.flag === "heavy" && !ctx.cfg.heavyTools) return false;
	if (e.flag === "attendees" && ctx.cfg.calendarAttendees !== "internal") return false;
	return true;
}

function countTools(ctx: ToolCtx, tools: readonly ToolDef[], prefix: string): number {
	return tools.filter((t) => t.name.startsWith(prefix) && visible(ctx, t.entry)).length;
}

/**
 * What this connection can't do. With mail on, the lines also say what mail tools can't reach, since
 * they follow the same choices (src/mail/access.ts): no NoDrive files without the Files app, no files
 * saved without write, and no Drive file sent as a share link without share.
 */
function cannotList(ctx: ToolCtx, mailStatus: string): string[] {
	const has = (s: Scope) => ctx.connection.scopes.includes(s);
	const mailWrites = mailStatus === "on" && has("mail.write");
	const out: string[] = [];
	if (!has("workspace.write")) out.push(`create or change files, documents, events, tasks, contacts or cards${mailWrites ? ", or save mail attachments to NoDrive" : ""}`);
	if (!has("workspace.remove")) out.push("replace files, move things to the trash, restore versions or cancel events");
	if (!has("workspace.share")) out.push(`share files, create public links or invite people to events${mailWrites ? ", or send NoDrive files as links in mail" : ""}`);
	if (mailStatus === "on" && !has("mail.write")) out.push("write or send mail");
	if (mailStatus === "on" && !has("mail.read")) out.push("read mail");
	for (const app of ALL_APPS) {
		if (app === "mail" || ctx.connection.apps.includes(app)) continue;
		const alsoMail = app === "files" && mailWrites ? ", so mail tools can't attach NoDrive files or save attachments there either" : "";
		out.push(`use ${APP_WORDS[app]} (not chosen for this connection)${alsoMail}`);
	}
	if (out.length) out.push("The person can allow more by reconnecting the assistant.");
	return out;
}

export const overview = defineTool({
	name: "workspace_overview",
	title: "Workspace overview",
	description:
		"Lists which Nourax Workspace apps and features are available to this person right now: NoDrive files and sharing, documents and PDF conversion, search inside files, NoCalendar and invitations, NoTasks, NoContacts, NoBoard, NoGantt and NoMail, with the size limits that apply and what this connection cannot do.",
	input: z.object({}).strict(),
	output,
	async run(ctx) {
		const TOOLS = await builtTools();
		// The same count core's factory hands the mail module for tools/list: our own visible tools.
		const ownCount = TOOLS.filter((t) => visible(ctx, t.entry)).length;
		const mailView = { grant: { scopes: ctx.connection.scopes, apps: ctx.connection.apps }, ownCount };
		const [capsR, navR, provR, mailR] = await Promise.allSettled([ctx.nc.capabilities(), ctx.nc.navigationApps(), ctx.nc.providers(), mailOverview(ctx.mail, mailView)]);
		const caps = settled(capsR);
		const navIds = settled(navR);
		const providers = settled(provR);
		const mail: MailOverview = mailR.status === "fulfilled" ? mailR.value : { status: ctx.connection.mail, tools: null, reason: null };
		const notes: string[] = [];
		if (!caps || !navIds || !providers) notes.push("Some of NoDrive's settings couldn't be read just now, so a few answers are unknown (null).");

		const nav = navIds ? new Set(navIds.map((id) => NAV[id]).filter((x): x is string => Boolean(x))) : null;
		const on = (product: string): boolean | null => (nav ? nav.has(product) : null);
		const apps = ctx.connection.apps;
		const sharingCaps = (caps?.raw.files_sharing ?? null) as { api_enabled?: boolean; public?: { enabled?: boolean } } | null;
		const deckOn = caps ? caps.deck !== null : on("boards");
		const heavy = ctx.cfg.heavyTools;
		const docsTools = countTools(ctx, TOOLS, "docs_");
		const builtConvert = TOOLS.some((t) => t.name === "docs_convert");

		const data: Output = {
			apps: {
				files: {
					available: on("files"),
					in_this_connection: apps.includes("files"),
					tools: countTools(ctx, TOOLS, "files_"),
					trash: caps ? caps.trash : null,
					versions: caps ? caps.versions : null,
				},
				sharing: {
					available: sharingCaps ? sharingCaps.api_enabled !== false : null,
					allowed: ctx.connection.scopes.includes("workspace.share") && apps.includes("files"),
					public_links: sharingCaps ? sharingCaps.public?.enabled === true : null,
					tools: countTools(ctx, TOOLS, "sharing_"),
				},
				documents: {
					available: heavy,
					in_this_connection: apps.includes("docs") && heavy,
					tools: docsTools,
					pdf_conversion: heavy && builtConvert,
				},
				content_search: { available: providers ? providers.includes("fulltextsearch") : null },
				calendar: {
					available: on("calendar"),
					in_this_connection: apps.includes("calendar"),
					tools: countTools(ctx, TOOLS, "calendar_"),
					attendees: ctx.cfg.calendarAttendees,
				},
				tasks: { available: on("tasks"), in_this_connection: apps.includes("calendar"), tools: countTools(ctx, TOOLS, "tasks_") },
				contacts: { available: on("contacts"), in_this_connection: apps.includes("contacts"), tools: countTools(ctx, TOOLS, "contacts_") },
				boards: { available: deckOn, in_this_connection: apps.includes("boards"), tools: countTools(ctx, TOOLS, "boards_") },
				gantt: { available: on("gantt"), in_this_connection: (apps as readonly string[]).includes("gantt"), tools: countTools(ctx, TOOLS, "gantt_") },
				mail: { status: mail.status, tools: mail.tools, ...(mail.offered !== undefined ? { offered: mail.offered } : {}), note: mail.reason },
			},
			limits: {
				upload_bytes: LIMITS.binaryUploadBytes,
				text_upload_chars: LIMITS.textUploadChars,
				read_chars_max: LIMITS.readCharsMax,
				read_source_bytes: LIMITS.serverRouteBytes,
				list_max: LIMITS.listMax,
				link_days_max: ctx.cfg.maxLinkDays,
				result_chars: LIMITS.resultChars,
				comment_chars: LIMITS.commentChars,
			},
			connection: {
				kind: ctx.connection.kind,
				can: ctx.connection.scopes.map((s) => SCOPE_WORDS[s]),
				cannot: cannotList(ctx, mail.status),
				apps: apps.map((a) => APP_WORDS[a]),
			},
			notes,
		};
		if (data.apps.content_search.available === false) notes.push("Search inside files isn't available right now; files_search finds files by name.");
		if (!heavy) notes.push("Documents, PDF conversion and reading Office or PDF files are switched off in Nourax Workspace right now.");
		const usable = [
			data.apps.files.in_this_connection && "NoDrive",
			data.apps.documents.in_this_connection && "documents",
			data.apps.calendar.in_this_connection && "NoCalendar and NoTasks",
			data.apps.contacts.in_this_connection && "NoContacts",
			data.apps.boards.in_this_connection && "NoBoard",
			data.apps.gantt.in_this_connection && data.apps.gantt.tools > 0 && "NoGantt",
			data.apps.mail.status === "on" && (data.apps.mail.tools ?? 0) > 0 && "NoMail",
		].filter(Boolean);
		return { data, summary: usable.length ? `This connection covers ${usable.join(", ")}.` : "This connection covers only the overview tools." };
	},
});
