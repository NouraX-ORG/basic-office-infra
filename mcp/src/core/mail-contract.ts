/**
 * The interface between core and the NoMail aggregator (lane E, src/mail/), for the caller side of
 * tool-provider contract v1 (brief section 5, DESIGN 13). Core builds a MailContext per request;
 * lane E implements listMailTools() and callMailTool() against it.
 */
import type { NxConfig, NxEnv } from "../env";
import type { MailCacheEntry, MailState } from "../vault/schema";

/** A provider tool after validation (13.3). */
export interface MailToolDef {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

/** What the mail module may use. The upstream token is the person's Supabase token, never the MCP token. */
export interface MailContext {
	env: NxEnv;
	cfg: NxConfig;
	rid: string;
	/** True when NOMAIL_TOOLS_URL and NOMAIL_TOOLS_KEY are set, the connection has a live upstream
	 *  session, a mail scope is granted and the Mail app is chosen (13.1). */
	active: boolean;
	/** Why mail is off, for whoami and the instructions. */
	state: "on" | "off" | "reconnect_needed" | "not_set_up";
	scopes: { read: boolean; write: boolean };
	/** The current upstream access token, refreshed first when less than 300 s is left. Null when dead. */
	upstreamToken(): Promise<string | null>;
	/**
	 * One forced refresh (after a NoMail 401). Single-flight per connection in the vault. `used` is the
	 * token that got the 401: when the vault already holds a different, fresh token (another request
	 * refreshed meanwhile), that token comes back and nothing is rotated (brief 5, caller rule 2).
	 */
	refreshUpstream(used?: string): Promise<string | null>;
	cache: {
		get(): Promise<MailCacheEntry | null>;
		/** value is JSON text (lane E stringifies the validated tool list). */
		put(value: string, ttlSec: number): Promise<void>;
		fail(): Promise<MailCacheEntry | null>;
	};
	setState(state: MailState): Promise<void>;
}
