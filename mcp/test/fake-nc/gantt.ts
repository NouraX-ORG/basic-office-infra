/**
 * Lane G's part of the fake (DESIGN 17.3 and 25): an in-memory NoGantt (nc_gantt 2.4.1) on its OCS
 * API, plus the two things its tools read elsewhere: core's sharees search (with a per-person
 * visibility list, to stand for privacy between organisations) and NoBoard's board lookup.
 *
 * Shapes follow what NoGantt answered live on 2026-10-25 (DESIGN 25.1): the OCS envelope, the real
 * HTTP status on errors with a short code in ocs.meta.message, 412 without OCS-APIRequest, dates as
 * "YYYY-MM-DD 00:00:00", predecessor ids "t-<id>"/"m-<id>", op ids for date moves, new links and
 * planning-period changes, and a revert that writes the old dates back into linked cards without
 * asking (ChangeEventController::revert calls syncByIds(..., true)).
 */
import { type FakeNc, ocs, type Recorded } from "./index";

export interface GProject {
	id: number;
	title: string;
	description: string | null;
	color: string;
	owner: string;
	deck_board_id: number | null;
	deck_sync_level: string;
	plan_start: string | null;
	plan_end: string | null;
	updated_at: string;
}
export interface GDep {
	id: number;
	task_id: number;
	predecessor_id: string;
	dependency_type: string;
	lag_days: number;
}
export interface GTask {
	id: number;
	project_id: number;
	subproject_id: number | null;
	title: string;
	description: string | null;
	start_date: string;
	end_date: string;
	status: string;
	manual_progress: number;
	deps: GDep[];
	resources: { resource_id: number }[];
	/**
	 * The task's own resource_id when it differs from its first task_resources row: NoGantt sends a task
	 * assigned that way with `resources: []` (checked live; DESIGN 25.10).
	 */
	resource_id?: number | null;
	deck_cards: number[];
	updated_at: string;
}
export interface GMilestone {
	id: number;
	project_id: number;
	subproject_id: number | null;
	task_id: number | null;
	title: string;
	milestone_date: string;
	dependency_type: string | null;
}
export interface GCard {
	board_id: number;
	readers: Set<string>;
	title?: string;
	description?: string;
	/** ISO date-times as NoBoard sends them, or null. */
	duedate?: string | null;
	startdate?: string | null;
	owner?: string;
}
export interface GShare {
	id: number;
	project_id: number;
	principal_id: string;
	principal_type: string;
	permission: string;
}
interface Change {
	op: string;
	entries: { task_id: number; field: "start_date" | "end_date"; old: string; new: string }[];
	links: number[];
	project_id: number;
	/** A planning-period change (ProjectService::updateProject logs it as one operation). */
	plan?: { old: [string | null, string | null]; new: [string | null, string | null] };
}

const G = "/ocs/v2\\.php/apps/nc_gantt/api/v1";
const fail = (status: number, message: string) => ocs([], status, message);
const D = (s: string) => s.slice(0, 10);

export class FakeGantt {
	projects = new Map<number, GProject>();
	tasks = new Map<number, GTask>();
	milestones = new Map<number, GMilestone>();
	phases = new Map<number, { id: number; project_id: number; parent_id: number | null; title: string; status: string }>();
	shares = new Map<number, GShare>();
	changes = new Map<string, Change>();
	/** Deck boards each person can see. */
	boards = new Map<number, { title: string; readers: Set<string>; editors: Set<string> }>();
	/** Deck cards and the board they are on, with what NoBoard's REST card read returns (DESIGN 25.9). */
	cards = new Map<number, GCard>();
	/** uid -> task ids assigned through a linked resource; uids absent here have no linked resource. */
	myTasks = new Map<string, number[]>();
	/** Core sharees search: who each person may find (privacy between organisations). */
	directory = new Map<string, { kind: "user" | "group"; id: string; label: string }[]>();
	baselines = new Map<number, { created_at: string; comment: string | null; ends: Map<number, string> }>();
	criticalOverride: { critical_ids: number[]; float_map: Record<string, number> | never[]; project_duration: number } | null = null;
	/**
	 * The NoBoard card summary the next date change or revert answers with, used once: every part of
	 * DeckDateSyncService's summary (updated, failed, deviations, pending, gone, unconfirmed).
	 */
	deckNext: Record<string, unknown> | null = null;
	/** How many plans were imported. */
	imports = 0;
	/** How many NoBoard card updates the tools sent. */
	cardPuts = 0;
	private next = 100;
	private ops = 0;

	constructor(private readonly fake: FakeNc) {}

	id(): number {
		return ++this.next;
	}

	/** The deck summary for this answer: deckNext once if set, else what the fake worked out. */
	deck(fallback: Record<string, unknown>): Record<string, unknown> {
		const d = this.deckNext ?? fallback;
		this.deckNext = null;
		return d;
	}

	newOp(): string {
		this.ops++;
		const h = this.ops.toString(16).padStart(12, "0");
		// Plainly made-up ids (never one that exists on drive.nourax.org; DESIGN 25.8).
		return `0000feed-0000-4000-8000-${h}`;
	}

	addProject(owner: string, p: Partial<GProject> = {}): GProject {
		const proj: GProject = {
			id: this.id(),
			title: "Plan",
			description: null,
			color: "#2563EB",
			owner,
			deck_board_id: null,
			deck_sync_level: "off",
			plan_start: null,
			plan_end: null,
			updated_at: "2026-10-25 10:00:00",
			...p,
		};
		this.projects.set(proj.id, proj);
		return proj;
	}

	addTask(projectId: number, t: Partial<GTask> = {}): GTask {
		const task: GTask = {
			id: this.id(),
			project_id: projectId,
			subproject_id: null,
			title: "Task",
			description: null,
			start_date: "2026-11-02 00:00:00",
			end_date: "2026-11-06 00:00:00",
			status: "not_started",
			manual_progress: 0,
			deps: [],
			resources: [],
			deck_cards: [],
			updated_at: "2026-10-25 10:00:00",
			...t,
		};
		this.tasks.set(task.id, task);
		return task;
	}

