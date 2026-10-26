import { defineConfig } from "vitest/config";

// Lane G's live tests (DESIGN 17.6 and 25), never part of `npm test`. Run from mcp/:
//   NX_G_ENV_FILE=<scratchpad>/g/dev.env NX_G_STATE_DIR=<scratchpad>/g/state \
//     npx vitest run --config test/live/gantt/vitest.g.config.ts
// They start `wrangler dev --env dev` on 127.0.0.1:8860 (or NX_G_PORT) and act as qa-t1-g-gantt-1 (organisation
// A), with qa-t1-g-gantt-3 (A) and qa-t1-g-gantt-2 (B) as the other people, against drive.nourax.org.
export default defineConfig({
	test: {
		include: ["test/live/gantt/**/*.live.test.ts"],
		globalSetup: ["test/live/gantt/global-setup-g.ts"],
		// The lane's own server; the clients default to the shared runner on :8787 otherwise.
		env: { NX_LIVE_BASE: process.env.NX_LIVE_BASE ?? `http://localhost:${process.env.NX_G_PORT ?? "8860"}` },
		testTimeout: 180000,
		hookTimeout: 180000,
		fileParallelism: false,
	},
});
