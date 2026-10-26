/**
 * Lane G's live runner: starts `wrangler dev --env dev` on 127.0.0.1:8860 (NX_G_PORT changes it,
 * when another lane's server holds that port) with lane G's env file (NX_G_ENV_FILE, in the
 * scratchpad, never in the repo; it holds the dev secrets and the three QA app passwords),
 * PUBLIC_ORIGIN at that port, the inspector 400 above it and, when NX_G_STATE_DIR is set, its own
 * local state folder, so it never shares Durable Object or KV files with the other lanes' servers.
 * Waits for /healthz and stops it at the end. A server already on the port is used only when it
 * knows lane G's QA account (another lane's server there is refused, never stopped).
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ME } from "./client-g";

const PORT = process.env.NX_G_PORT ?? "8860";
const BASE = `http://localhost:${PORT}`;
let child: ChildProcess | null = null;

async function up(): Promise<boolean> {
	try {
		return (await fetch(`${BASE}/healthz`)).ok;
	} catch {
		return false;
	}
}

/** Whether the server on the port is lane G's: its dev sign-in knows lane G's QA account. */
async function ours(): Promise<boolean> {
	const res = await fetch(`${BASE}/dev/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid: ME, scopes: ["workspace.read"] }) });
	await res.body?.cancel();
	return res.ok;
}

export async function setup(): Promise<void> {
	if (await up()) {
		if (await ours()) return;
		throw new Error(`Another server answers on :${PORT} and doesn't know ${ME}; set NX_G_PORT (and NX_LIVE_BASE) to a free port.`);
	}
	const envFile = process.env.NX_G_ENV_FILE;
	if (!envFile || !existsSync(envFile)) throw new Error("Set NX_G_ENV_FILE to lane G's dev env file in the scratchpad (DESIGN 16.3).");
	const root = process.cwd();
	const args = [
		join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
		"dev",
		"--env",
		"dev",
		"--ip",
		"127.0.0.1",
		"--port",
		PORT,
		"--inspector-port",
		String(Number(PORT) + 400),
		"--var",
		`PUBLIC_ORIGIN:${BASE}`,
		"--env-file",
		envFile,
		"--show-interactive-dev-session=false",
	];
	if (process.env.NX_G_STATE_DIR) args.push("--persist-to", process.env.NX_G_STATE_DIR);
	child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
	child.stdout?.on("data", () => undefined);
	child.stderr?.on("data", () => undefined);
	const started = Date.now();
	while (Date.now() - started < 150_000) {
		if (await up()) return;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`wrangler dev didn't start on :${PORT} within two and a half minutes`);
}

export async function teardown(): Promise<void> {
	if (!child?.pid) return;
	if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	else child.kill("SIGTERM");
}
