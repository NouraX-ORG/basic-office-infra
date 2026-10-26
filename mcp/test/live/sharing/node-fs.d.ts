/** The one extra Node API lane B's live helper uses (reading the dev env file), next to core's shim. */
declare module "node:fs" {
	export function readFileSync(path: string, encoding: "utf8"): string;
}
