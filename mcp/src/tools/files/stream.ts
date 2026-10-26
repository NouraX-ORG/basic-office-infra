/**
 * A PROPFIND Depth 1 answer read as a stream, a batch of whole <d:response> elements at a time (fix
 * round 4). The trash can hold tens of thousands of items: with trashbin retention "auto" nothing
 * expires by age (trash.ts, at the top), and one PROPFIND of it can be far over the 8 MiB the
 * buffered reader (core's dav.propfind) accepts. Here each batch is parsed and handed on, then
 * dropped, so memory stays small whatever the size, and the caller can stop as soon as it has what
 * it needs (files_move_to_trash stops at the item's own entry). Reading also stops after `maxChars`
 * characters or `timeoutMs`; the answer then says it isn't complete.
 *
 * Sabre writes one multistatus element whose start tag declares every namespace prefix; each batch
 * is parsed with that start tag (and the XML prologue) in front and the matching end tag behind.
 */
import { isToolError } from "../../core/errors";
import type { ToolCtx } from "../../core/tool";
import { type DavResponse, parseMultistatus } from "../../nc/index";

/** The end of one <d:response> element, whatever prefix the server gives the DAV namespace. */
const RESPONSE_END = /<\/(?:[A-Za-z_][\w.-]*:)?response\s*>/g;
/** The multistatus start tag, with its prefix. */
const ROOT_OPEN = /<([A-Za-z_][\w.-]*:)?multistatus\b[^>]*>/;
/** A start tag that hasn't arrived after this many characters isn't a multistatus answer. */
const ROOT_MAX_CHARS = 64 * 1024;

export interface StreamOptions {
	maxChars: number;
	timeoutMs: number;
}

/**
 * PROPFIND Depth 1 on `davPath` with `body`; `onBatch` gets each batch of responses and returns
 * false to stop reading. `complete` is true only when the whole answer was read and nothing stopped
 * it. An HTTP error (404, 401 and the rest) throws as for any NoDrive call; a failure while the body
 * is read (a timeout, a cut connection, broken XML) ends the reading with `complete` false.
 */
export async function streamPropfind(ctx: ToolCtx, davPath: string, body: string, onBatch: (rs: DavResponse[]) => boolean | undefined, o: StreamOptions): Promise<{ complete: boolean }> {
	const res = await ctx.nc.request("PROPFIND", davPath, {
		headers: { depth: "1", "content-type": "application/xml; charset=utf-8" },
		body,
		timeoutMs: o.timeoutMs,
	});
	if (res.status === 204 || !res.body) return { complete: true };
	const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
	let buf = "";
	let open: string | null = null;
	let close = "";
	let read = 0;
	let complete = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				complete = open !== null;
				break;
			}
			read += value.length;
			buf += value;
			if (open === null) {
				const m = ROOT_OPEN.exec(buf);
				if (!m) {
					if (buf.length > ROOT_MAX_CHARS) break;
					continue;
				}
				open = buf.slice(0, m.index + m[0].length);
				close = `</${m[1] ?? ""}multistatus>`;
				buf = buf.slice(m.index + m[0].length);
			}
			let lastEnd = 0;
			RESPONSE_END.lastIndex = 0;
			for (let m = RESPONSE_END.exec(buf); m; m = RESPONSE_END.exec(buf)) lastEnd = m.index + m[0].length;
			if (lastEnd > 0) {
				const rs = parseMultistatus(`${open}${buf.slice(0, lastEnd)}${close}`);
				buf = buf.slice(lastEnd);
				if (onBatch(rs) === false) break;
			}
			if (read > o.maxChars) break;
		}
	} catch (e) {
		// A dead credential can't show up here (the status was read above); anything else while the
		// body is read means the answer is incomplete, which the caller says.
		if (isToolError(e) && e.code === "reconnect_required") throw e;
		complete = false;
	} finally {
		if (complete) reader.releaseLock();
		else await reader.cancel().catch(() => undefined);
	}
	return { complete };
}
