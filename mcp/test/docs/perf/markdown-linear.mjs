/**
 * A Node wall-clock check that the Markdown parser is linear on inputs of many short lines
 * (DESIGN 12.2, fix round 3). It is NOT part of `npm test`: vitest runs inside workerd, whose clock
 * only moves across I/O, so it can't time CPU work; and it is a .mjs (not a .ts) so tsc doesn't
 * typecheck it, which lets Node strip the TypeScript types of the imported source at run time.
 *
 * Run it directly (Node 24):
 *   node test/docs/perf/markdown-linear.mjs
 *
 * Before the fix, a 200,000-line paragraph took about 11.5 s (quadratic: tokenize read the end of a
 * growing rope string on every "\n"); after it, well under a tenth of a second.
 */
import { parseMarkdown } from "../../../src/docs/markdown.ts";

const CASES = [
	{ name: "paragraph of short lines", make: (n) => "a\n".repeat(n) },
	{ name: "lazy list item", make: (n) => `- a\n${"b\n".repeat(n - 1)}` },
	{ name: "block quote", make: (n) => "> a\n".repeat(n) },
	{ name: "CRLF line endings", make: (n) => "a\r\n".repeat(n) },
	{ name: "400,000 characters, half of them newlines", make: () => "a\n".repeat(200_000) },
];

const SIZES = [25_000, 50_000, 100_000, 200_000];

const time = (fn) => {
	const t = performance.now();
	fn();
	return performance.now() - t;
};

let failed = false;
for (const { name, make } of CASES) {
	const times = {};
	for (const n of SIZES) {
		const input = make(n);
		parseMarkdown(input); // warm the JIT, then measure
		times[n] = time(() => parseMarkdown(input));
	}
	const row = SIZES.map((n) => `${n.toLocaleString("en-GB")}: ${times[n].toFixed(0)} ms`).join("  ");
	// Four times the input should take roughly four times as long, not sixteen (quadratic).
	const ratio = times[200_000] / Math.max(1, times[50_000]);
	const ok = ratio < 8 && times[200_000] < 3_000;
	if (!ok) failed = true;
	console.log(`${ok ? "OK  " : "FAIL"} ${name.padEnd(42)} ${row}  (x4 input -> x${ratio.toFixed(1)})`);
}

if (failed) {
	console.error("\nThe parser is not linear on many short lines (see the FAIL rows above).");
	process.exit(1);
}
console.log("\nLinear on every case.");
