#!/usr/bin/env node
// Prints the tool table for docs/mcp.md from the catalogue and the registry (lane F pastes it).
// Usage: node scripts/gen-tool-docs.mjs > /path/to/table.md
// SPDX-License-Identifier: AGPL-3.0-or-later

import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "nx-tool-docs-"));
const entry = join(out, "entry.ts");
const outfile = join(out, "docs.mjs");
const { writeFileSync } = await import("node:fs");
writeFileSync(
	entry,
	`export { CATALOG, annotationsFor, SCOPE_WORDS, APP_WORDS } from ${JSON.stringify(join(root, "src/mcp/catalog.ts"))};
export { TOOLS } from ${JSON.stringify(join(root, "src/tools/registry.ts"))};`,
);
try {
	await build({
		entryPoints: [entry],
		bundle: true,
		format: "esm",
		platform: "neutral",
		outfile,
		logLevel: "error",
		define: { __NX_DEV_AUTH__: "false" },
		external: ["cloudflare:workers", "node:*"],
		mainFields: ["module", "main"],
		conditions: ["workerd", "worker", "import"],
	});
	const m = await import(pathToFileURL(outfile).href);
	const built = new Map(m.TOOLS.map((t) => [t.name, t]));
	const hints = (c) => {
		const a = m.annotationsFor(c);
		return [a.readOnlyHint ? "read-only" : a.destructiveHint ? "changes or removes" : "adds", a.idempotentHint ? "idempotent" : "", a.openWorldHint ? "open world" : ""].filter(Boolean).join(", ");
	};
	const lines = [
		"| Tool | What it does | Needs | App | Kind | Built |",
		"|---|---|---|---|---|---|",
	];
	for (const c of m.CATALOG) {
		const t = built.get(c.name);
		const what = t ? t.description.replace(/\|/g, "\\|").split(". ")[0] + "." : "(not built yet)";
		lines.push(`| \`${c.name}\` | ${what} | ${m.SCOPE_WORDS[c.scope]} | ${c.app ? m.APP_WORDS[c.app] : "always on"} | ${hints(c)} | ${t ? "yes" : "no"} |`);
	}
	lines.push("", `${m.TOOLS.length} of ${m.CATALOG.length} tools built. Mail tools come from NoMail when it is connected.`);
	console.log(lines.join("\n"));
} finally {
	rmSync(out, { recursive: true, force: true });
}