	addMilestone(projectId: number, m: Partial<GMilestone> = {}): GMilestone {
		const ms: GMilestone = { id: this.id(), project_id: projectId, subproject_id: null, task_id: null, title: "Milestone", milestone_date: "2026-12-01", dependency_type: null, ...m };
		this.milestones.set(ms.id, ms);
		return ms;
	}

	role(projectId: number, uid: string): "admin" | "editor" | "viewer" | null {
		const p = this.projects.get(projectId);
		if (!p) return null;
		if (p.owner === uid) return "admin";
		let best: "admin" | "editor" | "viewer" | null = null;
		const rank = { viewer: 1, editor: 2, admin: 3 } as const;
		for (const s of this.shares.values()) {
			if (s.project_id !== projectId || s.principal_type !== "user" || s.principal_id !== uid) continue;
			const r = s.permission as keyof typeof rank;
			if (!best || rank[r] > rank[best]) best = r;
		}
		return best;
	}

	projectJson(p: GProject, uid: string, extra: Record<string, unknown> = {}) {
		return {
			id: p.id,
			title: p.title,
			description: p.description,
			color: p.color,
			deck_board_id: p.deck_board_id,
			deck_sync_level: p.deck_sync_level,
			deck_list_role: "subproject",
			baseline_id: null,
			owner_id: p.owner,
			owner_display_name: this.fake.users.get(p.owner)?.displayName ?? p.owner,
			created_at: "2026-10-25 10:00:00",
			updated_at: p.updated_at,
			permission: this.role(p.id, uid),
			reminders_enabled: true,
			plan_start: p.plan_start,
			plan_end: p.plan_end,
			dependency_mode: "manual",
			talk_token: null,
			knowledge_folder: null,
			...extra,
		};
	}

	taskJson(t: GTask) {
		return {
			id: t.id,
			project_id: t.project_id,
			subproject_id: t.subproject_id,
			title: t.title,
			description: t.description,
			start_date: t.start_date,
			end_date: t.end_date,
			color: null,
			work: null,
			sort_order: 0,
			dependencies: t.deps.map((d) => ({ ...d })),
			budget_planned: null,
			budget_unit: null,
			resource_id: t.resource_id !== undefined ? t.resource_id : (t.resources[0]?.resource_id ?? null),
			risk_level: null,
			actual_cost: null,
			progress_mode: "manual",
			manual_progress: t.manual_progress,
			status: t.status,
			created_at: "2026-10-25 10:00:00",
			updated_at: t.updated_at,
			resources: t.resources.map((r, i) => ({ id: i + 1, task_id: t.id, resource_id: r.resource_id, work: null, sort_order: i })),
			deck_card_id: t.deck_cards[0] ?? null,
			deck_deviation_kinds: [],
		};
	}

	/** Moves successors that start too early, in calendar days. Returns the moved tasks. */
	propagate(projectId: number, op: Change): GTask[] {
		const moved: GTask[] = [];
		for (let round = 0; round < 50; round++) {
			let changed = false;
			for (const t of this.tasks.values()) {
				if (t.project_id !== projectId) continue;
				for (const d of t.deps) {
					const pm = /^t-(\d+)$/.exec(d.predecessor_id);
					const pred = pm ? this.tasks.get(Number(pm[1])) : undefined;
					if (!pred || d.dependency_type !== "EA") continue;
					const earliest = addDays(D(pred.end_date), 1 + d.lag_days);
					if (D(t.start_date) < earliest) {
						const len = days(D(t.start_date), D(t.end_date));
						const ns = `${earliest} 00:00:00`;
						const ne = `${addDays(earliest, len)} 00:00:00`;
						op.entries.push({ task_id: t.id, field: "start_date", old: t.start_date, new: ns });
						op.entries.push({ task_id: t.id, field: "end_date", old: t.end_date, new: ne });
						t.start_date = ns;
						t.end_date = ne;
						t.updated_at = `2026-10-25 1${round % 10}:00:01`;
						moved.push(t);
						changed = true;
					}
				}
			}
			if (!changed) break;
		}
		return moved;
	}

	/**
	 * The tasks NoGantt would give negative slack, for the one cause lane G meets (DESIGN 25.10): a task
	 * of one day that hangs start to start, without lag, on a fixed milestone (no task_id, no
	 * dependency_type) and also waits for a task. CriticalPathService counts such a task as due on the
	 * milestone's day, and every task it waits for ends a day later at the earliest. The fake's links,
	 * new tasks and replaced links refuse what makes a task newly negative, as NoGantt does
	 * (assertNoNewNegativeFloat; tasks that were negative before stay allowed).
	 */
	negativeFloat(projectId: number): Set<number> {
		const out = new Set<number>();
		for (const t of this.tasks.values()) {
			if (t.project_id !== projectId || D(t.start_date) !== D(t.end_date)) continue;
			const pinned = t.deps.some((d) => {
				const mm = /^m-(\d+)$/.exec(d.predecessor_id);
				const ms = mm ? this.milestones.get(Number(mm[1])) : undefined;
				return !!ms && ms.task_id === null && ms.dependency_type === null && d.dependency_type === "AA" && d.lag_days === 0;
			});
			if (pinned && t.deps.some((d) => d.predecessor_id.startsWith("t-"))) out.add(t.id);
		}
		return out;
	}

	/** The title of a task newly in negativeFloat() after a change, or null. */
	newlyNegative(projectId: number, before: ReadonlySet<number>): string | null {
		for (const id of this.negativeFloat(projectId)) if (!before.has(id)) return this.tasks.get(id)?.title ?? "";
		return null;
	}

