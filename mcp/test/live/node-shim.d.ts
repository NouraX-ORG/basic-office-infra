/**
 * The few Node APIs the live runner uses, declared here so the pinned dependency list needs no
 * @types/node (DESIGN 3: lanes may not add dependencies).
 */
declare const process: {
	env: Record<string, string | undefined>;
	platform: string;
	execPath: string;
	cwd(): string;
};

declare module "node:child_process" {
	interface Readable {
		on(event: "data", cb: (chunk: unknown) => void): void;
	}
	export interface ChildProcess {
		pid?: number;
		stdout: Readable | null;
		stderr: Readable | null;
		kill(signal?: string): boolean;
	}
	export function spawn(cmd: string, args: string[], opts?: Record<string, unknown>): ChildProcess;
	export function spawnSync(cmd: string, args: string[], opts?: Record<string, unknown>): { status: number | null };
}

declare module "node:fs" {
	export function existsSync(path: string): boolean;
}

declare module "node:path" {
	export function join(...parts: string[]): string;
}
