import { defineConfig } from "vitest/config";

// Lane B's own live run (DESIGN 17.6) against a dev server it starts itself on :8810, so it never
// starts or reuses the shared runner's server on :8787:
//   wrangler dev --env dev --ip 127.0.0.1 --port 8810 --inspector-port 9310
//     --var PUBLIC_ORIGIN:http://localhost:8810 --env-file <scratchpad file> --persist-to <scratchpad dir>
//   NX_DEV_ENV_FILE=<scratchpad file> NX_LIVE_BASE=http://localhost:8810 \
//     npx vitest run --config test/live/sharing/vitest.lane-b.config.ts
// The env file holds the dev secrets and DEV_QA_ACCOUNTS for qa-t1-211, -212 and -213 (made by
// test/live/sharing/qa-setup.sh); it is never in the repo.
export default defineConfig({
	test: {
		include: ["test/live/sharing/**/*.live.test.ts", "test/live/contacts/**/*.live.test.ts"],
		// The lane's own server; the helpers default to the shared runner on :8787 otherwise.
		env: { NX_LIVE_BASE: process.env.NX_LIVE_BASE ?? "http://localhost:8810" },
		testTimeout: 180000,
		hookTimeout: 60000,
		fileParallelism: false,
	},
});
