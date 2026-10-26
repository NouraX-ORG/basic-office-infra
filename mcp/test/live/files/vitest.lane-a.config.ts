import { defineConfig } from "vitest/config";

// Lane A's own live run (DESIGN 17.6) against a dev server it started itself, so it never starts or
// reuses the shared runner's server on :8787:
//   wrangler dev --env dev --ip 127.0.0.1 --port 8800 --env-file <scratchpad file> --persist-to <scratchpad dir>
//   NX_LIVE_BASE=http://localhost:8800 npx vitest run --config test/live/files/vitest.lane-a.config.ts
// The env file sets PUBLIC_ORIGIN=http://localhost:8800 (env-file values override vars in local dev).
// The shared `npm run test:live` picks up the same cases on :8787.
export default defineConfig({
	test: {
		include: ["test/live/files/**/*.live.test.ts"],
		testTimeout: 180000,
		hookTimeout: 60000,
		fileParallelism: false,
	},
});
