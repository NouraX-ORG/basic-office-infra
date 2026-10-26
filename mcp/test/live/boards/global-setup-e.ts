/**
 * Lane E's live runner: starts `wrangler dev --env dev` on 127.0.0.1:8840 with lane E's env file
 * (NX_E_ENV_FILE; it sets PUBLIC_ORIGIN and NOMAIL_TOOLS_URL to :8840), waits for /healthz, and
 * stops it at the end. If something already answers on :8840, it is used.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PORT = "8840";
const BASE = `http://localhost:${PORT}`;
let child: ChildProcess | null = null;

async function up(): Promise<boolean> {
	try {
		return (await fetch(`${BASE}/healthz`)).ok;
	} catch {
		return false;
	}
}

export async function setup(): Promise<void> {
	if (await up()) return;
	const envFile = process.env.NX_E_ENV_FILE;
	if (!envFile || !existsSync(envFile)) throw new Error("Set NX_E_ENV_FILE to lane E's dev env file in the scratchpad (DESIGN 16.3).");
	const root = process.cwd();
	child = spawn(process.execPath, [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "dev", "--env", "dev", "--ip", "127.0.0.1", "--port", PORT, "--inspector-port", "9240", "--env-file", envFile, "--show-interactive-dev-session=false"], {
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
	throw new Error(`wrangler dev didn't start on :${PORT} within two minutes`);
}

export async function teardown(): Promise<void> {
	if (!child?.pid) return;
	if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	else child.kill("SIGTERM");
}
