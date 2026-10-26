/**
 * Brand rule 6: nothing a person can see may name the upstream file server, use its blue or link to
 * its sites. This minimal built-in set is what the brand test uses when Task 3's
 * nextcloud-apps/nourax_branding/sweep/rules.json isn't in the repo yet; the test prefers that file.
 * The patterns are assembled from parts so this file doesn't trip repo-wide sweeps itself.
 */
const N = ["next", "cloud"];

export const BUILTIN_BRAND_RULES: readonly { id: string; pattern: RegExp }[] = [
	{ id: "name", pattern: new RegExp(`${N[0]}[ -]?${N[1]}`, "i") },
	{ id: "blue-1", pattern: /#0082c9/i },
	{ id: "blue-2", pattern: /#00679e/i },
	{ id: "site", pattern: new RegExp(`(?:apps\\.|docs\\.)?${N[0]}${N[1]}\\.com`, "i") },
	{ id: "github", pattern: new RegExp(`github\\.com/${N[0]}${N[1]}`, "i") },
];

/** Returns the ids of the rules a text breaks (empty when clean). */
export function brandViolations(text: string, rules: readonly { id: string; pattern: RegExp }[] = BUILTIN_BRAND_RULES): string[] {
	return rules.filter((r) => r.pattern.test(text)).map((r) => r.id);
}

/** True when the text is clean. Used on provider (NoMail) descriptions and in tests. */
export function brandClean(text: string): boolean {
	return brandViolations(text).length === 0;
}
