import { vi } from "vitest";
import { type Env, handle } from "../src/handler";
import { base64urlEncode, importTicketKey, sealTicket, type Ticket } from "../src/ticket";

export const MiB = 1024 * 1024;
export const KEY = base64urlEncode(new Uint8Array(32).map((_, i) => i + 1));

export const testEnv: Env = {
	ORIGIN_BASE: "https://drive.test",
	ALLOWED_ORIGINS: "https://mail.test",
	MAX_CHUNK_BYTES: String(50 * MiB),
	MAX_UPLOAD_BYTES: String(10 * 1024 * MiB),
	UPLOAD_TICKET_KEY: KEY,
};

export function ticketFor(overrides: Partial<Ticket> = {}): Ticket {
	return {
		v: 1,
		uid: "hammad",
		login: "hammad",
		pass: "app-password-0123456789",
		path: "/NoMail/Sent/2026-10/report.pdf",
		size: 12 * MiB,
		chunk: 5 * MiB,
		upload: "nomail-0123456789",
		exp: Math.floor(Date.now() / 1000) + 3600,
		...overrides,
	};
}

export async function sealed(overrides: Partial<Ticket> = {}, key = KEY): Promise<string> {
	return sealTicket(ticketFor(overrides), await importTicketKey(key));
}

export async function call(
	path: string,
	options: { method?: string; ticket?: string | null; origin?: string | null; body?: Uint8Array; env?: Env } = {},
): Promise<Response> {
	const headers = new Headers();
	const origin = options.origin === undefined ? "https://mail.test" : options.origin;
	if (origin !== null) headers.set("Origin", origin);
	const ticket = options.ticket === undefined ? await sealed() : options.ticket;
	if (ticket !== null) headers.set("X-Upload-Ticket", ticket);
	if (options.body !== undefined) headers.set("Content-Length", String(options.body.byteLength));
	const request = new Request(`https://drive.test/nomail-upload${path}`, {
		method: options.method ?? "GET",
		headers,
		body: options.body,
	});
	return handle(request, options.env ?? testEnv);
}

export interface UpstreamCall {
	method: string;
	url: string;
	headers: Headers;
	bodyLength: number;
}

/** Replaces outbound fetch (Nextcloud) with scripted replies, recording each request. */
export function mockDrive(replies: Array<Response | number>): UpstreamCall[] {
	const calls: UpstreamCall[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input as RequestInfo, init);
		const body = request.body ? await request.arrayBuffer() : new ArrayBuffer(0);
		calls.push({ method: request.method, url: request.url, headers: request.headers, bodyLength: body.byteLength });
		const next = replies.shift();
		if (next === undefined) throw new Error(`unexpected extra call: ${request.method} ${request.url}`);
		return typeof next === "number" ? new Response(null, { status: next }) : next;
	});
	return calls;
}

/** Multistatus shaped like Nextcloud 35's PROPFIND replies. */
export function multistatus(items: Array<Record<string, string>>): Response {
	const responses = items
		.map(
			(item) =>
				`<d:response><d:href>${item.href}</d:href><d:propstat><d:prop>` +
				Object.entries(item)
					.filter(([k]) => k !== "href")
					.map(([k, v]) => `<${k}>${v}</${k}>`)
					.join("") +
				`</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
		)
		.join("");
	return new Response(
		`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">${responses}</d:multistatus>`,
		{ status: 207, headers: { "Content-Type": "application/xml; charset=utf-8" } },
	);
}
