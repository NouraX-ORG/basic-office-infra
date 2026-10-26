/**
 * Lane E owns this module (DESIGN 18.4): workspace_overview. workspace_whoami lives in ./whoami.ts
 * and belongs to core.
 */
import type { ToolDef } from "../../core/tool";
import { overview } from "./overview";

export const tools: ToolDef[] = [overview];
