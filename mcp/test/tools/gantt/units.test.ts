/** Unit tests for lane G's helpers: error mapping, the confirmation token, the import tree, brand and date mapping, size fitting and undo checks. */
import { describe, expect, it } from "vitest";
import { ToolError } from "../../../src/core/errors";
import { z } from "zod";
import type { ToolCtx } from "../../../src/core/tool";
import {
	boardOut,
	boardWarnings,
	brandText,
	checkedUndo,
	colour,
	day,
	depIn,
	depOut,
	fitWithin,
	jsonChars,
	mapGanttError,
	milestoneOut,
	notUndoable,
	PROJECT_OUT_ROOM,
	projectOut,
	restorable,
	roleOf,
	syncOf,
	TASK_LINKS_SHOWN,
	TASK_OUT_ROOM,
	taskOut,
} from "../../../src/tools/gantt/api";
import { checkConfirmToken, CONFIRM_TTL_SEC, makeConfirmToken } from "../../../src/tools/gantt/confirm";
import { buildTree } from "../../../src/tools/gantt/projects";
import { _movedBetween } from "../../../src/tools/gantt/tasks";
import { env } from "../../helpers/index";

const ocsErr = (status: number, message: string, statuscode = status) =>
	new ToolError("invalid_input", "x", { upstreamStatus: status, detail: JSON.stringify({ ocs: { meta: { statuscode, message }, data: [] } }) });

describe("mapGanttError", () => {
	it("maps NoGantt's codes to our codes and sentences, never its own text", () => {
		const cases: [ToolError, string, string][] = [
			[ocsErr(400, "dependency_cycle"), "invalid_input", "loop"],
			[ocsErr(400, "deck_sync_off"), "not_available", "isn't linked to a NoBoard board"],
			[ocsErr(400, "deck_write_level"), "not_available", "only reads"],
			[ocsErr(400, "deck_card_taken"), "already_exists", "another task"],
			[ocsErr(400, "invalid_deck_card"), "not_found", "NoBoard card"],
			[ocsErr(400, "principal_not_found"), "permission_denied", "can't share"],
			[ocsErr(404, "operation_not_found"), "not_found", "undo id"],
			[ocsErr(409, "conflict"), "conflict", "changed again"],
			[ocsErr(409, "entity_missing"), "conflict", "no longer exists"],
			[ocsErr(400, "negative_float:Leaky title"), "invalid_input", "fixed milestone"],
			[ocsErr(400, "invalid_limit"), "invalid_input", "didn't accept"],
			[ocsErr(400, "something_new"), "invalid_input", "didn't accept"],
			[ocsErr(404, "Invalid query, please check the syntax", 998), "not_available", "switched on"],
			[ocsErr(500, "internal_error"), "upstream_unavailable", "Try again"],
			[ocsErr(503, "busy"), "upstream_unavailable", "didn't answer"],
		];
		for (const [e, code, words] of cases) {
			const m = mapGanttError(e, "POST", {});
			expect([e.detail, m.code], e.detail).toEqual([e.detail, code]);
			expect(m.message, e.detail).toContain(words);
			expect(`${m.message} ${m.hint ?? ""}`).not.toMatch(/Leaky|syntax|internal_error|deck_|dependency_cycle|principal_not|operation_not|negative_float|entity_missing|invalid_limit|something_new/);
		}
	});
	it("gives the same not_found for 403 and 404 on reads, and permission_denied for 403 on writes", () => {
		const nf = "There's no project 4 that this person can see.";
		expect(mapGanttError(ocsErr(404, "not_found"), "GET", { notFound: nf }).message).toBe(nf);
		expect(mapGanttError(ocsErr(403, "forbidden"), "GET", { notFound: nf })).toMatchObject({ code: "not_found", message: nf });
		expect(mapGanttError(ocsErr(403, "forbidden"), "PUT", { forbidden: "No." })).toMatchObject({ code: "permission_denied", message: "No." });
	});
	it("passes dead credentials, rate limits and timeouts through unchanged", () => {
		for (const code of ["reconnect_required", "rate_limited", "timeout"] as const) {
			const e = new ToolError(code);
			expect(mapGanttError(e, "GET", {})).toBe(e);
		}
	});
});

