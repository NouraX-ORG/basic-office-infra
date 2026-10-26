/** calendar_list_calendars (DESIGN 11.5): the person's calendars, shared ones included. */
import { z } from "zod";
import { defineTool } from "../../core/tool";
import { loadHome, person } from "./common";

export const listCalendars = defineTool({
	name: "calendar_list_calendars",
	title: "List calendars",
	description:
		"Lists the person's NoCalendar calendars and task lists, shared ones included: name, colour, what each holds, whether it is read-only, and the default for new events.",
	input: z.object({}).strict(),
	async run(ctx) {
		const { cals } = await loadHome(ctx.nc);
		const calendars = cals.map((c) => ({
			calendar_id: c.id,
			name: c.name,
			color: c.color,
			holds: [...(c.events ? ["events"] : []), ...(c.tasks ? ["tasks"] : [])],
			read_only: c.readOnly,
			shared_by: person(c.sharedBy, c.sharedByName),
			is_default: c.isDefault && c.events,
			counts_for_free_time: c.events && !c.sharedBy && !c.transparent,
		}));
		return { data: { calendars }, summary: `Listed ${calendars.length} calendar${calendars.length === 1 ? "" : "s"}.` };
	},
});
