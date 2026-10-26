/**
 * NoDrive HTTP status to error catalogue (DESIGN 10.5). Messages are ours; server bodies are never
 * shown. Tools may catch a ToolError and replace its message with a more specific one.
 */
import { ToolError } from "../core/errors";

export interface StatusContext {
	method: string;
	/** A path or name from the tool's own input, to make the message concrete. */
	what?: string;
	/** Which precondition header the request carried. */
	precondition?: "if-match" | "if-none-match";
	retryAfter?: string | null;
}

export function mapStatus(status: number, c: StatusContext): ToolError {
	const what = c.what ? ` ${c.what}` : "";
	const opts = { upstreamStatus: status };
	if (status >= 300 && status < 400) return new ToolError("upstream_unavailable", "NoDrive answered in an unexpected way. Try again in a minute.", opts);
	switch (status) {
		case 400:
			return new ToolError("invalid_input", "NoDrive refused the request as invalid.", opts);
		case 403:
			return new ToolError("permission_denied", c.what ? `The person isn't allowed to do that with${what}.` : undefined, opts);
		case 404:
			return new ToolError("not_found", c.what ? `There's nothing at${what}.` : undefined, { ...opts, hint: c.what ? "files_search can find items by name." : undefined });
		case 405:
			if (c.method === "MKCOL") return new ToolError("already_exists", c.what ? `${c.what} already exists.` : undefined, opts);
			return new ToolError("invalid_input", "That can't be done to this item.", opts);
		case 409:
			return new ToolError("parent_missing", c.what ? `The folder for${what} doesn't exist.` : undefined, opts);
		case 412:
			if (c.precondition === "if-none-match") return new ToolError("already_exists", c.what ? `${c.what} already exists.` : undefined, opts);
			return new ToolError("conflict", c.what ? `${c.what} changed since it was read. Read it again first.` : undefined, opts);
		case 413:
			return new ToolError("too_large", undefined, opts);
		case 415:
			return new ToolError("unsupported_type", undefined, opts);
		case 423:
			return new ToolError("locked", c.what ? `${c.what} is locked because someone has it open. Try again later.` : undefined, opts);
		case 429: {
			const ra = Number(c.retryAfter ?? "");
			return new ToolError("rate_limited", "NoDrive asked to slow down. Try again shortly.", {
				...opts,
				retryAfterSec: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) : 30,
			});
		}
		case 507:
			return new ToolError("quota_exceeded", undefined, opts);
		default:
			if (status >= 500) return new ToolError("upstream_unavailable", undefined, opts);
			return new ToolError("upstream_unavailable", "NoDrive answered in an unexpected way. Try again in a minute.", opts);
	}
}
