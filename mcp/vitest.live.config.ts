import { defineConfig } from "vitest/config";

// Live integration tests (DESIGN 17.6): never part of `npm test`.
// They start `wrangler dev --env dev` on 127.0.0.1:8787 against drive.nourax.org as QA accounts.
// NX_DEV_ENV_FILE must name the dev env file in the scratchpad (never in the repo).
export default defineConfig({
	test: {
		include: ["test/live/**/*.live.test.ts"],
		globalSetup: ["test/live/_shared/global-setup.ts"],
		testTimeout: 120000,
		hookTimeout: 180000,
		fileParallelism: false,
	},
});
