/**
 * Read-only views of a NoGantt plan (DESIGN 25.3): gantt_critical_path and gantt_project_report.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { defineTool } from "../../core/tool";
import { ANSWER_REST, day, fitWithin, gantt, getProject, milestoneOut, projectTasks, projectUrl, type RawMilestone, statusOf, text, title, today } from "./api";
import { projectIdArg } from "./shapes";

// --- gantt_critical_path ---------------------------------------------------------------------

/** slack_days is null when NoGantt gave no slack for the task (for example when the links form a loop). */
const CpTask = z.object({ task_id: z.number(), title: z.string(), start: z.string().nullable(), end: z.string().nullable(), slack_days: z.number().nullable() });

export const criticalPath = defineTool({
	name: "gantt_critical_path",
	title: "Critical path",
	description:
		"Shows which tasks of a NoGantt project set its end date (the critical path, no slack) and how many working days the other tasks can slip without moving the end (slack_days; null when unknown). It is worked out from the links between tasks (gantt_link_tasks); tasks with no links start the plan.",
	input: z.object({ project_id: projectIdArg() }).strict(),
	async run(ctx, args) {
		const id = args.project_id;
		const [cp, tasks] = await Promise.all([
			gantt<{ critical_ids?: unknown[]; float_map?: Record<string, unknown>; project_duration?: number }>(ctx, "GET", `/projects/${id}/critical-path`, {
				notFound: `There's no project ${id} that this person can see.`,
			}),
			projectTasks(ctx, id),
		]);
		// NoGantt's float_map is an object keyed "t-<id>"; PHP sends an empty one as [] (its $empty result).
		const floats: Record<string, unknown> = cp?.float_map && typeof cp.float_map === "object" && !Array.isArray(cp.float_map) ? cp.float_map : {};
		const rows = tasks
			.map((t) => {
				const raw = floats[`t-${t.id}`];
				const f = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
				// No slack from NoGantt is unknown (null), never 0: 0 would mean the task is critical.
				return { task_id: t.id, title: title(t.title), start: day(t.start_date), end: day(t.end_date), slack_days: Number.isFinite(f) ? f : null };
			})
			.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? "") || a.task_id - b.task_id);
		const criticalIds = new Set((Array.isArray(cp?.critical_ids) ? cp.critical_ids : []).filter((x): x is number => typeof x === "number"));
		const criticalAll = rows.filter((r) => criticalIds.has(r.task_id));
		// Least slack first; tasks without a known slack last.
		const slack = (r: (typeof rows)[number]) => r.slack_days ?? Number.POSITIVE_INFINITY;
		const othersAll = rows.filter((r) => !criticalIds.has(r.task_id)).sort((a, b) => slack(a) - slack(b) || a.task_id - b.task_id);
		const unknown = othersAll.filter((r) => r.slack_days === null).length;
		// At most 200 of each; the critical tasks may use up to two thirds of the result, the others the rest.
		const room = ctx.budget.chars - ANSWER_REST;
		const critical = fitWithin(criticalAll, 200, Math.floor((room * 2) / 3), (items) => ({ critical: items })).items;
		const others = fitWithin(othersAll, 200, room, (items) => ({ critical, others: items })).items;
		let note: string | null = null;
		if (tasks.length === 0) note = "This project has no tasks yet.";
		else if (criticalIds.size === 0) {
			note = `No critical path could be worked out; the links between tasks may form a loop.${unknown === othersAll.length ? " Slack is unknown (null) for every task." : ""}`;
		}
		else if (unknown) note = `NoGantt gave no slack for ${unknown} task${unknown === 1 ? "" : "s"}; ${unknown === 1 ? "its" : "their"} slack_days ${unknown === 1 ? "is" : "are"} null.`;
		const data = {
			project_id: id,
			duration_working_days: Number(cp?.project_duration ?? 0) || 0,
			critical,
			critical_total: criticalAll.length,
			others,
			others_total: othersAll.length,
			note,
		};
		const warnings: string[] = [];
		if (critical.length < criticalAll.length || others.length < othersAll.length) {
			warnings.push(`Only ${critical.length} of ${criticalAll.length} critical tasks and ${others.length} of ${othersAll.length} other tasks fit in one answer (the others with the least slack first).`);
		}
		return {
			data,
			summary: `Project ${id}: ${criticalAll.length} critical task${criticalAll.length === 1 ? "" : "s"}, ${data.duration_working_days} working days in all.`,
			...(warnings.length ? { warnings } : {}),
		};
	},
});

