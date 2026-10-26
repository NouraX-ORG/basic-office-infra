/** Relationship parts (OPC): which part a relationship id points to. */
import { DOC_LIMITS } from "../limits";
import { attr, NS, parsePart } from "../sax";
import type { ZipReader } from "../zip";

export interface RelTarget {
	target: string;
	type: string;
	external: boolean;
}

/** "word/document.xml" -> "word/_rels/document.xml.rels". */
export function relsPathFor(part: string): string {
	const i = part.lastIndexOf("/");
	return i < 0 ? `_rels/${part}.rels` : `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
}

/** Resolves a relative target against the folder of `fromPart`; returns a zip entry name. */
export function resolvePart(fromPart: string, target: string): string {
	if (target.startsWith("/")) return target.slice(1);
	const base = fromPart.includes("/") ? fromPart.slice(0, fromPart.lastIndexOf("/")).split("/") : [];
	for (const seg of target.split("/")) {
		if (seg === "..") base.pop();
		else if (seg !== "." && seg !== "") base.push(seg);
	}
	return base.join("/");
}

/** Reads a relationship part, streamed; at most DOC_LIMITS.tableEntries relationships are kept. */
export function readRels(zip: ZipReader, relsPath: string): Map<string, RelTarget> {
	const out = new Map<string, RelTarget>();
	parsePart(zip, relsPath, {
		open(t) {
			if (t.uri !== NS.rel || t.local !== "Relationship" || out.size >= DOC_LIMITS.tableEntries) return;
			const id = attr(t, null, "Id");
			const target = attr(t, null, "Target");
			if (!id || target === undefined) return;
			out.set(id, { target: target.slice(0, 8192), type: (attr(t, null, "Type") ?? "").slice(0, 512), external: (attr(t, null, "TargetMode") ?? "").toLowerCase() === "external" });
		},
	});
	return out;
}
