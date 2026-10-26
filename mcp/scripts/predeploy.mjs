#!/usr/bin/env node
// The deploy guard (DESIGN 16.2 and 19). `npm run deploy` runs this file with --deploy, and only this
// file starts `wrangler deploy`, with fixed arguments, so no --env can slip through.
//
//   node scripts/predeploy.mjs --bundle-only   checks the production config and bundle (part of npm test)
//   node scripts/predeploy.mjs --deploy        the unit tests and the typecheck first, then the
//                                              same checks, the secret names, and the deploy
//
// It refuses: extra arguments; CLOUDFLARE_ENV; failing unit tests or typecheck (--deploy); workers_dev
// or preview_urls on; any route other than the owner's custom domain; DEV_ names in the top-level vars
// or the Worker's secrets; env.dev using the production KV namespace; a NOMAIL_TOOLS_URL the Worker
// can't use (it would hide the mail tools); and a bundle that still contains dev-only code (the marker
// string and the /dev/ routes).
//
// The build is stamped with the git commit (`--define __NX_BUILD__`), which /healthz shows.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const mode = args[0];
const fail = (msg) => {
	console.error(`predeploy: REFUSED: ${msg}`);
	process.exit(1);
};
const ok = (msg) => console.log(`predeploy: ok: ${msg}`);

if (mode !== "--bundle-only" && mode !== "--deploy") fail("use --bundle-only or --deploy");
if (args.length !== 1) fail(`unexpected arguments: ${args.slice(1).join(" ")} (deploy only the top-level config, never --env)`);
if (process.env.CLOUDFLARE_ENV) fail("CLOUDFLARE_ENV is set; deploy only the top-level config");

