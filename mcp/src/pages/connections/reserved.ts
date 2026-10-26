/**
 * The name of this page's own sign-in on NoDrive's grant page, and its look-alikes (lane F).
 * Kept apart from views.ts so core's auth/dcr.ts can use isReservedLabel() with only one more
 * import (auth/connect.ts, which imports nothing from dcr.ts; lane F notes: core patch "DCR name").
 */
import { connectorUserAgent } from "../../auth/connect";

/** The app-password name for a /connections sign-in ("AI app (Connections page)"). */
export const SESSION_LABEL = "Connections page";

/** Letters and digits only, lower case: "Connections_Page" and "connections-page" look the same on a grant page. */
function squash(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Whether a name would look like this page's own sign-in on NoDrive's grant page. A desktop key may
 * not carry that name or a look-alike (parseKeyForm), so a key's grant can't pass itself off as the
 * page's sign-in. It is compared after NoDrive's own clean-up of the name (connectorUserAgent),
 * without case, spaces or punctuation, and also in the singular.
 * AI apps name themselves (DCR client_name): since fix round 4, auth/dcr.ts refuses such a name at
 * registration and clientLabel() shows one registered before that as plain "AI app", so no AI app's
 * access is named like the page's sign-in any more. The list still warns about an older connection
 * with that name.
 */
export function isReservedLabel(label: string): boolean {
	const shown = squash(connectorUserAgent(label));
	const reserved = squash(SESSION_LABEL);
	return shown.includes(reserved) || shown.includes(reserved.replace(/s(?=page$)/, ""));
}
