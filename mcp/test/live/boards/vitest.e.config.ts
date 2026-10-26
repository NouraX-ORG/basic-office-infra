import { defineConfig } from "vitest/config";

// Lane E's live tests (DESIGN 17.6), never part of `npm test`. Run from mcp/:
//   NX_E_ENV_FILE=<scratchpad>/dev8840.env npx vitest run --config test/live/boards/vitest.e.config.ts
// They start `wrangler dev --env dev` on 127.0.0.1:8840 and act as qa-t1-27 (and qa-t1-24 as the
// second person) against drive.nourax.org.
export default defineConfig({
	test: {
		include: ["test/live/boards/**/*.live.test.ts", "test/live/mail/**/*.live.test.ts"],
		globalSetup: ["test/live/boards/global-setup-e.ts"],
		// The lane's own server; the clients default to the shared runner on :8787 otherwise.
		env: { NX_LIVE_BASE: process.env.NX_LIVE_BASE ?? "http://localhost:8840" },
		testTimeout: 120000,
		hookTimeout: 180000,
		fileParallelism: false,
	},
});
