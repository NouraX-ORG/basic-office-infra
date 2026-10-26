/**
 * Finding people, groups and teams to share with, on top of core's sharees search (which already
 * leaves out the person themself, the admin group and local accounts).
 *
 * With privacy between organisations on (brief section 7, docs/teams.md), the server returns only
 * people who share an organisation or team with the person, and only the person's own groups.
 * Task 6b makes that an admin switch, so the texts the tools show hold either way: "only those the
 * workspace lets this person see", with the privacy rule named as the case when it is on. A
 * Nourax team is the group "team:<id>" and an organisation is the group "org:<id>"; they keep their
 * group ids ("group:team:<id>") so the share type can never be mistaken, and are shown as kind
 * "team" and detail "organisation". Teams-app teams ("team:<id>", shareType 7) appear only while
 * that app is on.
 */
import type { TypedKind } from "../../core/ids";
import type { ToolCtx } from "../../core/tool";
import type { Sharee } from "../../nc/index";
import { shownOrNull } from "./bounded";
import { SHOWN_CHARS } from "./shares";

export type PeopleKind = "person" | "group" | "team";

export interface Found {
	id: string;
	kind: PeopleKind;
	display_name: string;
	detail: string | null;
}

export function classify(s: Sharee): Found {
	// A name is display text, cut to the server's own column size (fix round 3); ids stay as sent.
	const display_name = shownOrNull(s.display_name, SHOWN_CHARS.name) ?? s.id;
	if (s.kind === "group") {
		const gid = s.id.slice("group:".length);
		if (gid.startsWith("team:")) return { id: s.id, kind: "team", display_name, detail: "team" };
		if (gid.startsWith("org:")) return { id: s.id, kind: "group", display_name, detail: "organisation" };
		return { id: s.id, kind: "group", display_name, detail: "group" };
	}
	if (s.kind === "team") return { id: s.id, kind: "team", display_name, detail: "team" };
	return { id: s.id, kind: "person", display_name, detail: null };
}

/** The sharee kinds to ask the server for, so Nourax teams (groups) are found for "team". */
export function serverKinds(want: ReadonlySet<PeopleKind>): TypedKind[] {
	const k: TypedKind[] = [];
	if (want.has("person")) k.push("person");
	if (want.has("group") || want.has("team")) k.push("group");
	if (want.has("team")) k.push("team");
	return k;
}

export async function findPeople(ctx: ToolCtx, query: string, want: ReadonlySet<PeopleKind>, limit: number): Promise<Found[]> {
	const found = await ctx.nc.sharees.search(query, { kinds: serverKinds(want), limit: 25 });
	return found
		.map(classify)
		.filter((f) => want.has(f.kind))
		.slice(0, limit);
}
