import { defineConfig } from "vitest/config";

// Lane C's live cases (DESIGN 17.6), never part of `npm test`. Core's runner is fixed to :8787;
// lanes run side by side, so this one starts its own `wrangler dev --env dev` on 127.0.0.1:8820
// (NX_LIVE_PORT) with its own local state folder and inspector port. Run from mcp/:
//   NX_DEV_ENV_FILE=<scratchpad env file> npx vitest run --config test/live/docs/vitest.config.ts
// The same cases also run under core's vitest.live.config.ts (port 8787, NX_LIVE_PORT unset).
const port = process.env.NX_LIVE_PORT ?? "8820";
process.env.NX_LIVE_PORT = port;

export default defineConfig({
	test: {
		include: ["test/live/docs/**/*.live.test.ts"],
		globalSetup: ["test/live/docs/global-setup.ts"],
		env: { NX_LIVE_PORT: port },
		testTimeout: 300_000,
		hookTimeout: 180_000,
		fileParallelism: false,
	},
});
