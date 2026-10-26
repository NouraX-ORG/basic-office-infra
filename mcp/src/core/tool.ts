/**
 * The tool framework (DESIGN 10.1 and 18.3), the only way to add a tool. Frozen by core:
 * defineTool(), ToolCtx, ToolOutcome and ToolDef. Lanes import these and never edit them.
 */
import type { z } from "zod";
import type { NxConfig, NxEnv } from "../env";
import { type CatalogEntry, catalogEntry, type AppId, type Scope } from "../mcp/catalog";
import type { Nc } from "../nc/index";
import type { ErrorCode } from "./errors";
import type { Bucket } from "./limits";
import type { CliName } from "./log";
import type { Undo } from "./shapes";
import type { TimeApi } from "./time";
import type { MailContext } from "./mail-contract";

export type MailStatus = "on" | "off" | "reconnect_needed" | "not_set_up";

export interface ConnectionInfo {
	connectionId: string;
	kind: "oauth" | "desktop" | "dev";
	/** The client label, for example "Claude". */
	client: string;
	cli: CliName;
	scopes: Scope[];
	apps: AppId[];
	/** ISO 8601. */
	connectedAt: string;
	expiresAt: string;
	mail: MailStatus;
}

export interface PageApi {
	/** Offset paging over a full list, with a cursor bound to this call's arguments. */
	slice<T>(all: readonly T[], limit: number): Promise<{ items: T[]; next_cursor: string | null; has_more: boolean }>;
	/** Encode any position (for example sub-cursors) bound to this call's arguments. */
	encode(position: unknown): Promise<string>;
	/** The position from this call's `cursor` argument, or null. Refuses a cursor from other arguments. */
	decode<T = unknown>(): Promise<T | null>;
	/**
	 * The largest prefix of `items` whose rendered output fits the result budget, measured as
	 * structuredContent carries it: JSON with nulls kept, with room for a 300-character summary
	 * (section 30.7; it measured without nulls before).
	 */
	fit<T>(items: readonly T[], render: (items: T[]) => unknown): { items: T[]; cut: boolean };
}

export interface ToolCtx {
	uid: string;
	displayName: string | null;
	connection: ConnectionInfo;
	/** The NoDrive client bound to this person (egress-checked). */
	nc: Nc;
	/** For lane E's mail tools only. */
	mail: MailContext;
	time: TimeApi;
	/** Characters left for the payload of this result. */
	budget: { chars: number };
	page: PageApi;
	/** Aborts after 60 s. */
	signal: AbortSignal;
	rid: string;
	env: NxEnv;
	cfg: NxConfig;
	/**
	 * Metadata-only notes for the tool log line (short codes such as "content_search"): written in the
	 * line's `notes`, each once; "href_outside" is also an auth event (section 30.5).
	 */
	log: { note(code: string): void };
	/**
	 * A warning for the person, added to the result's `warnings` when the tool succeeds (for example
	 * that the folder written into is shared, files/exposure.ts). Never names a path outside the frame.
	 */
	warn(message: string): void;
	fail(code: ErrorCode, message?: string, hint?: string): never;
	/** Counts extra work against the person's limits (content search as heavy, upload bytes). Throws rate_limited or daily_limit. */
	charge(bucket: Bucket, weight?: number, bytes?: number): Promise<void>;
}

export interface ToolOutcome<O = Record<string, unknown>> {
	/** structuredContent; must match the output schema. */
	data: O;
	/** One line written by the server, e.g. "Listed 12 items in /Projects." */
	summary: string;
	/** Merged into structuredContent as `undo` when given. */
	undo?: Undo;
	/** Merged into structuredContent as `warnings` when given. */
	warnings?: string[];
	/** When set, framed instead of the JSON (files_read_text: the file text itself). */
	text?: string;
	/** A different notice line for the framed block (mail). */
	notice?: string;
}

export interface ToolSpec<I extends z.ZodObject, O extends z.ZodType> {
	name: string;
	title: string;
	/** At most 450 characters, facts only (10.8). */
	description: string;
	/** A strict zod object: every string has .max(), every number has bounds. */
	input: I;
	output?: O;
	run: (ctx: ToolCtx, args: z.output<I>) => Promise<ToolOutcome<z.output<O>>>;
}

export interface ToolDef {
	name: string;
	entry: CatalogEntry;
	title: string;
	description: string;
	input: z.ZodObject;
	output?: z.ZodType;
	run: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<ToolOutcome<unknown>>;
}

/** Declares one tool. The name must be a catalogue entry; everything else is checked by the lint test. */
export function defineTool<I extends z.ZodObject, O extends z.ZodType>(spec: ToolSpec<I, O>): ToolDef {
	const entry = catalogEntry(spec.name);
	if (!entry) throw new Error(`Tool ${spec.name} is not in the catalogue (src/mcp/catalog.ts)`);
	return {
		name: spec.name,
		entry,
		title: spec.title,
		description: spec.description,
		input: spec.input,
		output: spec.output,
		run: spec.run as ToolDef["run"],
	};
}
