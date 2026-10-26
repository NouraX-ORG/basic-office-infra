/**
 * People, groups and teams the person may share with (DESIGN 11.3). Always left out: the person
 * themself, the admin group, and non-UUID local accounts (QA accounts are allowed in dev only).
 * verify() re-checks one typed id with a fresh search and needs an exact match, because creating a
 * share only checks that the account exists, not that the sharer may see it.
 */
import { isUuid, parseTypedId, QA_UID_RE, type TypedKind, typedId } from "../core/ids";
import type { NcClient } from "./client";

export interface Sharee {
	id: string;
	kind: TypedKind;
	display_name: string;
	detail: string | null;
}

interface RawSharee {
	label?: string;
	value?: { shareType?: number; shareWith?: string };
	shareWithDisplayNameUnique?: string;
	subline?: string;
	name?: string;
}

const TYPE_OF: Record<number, TypedKind> = { 0: "person", 1: "group", 7: "team" };
const SHARE_TYPE: Record<TypedKind, number> = { person: 0, group: 1, team: 7 };

export interface ShareesApi {
	search(query: string, opts?: { kinds?: TypedKind[]; limit?: number }): Promise<Sharee[]>;
	/** Returns the sharee for a typed id when a fresh search finds it exactly, else null. */
	verify(raw: string, allowed?: TypedKind[]): Promise<Sharee | null>;
}

export function shareesApi(nc: NcClient, opts: { dev: boolean }): ShareesApi {
	const allowedUid = (uid: string) => isUuid(uid) || (opts.dev && QA_UID_RE.test(uid));

	function keep(s: Sharee): boolean {
		if (s.kind === "person") return s.id !== typedId("person", nc.uid) && allowedUid(s.id.slice("person:".length));
		if (s.kind === "group") return s.id !== "group:admin";
		return true;
	}

	async function raw(query: string, kinds: TypedKind[], limit: number): Promise<{ exact: Sharee[]; other: Sharee[] }> {
		const data = await nc.ocs.get<Record<string, unknown>>("/ocs/v2.php/apps/files_sharing/api/v1/sharees", {
			search: query,
			itemType: "file",
			"shareType[]": kinds.map((k) => String(SHARE_TYPE[k])),
			perPage: Math.min(Math.max(limit, 1), 25),
			lookup: "false",
		});
		const pick = (list: unknown): Sharee[] => {
			if (!Array.isArray(list)) return [];
			const out: Sharee[] = [];
			for (const r of list as RawSharee[]) {
				const t = r.value?.shareType;
				const w = r.value?.shareWith;
				if (typeof t !== "number" || typeof w !== "string" || !TYPE_OF[t]) continue;
				const kind = TYPE_OF[t] as TypedKind;
				if (!kinds.includes(kind)) continue;
				out.push({
					id: typedId(kind, w),
					kind,
					display_name: (r.label ?? r.name ?? w).slice(0, 200),
					detail: kind === "group" ? "group" : kind === "team" ? "team" : null,
				});
			}
			return out;
		};
		const exactRaw = (data?.exact ?? {}) as Record<string, unknown>;
		const exact = [...pick(exactRaw.users), ...pick(exactRaw.groups), ...pick(exactRaw.circles)].filter(keep);
		const other = [...pick(data?.users), ...pick(data?.groups), ...pick(data?.circles)].filter(keep);
		return { exact, other };
	}

	return {
		async search(query, o = {}) {
			const kinds = o.kinds?.length ? o.kinds : (["person", "group", "team"] as TypedKind[]);
			const limit = o.limit ?? 10;
			const { exact, other } = await raw(query, kinds, limit);
			const seen = new Set<string>();
			const out: Sharee[] = [];
			for (const s of [...exact, ...other]) {
				if (seen.has(s.id)) continue;
				seen.add(s.id);
				out.push(s);
				if (out.length >= limit) break;
			}
			return out;
		},
		async verify(rawId, allowed = ["person", "group", "team"]) {
			const t = parseTypedId(rawId, allowed);
			const { exact, other } = await raw(t.id, [t.kind], 25);
			const want = typedId(t.kind, t.id);
			return [...exact, ...other].find((s) => s.id === want) ?? null;
		},
	};
}
