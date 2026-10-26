/** The connector's version, shown in /healthz, the MCP serverInfo and the User-Agent sent to NoDrive. */
export const VERSION = "0.1.0";
export const SERVER_NAME = "nourax-workspace";
export const SERVER_TITLE = "Nourax Workspace";
export const USER_AGENT = `Nourax-Workspace-MCP/${VERSION}`;

declare const __NX_BUILD__: string | undefined;

/**
 * The git commit this bundle was built from (12 hex characters, "-dirty" when mcp/ had changes),
 * set by scripts/predeploy.mjs with `--define`, so /healthz shows which build is live (DESIGN 2.1).
 * Local dev and tests have no define and say "dev". `typeof` keeps an undefined name safe.
 */
export const BUILD: string = typeof __NX_BUILD__ === "string" && /^[0-9a-f]{7,40}(?:-dirty)?$/.test(__NX_BUILD__) ? __NX_BUILD__ : "dev";
