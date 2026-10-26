/**
 * Lane D (tasks) tools, in catalogue order (DESIGN 11.6). Tasks are VTODOs in NoCalendar task lists;
 * the CalDAV layer is shared with the calendar tools (../calendar/caldav.ts).
 */
import type { ToolDef } from "../../core/tool";
import { completeTask } from "./complete";
import { createTask } from "./create";
import { listTasks } from "./list";
import { setTaskDue } from "./set-due";

export const tools: ToolDef[] = [listTasks, createTask, completeTask, setTaskDue];