// --- gantt_project_report --------------------------------------------------------------------

interface Rollup {
	progress?: number;
	budget_total?: number | null;
	budget_unit?: string | null;
	schedule_deviation?: number;
	schedule_level?: number;
	risk_level?: number | null;
	blocked_count?: number;
	deck_deviation_count?: number;
	evm?: { pv?: number; ev?: number; ac?: number | null; spi?: number | null; cpi?: number | null } | null;
}

interface Delta {
	baseline_date?: string;
	baseline_comment?: string | null;
	items?: { task_id?: number; title?: string; deleted?: boolean; baseline_end?: string; current_end?: string | null; schedule_variance_days?: number | null }[];
	summary?: { total_schedule_variance_days?: number; count_delayed?: number; count_total?: number };
}

const SCHEDULE = ["on_track", "at_risk", "late"] as const;

export const projectReport = defineTool({
	name: "gantt_project_report",
	title: "Project report",
	description:
		"Reports on one NoGantt project: progress, schedule status (on_track, at_risk or late), tasks done, in progress, blocked and overdue, the next milestones, budget and earned value where set, and, when a baseline was saved in NoGantt, how many tasks end later than in it and the biggest delays (calendar days).",
	input: z.object({ project_id: projectIdArg() }).strict(),
	async run(ctx, args) {
		const id = args.project_id;
		const nf = { notFound: `There's no project ${id} that this person can see.` };
		const [p, rollup, tasks, milestones, delta] = await Promise.all([
			getProject(ctx, id),
			gantt<Rollup>(ctx, "GET", `/projects/${id}/rollup`, nf),
			projectTasks(ctx, id),
			gantt<RawMilestone[]>(ctx, "GET", `/projects/${id}/milestones`, nf),
			gantt<Delta>(ctx, "GET", `/projects/${id}/report/delta`, nf).catch((e: unknown) => {
				// No baseline saved yet: NoGantt answers 404 no_baseline. Anything else is a real failure.
				if (e instanceof ToolError && e.code === "not_found") return null;
				throw e;
			}),
		]);
		const now = today(ctx);
		const counts = { total: tasks.length, not_started: 0, in_progress: 0, blocked: 0, done: 0, overdue: 0 };
		let first: string | null = null;
		let last: string | null = null;
		for (const t of tasks) {
			const s = statusOf(t.status);
			const progress = Number(t.manual_progress ?? 0) || 0;
			const isDone = s === "done" || progress >= 100;
			if (isDone) counts.done++;
			else counts[s]++;
			const st = day(t.start_date);
			const en = day(t.end_date);
			if (st && (!first || st < first)) first = st;
			if (en && (!last || en > last)) last = en;
			if (!isDone && en && en < now) counts.overdue++;
		}
		const next = (Array.isArray(milestones) ? milestones : [])
			.map(milestoneOut)
			.filter((m) => m.date !== null && m.date >= now)
			.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))
			.slice(0, 5)
			.map((m) => ({ milestone_id: m.milestone_id, title: m.title, date: m.date }));
		const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
		const evm = rollup?.evm ?? null;
		const unit = rollup?.budget_unit === "gemischt" ? "mixed" : text(rollup?.budget_unit ?? null, 20);
		let baseline = null;
		if (delta && Array.isArray(delta.items)) {
			// Every task that ends later than in the baseline (calendar days, as NoGantt counts them).
			// NoGantt's own summary counts a task as delayed only beyond 7 days (ReportService: schedVar > 7),
			// so both counts come from the same items as biggest_delays and say which rule they use (DESIGN 25.10).
			const late = delta.items.filter((i) => typeof i.task_id === "number" && typeof i.schedule_variance_days === "number" && (i.schedule_variance_days as number) > 0);
			const delays = late
				.slice()
				.sort((a, b) => (b.schedule_variance_days as number) - (a.schedule_variance_days as number))
				.slice(0, 20)
				.map((i) => ({
					task_id: i.task_id as number,
					title: title(i.title),
					baseline_end: day(i.baseline_end),
					current_end: day(i.current_end ?? null),
					variance_days: i.schedule_variance_days as number,
				}));
			baseline = {
				saved_at: day(delta.baseline_date),
				comment: text(delta.baseline_comment ?? null, 300),
				tasks_compared: Number(delta.summary?.count_total ?? delta.items.length) || 0,
				delayed_tasks: late.length,
				delayed_more_than_7_days: late.filter((i) => (i.schedule_variance_days as number) > 7).length,
				total_schedule_variance_days: Number(delta.summary?.total_schedule_variance_days ?? 0) || 0,
				biggest_delays: delays,
			};
		}
		const level = Math.max(0, Math.min(2, Number(rollup?.schedule_level ?? 0) || 0));
		const data = {
			project: { project_id: p.id, title: title(p.title), plan_start: day(p.plan_start), plan_end: day(p.plan_end), web_url: projectUrl(ctx, p.id) },
			progress_percent: Math.max(0, Math.min(100, Number(rollup?.progress ?? 0) || 0)),
			schedule: { status: SCHEDULE[level] as (typeof SCHEDULE)[number], worst_delay_working_days: Number(rollup?.schedule_deviation ?? 0) || 0 },
			tasks: counts,
			dates: { first_start: first, last_end: last },
			next_milestones: next,
			budget: {
				planned: num(rollup?.budget_total),
				unit,
				earned_value: evm ? { pv: num(evm.pv), ev: num(evm.ev), ac: num(evm.ac), spi: num(evm.spi), cpi: num(evm.cpi) } : null,
			},
			highest_risk: num(rollup?.risk_level),
			board_differences: Number(rollup?.deck_deviation_count ?? 0) || 0,
			baseline,
		};
		return {
			data,
			summary: `Project ${id}: ${data.progress_percent}% done, schedule ${data.schedule.status.replace("_", " ")}, ${counts.overdue} overdue task${counts.overdue === 1 ? "" : "s"}.`,
		};
	},
});

