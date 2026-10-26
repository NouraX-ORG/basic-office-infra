import { defineConfig } from "vitest/config";

// Lane F's own live run (DESIGN 17.6) against a dev server it started itself, so it never starts or
// reuses the shared runner's server on :8787:
//   wrangler dev --env dev --ip 127.0.0.1 --port 8850 --env-file <scratchpad file> --persist-to <scratchpad dir>
//   NX_LIVE_BASE=http://localhost:8850 npx vitest run --config test/live/connections/vitest.lane-f.config.ts
// The shared `npm run test:live` picks up the same cases on :8787.
export default defineConfig({
	test: {
		include: ["test/live/connections/**/*.live.test.ts"],
		testTimeout: 120000,
		hookTimeout: 60000,
		fileParallelism: false,
	},
});
