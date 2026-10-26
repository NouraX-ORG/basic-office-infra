/** The one more Node API lane G's live helpers use (core's shim declares the rest; no @types/node). */
declare module "node:fs" {
	export function readFileSync(path: string, encoding: "utf8"): string;
}
