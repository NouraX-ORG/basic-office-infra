/** The request id made by the router, shared with the handlers without touching the request. */
import { newId } from "../core/bytes";

const ids = new WeakMap<Request, string>();

export function setRid(request: Request, rid: string): void {
	ids.set(request, rid);
}

export function ridOf(request: Request): string {
	let rid = ids.get(request);
	if (!rid) {
		rid = newId();
		ids.set(request, rid);
	}
	return rid;
}

/**
 * What the MCP handler learnt about a request, for the router's req line (DESIGN 15): the protocol
 * era and the client kind. Keyed by the request id, taken (and so removed) when the line is written.
 */
export interface ReqNotes {
	era?: string;
	cli?: string;
}

const notes = new Map<string, ReqNotes>();

export function noteReq(rid: string, n: ReqNotes): void {
	// Bounded: a request that never reaches the router's log line can't make this grow for ever.
	if (notes.size > 1000) notes.clear();
	notes.set(rid, { ...(notes.get(rid) ?? {}), ...n });
}

export function takeReqNotes(rid: string): ReqNotes | undefined {
	const n = notes.get(rid);
	notes.delete(rid);
	return n;
}
