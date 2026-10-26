/**
 * The result shapes of lane D's 11 tools (DESIGN 11.5, 11.6), as structuredContent carries them
 * after core merges `undo` and `warnings` in (src/mcp/register.ts).
 *
 * They are not published as outputSchema in tools/list, the same as lanes A, B and G do: DESIGN 10.8
 * keeps the whole own tools/list within 60 KB, and these shapes would add 12,976 bytes to lane D's
 * 13,479 (measured 2026-10-25; the Event object alone repeats in four of them), nearly doubling it.
 * The MCP specification makes outputSchema
 * optional, and every result's JSON is also in the framed text block (DESIGN 10.4). The contract
 * tests check every successful result against these shapes exactly, with no extra keys at any level
 * (test/tools/calendar/_helpers.ts), so the code and this file can't drift apart. Publishing them
 * later is one line per tool (`output:`), if core's re-budget of tools/list allows it.
 *
 * Changes from DESIGN 11.5 on purpose (review fix round 1):
 * - calendar_update_event and calendar_cancel_event: `notified` is Person[] as designed, and means
 *   the people NoCalendar was asked to tell, not proof that they received it;
 * - calendar_add_attendees: `invited` and `not_invited` instead of `delivered` and `not_delivered`,
 *   because SCHEDULE-STATUS can't prove delivery (events.ts, deliveryFailed);
 * - events and tasks carry `etag` (for expected_etag) and events `reminder_minutes_before`.
 * Fix round 3:
 * - events carry `attendees_total` only when `attendees` is cut to the first 50 (and a warning says
 *   so), so a cut list never looks complete;
 * - tasks_complete has `warnings`, for what its undo can't put back.
 * DESIGN 27 records all of lane D's changes from the spec.
 */
import { z } from "zod";
import { Person, Undo } from "../../core/shapes";

const text = z.string();
const maybe = z.string().nullable();
const warnings = z.array(z.string()).optional();
const paging = { next_cursor: maybe, has_more: z.boolean() };

export const EventShape = z.strictObject({
	event_id: text,
	calendar_id: text,
	title: text,
	start: text,
	end: text,
	all_day: z.boolean(),
	time_zone: text,
	location: maybe,
	description: maybe,
	status: z.enum(["confirmed", "tentative", "cancelled"]),
	repeats: z.boolean(),
	occurrence_start: maybe,
	reminder_minutes_before: z.number().nullable(),
	attendees: z.array(z.strictObject({ name: maybe, email: maybe, status: text })),
	attendees_total: z.number().int().optional(),
	organizer: z.strictObject({ name: maybe, email: maybe }).nullable(),
	etag: maybe,
	web_url: text,
});

export const TaskShape = z.strictObject({
	task_id: text,
	list_id: text,
	title: text,
	notes: maybe,
	due: maybe,
	start: maybe,
	priority: z.enum(["high", "normal", "low"]).nullable(),
	completed: z.boolean(),
	completed_at: maybe,
	etag: maybe,
	web_url: text,
});

const PersonShape = z.strictObject({ id: text, display_name: maybe });
const UndoShape = Undo;

/** Every lane D tool's structuredContent, by tool name. */
export const LANE_D_OUTPUTS: Readonly<Record<string, z.ZodType>> = {
	calendar_list_calendars: z.strictObject({
		calendars: z.array(
			z.strictObject({
				calendar_id: text,
				name: text,
				color: maybe,
				holds: z.array(z.enum(["events", "tasks"])),
				read_only: z.boolean(),
				shared_by: PersonShape.nullable(),
				is_default: z.boolean(),
				counts_for_free_time: z.boolean(),
			}),
		),
	}),
	calendar_list_events: z.strictObject({ events: z.array(EventShape), ...paging, warnings }),
	calendar_find_free_time: z.strictObject({
		slots: z.array(z.strictObject({ start: text, end: text })),
		time_zone: text,
		calendars_checked: z.array(text),
		warnings,
	}),
	calendar_create_event: z.strictObject({ event: EventShape, undo: UndoShape, warnings }),
	calendar_update_event: z.strictObject({ event: EventShape, notified: z.array(PersonShape), undo: UndoShape, warnings }),
	calendar_cancel_event: z.strictObject({
		event_id: text,
		mode: z.enum(["mark_cancelled", "remove"]),
		scope: z.enum(["this", "series"]).nullable(),
		occurrence_start: maybe,
		notified: z.array(PersonShape),
		undo: z.null(),
		warnings,
	}),
	calendar_add_attendees: z.strictObject({
		event: EventShape,
		invited: z.array(PersonShape),
		not_invited: z.array(z.strictObject({ id: text, reason: text })),
		undo: z.null(),
		warnings,
	}),
	calendar_respond: z.strictObject({
		event_id: text,
		response: z.enum(["accepted", "declined", "tentative"]),
		previous_response: z.enum(["accepted", "declined", "tentative", "needs_action"]),
		scope: z.enum(["this", "series"]).nullable(),
		occurrence_start: maybe,
		event: EventShape.optional(),
		undo: UndoShape,
		warnings,
	}),
	tasks_list: z.strictObject({
		tasks: z.array(TaskShape),
		lists: z.array(z.strictObject({ list_id: text, name: text, read_only: z.boolean() })),
		...paging,
		warnings,
	}),
	tasks_create: z.strictObject({ task: TaskShape, warnings }),
	tasks_complete: z.strictObject({ task: TaskShape, undo: UndoShape, warnings }),
	tasks_set_due_date: z.strictObject({ task: TaskShape, undo: UndoShape, warnings }),
};

/** Kept so a type check notices when the shared Person shape changes. */
export type LaneDPerson = z.infer<typeof Person>;
