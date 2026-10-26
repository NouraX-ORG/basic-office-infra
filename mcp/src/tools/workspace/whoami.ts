/**
 * workspace_whoami (DESIGN 11.1): core's reference tool, built end to end.
 * GET /ocs/v2.php/cloud/user plus the vault record.
 */
import { z } from "zod";
import { defineTool } from "../../core/tool";
import { APP_WORDS, SCOPE_WORDS } from "../../mcp/catalog";

const output = z.object({
	user_id: z.string(),
	display_name: z.string().nullable(),
	email: z.string().nullable(),
	language: z.string().nullable(),
	time_zone: z.string(),
	storage: z.object({
		used_bytes: z.number(),
		free_bytes: z.number().nullable(),
		total_bytes: z.number().nullable(),
		used_percent: z.number().nullable(),
	}),
	connection: z.object({
		kind: z.enum(["oauth", "desktop", "dev"]),
		client: z.string(),
		can: z.array(z.string()),
		apps: z.array(z.string()),
		connected_at: z.string(),
		expires_at: z.string(),
	}),
	mail: z.enum(["on", "off", "reconnect_needed", "not_set_up"]),
});

export const whoami = defineTool({
	name: "workspace_whoami",
	title: "Who am I",
	description:
		"Shows who this connection acts as in Nourax Workspace: display name, user id, email, language, time zone, NoDrive storage used and free, what this connection may do and which apps it covers, and when it expires. Times without an offset in other tools are read in this time zone.",
	input: z.object({}).strict(),
	output,
	async run(ctx) {
		const me = await ctx.nc.cloudUser();
		const q = me.quota;
		const total = q.total ?? (q.free !== null ? q.used + q.free : null);
		const usedPercent = q.relative ?? (total && total > 0 ? Math.round((q.used / total) * 1000) / 10 : null);
		const data = {
			user_id: ctx.uid,
			display_name: me.displayName ?? ctx.displayName,
			email: me.email,
			language: me.language,
			time_zone: ctx.time.zone,
			storage: { used_bytes: q.used, free_bytes: q.free, total_bytes: total, used_percent: usedPercent },
			connection: {
				kind: ctx.connection.kind,
				client: ctx.connection.client,
				can: ctx.connection.scopes.map((s) => SCOPE_WORDS[s]),
				apps: ctx.connection.apps.map((a) => APP_WORDS[a]),
				connected_at: ctx.connection.connectedAt,
				expires_at: ctx.connection.expiresAt,
			},
			mail: ctx.connection.mail,
		};
		const name = data.display_name ?? ctx.uid;
		return { data, summary: `This connection acts as ${name} in Nourax Workspace.` };
	},
});
