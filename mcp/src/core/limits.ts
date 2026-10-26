/** Every size, time and count limit in one place (DESIGN section 14). Lanes import; only core edits. */
export const LIMITS = {
	mcpBodyBytes: 4 * 1024 * 1024,
	resultChars: 60_000,
	textUploadChars: 1_000_000,
	binaryUploadBytes: 2 * 1024 * 1024,
	readCharsDefault: 20_000,
	readCharsMax: 50_000,
	readTextSourceBytes: 10 * 1024 * 1024,
	officeInWorkerBytes: 10 * 1024 * 1024,
	pdfInWorkerBytes: 15 * 1024 * 1024,
	serverRouteBytes: 25 * 1024 * 1024,
	unzipPartBytes: 30 * 1024 * 1024,
	unzipTotalBytes: 60 * 1024 * 1024,
	unzipEntries: 2_000,
	davXmlBytes: 8 * 1024 * 1024,
	jsonBytes: 4 * 1024 * 1024,
	folderReadEntries: 2_000,
	// The trash is read as a stream (fix round 4, files/stream.ts): at most this many characters
	// (about 50,000 items at some 650 characters each) and this long per read. files_list_trash keeps
	// the newest folderReadEntries of what it reads.
	trashReadChars: 32 * 1024 * 1024,
	trashReadTimeoutMs: 20_000,
	// files_restore_from_trash looks at the shares of at most this many items inside a restored
	// folder; a bigger folder counts as possibly shared by link (fix round 4).
	restoreScanItems: 1_000,
	listMax: 200,
	searchMax: 50,
	unifiedSearchPerCall: 25,
	markdownChars: 400_000,
	sheets: 20,
	cells: 50_000,
	slides: 60,
	templateBytes: 10 * 1024 * 1024,
	templateKeys: 200,
	templateValueChars: 10_000,
	docOutputBytes: 20 * 1024 * 1024,
	convertBytes: 25 * 1024 * 1024,
	// Inside the 60 s tool budget, with room for the reads before and the PUT after (fix round 3:
	// it was 90 s, which the tool timeout always cut first).
	convertTimeoutMs: 40_000,
	convertPerHour: 20,
	eventRangeDays: 92,
	freeTimeDays: 31,
	descriptionInChars: 10_000,
	descriptionOutChars: 2_000,
	attendeesPerCall: 50,
	cardBytes: 100 * 1024,
	notesOutChars: 2_000,
	titleChars: 255,
	commentChars: 1_000,
	shareLabelChars: 100,
	shareNoteChars: 500,
	linkDaysDefault: 30,
	mailBytes: 1024 * 1024,
	mailCallTimeoutMs: 25_000,
	mailListTimeoutMs: 8_000,
	// 71 own tools + 29 = 100, ONLYOFFICE's cap (fix round 3: calendar_respond took one; NoMail ships 18).
	mailTools: 29,
	mailSchemaBytes: 32 * 1024,
	ncTimeoutMs: 20_000,
	// The person's time zone, looked up inside a tool's budget for the tools that read times, with
	// no retry (fix round 4, src/mcp/zone.ts).
	zoneLookupMs: 5_000,
	toolTimeoutMs: 60_000,
	supabaseTimeoutMs: 8_000,
	ncConcurrency: 4,
	connectionsPerPerson: 5,
	maxGrantAgeSec: 60 * 24 * 3600,
	idleSec: 14 * 24 * 3600,
	desktopIdleSec: 30 * 24 * 3600,
	accessTokenTtlSec: 3600,
	refreshTokenTtlSec: 14 * 24 * 3600,
	clientRegistrationTtlSec: 90 * 24 * 3600,
	connectFlowSec: 20 * 60,
	consentRememberSec: 7 * 24 * 3600,
	sessionSec: 30 * 60,
	dedupeSec: 10 * 60,
	mailCacheSec: 300,
	mailFailCacheSec: 60,
	upstreamRefreshMarginSec: 300,
	instructionsChars: 900,
	descriptionChars: 450,
	propertyDescriptionChars: 120,
	toolNameChars: 25,
	// The whole own tools/list with every app and scope: 98,254 bytes measured 2026-10-26 (71 tools,
	// no "$schema" lines). The first design's 60 KB budget was for 55 tools; NoGantt's 15 and
	// calendar_respond outgrew it, and trimming the input descriptions further would cost the tools'
	// clarity (fix round 3, DESIGN 10.8; the owner may still ask for a trim per app).
	ownToolsListBytes: 100 * 1024,
} as const;

/** Per-person buckets kept exactly in the Vault (DESIGN 9.4). */
export type Bucket = "read" | "write" | "remove" | "share" | "heavy" | "mail";

export const PER_MINUTE: Readonly<Record<Bucket, number>> = {
	read: 120,
	write: 30,
	remove: 20,
	share: 10,
	heavy: 10,
	mail: 30,
};

/**
 * Exact daily caps on unauthenticated work, kept in the Quota object (DESIGN 14, fix round 2;
 * DESIGN 29.1). "authorize" counts sign-ins started at GET /authorize; "register" counts client
 * registrations; "page_signin" counts NoDrive sign-ins and desktop keys started on /connections.
 * perCaller is per network: an IPv4 address, or an IPv6 address by its /48 (vault/quota.ts
 * dailyBucket); global is for everyone.
 *
 * reserve: a caller that has used fewer than this many units today still gets one when the global
 * cap is used up, so someone with many networks can't lock everybody else out for the day. It raises
 * the worst day by at most `reserve` units for each network an outsider holds.
 *
 * How many networks it takes to use up a global cap is global / perCaller: 30 for sign-ins and, since
 * the third system review (section 30.1), 100 for registrations. Before, registrations were 200 per
 * network and 1,000 in all, so five networks used up the day, and the AI vendors' servers (a few
 * networks for all of their users) were left with their reserve. A registration is counted only when
 * it is stored (auth/dcr-cap.ts), never for a malformed or refused one.
 *
 * Worst day without the reserve: 3,000 registrations (one KV write each) and 3,000 sign-ins (at most
 * about three KV writes or deletes each), so about 12,000 KV operations: some 360,000 a month, inside
 * Workers Paid's included million writes. An AI vendor that registers more than 30 clients a day from
 * one network waits until midnight UTC for the rest (raise perCaller here if that happens).
 *
 * page_signin writes no KV: each start is one ConnectFlow object and one NoDrive login-flow row
 * (NoDrive expires it after 20 minutes). It has its own name so that a flood of AI-app sign-ins can't
 * stop people from opening /connections, the page where they see and end their connections; its
 * global cap only bounds the load on NoDrive.
 */
export type QuotaName = "authorize" | "register" | "page_signin";
export const DAILY_CAPS: Readonly<Record<QuotaName, { perCaller: number; global: number; reserve: number }>> = {
	authorize: { perCaller: 100, global: 3_000, reserve: 3 },
	register: { perCaller: 30, global: 3_000, reserve: 5 },
	page_signin: { perCaller: 30, global: 20_000, reserve: 5 },
};

/** Per UTC day. "calls" counts every tool call; the others count their bucket. */
export const PER_DAY = {
	calls: 5_000,
	write: 500,
	remove: 100,
	share: 30,
	heavy: 200,
	mail: 1_000,
	uploadBytes: 200 * 1024 * 1024,
} as const;