describe("size fitting and undo checks", () => {
	it("fitWithin keeps the largest prefix under the cap and the size", () => {
		const items = Array.from({ length: 300 }, (_, i) => ({ i, t: "x".repeat(90) }));
		const all = fitWithin(items.slice(0, 5), 200, 10_000, (xs) => ({ xs }));
		expect(all).toEqual({ items: items.slice(0, 5), cut: false });
		const capped = fitWithin(items, 200, 1_000_000, (xs) => ({ xs }));
		expect([capped.items.length, capped.cut]).toEqual([200, true]);
		const sized = fitWithin(items, 200, 5_000, (xs) => ({ xs }));
		expect(JSON.stringify({ xs: sized.items }).length).toBeLessThanOrEqual(5_000);
		expect(JSON.stringify({ xs: items.slice(0, sized.items.length + 1) }).length).toBeGreaterThan(5_000);
		expect(fitWithin(items, 200, 5, (xs) => ({ xs })).items).toEqual([]);
	});
	it("restorable says whether a text could be written back whole", () => {
		expect(restorable(null, 10)).toEqual({ value: null, exact: true, why: null });
		expect(restorable("", 10)).toEqual({ value: null, exact: true, why: null });
		expect(restorable("Plan \"A\"\n\u0001", 10)).toEqual({ value: "Plan \"A\"\n\u0001", exact: true, why: null });
		// Shown changed: NoGantt's own name, and DEL or C1 controls (the framed text drops them).
		expect(restorable("nc_gantt", 10)).toEqual({ value: "NoGantt", exact: false, why: "changed" });
		expect(restorable("a\u007fb", 10)).toMatchObject({ exact: false, why: "changed" });
		expect(restorable("a\u0085b", 10)).toMatchObject({ exact: false, why: "changed" });
		expect(restorable("x".repeat(11), 10)).toEqual({ value: `${"x".repeat(9)}…`, exact: false, why: "long" });
	});
	it("checkedUndo leaves out what the tool's input would refuse, and names it", () => {
		const input = z.object({ id: z.number(), a: z.string().optional(), b: z.string().nullable().optional(), c: z.number().optional() }).strict();
		expect(checkedUndo(input, { id: 1, a: "x", b: null }, ["id"])).toEqual({ args: { id: 1, a: "x", b: null }, dropped: [] });
		expect(checkedUndo(input, { id: 1, a: null, c: 2 }, ["id"])).toEqual({ args: { id: 1, c: 2 }, dropped: ["a"] });
		expect(checkedUndo(input, { id: 1, a: null }, ["id"])).toEqual({ args: null, dropped: ["a"] });
		expect(checkedUndo(input, { id: "1", a: "x" }, ["id"]).args).toBeNull();
	});
});

describe("confirmation token (kept for the owner's decision, DESIGN 25.6)", () => {
	const parts = ["qa-t1-91", "conn1", 4, 5, "2026-10-25 12:00:00"];
	it("accepts its own token for the same parts within 10 minutes only", async () => {
		const now = Date.UTC(2026, 9, 25, 12, 0, 0);
		const { token, expires_at } = await makeConfirmToken(env, parts, now);
		expect(expires_at).toBe(new Date(now + CONFIRM_TTL_SEC * 1000).toISOString());
		expect(await checkConfirmToken(env, token, parts, now + 1000)).toBe("ok");
		expect(await checkConfirmToken(env, token, parts, now + (CONFIRM_TTL_SEC + 1) * 1000)).toBe("expired");
		for (const i of [0, 1, 2, 3, 4]) {
			const other = [...parts];
			other[i] = `${other[i]}x`;
			expect(await checkConfirmToken(env, token, other, now)).toBe("invalid");
		}
		const [, exp, mac] = token.split(".");
		expect(await checkConfirmToken(env, `gd1.${Number(exp) + 600}.${mac}`, parts, now)).toBe("invalid");
		expect(await checkConfirmToken(env, "nonsense", parts, now)).toBe("invalid");
	});
	it("is void under another NX_SECRET (the kill switch) and refuses a missing one", async () => {
		const { token } = await makeConfirmToken(env, parts);
		expect(await checkConfirmToken({ NX_SECRET: "another-secret-0123456789abcdef0123456789" }, token, parts)).toBe("invalid");
		await expect(makeConfirmToken({ NX_SECRET: "short" }, parts)).rejects.toBeInstanceOf(ToolError);
	});
	it("can't be confused by a | inside a part", async () => {
		const { token } = await makeConfirmToken(env, ["a|b", "c"]);
		expect(await checkConfirmToken(env, token, ["a", "b|c"])).toBe("invalid");
	});
});