	hasCycle(projectId: number): boolean {
		const preds = new Map<string, string[]>();
		for (const t of this.tasks.values()) if (t.project_id === projectId) preds.set(`t-${t.id}`, t.deps.map((d) => d.predecessor_id));
		const state = new Map<string, number>();
		const visit = (n: string): boolean => {
			if (state.get(n) === 1) return true;
			if (state.get(n) === 2) return false;
			state.set(n, 1);
			for (const p of preds.get(n) ?? []) if (visit(p)) return true;
			state.set(n, 2);
			return false;
		};
		return [...preds.keys()].some(visit);
	}
}

function addDays(d: string, n: number): string {
	const t = new Date(`${d}T00:00:00Z`);
	t.setUTCDate(t.getUTCDate() + n);
	return t.toISOString().slice(0, 10);
}
function days(a: string, b: string): number {
	return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
/**
 * What PHP's json_encode makes of an array keyed by item key: a JSON list when the keys are exactly
 * "0", "1", ... in order (PHP turns such keys into integers), else an object (DESIGN 25.9).
 */
export function phpKeyed(entries: readonly [string, number][]): Record<string, number> | number[] {
	return entries.every(([k], i) => k === String(i)) ? entries.map(([, v]) => v) : Object.fromEntries(entries);
}
function body(req: Recorded): Record<string, unknown> {
	try {
		return req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(`${s.slice(0, 10)}T00:00:00Z`));

/** Installs NoGantt, core sharees and the NoBoard board lookup on a fake. */
export function installGantt(fake: FakeNc): FakeGantt {
	const g = new FakeGantt(fake);
	type H = (req: Recorded, uid: string, m: RegExpExecArray) => Response | Promise<Response>;
	const on = (method: string, path: string, h: H) =>
		fake.on(method, new RegExp(`^${G}${path}$`), (req, _f, m) => {
			if (!req.auth) return new Response(JSON.stringify({ ocs: { meta: { status: "failure", statuscode: 997, message: "Current user is not logged in" }, data: [] } }), { status: 401 });
			if (req.headers.get("ocs-apirequest") !== "true") return Response.json({ message: "CSRF check failed" }, { status: 412 });
			return h(req, req.auth, m);
		});
	const project = (uid: string, id: number, need: "view" | "edit" | "admin"): GProject | Response => {
		const p = g.projects.get(id);
		if (!p) return fail(404, "not_found");
		const r = g.role(id, uid);
		const ok = need === "view" ? r !== null : need === "edit" ? r === "editor" || r === "admin" : r === "admin";
		return ok ? p : fail(403, "forbidden");
	};

	on("GET", "/projects", (_req, uid) => ocs([...g.projects.values()].filter((p) => g.role(p.id, uid)).map((p) => g.projectJson(p, uid))));
	on("POST", "/projects", (req, uid) => {
		const b = body(req);
		if (typeof b.title !== "string") return fail(400, "invalid_title");
		if (b.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(b.color))) return fail(400, "invalid_color");
		const start = (b.plan_start as string | undefined) ?? null;
		const end = (b.plan_end as string | undefined) ?? null;
		const p = g.addProject(uid, { title: b.title, description: (b.description as string) ?? null, color: (b.color as string) ?? "#0082c9", plan_start: start ?? end, plan_end: end ?? start });
		return ocs(g.projectJson(p, uid), 201);
	});
	on("GET", "/projects/(\\d+)", (_req, uid, m) => {
		const p = project(uid, Number(m[1]), "view");
		return p instanceof Response ? p : ocs(g.projectJson(p, uid));
	});
	on("PUT", "/projects/(\\d+)", (req, uid, m) => {
		const p = project(uid, Number(m[1]), "edit");
		if (p instanceof Response) return p;
		const b = body(req);
		if (typeof b.title === "string") p.title = b.title;
		if (typeof b.description === "string") p.description = b.description || null;
		if (typeof b.color === "string") {
			if (!/^#[0-9a-fA-F]{6}$/.test(b.color)) return fail(400, "invalid_color");
			p.color = b.color;
		}
		let opId: string | null = null;
		if ("plan_start" in b || "plan_end" in b) {
			const s = "plan_start" in b ? (b.plan_start as string | null) : p.plan_start;
			const e = "plan_end" in b ? (b.plan_end as string | null) : p.plan_end;
			if (s && e && s > e) return fail(400, "plan_start_after_end");
			const old: [string | null, string | null] = [p.plan_start, p.plan_end];
			p.plan_start = s ?? null;
			p.plan_end = e ?? null;
			if (old[0] !== p.plan_start || old[1] !== p.plan_end) {
				const op: Change = { op: g.newOp(), entries: [], links: [], project_id: p.id, plan: { old, new: [p.plan_start, p.plan_end] } };
				g.changes.set(op.op, op);
				opId = op.op;
			}
		}
		if ("deck_board_id" in b) p.deck_board_id = (b.deck_board_id as number | null) ?? null;
		if ("deck_sync_level" in b) p.deck_sync_level = String(b.deck_sync_level);
		if (p.deck_board_id === null) p.deck_sync_level = "off";
		p.updated_at = "2026-10-25 12:00:00";
		// Like Project::jsonSerialize: op_id only when the planning period changed.
		return ocs(g.projectJson(p, uid, opId ? { op_id: opId } : {}));
	});
	on("GET", "/projects/(\\d+)/subprojects", (_req, uid, m) => {
		const p = project(uid, Number(m[1]), "view");
		if (p instanceof Response) return p;
		return ocs([...g.phases.values()].filter((s) => s.project_id === p.id).map((s) => ({ ...s, description: null, color: null, sort_order: 0, deck_list_id: null })));
	});
	on("GET", "/projects/(\\d+)/tasks", (_req, uid, m) => {
		const p = project(uid, Number(m[1]), "view");
		if (p instanceof Response) return p;
		return ocs([...g.tasks.values()].filter((t) => t.project_id === p.id).map((t) => g.taskJson(t)));
	});
	on("POST", "/projects/(\\d+)/tasks", (req, uid, m) => {
		const p = project(uid, Number(m[1]), "edit");
		if (p instanceof Response) return p;
		const b = body(req);
		if (!isDate(b.start_date) || !isDate(b.end_date)) return fail(400, "invalid_date");
		if (b.status !== undefined && !["not_started", "in_progress", "blocked", "done"].includes(String(b.status))) return fail(400, "invalid_status");
		if (b.subproject_id !== undefined && b.subproject_id !== null && g.phases.get(Number(b.subproject_id))?.project_id !== p.id) return fail(400, "invalid_subproject_id");
		const floatBefore = g.negativeFloat(p.id);
		const t = g.addTask(p.id, {
			title: String(b.title),
			description: (b.description as string) ?? null,
			start_date: `${String(b.start_date).slice(0, 10)} 00:00:00`,
			end_date: `${String(b.end_date).slice(0, 10)} 00:00:00`,
			status: (b.status as string) ?? "not_started",
			manual_progress: Number(b.manual_progress ?? 0),
			subproject_id: (b.subproject_id as number) ?? null,
		});
		const deps = Array.isArray(b.dependencies) ? (b.dependencies as Record<string, unknown>[]) : [];
		for (const d of deps) {
			const pm = /^([tm])-(\d+)$/.exec(String(d.predecessor_id));
			const okPred = pm && (pm[1] === "t" ? g.tasks.get(Number(pm[2]))?.project_id === p.id : g.milestones.get(Number(pm[2]))?.project_id === p.id);
			if (!okPred) {
				g.tasks.delete(t.id);
				return fail(400, "invalid_dependency");
			}
			t.deps.push({ id: g.id(), task_id: t.id, predecessor_id: String(d.predecessor_id), dependency_type: String(d.dependency_type ?? "EA"), lag_days: Number(d.lag_days ?? 0) });
		}
		const negative = g.newlyNegative(p.id, floatBefore);
		if (negative !== null) {
			g.tasks.delete(t.id);
			return fail(400, `negative_float:${negative}`);
		}
		if (deps.length) g.propagate(p.id, { op: "x", entries: [], links: [], project_id: p.id });
		return ocs(g.taskJson(t), 201);
	});
	on("PUT", "/tasks/(\\d+)", (req, uid, m) => {
		const t = g.tasks.get(Number(m[1]));
		if (!t) return fail(404, "not_found");
		const p = project(uid, t.project_id, "edit");
		if (p instanceof Response) return p;
		const b = body(req);
		if (b.start_date !== undefined && !isDate(b.start_date)) return fail(400, "invalid_date");
		if (b.end_date !== undefined && !isDate(b.end_date)) return fail(400, "invalid_date");
		if (b.status !== undefined && !["not_started", "in_progress", "blocked", "done"].includes(String(b.status))) return fail(400, "invalid_status");
		const op: Change = { op: g.newOp(), entries: [], links: [], project_id: p.id };
		if (Array.isArray(b.dependencies)) {
			const floatBefore = g.negativeFloat(p.id);
			const next = (b.dependencies as Record<string, unknown>[]).map((d) => ({ id: g.id(), task_id: t.id, predecessor_id: String(d.predecessor_id), dependency_type: String(d.dependency_type ?? "EA"), lag_days: Number(d.lag_days ?? 0) }));
			const saved = t.deps;
			t.deps = next;
			if (g.hasCycle(p.id)) {
				t.deps = saved;
				return fail(400, "dependency_cycle");
			}
			// Replacing the links drops a link to the milestone, which NoGantt then accepts (TaskService::update).
			const negative = g.newlyNegative(p.id, floatBefore);
			if (negative !== null) {
				t.deps = saved;
				return fail(400, `negative_float:${negative}`);
			}
		}
		if (typeof b.title === "string") t.title = b.title;
		if (typeof b.description === "string") t.description = b.description || null;
		if (typeof b.status === "string") t.status = b.status;
		if (typeof b.manual_progress === "number") t.manual_progress = b.manual_progress;
		if ("subproject_id" in b) t.subproject_id = (b.subproject_id as number | null) ?? null;
		for (const f of ["start_date", "end_date"] as const) {
			if (typeof b[f] === "string") {
				const nv = `${String(b[f]).slice(0, 10)} 00:00:00`;
				if (nv !== t[f]) op.entries.push({ task_id: t.id, field: f, old: t[f], new: nv });
				t[f] = nv;
			}
		}
		t.updated_at = "2026-10-25 12:00:00";
		const own = op.entries.length > 0;
		const moved = g.propagate(p.id, op);
		const opId = op.entries.length ? op.op : null;
		if (opId) g.changes.set(opId, op);
		const deck = b.deck_confirmed === true ? { updated: t.deck_cards.map((c) => ({ card_id: c })), failed: [], deviations: [], pending: [], gone: [], unconfirmed: 0 } : { updated: [], failed: [], deviations: [], pending: [], gone: [], unconfirmed: own && t.deck_cards.length && p.deck_sync_level === "write_confirm" ? t.deck_cards.length : 0 };
		return ocs({ task: g.taskJson(t), propagated: moved.map((x) => ({ ...g.taskJson(x), start_date: D(x.start_date), end_date: D(x.end_date) })), op_id: opId, deck: g.deck(deck) });
	});
	on("DELETE", "/tasks/(\\d+)", (req, uid, m) => {
		const t = g.tasks.get(Number(m[1]));
		if (!t) return fail(404, "not_found");
		const p = project(uid, t.project_id, "edit");
		if (p instanceof Response) return p;
		const archive = req.url.searchParams.get("archive_deck_cards") === "true";
		g.tasks.delete(t.id);
		for (const o of g.tasks.values()) o.deps = o.deps.filter((d) => d.predecessor_id !== `t-${t.id}`);
		for (const ms of [...g.milestones.values()]) if (ms.task_id === t.id) g.milestones.delete(ms.id);
		return ocs({ deck: { archived: archive ? t.deck_cards.map((c) => ({ card_id: c, title: "Card" })) : [], failed: [] } });
	});
	on("GET", "/tasks/(\\d+)/deck-delete-preview", (_req, uid, m) => {
		const t = g.tasks.get(Number(m[1]));
		if (!t) return fail(404, "not_found");
		const p = project(uid, t.project_id, "edit");
		if (p instanceof Response) return p;
		const can = p.deck_sync_level.startsWith("write") ? t.deck_cards : [];
		return ocs({ ask: can.length > 0, count: can.length, unchanged: 0, cards: can.map((c) => ({ card_id: c, board_id: p.deck_board_id, task_id: t.id })) });
	});
	on("POST", "/projects/(\\d+)/dependencies", (req, uid, m) => {
		const p = project(uid, Number(m[1]), "edit");
		if (p instanceof Response) return p;
		const links = (body(req).links ?? []) as Record<string, unknown>[];
		if (!Array.isArray(links) || links.length === 0) return fail(400, "invalid_dependency");
		const floatBefore = g.negativeFloat(p.id);
		const op: Change = { op: g.newOp(), entries: [], links: [], project_id: p.id };
		let added = 0;
		let skipped = 0;
		const touched = new Set<number>();
		const backup = new Map([...g.tasks.values()].map((t) => [t.id, t.deps.slice()]));
		for (const l of links) {
			const t = g.tasks.get(Number(l.task_id));
			if (!t || t.project_id !== p.id) return fail(400, "invalid_task_id");
			if (t.deps.some((d) => d.predecessor_id === l.predecessor_id)) {
				skipped++;
				continue;
			}
			const dep = { id: g.id(), task_id: t.id, predecessor_id: String(l.predecessor_id), dependency_type: String(l.dependency_type ?? "EA"), lag_days: Number(l.lag_days ?? 0) };
			t.deps.push(dep);
			op.links.push(dep.id);
			touched.add(t.id);
			added++;
		}
		const restore = () => {
			for (const [id, deps] of backup) {
				const t = g.tasks.get(id);
				if (t) t.deps = deps;
			}
		};
		if (g.hasCycle(p.id)) {
			restore();
			return fail(400, "dependency_cycle");
		}
		// Like TaskService::linkMany: the whole call is refused when a task gets negative slack.
		const negative = g.newlyNegative(p.id, floatBefore);
		if (negative !== null) {
			restore();
			return fail(400, `negative_float:${negative}`);
		}
		for (const x of g.propagate(p.id, op)) touched.add(x.id);
		const opId = added ? op.op : null;
		if (opId) g.changes.set(opId, op);
		return ocs({ tasks: [...touched].map((id) => g.taskJson(g.tasks.get(id) as GTask)), op_id: opId, added, skipped, deck: g.deck({ updated: [], failed: [], deviations: [], pending: [], gone: [], unconfirmed: 0 }) }, 201);
	});
	on("GET", "/projects/(\\d+)/milestones", (_req, uid, m) => {
		const p = project(uid, Number(m[1]), "view");
		if (p instanceof Response) return p;
		return ocs([...g.milestones.values()].filter((x) => x.project_id === p.id).map((x) => ({ ...x, created_at: "2026-10-25 10:00:00", updated_at: "2026-10-25 10:00:00" })));
	});
	on("POST", "/projects/(\\d+)/milestones", (req, uid, m) => {
		const p = project(uid, Number(m[1]), "edit");
		if (p instanceof Response) return p;
		const b = body(req);
		if (b.dependency_type !== undefined && !["EA", "AA", "EE", "AE"].includes(String(b.dependency_type))) return fail(400, "Invalid dependency_type");
		if (b.task_id !== undefined && g.tasks.get(Number(b.task_id))?.project_id !== p.id) return fail(400, "invalid_task_id");
		let date = String(b.milestone_date);
		if (b.task_id !== undefined && b.dependency_type) {
			const t = g.tasks.get(Number(b.task_id)) as GTask;
			date = D(b.dependency_type === "AA" || b.dependency_type === "AE" ? t.start_date : t.end_date);
		}
		const ms = g.addMilestone(p.id, { title: String(b.title), milestone_date: date, subproject_id: (b.subproject_id as number) ?? null, task_id: (b.task_id as number) ?? null, dependency_type: (b.dependency_type as string) ?? null });
		return ocs({ ...ms, created_at: "2026-10-25 10:00:00", updated_at: "2026-10-25 10:00:00" }, 201);
	});
	on("GET", "/my-tasks", (req, uid) => {
		const ids = g.myTasks.get(uid);
		if (!ids) return ocs({ has_linked_resource: false, tasks: [] });
		const includeDone = req.url.searchParams.get("include_done") === "true";
		// Like MyTaskController: limit 1 to 500 (else 400 invalid_limit), earliest due first.
		const rawLimit = req.url.searchParams.get("limit");
		const limit = rawLimit === null ? null : Number(rawLimit);
		if (limit !== null && !(Number.isInteger(limit) && limit >= 1 && limit <= 500)) return fail(400, "invalid_limit");
		const tasks = ids
			.map((id) => g.tasks.get(id))
			.filter((t): t is GTask => !!t && g.role(t.project_id, uid) !== null && (includeDone || t.status !== "done"))
			.sort((a, b) => a.end_date.localeCompare(b.end_date))
			.slice(0, limit ?? undefined)
			.map((t) => ({ id: t.id, title: t.title, project_id: t.project_id, project_title: g.projects.get(t.project_id)?.title ?? "", project_color: "#0082c9", subproject_id: null, start_date: t.start_date, end_date: t.end_date, manual_progress: t.manual_progress, status: t.status, risk_level: null, overdue: D(t.end_date) < "2026-10-25" && t.status !== "done" }));
		return ocs({ has_linked_resource: true, tasks });
	});
	on("GET", "/projects/(\\d+)/critical-path", (_req, uid, m) => {
		const p = project(uid, Number(m[1]), "view");
		if (p instanceof Response) return p;
		if (g.criticalOverride) return ocs({ project_id: p.id, ...g.criticalOverride });
		const tasks = [...g.tasks.values()].filter((t) => t.project_id === p.id);
		return ocs({ project_id: p.id, critical_ids: tasks.map((t) => t.id), float_map: Object.fromEntries(tasks.map((t) => [`t-${t.id}`, 0])), project_duration: tasks.length ? 10 : 0 });
	});
	on("GET", "/projects/(\\d+)/rollup", (_req, uid, m) => {
		const p = project(uid, Number(m[1]), "view");
		if (p instanceof Response) return p;
		const tasks = [...g.tasks.values()].filter((t) => t.project_id === p.id);
		const progress = tasks.length ? Math.round(tasks.reduce((a, t) => a + t.manual_progress, 0) / tasks.length) : 0;
		return ocs({ project_id: p.id, progress, budget_tasks: null, budget_total: 1200.5, budget_unit: "gemischt", schedule_deviation: 6, schedule_level: 1, risk_level: 2, blocked_count: 0, deck_deviation_count: 1, evm: { pv: 100, ev: 80, ac: null, spi: 0.8, cpi: null } });
	});
	on("GET", "/projects/(\\d+)/report/delta", (_req, uid, m) => {
		const p = project(uid, Number(m[1]), "view");
		if (p instanceof Response) return p;
		const b = g.baselines.get(p.id);
		if (!b) return fail(404, "no_baseline");
		const items = [...b.ends.entries()].map(([tid, end]) => {
			const t = g.tasks.get(tid);
			const v = t ? days(end, D(t.end_date)) : null;
			return { task_id: tid, title: t?.title ?? "Gone", deleted: !t, baseline_start: end, baseline_end: end, current_end: t ? D(t.end_date) : null, schedule_variance_days: v };
		});
		return ocs({ project_id: p.id, baseline_id: 1, baseline_date: b.created_at, baseline_comment: b.comment, items, summary: { total_schedule_variance_days: items.reduce((a, i) => a + (i.schedule_variance_days ?? 0), 0), count_delayed: items.filter((i) => (i.schedule_variance_days ?? 0) > 7).length, count_on_time: 0, count_total: items.length } });
	});
	// Like StructureImportService::import: tasks without their own dates start at options.start_date and
	// hang on a "Project start" milestone (a start-to-start link each, counted in dependencies); links
	// sent with the import are stored but move nothing (insertDependencies). Days are calendar days here.
	on("POST", "/structure-import", (req, uid) => {
		const b = body(req);
		const target = (b.target ?? {}) as Record<string, unknown>;
		const options = (b.options ?? {}) as Record<string, unknown>;
		if (!isDate(options.start_date)) return fail(400, "invalid_start_date");
		const start0 = String(options.start_date).slice(0, 10);
		const dur0 = Number(options.duration ?? 1);
		let p: GProject;
		if (target.project_id !== undefined) {
			const pp = project(uid, Number(target.project_id), "edit");
			if (pp instanceof Response) return pp;
			p = pp;
		} else {
			if (typeof target.title !== "string" || !target.title.trim()) return fail(400, "invalid_title");
			p = g.addProject(uid, { title: target.title, color: "#0082c9", plan_start: start0 });
		}
		const stats = { subprojects: 0, tasks: 0, milestones: 0, dependencies: 0 };
		const keys: [string, number][] = [];
		const undated: GTask[] = [];
		const walk = (items: Record<string, unknown>[], parent: number | null) => {
			for (const it of items) {
				if (it.type === "subproject") {
					const id = g.id();
					g.phases.set(id, { id, project_id: p.id, parent_id: parent, title: String(it.title).trim(), status: "not_started" });
					stats.subprojects++;
					walk((it.children ?? []) as Record<string, unknown>[], id);
				} else {
					const dur = Number(it.duration ?? 0) >= 1 ? Number(it.duration) : dur0;
					const ownStart = typeof it.start_date === "string" ? it.start_date : null;
					const ownEnd = typeof it.end_date === "string" ? it.end_date : null;
					const start = ownStart ?? (ownEnd ? addDays(ownEnd, 1 - dur) : start0);
					const end = ownEnd ?? addDays(start, dur - 1);
					const t = g.addTask(p.id, {
						title: String(it.title).trim(),
						subproject_id: parent,
						start_date: `${start} 00:00:00`,
						end_date: `${end} 00:00:00`,
						status: it.done ? "done" : "not_started",
						manual_progress: it.done ? 100 : 0,
						description: (it.description as string) ?? null,
					});
					stats.tasks++;
					keys.push([String(it.key), t.id]);
					if (!ownStart && !ownEnd) undated.push(t);
				}
			}
		};
		walk((b.items ?? []) as Record<string, unknown>[], (target.subproject_id as number) ?? null);
		if (options.start_milestone !== false && undated.length) {
			const ms = g.addMilestone(p.id, { title: "Project start", milestone_date: start0 });
			stats.milestones++;
			for (const t of undated) {
				t.deps.push({ id: g.id(), task_id: t.id, predecessor_id: `m-${ms.id}`, dependency_type: "AA", lag_days: 0 });
				stats.dependencies++;
			}
		}
		const byKey = new Map(keys);
		for (const d of (b.dependencies ?? []) as { from: string; to: string }[]) {
			const to = g.tasks.get(byKey.get(d.to) as number);
			if (to && byKey.get(d.from)) {
				to.deps.push({ id: g.id(), task_id: to.id, predecessor_id: `t-${byKey.get(d.from)}`, dependency_type: "EA", lag_days: 0 });
				stats.dependencies++;
			}
		}
		g.imports++;
		return ocs({ project_id: p.id, ...stats, task_ids: phpKeyed(keys) }, 201);
	});
	on("POST", "/tasks/(\\d+)/deck-links", (req, uid, m) => {
		const t = g.tasks.get(Number(m[1]));
		if (!t) return fail(404, "not_found");
		const p = project(uid, t.project_id, "edit");
		if (p instanceof Response) return p;
		if (p.deck_sync_level === "off") return fail(400, "deck_sync_off");
		const b = body(req);
		const card = g.cards.get(Number(b.card_id));
		if (!card || !card.readers.has(uid)) return fail(400, "invalid_deck_card");
		for (const o of g.tasks.values()) if (o.id !== t.id && o.deck_cards.includes(Number(b.card_id))) return fail(400, "deck_card_taken");
		const canWrite = p.deck_sync_level.startsWith("write");
		if (b.date_action === "enforce" && !canWrite) return fail(400, "deck_write_level");
		if (!t.deck_cards.includes(Number(b.card_id))) t.deck_cards.push(Number(b.card_id));
		// Like DeckLinkService::settleDates: the plan's dates go in with enforce, or into a card without
		// dates on a write level; otherwise the card is only compared.
		const hasDate = (card.duedate ?? null) !== null || (card.startdate ?? null) !== null;
		let dates: string;
		if (b.date_action === "enforce" || (!hasDate && canWrite)) {
			card.duedate = `${D(t.end_date)}T00:00:00+00:00`;
			card.startdate = `${D(t.start_date)}T00:00:00+00:00`;
			dates = "written";
		} else if (!hasDate) dates = "none";
		else dates = (card.duedate && card.duedate.slice(0, 10) !== D(t.end_date)) || (card.startdate && card.startdate.slice(0, 10) !== D(t.start_date)) ? "deviation" : "match";
		return ocs({ id: g.id(), task_id: t.id, card_id: Number(b.card_id), board_id: card.board_id, last_sync_at: "2026-10-25 12:00:00", dates }, 201);
	});
	on("POST", "/tasks/(\\d+)/deck-cards", (_req, uid, m) => {
		const t = g.tasks.get(Number(m[1]));
		if (!t) return fail(404, "not_found");
		const p = project(uid, t.project_id, "edit");
		if (p instanceof Response) return p;
		if (!p.deck_sync_level.startsWith("write")) return fail(400, "deck_write_level");
		if (p.deck_board_id === null) return fail(400, "deck_no_board");
		const cardId = g.id();
		// DeckLinkService::cardDescription: the task's notes, then NoGantt's fixed German backlink.
		const backlink = `Geplant in nc_Gantt: https://drive.nourax.org/apps/nc_gantt/?project=${p.id}&task=${t.id}`;
		const notes = (t.description ?? "").trim();
		g.cards.set(cardId, {
			board_id: p.deck_board_id,
			readers: new Set([uid]),
			title: t.title,
			description: notes ? `${notes}\n\n${backlink}` : backlink,
			duedate: `${D(t.end_date)}T00:00:00+00:00`,
			startdate: `${D(t.start_date)}T00:00:00+00:00`,
			owner: uid,
		});
		t.deck_cards.push(cardId);
		return ocs({ id: g.id(), task_id: t.id, card_id: cardId, board_id: p.deck_board_id, last_sync_at: "2026-10-25 12:00:00", title: t.title, dates: "written", assignment: { assigned: [uid], no_account: [], roles: [], no_access: [], failed: false } }, 201);
	});
	on("GET", "/projects/(\\d+)/shares", (_req, uid, m) => {
		const p = project(uid, Number(m[1]), "admin");
		if (p instanceof Response) return p;
		return ocs([...g.shares.values()].filter((s) => s.project_id === p.id).map((s) => ({ ...s, attachments_shared: false, created_at: "2026-10-25 10:00:00", display_name: fake.users.get(s.principal_id)?.displayName ?? s.principal_id, attachment_count: 0 })));
	});
	on("POST", "/projects/(\\d+)/shares", (req, uid, m) => {
		const p = project(uid, Number(m[1]), "admin");
		if (p instanceof Response) return p;
		const b = body(req);
		if (!["viewer", "editor", "admin"].includes(String(b.permission))) return fail(400, "invalid_permission");
		// Like NoGantt 2.4.1: a user share only checks that the account exists (DESIGN 25.2).
		if (b.principal_type === "user" && !fake.users.has(String(b.principal_id))) return fail(400, "principal_not_found");
		const prev = [...g.shares.values()].find((s) => s.project_id === p.id && s.principal_type === b.principal_type && s.principal_id === b.principal_id);
		if (prev) {
			prev.permission = String(b.permission);
			return ocs({ ...prev, attachments_shared: false, created_at: "2026-10-25 10:00:00", display_name: fake.users.get(prev.principal_id)?.displayName ?? prev.principal_id, attachment_count: 0 });
		}
		const s: GShare = { id: g.id(), project_id: p.id, principal_id: String(b.principal_id), principal_type: String(b.principal_type), permission: String(b.permission) };
		g.shares.set(s.id, s);
		return ocs({ ...s, attachments_shared: false, created_at: "2026-10-25 10:00:00", display_name: fake.users.get(s.principal_id)?.displayName ?? s.principal_id, attachment_count: 0 }, 201);
	});
	on("DELETE", "/shares/(\\d+)", (_req, uid, m) => {
		const s = g.shares.get(Number(m[1]));
		if (!s) return fail(404, "not_found");
		const p = project(uid, s.project_id, "admin");
		if (p instanceof Response) return p;
		g.shares.delete(s.id);
		// Live: 204 with an empty body (DESIGN 25.1).
		return new Response(null, { status: 204 });
	});
	on("POST", "/changes/([0-9a-f-]{36})/revert", (_req, uid, m) => {
		const op = g.changes.get(m[1] as string);
		if (!op) return fail(404, "operation_not_found");
		const p = project(uid, op.project_id, "edit");
		if (p instanceof Response) return p;
		// Like ChangeEventService::revertOperation, which keeps an operation's events after a revert: a
		// link the change added that is gone answers entity_missing (link events come first), and a field
		// whose value isn't the logged new one any more answers conflict. So a second undo gets one too.
		for (const id of op.links) if (![...g.tasks.values()].some((t) => t.deps.some((d) => d.id === id))) return fail(409, "entity_missing");
		for (const e of op.entries) if ((g.tasks.get(e.task_id) as GTask | undefined)?.[e.field] !== e.new) return fail(409, "conflict");
		if (op.plan && (p.plan_start !== op.plan.new[0] || p.plan_end !== op.plan.new[1])) return fail(409, "conflict");
		for (const e of [...op.entries].reverse()) {
			const t = g.tasks.get(e.task_id);
			if (t) t[e.field] = e.old;
		}
		if (op.plan) [p.plan_start, p.plan_end] = op.plan.old;
		for (const t of g.tasks.values()) t.deps = t.deps.filter((d) => !op.links.includes(d.id));
		const taskIds = [...new Set(op.entries.map((e) => e.task_id))];
		// The old dates go back into linked cards without asking when the project's board link writes.
		const cards = p.deck_sync_level.startsWith("write") ? taskIds.flatMap((id) => g.tasks.get(id)?.deck_cards ?? []) : [];
		const deck = { updated: cards.map((c) => ({ card_id: c })), failed: [], deviations: [], pending: [], gone: [], unconfirmed: 0 };
		const types = [...(op.entries.length ? ["task"] : []), ...(op.links.length ? ["dependency"] : []), ...(op.plan ? ["project"] : [])];
		return ocs({ reverted_count: op.entries.length + op.links.length + (op.plan ? 2 : 0), op_id: op.op, task_ids: taskIds, entity_types: types, deck: g.deck(deck) });
	});

	// NoBoard: the board lookup that gantt_update_project makes before linking.
	fake.on("GET", /^\/index\.php\/apps\/deck\/api\/v1\.0\/boards\/(\d+)$/, (req, _f, m) => {
		const b = g.boards.get(Number(m[1]));
		if (!req.auth) return new Response("", { status: 401 });
		if (!b || !b.readers.has(req.auth)) return Response.json({ status: 403, message: "Permission denied" }, { status: 403 });
		return Response.json({ id: Number(m[1]), title: b.title, archived: false, stacks: [{ id: Number(m[1]) * 10 + 1, title: "To do", order: 0 }], permissions: { PERMISSION_READ: true, PERMISSION_EDIT: b.editors.has(req.auth) } });
	});
	// NoBoard's REST card read and update. Like Deck 1.19.1, the read finds the card by its id alone and
	// checks the person's right on the card's own board.
	const cardJson = (id: number, c: GCard) => ({
		id,
		title: c.title ?? "Card",
		description: c.description ?? "",
		stackId: c.board_id * 10 + 1,
		type: "plain",
		order: 999,
		owner: { primaryKey: c.owner ?? "nobody", uid: c.owner ?? "nobody", displayname: c.owner ?? "nobody", type: 0 },
		archived: false,
		done: null,
		duedate: c.duedate ?? null,
		startdate: c.startdate ?? null,
		deletedAt: 0,
	});
	fake.on("GET", /^\/index\.php\/apps\/deck\/api\/v1\.0\/boards\/(\d+)\/stacks\/(\d+)\/cards\/(\d+)$/, (req, _f, m) => {
		const c = g.cards.get(Number(m[3]));
		if (!req.auth) return new Response("", { status: 401 });
		if (!c || !c.readers.has(req.auth)) return Response.json({ status: 403, message: "Permission denied" }, { status: 403 });
		return Response.json(cardJson(Number(m[3]), c));
	});
	fake.on("PUT", /^\/index\.php\/apps\/deck\/api\/v1\.0\/boards\/(\d+)\/stacks\/(\d+)\/cards\/(\d+)$/, (req, _f, m) => {
		const c = g.cards.get(Number(m[3]));
		if (!req.auth) return new Response("", { status: 401 });
		if (!c || !c.readers.has(req.auth) || !g.boards.get(c.board_id)?.editors.has(req.auth)) return Response.json({ status: 403, message: "Permission denied" }, { status: 403 });
		const b = body(req);
		// Deck's REST update replaces every field (fullCardBody sends them all).
		if (typeof b.title === "string") c.title = b.title;
		c.description = typeof b.description === "string" ? b.description : "";
		c.duedate = (b.duedate as string | null | undefined) ?? null;
		c.startdate = (b.startdate as string | null | undefined) ?? null;
		g.cardPuts++;
		return Response.json(cardJson(Number(m[3]), c));
	});

	// Core's sharees search, with what each person may find (privacy between organisations).
	fake.on("GET", /^\/ocs\/v2\.php\/apps\/files_sharing\/api\/v1\/sharees$/, (req) => {
		if (!req.auth) return new Response("", { status: 401 });
		const term = (req.url.searchParams.get("search") ?? "").toLowerCase();
		const types = req.url.searchParams.getAll("shareType[]");
		const seen = (g.directory.get(req.auth) ?? []).filter((e) => e.id.toLowerCase().includes(term) || e.label.toLowerCase().includes(term));
		const users = types.includes("0") ? seen.filter((e) => e.kind === "user").map((e) => ({ label: e.label, value: { shareType: 0, shareWith: e.id }, shareWithDisplayNameUnique: `${e.id}@example.invalid` })) : [];
		const groups = types.includes("1") ? seen.filter((e) => e.kind === "group").map((e) => ({ label: e.label, value: { shareType: 1, shareWith: e.id } })) : [];
		const exactUsers = users.filter((u) => u.value.shareWith.toLowerCase() === term);
		const exactGroups = groups.filter((u) => u.value.shareWith.toLowerCase() === term);
		return ocs({
			exact: { users: exactUsers, groups: exactGroups, circles: [], remotes: [], emails: [] },
			users: users.filter((u) => !exactUsers.includes(u)),
			groups: groups.filter((u) => !exactGroups.includes(u)),
			circles: [],
		});
	});
	return g;
}
