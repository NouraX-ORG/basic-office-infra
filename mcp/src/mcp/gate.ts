/**
 * The scope, app and flag gate (DESIGN 6.2 and 10.2). Tools outside the grant are not registered,
 * so they are absent from tools/list. A tools/call for a known tool that is hidden:
 * - by scope, on an OAuth connection: HTTP 403 insufficient_scope naming the scopes (step-up);
 * - by scope on a desktop key, or by app or flag: a tool result with isError and not_available.
 */
import { ToolError } from "../core/errors";
import type { ToolDef } from "../core/tool";
import { TOOLS } from "../tools/registry";
import { ALL_SCOPES, type CatalogEntry, catalogEntry, type Scope } from "./catalog";
import type { RequestCtx } from "./context";

export type Hidden = "scope" | "app" | "flag" | null;

export function hiddenBy(entry: CatalogEntry, rc: Pick<RequestCtx, "scopes" | "apps" | "cfg">): Hidden {
	if (!rc.scopes.includes(entry.scope)) return "scope";
	if (entry.app !== null && !rc.apps.includes(entry.app)) return "app";
	if (entry.flag === "heavy" && !rc.cfg.heavyTools) return "flag";
	if (entry.flag === "attendees" && rc.cfg.calendarAttendees !== "internal") return "flag";
	return null;
}

export function visibleTools(rc: Pick<RequestCtx, "scopes" | "apps" | "cfg">): ToolDef[] {
	return TOOLS.filter((t) => hiddenBy(t.entry, rc) === null);
}

/** Scopes as granted: the token's for OAuth, the vault record's for desktop keys. Always valid names. */
export function effectiveScopes(tokenScopes: readonly string[], recordScopes: readonly string[], canStepUp: boolean): Scope[] {
	const src = canStepUp ? tokenScopes : recordScopes;
	const set = new Set(src.filter((s): s is Scope => (ALL_SCOPES as readonly string[]).includes(s)));
	// Mail scopes need the vault record too (they are chosen at consent and stored there).
	return ALL_SCOPES.filter((s) => set.has(s));
}

export type GateDecision =
	| { kind: "pass" }
	| { kind: "step_up"; needed: Scope }
	| { kind: "not_available"; name: string; error: ToolError };

export function gateCall(
	rc: Pick<RequestCtx, "scopes" | "apps" | "cfg" | "canStepUp">,
	toolName: string | undefined,
	isBuilt: (name: string) => boolean = (name) => TOOLS.some((t) => t.name === name),
): GateDecision {
	if (!toolName) return { kind: "pass" };
	const entry = catalogEntry(toolName);
	if (!entry) return { kind: "pass" };
	if (!isBuilt(toolName)) return { kind: "pass" };
	const hidden = hiddenBy(entry, rc);
	if (hidden === null) return { kind: "pass" };
	if (hidden === "scope") {
		if (rc.canStepUp) return { kind: "step_up", needed: entry.scope };
		return {
			kind: "not_available",
			name: toolName,
			error: new ToolError("not_available", "This desktop key wasn't made with permission for that.", {
				hint: `Make a new key with more allowed at ${rc.cfg.publicOrigin}/connections.`,
			}),
		};
	}
	if (hidden === "app") {
		return {
			kind: "not_available",
			name: toolName,
			error: new ToolError("not_available", "This connection was set up without that app.", { hint: "Reconnect the assistant to add it." }),
		};
	}
	return {
		kind: "not_available",
		name: toolName,
		error: new ToolError("not_available", "That tool is switched off in Nourax Workspace right now."),
	};
}
