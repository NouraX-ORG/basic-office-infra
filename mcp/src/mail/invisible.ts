/**
 * Invisible Unicode (DESIGN 26.5), lane E. Moved to src/core/invisible.ts in fix round 4, where
 * every result is now cleaned (src/mcp/register.ts outcomeToResult and core's frame()); kept here so
 * the mail lane's imports (src/mail/index.ts, src/mail/validate.ts) and src/tools/boards/deck.ts
 * stay as they were.
 */
export { dropInvisible, hasInvisible } from "../core/invisible";
