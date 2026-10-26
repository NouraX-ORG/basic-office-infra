/**
 * What a person pastes into ONLYOFFICE Desktop Editors for a desktop key (lane F, DESIGN 6.6).
 * No imports, so core's key page (auth/connect.ts desktopKeyPage) can use the same text as the
 * key form without an import cycle (lane F notes: core patch "key page").
 *
 * ONLYOFFICE's own "Connecting MCP servers" page (api.onlyoffice.com, checked 2026-10-25): in the
 * start window, AI agent, Settings, MCP Servers, Edit configuration, then a JSON object with a
 * top-level "mcpServers". docs/mcp.md 2.4 shows the same block.
 */

/** Where the setting goes in ONLYOFFICE, in the words the pages use. */
export const ONLYOFFICE_MENU_PATH = "in ONLYOFFICE's start window, AI agent, then Settings, then MCP Servers, then Edit configuration";

/** Stands for the key in the template on the key form (the key itself is shown once, on the next page). */
export const KEY_PLACEHOLDER = "nxw_ct_…";

/**
 * The whole {"mcpServers": {...}} block for ONLYOFFICE's Edit configuration, with the server named
 * "nourax" (ONLYOFFICE puts that name in front of every tool name).
 */
export function desktopKeySetting(publicOrigin: string, key: string): string {
	return JSON.stringify({ mcpServers: { nourax: { url: `${publicOrigin}/mcp`, headers: { Authorization: `Bearer ${key}` } } } });
}
