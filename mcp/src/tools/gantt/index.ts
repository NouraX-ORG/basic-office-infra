/**
 * Lane G (NoGantt) owns this module (DESIGN section 25): the 15 gantt_* tools, in catalogue order.
 */
import type { ToolDef } from "../../core/tool";
import { catalogIndex } from "../../mcp/catalog";
import { boardTools } from "./board";
import { insightTools } from "./insight";
import { projectTools } from "./projects";
import { shareTools } from "./share";
import { taskTools } from "./tasks";

export const tools: ToolDef[] = [...projectTools, ...taskTools, ...insightTools, ...boardTools, ...shareTools].sort((a, b) => catalogIndex(a.name) - catalogIndex(b.name));
