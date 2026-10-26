/**
 * Server capabilities, enabled apps and unified-search providers, cached per person in isolate
 * memory for 10 minutes (keyed by a hash of the uid, never the uid itself).
 */
import { sha256Hex } from "../core/bytes";
import type { NcClient } from "./client";

export interface Capabilities {
	raw: Record<string, unknown>;
	/** files.undelete: deleting lands in the trash. */
	trash: boolean;
	/** files.versioning */
	versions: boolean;
	deck: { version: string | null; apiVersions: string[] } | null;
	fileConversions: unknown[];
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(kind: string, uid: string, load: () => Promise<T>): Promise<T> {
	const k = `${kind}:${(await sha256Hex(uid)).slice(0, 24)}`;
	const hit = cache.get(k);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
	const value = await load();
	cache.set(k, { at: Date.now(), value });
	if (cache.size > 5000) cache.clear();
	return value;
}

export function clearCapabilityCache(): void {
	cache.clear();
}

export async function capabilities(nc: NcClient): Promise<Capabilities> {
	return cached("caps", nc.uid, async () => {
		const d = await nc.ocs.get<{ capabilities?: Record<string, unknown> }>("/ocs/v2.php/cloud/capabilities");
		const caps = (d?.capabilities ?? {}) as Record<string, Record<string, unknown> | undefined>;
		const files = caps.files ?? {};
		const deck = caps.deck as Record<string, unknown> | undefined;
		return {
			raw: caps as Record<string, unknown>,
			trash: files.undelete === true,
			versions: files.versioning === true,
			deck: deck
				? {
						version: typeof deck.version === "string" ? deck.version : null,
						apiVersions: Array.isArray(deck.apiVersions) ? deck.apiVersions.filter((x): x is string => typeof x === "string") : [],
					}
				: null,
			fileConversions: Array.isArray(files.file_conversions) ? (files.file_conversions as unknown[]) : [],
		};
	});
}

/** Unified-search provider ids. Never call a provider id that isn't listed (the server answers 500). */
export async function searchProviders(nc: NcClient): Promise<string[]> {
	return cached("providers", nc.uid, async () => {
		const d = await nc.ocs.get<unknown>("/ocs/v2.php/search/providers");
		if (!Array.isArray(d)) return [];
		return d.map((p) => (p && typeof p === "object" ? (p as { id?: unknown }).id : null)).filter((x): x is string => typeof x === "string");
	});
}

/** App ids in the person's navigation (which apps are on for them). */
export async function navigationApps(nc: NcClient): Promise<string[]> {
	return cached("nav", nc.uid, async () => {
		const d = await nc.ocs.get<unknown>("/ocs/v2.php/core/navigation/apps");
		if (!Array.isArray(d)) return [];
		return d.map((p) => (p && typeof p === "object" ? (p as { id?: unknown }).id : null)).filter((x): x is string => typeof x === "string");
	});
}