describe("buildTree", () => {
	it("nests by parent_key in order and keeps tasks' own fields", () => {
		const tree = buildTree([
			{ key: "p", kind: "phase", title: "P", notes: "n" },
			{ key: "q", kind: "phase", title: "Q", parent_key: "p" },
			{ key: "t1", kind: "task", title: "T1", parent_key: "q", done: true, duration_days: 2 },
			{ key: "t2", kind: "task", title: "T2" },
		]);
		expect(tree).toEqual([
			{ key: "p", type: "subproject", title: "P", description: "n", children: [{ key: "q", type: "subproject", title: "Q", children: [{ key: "t1", type: "task", title: "T1", done: true, duration: 2 }] }] },
			{ key: "t2", type: "task", title: "T2" },
		]);
	});
	it("allows 5 levels of phases and refuses 6", () => {
		const chain = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `p${i}`, kind: "phase" as const, title: "P", ...(i ? { parent_key: `p${i - 1}` } : {}) }));
		expect(() => buildTree(chain(6))).not.toThrow();
		expect(() => buildTree(chain(7))).toThrow(ToolError);
	});
});

describe("mapping", () => {
	it("shows NoGantt's own name and the upstream blue the Nourax way", () => {
		expect(brandText("Geplant in nc_Gantt and NC-Gantt and nc_gantt")).toBe("Geplant in NoGantt and NoGantt and NoGantt");
		expect(colour("#0082C9")).toBe("#2563EB");
		expect(colour("#00679e")).toBe("#2563EB");
		expect(colour("#123456")).toBe("#123456");
	});
	it("reads dates, roles, board levels, links and milestones", () => {
		expect(day("2026-11-02 00:00:00")).toBe("2026-11-02");
		expect(day("2026-11-13")).toBe("2026-11-13");
		expect(day("garbage")).toBeNull();
		expect([roleOf("admin"), roleOf("editor"), roleOf("viewer"), roleOf(null)]).toEqual(["project_admin", "editor", "viewer", "viewer"]);
		expect([syncOf("off"), syncOf("read"), syncOf("write_confirm"), syncOf("write_silent"), syncOf("odd")]).toEqual(["off", "read", "write_with_confirmation", "write", "off"]);
		expect(depOut({ predecessor_id: "m-3", dependency_type: "AE", lag_days: -2 })).toEqual({ after_task_id: null, after_milestone_id: 3, type: "start_to_finish", lag_days: -2 });
		expect(depOut({ predecessor_id: "x-3", dependency_type: "EA", lag_days: 0 })).toBeNull();
		expect(depIn({ after_milestone_id: 3, type: "finish_to_finish" })).toEqual({ predecessor_id: "m-3", dependency_type: "EE", lag_days: 0 });
		expect(milestoneOut({ id: 1, project_id: 2, subproject_id: 7, task_id: null, title: "M", milestone_date: "2026-12-01", dependency_type: "AA" }).follows).toEqual({ kind: "phase", id: 7, at: "start" });
		expect(milestoneOut({ id: 1, project_id: 2, subproject_id: null, task_id: null, title: "M", milestone_date: "2026-12-01", dependency_type: "EE" }).follows).toEqual({ kind: "project", id: null, at: "end" });
	});
	it("finds the tasks whose dates moved", () => {
		const t = (id: number, s: string, e: string) => ({ id, project_id: 1, subproject_id: null, title: `T${id}`, description: null, start_date: s, end_date: e, status: null, manual_progress: 0 });
		expect(_movedBetween([t(1, "2026-11-02 00:00:00", "2026-11-03 00:00:00"), t(2, "2026-11-04 00:00:00", "2026-11-05 00:00:00")], [t(1, "2026-11-02", "2026-11-03"), t(2, "2026-11-06", "2026-11-07")])).toEqual([
			{ task_id: 2, title: "T2", start: "2026-11-06", end: "2026-11-07" },
		]);
	});
});

