/**
 * The live runner (DESIGN 17.6): starts `wrangler dev --env dev` on 127.0.0.1:8787 with the dev env
 * file from the scratchpad (NX_DEV_ENV_FILE, never in the repo), waits for /healthz, and stops it at
 * the end. If something already answers on :8787 (a dev server you started yourself), it is used.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BASE = "http://localhost:8787";
let child: ChildProcess | null = null;

async function up(): Promise<boolean> {
	try {
		const r = await fetch(`${BASE}/healthz`);
		return r.ok;
	} catch {
		return false;
	}
}

export async function setup(): Promise<void> {
	if (await up()) return;
	const envFile = process.env.NX_DEV_ENV_FILE;
	if (!envFile || !existsSync(envFile)) throw new Error("Set NX_DEV_ENV_FILE to the dev env file in the scratchpad (DESIGN 16.3).");
	const root = process.cwd();
	child = spawn(process.execPath, [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "dev", "--env", "dev", "--ip", "127.0.0.1", "--port", "8787", "--env-file", envFile, "--show-interactive-dev-session=false"], {
		cwd: root,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
	});
	child.stdout?.on("data", () => undefined);
	child.stderr?.on("data", () => undefined);
	const started = Date.now();
	while (Date.now() - started < 120_000) {
		if (await up()) return;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error("wrangler dev didn't start on :8787 within two minutes");
}

export async function teardown(): Promise<void> {
	if (!child?.pid) return;
	if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	else child.kill("SIGTERM");
}
