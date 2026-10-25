// Reference implementation of upload-ticket minting, for tests and for NoMail's Edge Function.
// The function below uses only WebCrypto, so it runs unchanged in Deno (Supabase) and Node 20+.
//
// CLI (used by tests/worker-local.sh):
//   node tools/mint-ticket.mjs <key-file> <uid> <login> <app-password-file> <path> <size> [chunk] [upload-id]
// <key-file> "-" reads the key from stdin, so it can be piped from the server without a file.
// Prints the ticket on stdout. Never log it: it is a bearer credential for one upload.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";

const AAD = new TextEncoder().encode("nodrive-upload-v1");

function b64url(bytes) {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromB64url(text) {
	const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/**
 * @param {string} keyB64url  DRIVE_UPLOAD_TICKET_KEY (32 bytes, base64url)
 * @param {{uid:string, login:string, pass:string, path:string, size:number, chunk?:number,
 *          upload?:string, ttlSeconds?:number, mtime?:number}} f
 */
export async function mintUploadTicket(keyB64url, f) {
	const key = await crypto.subtle.importKey("raw", fromB64url(keyB64url.trim()), { name: "AES-GCM" }, false, ["encrypt"]);
	const ticket = {
		v: 1,
		uid: f.uid,
		login: f.login,
		pass: f.pass,
		path: f.path,
		size: f.size,
		chunk: f.chunk ?? 50 * 1024 * 1024,
		upload: f.upload ?? `nomail-${crypto.randomUUID()}`,
		exp: Math.floor(Date.now() / 1000) + (f.ttlSeconds ?? 6 * 3600),
		...(f.mtime === undefined ? {} : { mtime: f.mtime }),
	};
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, new TextEncoder().encode(JSON.stringify(ticket))),
	);
	const out = new Uint8Array(12 + sealed.length);
	out.set(iv);
	out.set(sealed, 12);
	return `v1.${b64url(out)}`;
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` || process.argv[1]?.endsWith("mint-ticket.mjs")) {
	const [keyFile, uid, login, passFile, path, size, chunk, upload] = process.argv.slice(2);
	if (!keyFile || !uid || !login || !passFile || !path || !size) {
		console.error("usage: mint-ticket.mjs <key-file> <uid> <login> <app-password-file> <path> <size> [chunk] [upload-id]");
		process.exit(2);
	}
	const ticket = await mintUploadTicket(readFileSync(keyFile === "-" ? 0 : keyFile, "utf8"), {
		uid,
		login,
		pass: readFileSync(passFile, "utf8").trim(),
		path,
		size: Number(size),
		chunk: chunk ? Number(chunk) : undefined,
		upload: upload || undefined,
	});
	process.stdout.write(ticket);
}
