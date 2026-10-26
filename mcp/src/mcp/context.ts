/** The per-request context the handler builds and the factory and tool wrapper read. */
import type { OAuthResourceAuth } from "@cloudflare/workers-oauth-provider";
import type { NxConfig, NxEnv } from "../env";
import type { ToolError } from "../core/errors";
import type { CliName } from "../core/log";
import type { MailContext } from "../core/mail-contract";
import type { Nc, NcStats } from "../nc/index";
import type { OpenOk } from "../vault/schema";
import type { Vault } from "../vault/vault";
import type { AppId, Scope } from "./catalog";

/** What the grant (or desktop-key record) carries, encrypted by the OAuth library. */
export interface GrantProps {
	v: 1;
	kind: "oauth" | "desktop" | "dev";
	uid: string;
	connectionId: string;
	/** base64url of the 32-byte use key. Never stored by us; it lives only in the encrypted props. */
	vaultKey: string;
	connectedAt: number;
	clientLabel: string;
	grantId?: string;
}

export interface RequestCtx {
	rid: string;
	env: NxEnv;
	cfg: NxConfig;
	startedAt: number;
	cli: CliName;
	era?: string;
	clientIp?: string;
	auth: OAuthResourceAuth;
	props: GrantProps;
	uid: string;
	connectionId: string;
	/** True for OAuth tokens (they can step up); false for desktop keys. */
	canStepUp: boolean;
	scopes: Scope[];
	apps: AppId[];
	open: OpenOk;
	vault: DurableObjectStub<Vault>;
	useKey: Uint8Array;
	nc: Nc;
	/** Aborts every NoDrive call of this request; the tool wrapper fires it at the 60 s budget. */
	ncAbort?: AbortController;
	stats: NcStats;
	zone: string;
	/** False when NoDrive didn't answer the time-zone lookup, so `zone` is the default (a warning says so). */
	zoneKnown?: boolean;
	mail: MailContext;
	/** The JSON-RPC method of this request and, for tools/call, the tool name. */
	method: string;
	toolName?: string;
	/** A Vault limit that blocked this tools/call: the wrapper answers with it. */
	blocked?: ToolError;
	/** A known tool hidden by app or flag: the factory registers a stub that answers not_available. */
	gated?: { name: string; error: ToolError };
	/** Set when the NoDrive credential turned out dead (8.5). */
	deadCredential: boolean;
	inBytes: number;
}
