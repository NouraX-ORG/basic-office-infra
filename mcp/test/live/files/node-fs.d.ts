/** Lane A's live cases read a netrc file from the scratchpad (never in the repo); core's shim has no readFileSync. */
declare module "node:fs" {
	export function readFileSync(path: string, encoding: "utf8"): string;
}
