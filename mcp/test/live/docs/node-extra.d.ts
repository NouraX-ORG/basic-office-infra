/** The extra Node APIs lane C's live runner uses (merged with test/live/node-shim.d.ts). */
declare module "node:fs" {
	export function readFileSync(path: string, encoding: "utf8"): string;
	export function writeFileSync(path: string, data: Uint8Array | string): void;
	export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
}