// A deploy ships only what passes the unit tests and the typecheck (fix round 3: `npm run deploy`
// used to skip them). --bundle-only is itself the last step of `npm test`, so it doesn't run them.
if (mode === "--deploy") {
	const steps = [
		["unit tests", [join(root, "node_modules", "vitest", "vitest.mjs"), "run"]],
		["typecheck", [join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit"]],
		["typecheck (tests)", [join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", "test"]],
		["typecheck (live tests)", [join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", "test/live"]],
	];
	for (const [what, argv] of steps) {
		const t = spawnSync(process.execPath, argv, { cwd: root, stdio: "inherit" });
		if (t.status !== 0) fail(`${what} failed; nothing was deployed`);
		ok(what);
	}
}

const wrangler = require(join(root, "node_modules", "wrangler"));
const cfg = wrangler.unstable_readConfig({ config: join(root, "wrangler.jsonc") });

if (cfg.name !== "nourax-workspace-mcp") fail(`unexpected Worker name ${cfg.name}`);
if (cfg.workers_dev !== false) fail("workers_dev must be false");
if (cfg.preview_urls !== false) fail("preview_urls must be false");
const routes = cfg.routes ?? [];
const routeOk =
	routes.length === 0 ||
	(routes.length === 1 && typeof routes[0] === "object" && routes[0].pattern === "mcp.nourax.org" && routes[0].custom_domain === true);
if (!routeOk) fail(`routes must be empty or exactly the custom domain mcp.nourax.org (got ${JSON.stringify(routes)})`);
if (cfg.define?.__NX_DEV_AUTH__ !== "false") fail("define __NX_DEV_AUTH__ must be \"false\" at the top level");
if (cfg.minify !== true) fail("minify must be true, so the dev-only branches are dropped");
const vars = cfg.vars ?? {};
if (vars.NX_ENV !== "production") fail("NX_ENV must be production");
if (vars.PUBLIC_ORIGIN !== "https://mcp.nourax.org") fail("PUBLIC_ORIGIN must be https://mcp.nourax.org");
const devVars = Object.keys(vars).filter((k) => k.startsWith("DEV_"));
if (devVars.length) fail(`DEV_ vars in the top-level config: ${devVars.join(", ")}`);
if ((cfg.compatibility_flags ?? []).includes("global_fetch_strictly_public")) fail("global_fetch_strictly_public must stay off (DESIGN 0.5)");
// The same rules as parseNomailUrl() in src/env.ts. At run time a bad value only hides the mail
// tools (and logs mail_setup_fault); here it stops the deploy, so the typo is seen at once.
const rawNomail = String(vars.NOMAIL_TOOLS_URL ?? "").trim();
if (rawNomail) {
	let u;
	try {
		u = new URL(rawNomail);
	} catch {
		fail("NOMAIL_TOOLS_URL is not a URL");
	}
	if (u.protocol !== "https:") fail("NOMAIL_TOOLS_URL must be https");
	const hosts = [new URL(String(vars.DRIVE_ORIGIN ?? "https://drive.nourax.org")).host, new URL(vars.PUBLIC_ORIGIN).host];
	if (hosts.includes(u.host)) fail("NOMAIL_TOOLS_URL must not be the drive or MCP host");
	if (u.search || u.hash || u.username || u.password || /[?#]/.test(rawNomail)) fail("NOMAIL_TOOLS_URL must be a plain base URL (no query, fragment or user name)");
	ok(`NOMAIL_TOOLS_URL is a plain https base URL on ${u.host}`);
}
const devCfg = wrangler.unstable_readConfig({ config: join(root, "wrangler.jsonc"), env: "dev" });
const prodKv = (cfg.kv_namespaces ?? []).find((k) => k.binding === "OAUTH_KV");
const devKv = (devCfg.kv_namespaces ?? []).find((k) => k.binding === "OAUTH_KV");
if (!prodKv?.id) fail("OAUTH_KV has no id at the top level");
if (!devKv?.id || devKv.id === prodKv.id || devKv.preview_id === prodKv.id || prodKv.preview_id === prodKv.id) {
	fail("env.dev (and preview_id) must use their own OAUTH_KV namespace, never the production one");
}
if (cfg.observability?.logs?.invocation_logs !== false || cfg.observability?.traces?.enabled !== false || cfg.observability?.redact_query_string !== true) {
	fail("observability must keep invocation logs and traces off and redact query strings");
}
ok("config: workers_dev off, previews off, routes " + (routes.length ? "custom domain only" : "none") + ", no DEV_ vars, dev KV separate");

// The build id: the commit, plus "-dirty" when mcp/ has uncommitted or untracked changes.
function buildId() {
	try {
		const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		const dirty = execFileSync("git", ["status", "--porcelain", "--", "."], { cwd: root, encoding: "utf8" }).trim() !== "";
		if (!/^[0-9a-f]{12}$/.test(sha)) return null;
		return dirty ? `${sha}-dirty` : sha;
	} catch {
		return null;
	}
}
const build = buildId();
if (!build) fail("could not read the git commit for the build id");
const defineArgs = ["--define", `__NX_BUILD__:${JSON.stringify(build)}`];

// Build the production bundle exactly as a deploy would, and look for dev-only code.
const out = mkdtempSync(join(tmpdir(), "nx-mcp-bundle-"));
try {
	const r = spawnSync(process.execPath, [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "deploy", "--dry-run", "--outdir", out, "--env=", ...defineArgs], {
		cwd: root,
		encoding: "utf8",
	});
	if (r.status !== 0) fail(`dry-run build failed:\n${r.stdout}\n${r.stderr}`);
	const file = join(out, "index.js");
	const js = readFileSync(file, "utf8");
	const markers = ["NX_DEV_AUTH_MARKER_7f3c", "/dev/token", "/dev/mock-nomail", "/dev/callback", "dev:client:v1", "dev_uid", "Dev only: QA account"];
	const found = markers.filter((m) => js.includes(m));
	if (found.length) fail(`dev-only code is in the production bundle: ${found.join(", ")}`);
	if (!js.includes(JSON.stringify(build))) fail("the build id is not in the bundle");
	const size = statSync(file).size;
	const gz = (r.stdout.match(/Total Upload: ([^\n]+)/) ?? [])[1] ?? "?";
	ok(`bundle has no dev-only code; build ${build}; ${(size / 1024).toFixed(1)} KiB (${gz})`);
} finally {
	rmSync(out, { recursive: true, force: true });
}

if (mode === "--deploy") {
	const s = spawnSync(process.execPath, [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "secret", "list", "--env=", "--format", "json"], {
		cwd: root,
		encoding: "utf8",
	});
	if (s.status === 0) {
		let names = [];
		try {
			names = JSON.parse(s.stdout).map((x) => x.name);
		} catch {
			fail("could not read the secret names");
		}
		const dev = names.filter((n) => n.startsWith("DEV_"));
		if (dev.length) fail(`DEV_ secrets on the production Worker: ${dev.join(", ")}`);
		for (const need of ["NX_SECRET", "NX_REVOKE_SECRET"]) if (!names.includes(need)) fail(`secret ${need} is not set`);
		ok(`secrets: ${names.join(", ")} (names only)`);
	} else if (!/not found|does not exist|10007/i.test(`${s.stdout}${s.stderr}`)) {
		fail(`could not list secrets:\n${s.stderr}`);
	} else {
		ok("no Worker yet; secrets are set after the first upload");
	}
	const d = spawnSync(process.execPath, [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "deploy", "--env=", ...defineArgs], { cwd: root, stdio: "inherit" });
	process.exit(d.status ?? 1);
}
