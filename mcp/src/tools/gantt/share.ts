/**
 * gantt_share_project (DESIGN 25.3 and 25.2): list, find, share and unshare for one NoGantt project.
 *
 * Privacy between organisations: NoGantt's own share endpoint accepts any existing account,
 * including people of another organisation (checked live, 25.2). So this tool only ever offers what
 * core's sharees search returns for the person (nc.sharees.search, which follows the server's
 * sharing and enumeration rules) and only shares with an id that a fresh core search returns again
 * as an exact match (nc.sharees.verify). It never uses NoGantt's own people search.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { parseTypedId, type TypedKind, typedIdSchema } from "../../core/ids";
import { defineTool } from "../../core/tool";
import { ANSWER_REST, fitWithin, gantt, ganttNoContent, getProject, own, permissionOf, type Role, roleOf, text } from "./api";
import { idArg, projectIdArg } from "./shapes";

interface RawShare {
	id: number;
	project_id: number;
	principal_id: string;
	principal_type: string;
	permission: string;
	created_at?: string;
	display_name?: string;
}

const KIND_OF: Record<string, TypedKind> = { user: "person", group: "group", team: "team" };
const TYPE_OF: Record<TypedKind, string> = { person: "user", group: "group", team: "team" };

function shareOut(s: RawShare) {
	const kind = own(KIND_OF, s.principal_type) ?? "person";
	return {
		share_id: s.id,
		with: { id: `${kind}:${s.principal_id}`, kind, display_name: text(s.display_name ?? null, 200) },
		role: roleOf(s.permission),
		created_at: s.created_at ? String(s.created_at).replace(" ", "T").slice(0, 19) : null,
	};
}

const ShareOut = z.object({
	share_id: z.number(),
	with: z.object({ id: z.string(), kind: z.enum(["person", "group", "team"]), display_name: z.string().nullable() }),
	role: z.enum(["viewer", "editor", "project_admin"]),
	created_at: z.string().nullable(),
});

const adminOnly = "Only the project's owner or a project admin can see and change who it is shared with.";

export const shareProject = defineTool({
	name: "gantt_share_project",
	title: "Share a project",
	description:
		"Who a NoGantt project is shared with. action list shows its shares; find looks up people, groups and teams the person may share with (by name); share gives one of them (share_with id from find) the role viewer, editor or project_admin, or changes their role (without role: viewer when new; an existing share keeps its role); unshare ends one share. list, share and unshare need the project admin role; find works for anyone who can see the project.",
	input: z
		.object({
			project_id: projectIdArg(),
			action: z.enum(["list", "find", "share", "unshare"]).describe("What to do."),
			query: z.string().min(2).max(100).optional().describe("For find: part of a name."),
			share_with: typedIdSchema.optional().describe("For share: an id from find."),
			// No default (DESIGN 25.8): NoGantt changes an existing share's role in place, so a default
			// would take rights away from a call that only meant to make sure someone has access.
			role: z.enum(["viewer", "editor", "project_admin"]).optional().describe("For share. Left out: viewer for a new share; an existing share keeps its role."),
			share_id: idArg("For unshare: a share_id from list.").optional(),
		})
		.strict(),
	async run(ctx, args) {
		const pid = args.project_id;
		const base = { action: args.action, shares: null, total: null, candidates: null, share: null, changed_role_from: null };
		// NoGantt's GET also removes shares to groups and teams that no longer exist, for good
		// (ShareController::index); every action here reads the list first (DESIGN 25.9).
		const listShares = async () =>
			(await gantt<RawShare[]>(ctx, "GET", `/projects/${pid}/shares`, { notFound: `There's no project ${pid} that this person can see.` }).catch((e: unknown) => {
				// NoGantt answers 403 to anyone who isn't the owner or a project admin.
				if (e instanceof ToolError && e.code === "not_found") {
					return getProject(ctx, pid).then(() => {
						throw new ToolError("permission_denied", adminOnly);
					});
				}
				throw e;
			})) as RawShare[];

		if (args.action === "list") {
			const all = (await listShares()).map(shareOut);
			// At most 200, and within the result (DESIGN 25.5).
			const shares = fitWithin(all, 200, ctx.budget.chars - ANSWER_REST, (items) => ({ shares: items })).items;
			return {
				data: { ...base, shares, total: all.length },
				summary: `NoGantt project ${pid} is shared ${all.length} time${all.length === 1 ? "" : "s"}.`,
				...(shares.length < all.length ? { warnings: [`Only ${shares.length} of ${all.length} shares fit in one answer; NoGantt shows them all.`] } : {}),
			};
		}

		if (args.action === "find") {
			if (!args.query) throw new ToolError("invalid_input", "find needs query.", { field: "query" });
			await getProject(ctx, pid);
			const found = await ctx.nc.sharees.search(args.query, { kinds: ["person", "group", "team"], limit: 10 });
			const candidates = found.map((s) => ({ id: s.id, kind: s.kind, display_name: text(s.display_name, 200) ?? s.id, detail: s.detail }));
			return { data: { ...base, candidates }, summary: `Found ${candidates.length} match${candidates.length === 1 ? "" : "es"} to share with.` };
		}

		if (args.action === "share") {
			if (!args.share_with) throw new ToolError("invalid_input", "share needs share_with (an id from find).", { field: "share_with" });
			const wanted = parseTypedId(args.share_with, ["person", "group", "team"], "share_with");
			const existing = await listShares();
			const prev = existing.find((s) => own(KIND_OF, s.principal_type) === wanted.kind && s.principal_id === wanted.id);
			// An existing share with no new role, or with the role it has, stays as it is: nothing is
			// written (NoGantt's create would change its role in place; DESIGN 25.8). The project admin
			// sees this share in action list anyway, so nothing new is shown.
			if (prev && (args.role === undefined || args.role === roleOf(prev.permission))) {
				const kept = shareOut(prev);
				return {
					data: { ...base, share: kept },
					summary: `NoGantt project ${pid} is already shared with them as ${kept.role}; nothing was changed.`,
					undo: null,
				};
			}
			const role: Role = args.role ?? "viewer";
			// Only what core's search returns for this person, re-checked now (privacy between organisations).
			const ok = await ctx.nc.sharees.verify(args.share_with, [wanted.kind]);
			if (!ok) {
				throw new ToolError("permission_denied", "That isn't someone this person can share with.", {
					hint: "gantt_share_project with action find lists who they can share with.",
					field: "share_with",
				});
			}
			const r = await gantt<RawShare>(ctx, "POST", `/projects/${pid}/shares`, {
				body: { principal_id: wanted.id, principal_type: TYPE_OF[wanted.kind], permission: permissionOf(role) },
				forbidden: adminOnly,
			});
			const share = shareOut(r);
			const from = prev ? roleOf(prev.permission) : null;
			const warnings: string[] = [];
			if (wanted.kind === "person") warnings.push("Files attached to this project in NoGantt are shared with them too.");
			if (role === "project_admin") warnings.push("A project admin can share the project further and delete it.");
			return {
				data: { ...base, share, changed_role_from: from },
				summary: from ? `Changed a share of NoGantt project ${pid} from ${from} to ${share.role}.` : `Shared NoGantt project ${pid} as ${share.role}.`,
				undo: from
					? { tool: "gantt_share_project", arguments: { project_id: pid, action: "share", share_with: args.share_with, role: from } }
					: { tool: "gantt_share_project", arguments: { project_id: pid, action: "unshare", share_id: share.share_id } },
				...(warnings.length ? { warnings } : {}),
			};
		}

		// unshare
		if (args.share_id === undefined) throw new ToolError("invalid_input", "unshare needs share_id (from list).", { field: "share_id" });
		const existing = await listShares();
		const target = existing.find((s) => s.id === args.share_id);
		if (!target) throw new ToolError("not_found", `NoGantt project ${pid} has no share ${args.share_id}.`, { hint: "action list shows its shares.", field: "share_id" });
		await ganttNoContent(ctx, "DELETE", `/shares/${args.share_id}`, { notFound: `NoGantt project ${pid} has no share ${args.share_id}.`, forbidden: adminOnly });
		const share = shareOut(target);
		return {
			data: { ...base, share },
			summary: `Stopped sharing NoGantt project ${pid} with one ${share.with.kind}.`,
			undo: { tool: "gantt_share_project", arguments: { project_id: pid, action: "share", share_with: share.with.id, role: share.role } },
		};
	},
});

export const shareTools = [shareProject];

/** Result shapes, checked by the contract tests (not published in tools/list; see shapes.ts). */
export const SHARE_OUTPUTS = {
	gantt_share_project: z.object({
	action: z.enum(["list", "find", "share", "unshare"]),
	shares: z.array(ShareOut).max(200).nullable(),
	total: z.number().nullable(),
	candidates: z.array(z.object({ id: z.string(), kind: z.enum(["person", "group", "team"]), display_name: z.string(), detail: z.string().nullable() })).nullable(),
	share: ShareOut.nullable(),
	changed_role_from: z.enum(["viewer", "editor", "project_admin"]).nullable(),
}),
};
