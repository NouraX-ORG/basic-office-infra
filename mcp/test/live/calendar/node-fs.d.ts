/** Lane D's live setup reads the dev env file (never in the repo); core's shim has no readFileSync. */
declare module "node:fs" {
	export function readFileSync(path: string, encoding: "utf8"): string;
}
