import { describe, expect, it } from "vitest";
import { base64urlEncode, expectedChunkLength, importTicketKey, openTicket, sealTicket, TicketError } from "../src/ticket";
import { KEY, MiB, ticketFor } from "./helpers";

const limits = { maxChunk: 50 * MiB, maxBytes: 10 * 1024 * MiB };

describe("upload tickets", () => {
	it("round-trips a sealed ticket", async () => {
		const key = await importTicketKey(KEY);
		const text = await sealTicket(ticketFor(), key);
		expect(text.startsWith("v1.")).toBe(true);
		expect(text).not.toContain("app-password");
		expect(await openTicket(text, key, limits)).toEqual(ticketFor({ exp: (await openTicket(text, key, limits)).exp }));
	});

	it("rejects a ticket sealed with another key", async () => {
		const other = base64urlEncode(new Uint8Array(32).fill(9));
		const text = await sealTicket(ticketFor(), await importTicketKey(other));
		await expect(openTicket(text, await importTicketKey(KEY), limits)).rejects.toThrow("not valid");
	});

	it("rejects a tampered ticket", async () => {
		const key = await importTicketKey(KEY);
		const text = await sealTicket(ticketFor(), key);
		const flipped = text.slice(0, -2) + (text.endsWith("A") ? "BB" : "AA");
		await expect(openTicket(flipped, key, limits)).rejects.toBeInstanceOf(TicketError);
	});

	it("rejects expired and over-long tickets", async () => {
		const key = await importTicketKey(KEY);
		const now = Math.floor(Date.now() / 1000);
		await expect(openTicket(await sealTicket(ticketFor({ exp: now - 1 }), key), key, limits)).rejects.toThrow("expired");
		await expect(openTicket(await sealTicket(ticketFor({ exp: now + 25 * 3600 }), key), key, limits)).rejects.toThrow("24 hours");
	});

	it.each([
		["/Documents/x.pdf", "must start with /NoMail/"],
		["/NoMail/../Documents/x.pdf", "'..'"],
		["/NoMail//x.pdf", "empty"],
		["/NoMail/", "empty"],
		["/NoMail/a\\b.pdf", "backslash"],
	])("refuses the path %s", async (path, message) => {
		const key = await importTicketKey(KEY);
		await expect(openTicket(await sealTicket(ticketFor({ path }), key), key, limits)).rejects.toThrow(message);
	});

	it("enforces chunk and file size limits", async () => {
		const key = await importTicketKey(KEY);
		await expect(openTicket(await sealTicket(ticketFor({ chunk: 4 * MiB }), key), key, limits)).rejects.toThrow("chunk size");
		await expect(openTicket(await sealTicket(ticketFor({ chunk: 51 * MiB }), key), key, limits)).rejects.toThrow("chunk size");
		await expect(openTicket(await sealTicket(ticketFor({ size: 11 * 1024 * MiB }), key), key, limits)).rejects.toThrow("file size");
	});

	it("refuses a missing key secret", async () => {
		await expect(importTicketKey(undefined)).rejects.toThrow("not set");
		await expect(importTicketKey("short")).rejects.toThrow("32 bytes");
	});
});

describe("chunk lengths (R2 needs equal parts)", () => {
	it("gives every chunk but the last the full size", () => {
		const t = { size: 12 * MiB, chunk: 5 * MiB };
		expect(expectedChunkLength(t, 1)).toBe(5 * MiB);
		expect(expectedChunkLength(t, 2)).toBe(5 * MiB);
		expect(expectedChunkLength(t, 3)).toBe(2 * MiB);
		expect(expectedChunkLength(t, 4)).toBeNull();
		expect(expectedChunkLength(t, 0)).toBeNull();
	});

	it("handles an exact multiple and a single small chunk", () => {
		expect(expectedChunkLength({ size: 10 * MiB, chunk: 5 * MiB }, 2)).toBe(5 * MiB);
		expect(expectedChunkLength({ size: 1000, chunk: 5 * MiB }, 1)).toBe(1000);
	});
});
