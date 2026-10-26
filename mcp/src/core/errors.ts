/**
 * The error catalogue (DESIGN 10.5). Every tool failure becomes one of these codes with one or two
 * plain sentences. Raw server bodies are never passed on: they may hold traces or the upstream brand.
 */
export type ErrorCode =
	| "invalid_input"
	| "not_found"
	| "already_exists"
	| "conflict"
	| "parent_missing"
	| "permission_denied"
	| "locked"
	| "too_large"
	| "unsupported_type"
	| "quota_exceeded"
	| "rate_limited"
	| "daily_limit"
	| "not_available"
	| "reconnect_required"
	| "upstream_unavailable"
	| "timeout";

export const ERROR_CODES: readonly ErrorCode[] = [
	"invalid_input",
	"not_found",
	"already_exists",
	"conflict",
	"parent_missing",
	"permission_denied",
	"locked",
	"too_large",
	"unsupported_type",
	"quota_exceeded",
	"rate_limited",
	"daily_limit",
	"not_available",
	"reconnect_required",
	"upstream_unavailable",
	"timeout",
];

/** Whether the same call may work if tried again later without changes. */
export const RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
	invalid_input: false,
	not_found: false,
	already_exists: false,
	conflict: false,
	parent_missing: false,
	permission_denied: false,
	locked: true,
	too_large: false,
	unsupported_type: false,
	quota_exceeded: false,
	rate_limited: true,
	daily_limit: true,
	not_available: false,
	reconnect_required: false,
	upstream_unavailable: true,
	timeout: true,
};

/** Default plain-English messages, used when a tool gives none. */
export const DEFAULT_MESSAGE: Readonly<Record<ErrorCode, string>> = {
	invalid_input: "Some of the input isn't valid.",
	not_found: "That item doesn't exist, or this person can't see it.",
	already_exists: "Something with that name already exists there.",
	conflict: "The item changed since it was read. Read it again first.",
	parent_missing: "The folder it should go in doesn't exist.",
	permission_denied: "This person isn't allowed to do that.",
	locked: "The item is locked because someone has it open. Try again later.",
	too_large: "That is too large for this connector.",
	unsupported_type: "This kind of file isn't supported here.",
	quota_exceeded: "NoDrive storage is full.",
	rate_limited: "Too many requests in a short time. Try again in a moment.",
	daily_limit: "This connection reached today's limit. It resets at midnight UTC.",
	not_available: "That isn't available on this connection.",
	reconnect_required: "This assistant's access to Nourax Workspace has ended. Reconnect it.",
	upstream_unavailable: "Nourax Workspace didn't answer. Try again in a minute.",
	timeout: "That took too long. Try again, or try something smaller.",
};

export interface ToolErrorOptions {
	hint?: string;
	field?: string;
	retryAfterSec?: number;
	/** Set by the NoDrive client when its one 401 probe also failed: the credential is dead. */
	deadCredential?: boolean;
	/** For logs only: the HTTP status from NoDrive or NoMail. Never shown. */
	upstreamStatus?: number;
	/** For matching only (for example an OCS message). Never shown to anyone and never logged. */
	detail?: string;
	/**
	 * Overrides RETRYABLE for this one error. The wrapper sets false when a tool that changes data
	 * failed after it may already have done its work (register.ts, unsureOutcome).
	 */
	retryable?: boolean;
}

export class ToolError extends Error {
	readonly code: ErrorCode;
	readonly hint?: string;
	readonly field?: string;
	readonly retryAfterSec?: number;
	readonly deadCredential: boolean;
	readonly upstreamStatus?: number;
	readonly detail?: string;
	private readonly retryOverride?: boolean;
	constructor(code: ErrorCode, message?: string, opts: ToolErrorOptions = {}) {
		super(message ?? DEFAULT_MESSAGE[code]);
		this.name = "ToolError";
		this.code = code;
		this.hint = opts.hint;
		this.field = opts.field;
		this.retryAfterSec = opts.retryAfterSec;
		this.deadCredential = opts.deadCredential === true;
		this.upstreamStatus = opts.upstreamStatus;
		this.detail = opts.detail;
		this.retryOverride = opts.retryable;
	}
	get retryable(): boolean {
		return this.retryOverride ?? RETRYABLE[this.code];
	}
	/** True or false when the tool said so itself (it knows the outcome); undefined otherwise. */
	get statedRetryable(): boolean | undefined {
		return this.retryOverride;
	}
}

export function fail(code: ErrorCode, message?: string, opts?: ToolErrorOptions): never {
	throw new ToolError(code, message, opts);
}

export function isToolError(e: unknown): e is ToolError {
	return e instanceof ToolError;
}

/** Anything thrown that isn't a ToolError is our bug or a network failure: say so plainly. */
export function asToolError(e: unknown): ToolError {
	if (e instanceof ToolError) return e;
	if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
		return new ToolError("timeout");
	}
	return new ToolError("upstream_unavailable", "Something went wrong while doing that. Try again in a minute.");
}

/** What goes into `_meta["nourax/error"]`. */
export function errorMeta(e: ToolError): Record<string, unknown> {
	const m: Record<string, unknown> = { code: e.code, retryable: e.retryable };
	if (e.retryAfterSec !== undefined) m.retry_after_seconds = e.retryAfterSec;
	if (e.field !== undefined) m.field = e.field;
	return m;
}