describe("worst-case sizes (DESIGN 25.7)", () => {
	const ctx = { cfg: { driveOrigin: "https://drive.nourax.org" } } as unknown as ToolCtx;
	const ctl = (n: number) => "\u0001".repeat(n);
	it("one task's output stays within TASK_OUT_ROOM, links cut to 100 with the count", () => {
		const deps = Array.from({ length: 500 }, (_, i) => ({ id: i, task_id: 1, predecessor_id: `t-${999_999_999_000 + i}`, dependency_type: "AE", lag_days: -30 }));
		const t = taskOut(ctx, { id: 2_147_483_647, project_id: 2_147_483_647, subproject_id: 2_147_483_647, title: ctl(400), description: ctl(10_000), start_date: "2026-11-02 00:00:00", end_date: "2026-11-06 00:00:00", status: "in_progress", manual_progress: 50, dependencies: deps, resources: [1], deck_card_id: 2_147_483_647 });
		expect(t.depends_on).toHaveLength(TASK_LINKS_SHOWN);
		expect(t.depends_on_total).toBe(500);
		expect(jsonChars(t)).toBeLessThan(TASK_OUT_ROOM - 1_000);
		const few = taskOut(ctx, { id: 1, project_id: 1, subproject_id: null, title: "T", description: null, start_date: "2026-11-02", end_date: "2026-11-02", status: null, manual_progress: 0, dependencies: deps.slice(0, 3) });
		expect(few.depends_on).toHaveLength(3);
		expect("depends_on_total" in few).toBe(false);
	});
	it("one project's output stays within PROJECT_OUT_ROOM", () => {
		const p = projectOut(ctx, { id: 2_147_483_647, title: ctl(400), description: ctl(10_000), color: "#123456", deck_board_id: 2_147_483_647, deck_sync_level: "write_confirm", owner_id: "x".repeat(64), owner_display_name: ctl(400), permission: "admin", plan_start: "2026-11-02", plan_end: "2026-12-31", updated_at: null });
		expect(jsonChars(p)).toBeLessThan(PROJECT_OUT_ROOM - 1_000);
	});
	it("the card summary counts every part of NoGantt's summary, and the warnings name each", () => {
		expect(boardOut({ updated: [], failed: [], deviations: [], pending: [], gone: [], unconfirmed: 0 })).toBeNull();
		const b = boardOut({ updated: [1], failed: [2], pending: [3], deviations: [4, 5], gone: [6], unconfirmed: 2 });
		expect(b).toEqual({ cards_updated: 1, cards_failed: 2, cards_kept_their_dates: 2, cards_gone: 1, waiting_for_confirmation: 2 });
		const w = boardWarnings(b, "old").join(" ");
		expect(w).toContain("wrote the old dates back into 1 linked NoBoard card.");
		expect(w).toContain("2 linked NoBoard cards couldn't be given the old dates.");
		expect(w).toContain("2 linked NoBoard cards kept their own dates, because they were changed in NoBoard");
		expect(w).toContain("1 linked NoBoard card no longer exists in NoBoard.");
		const n = boardWarnings(boardOut({ deviations: [1] }), "new");
		expect(n).toEqual(["1 linked NoBoard card kept its own dates, because it was changed in NoBoard since NoGantt last wrote it."]);
		expect(boardWarnings(boardOut({ updated: [1] }), "new")).toEqual([]);
	});
	it("the refusals for values an undo couldn't put back are plain and point to NoGantt", () => {
		const url = "https://drive.nourax.org/apps/nc_gantt/?project=1&task=2";
		const long = notUndoable("task", "notes", "long", 10_000, url);
		expect([long.code, long.message, long.hint, long.field]).toEqual(["too_large", "This task's notes are longer than 10,000 characters, so changing them here couldn't be undone. Nothing was changed.", `Change them in NoGantt itself: ${url}`, "notes"]);
		const changed = notUndoable("project", "title", "changed", 255, url);
		expect([changed.code, changed.message]).toEqual(["not_available", "This project's title holds characters this connector doesn't show exactly, so changing it here couldn't be undone. Nothing was changed."]);
		expect(notUndoable("task", "notes", "big", 0, url).message).toContain("too much of one answer");
	});
});