export const insightTools = [criticalPath, projectReport];

/** Result shapes, checked by the contract tests (not published in tools/list; see shapes.ts). */
export const INSIGHT_OUTPUTS = {
	gantt_critical_path: z.object({
		project_id: z.number(),
		duration_working_days: z.number(),
		critical: z.array(CpTask).max(200),
		critical_total: z.number(),
		others: z.array(CpTask).max(200),
		others_total: z.number(),
		note: z.string().nullable(),
	}),
	gantt_project_report: z.object({
	project: z.object({ project_id: z.number(), title: z.string(), plan_start: z.string().nullable(), plan_end: z.string().nullable(), web_url: z.string() }),
	progress_percent: z.number(),
	schedule: z.object({ status: z.enum(SCHEDULE), worst_delay_working_days: z.number() }),
	tasks: z.object({ total: z.number(), not_started: z.number(), in_progress: z.number(), blocked: z.number(), done: z.number(), overdue: z.number() }),
	dates: z.object({ first_start: z.string().nullable(), last_end: z.string().nullable() }),
	next_milestones: z.array(z.object({ milestone_id: z.number(), title: z.string(), date: z.string().nullable() })),
	budget: z.object({
		planned: z.number().nullable(),
		unit: z.string().nullable(),
		earned_value: z.object({ pv: z.number().nullable(), ev: z.number().nullable(), ac: z.number().nullable(), spi: z.number().nullable(), cpi: z.number().nullable() }).nullable(),
	}),
	highest_risk: z.number().nullable(),
	board_differences: z.number(),
	baseline: z
		.object({
			saved_at: z.string().nullable(),
			comment: z.string().nullable(),
			tasks_compared: z.number(),
			/** Tasks that end later than in the baseline: every one, of which biggest_delays lists up to 20. */
			delayed_tasks: z.number(),
			/** Of those, the ones more than 7 calendar days late: what NoGantt's own report counts as delayed. */
			delayed_more_than_7_days: z.number(),
			total_schedule_variance_days: z.number(),
			biggest_delays: z.array(z.object({ task_id: z.number(), title: z.string(), baseline_end: z.string().nullable(), current_end: z.string().nullable(), variance_days: z.number() })),
		})
		.nullable(),
}),
};
