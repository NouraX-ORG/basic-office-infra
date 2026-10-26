/**
 * Conversions through the ONLYOFFICE connector's own downloadas route, as the person (DESIGN 12.5).
 * The connector checks the person's access and calls the converter over the Docker network, so WAF
 * rule 2 stays as it is and no ONLYOFFICE path is opened. A failed conversion comes back as HTTP 200
 * with an HTML page, so the answer is checked by content type and magic bytes.
 */
import { ToolError } from "../core/errors";
import { LIMITS } from "../core/limits";
import type { NcClient } from "./client";

const ZIP_TARGETS = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp"]);
const TEXT_TARGETS = new Set(["txt", "csv"]);

function looksRight(ext: string, bytes: Uint8Array, contentType: string): boolean {
	const ct = contentType.toLowerCase();
	if (ct.includes("text/html")) return false;
	if (ext === "pdf") return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
	if (ZIP_TARGETS.has(ext)) return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
	if (TEXT_TARGETS.has(ext)) {
		try {
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
		} catch {
			return false;
		}
		const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
		return !head.startsWith("<!doctype html") && !head.startsWith("<html");
	}
	return false;
}

/** Converts the file with `fileId` (from our own PROPFIND, never from the client) to `ext`. */
export async function officeConvert(nc: NcClient, fileId: number, ext: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<Uint8Array> {
	if (!Number.isSafeInteger(fileId) || fileId <= 0) throw new ToolError("invalid_input", "The file id isn't valid.");
	if (!/^[a-z0-9]{2,5}$/.test(ext)) throw new ToolError("invalid_input", "That target format isn't supported.");
	const slot = nc.convertSlot ? await nc.convertSlot() : null;
	try {
		const qs = new URLSearchParams({ fileId: String(fileId), toExtension: ext });
		const res = await nc.request("GET", `/index.php/apps/onlyoffice/downloadas?${qs.toString()}`, {
			timeoutMs: opts.timeoutMs ?? LIMITS.convertTimeoutMs,
			// One try only: a retry after a 502/503/504 could double a 40 s wait past the tool budget.
			noRetry: true,
		});
		if (res.status !== 200) {
			await res.body?.cancel();
			throw new ToolError("unsupported_type", "That file couldn't be converted.");
		}
		const bytes = await nc.readBytes(res, opts.maxBytes ?? LIMITS.convertBytes);
		if (!looksRight(ext, bytes, res.headers.get("content-type") ?? "")) {
			throw new ToolError("unsupported_type", "That file couldn't be converted.");
		}
		return bytes;
	} finally {
		await slot?.release();
	}
}
