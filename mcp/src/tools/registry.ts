/**
 * Every tool that is built, in catalogue order. Each lane fills only its own module; this file is
 * core's. A tool that is in the catalogue but not built yet is simply absent from tools/list.
 */
import type { ToolDef } from "../core/tool";
import { CATALOG, catalogIndex } from "../mcp/catalog";
import { tools as boards } from "./boards/index";
import { tools as calendar } from "./calendar/index";
import { tools as contacts } from "./contacts/index";
import { tools as docs } from "./docs/index";
import { tools as files } from "./files/index";
import { tools as gantt } from "./gantt/index";
import { tools as sharing } from "./sharing/index";
import { tools as tasks } from "./tasks/index";
import { tools as workspace } from "./workspace/index";
import { whoami } from "./workspace/whoami";

function build(): readonly ToolDef[] {
	const all = [whoami, ...workspace, ...files, ...docs, ...sharing, ...calendar, ...tasks, ...contacts, ...boards];
	all.push(...gantt); // lane G (NoGantt), DESIGN section 25
	const seen = new Set<string>();
	for (const t of all) {
		if (seen.has(t.name)) throw new Error(`Tool ${t.name} is registered twice`);
		seen.add(t.name);
		if (catalogIndex(t.name) < 0) throw new Error(`Tool ${t.name} is not in the catalogue`);
	}
	return Object.freeze(all.sort((a, b) => catalogIndex(a.name) - catalogIndex(b.name)));
}

export const TOOLS: readonly ToolDef[] = build();

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function toolDef(name: string): ToolDef | undefined {
	return BY_NAME.get(name);
}

/** Names in the catalogue that no lane has built yet (for the overview and the docs generator). */
export function notBuiltYet(): string[] {
	return CATALOG.filter((c) => !BY_NAME.has(c.name)).map((c) => c.name);
}
