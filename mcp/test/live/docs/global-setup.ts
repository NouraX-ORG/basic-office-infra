/**
 * Lane C's live runner: starts `wrangler dev --env dev` on 127.0.0.1:NX_LIVE_PORT (default 8820)
 * with the dev env file from the scratchpad (NX_DEV_ENV_FILE; it must set PUBLIC_ORIGIN to the same
 * port), a local state folder of its own (NX_LIVE_STATE, a new subfolder per run so the per-person
 * limits start from zero) and its own inspector port. Stops it at the end. If something already
 * answers on the port, that server is used.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PORT = process.env.NX_LIVE_PORT ?? "8820";
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
	const envFile = process.env.NX_DEV_ENV_FILE;
	if (!envFile || !existsSync(envFile)) throw new Error("Set NX_DEV_ENV_FILE to the dev env file in the scratchpad (DESIGN 16.3).");
	const root = process.cwd();
	const args = [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "dev", "--env", "dev", "--ip", "127.0.0.1", "--port", PORT, "--inspector-port", String(Number(PORT) + 1000), "--env-file", envFile, "--show-interactive-dev-session=false"];
	// Lanes share one folder, and wrangler dev rebuilds (and restarts) whenever any source file
	// changes. NX_LIVE_SCRIPT names a dev bundle built beforehand
	// (`npx wrangler deploy --dry-run --env dev --outdir <dir>`, which deploys nothing); it is served
	// as it is, so other people's edits can't restart the server mid-run.
	if (process.env.NX_LIVE_SCRIPT) args.splice(2, 0, process.env.NX_LIVE_SCRIPT, "--no-bundle", "--config", join(root, "wrangler.jsonc"));
	if (process.env.NX_LIVE_STATE) args.push("--persist-to", join(process.env.NX_LIVE_STATE, new Date().toISOString().replace(/[-:.TZ]/g, "")));
	child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
	child.stdout?.on("data", () => undefined);
	child.stderr?.on("data", () => undefined);
	const started = Date.now();
	while (Date.now() - started < 150_000) {
		if (await up()) return;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`wrangler dev didn't start on :${PORT} within 150 seconds`);
}

export async function teardown(): Promise<void> {
	if (!child?.pid) return;
	if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	else child.kill("SIGTERM");
}
