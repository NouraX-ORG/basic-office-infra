import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Unit, protocol and contract tests run inside workerd with the dev environment's bindings.
// Outbound calls go through src/core/egress.ts and are answered by test/fake-nc (a spy on fetch).
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc", environment: "dev" },
			miniflare: {
				bindings: {
					NX_SECRET: "test-nx-secret-0123456789abcdef0123456789abcdef",
					NX_REVOKE_SECRET: "test-nx-revoke-secret-0123456789abcdef0123456789",
					// Fake QA accounts known to test/fake-nc; never real credentials.
					DEV_QA_ACCOUNTS: JSON.stringify({
						"qa-t1-91": "FAKEAPPPASS-qa-t1-91-0123456789abcdef",
						"qa-t1-92": "FAKEAPPPASS-qa-t1-92-0123456789abcdef",
					}),
				},
			},
		}),
	],
	define: { __NX_DEV_AUTH__: "true" },
	test: {
		include: ["test/**/*.test.ts"],
		exclude: ["test/live/**"],
		// Under the full run about a hundred workerd isolates start at once, and tests that make many
		// calls through the whole Worker came close to 20 s (fix round 3); 45 s leaves room for load
		// while a real hang still fails.
		testTimeout: 45000,
	},
});
