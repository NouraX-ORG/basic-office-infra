import { defineConfig } from "vitest/config";

// Lane D's own live run (DESIGN 17.6), against a `wrangler dev --env dev` that is already running
// at NX_LIVE_BASE (lane D used :8830 with --var PUBLIC_ORIGIN:http://localhost:8830 and its own
// --persist-to, so it never shares a port or local state with the other lanes). The integrator's
// run uses core's vitest.live.config.ts, which picks these files up as well.
export default defineConfig({
	test: {
		include: ["test/live/calendar/**/*.live.test.ts", "test/live/tasks/**/*.live.test.ts"],
		testTimeout: 120000,
		hookTimeout: 180000,
		fileParallelism: false,
	},
});
