/**
 * Lane D (calendar) tools, in catalogue order (DESIGN 11.5). CalDAV over core's NoDrive client;
 * jCal on the wire; shared pieces in caldav.ts, common.ts, events.ts, occurrence.ts and query.ts.
 */
import type { ToolDef } from "../../core/tool";
import { addAttendees } from "./add-attendees";
import { cancelEvent } from "./cancel-event";
import { createEvent } from "./create-event";
import { findFreeTime } from "./find-free-time";
import { listCalendars } from "./list-calendars";
import { listEvents } from "./list-events";
import { respondEvent } from "./respond";
import { updateEvent } from "./update-event";

export const tools: ToolDef[] = [listCalendars, listEvents, findFreeTime, createEvent, updateEvent, cancelEvent, addAttendees, respondEvent];
