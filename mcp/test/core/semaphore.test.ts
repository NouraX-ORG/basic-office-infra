/**
 * The NoDrive client's limit of 4 calls at once per tool call (DESIGN 14, 29.8). A finished call
 * hands its slot straight to the next waiter; before the fix, a caller arriving between the release
 * and the woken waiter's turn could take the slot as well, and max + 1 calls ran.
 */
import { describe, expect, it } from "vitest";
import { Semaphore } from "../../src/nc/client";

const ticks = async (n: number) => {
	for (let i = 0; i < n; i++) await Promise.resolve();
};

async function peakWith(max: number, lateAfterTicks: number): Promise<{ peak: number; sem: Semaphore }> {
	const sem = new Semaphore(max);
	let running = 0;
	let peak = 0;
	const work = async () => {
		running++;
		peak = Math.max(peak, running);
		await ticks(5);
		running--;
	};
	const releases: (() => void)[] = [];
	// Fill every slot with a call that waits to be released, and queue one more.
	const holders = Array.from({ length: max }, () =>
		sem.run(async () => {
			running++;
			peak = Math.max(peak, running);
			await new Promise<void>((r) => releases.push(r));
			running--;
		}),
	);
	const waiter = sem.run(work);
	await ticks(3);
	// One holder finishes; a new caller arrives a few microtasks later, around the hand-over.
	(releases.shift() as () => void)();
	await ticks(lateAfterTicks);
	const late = sem.run(work);
	for (const r of releases) r();
	await Promise.all([...holders, waiter, late]);
	return { peak, sem };
}

describe("Semaphore", () => {
	it("never runs more than max, wherever a new caller lands around a hand-over", async () => {
		for (const max of [1, 2, 4]) {
			for (let lateAfter = 0; lateAfter < 8; lateAfter++) {
				const { peak, sem } = await peakWith(max, lateAfter);
				expect(peak, `max ${max}, late after ${lateAfter} microtasks`).toBeLessThanOrEqual(max);
				expect(sem.running).toBe(0);
			}
		}
	});
	it("runs up to max at once and then queues, in order", async () => {
		const sem = new Semaphore(2);
		const order: number[] = [];
		const gates: (() => void)[] = [];
		const job = (n: number) =>
			sem.run(async () => {
				order.push(n);
				await new Promise<void>((r) => gates.push(r));
			});
		const all = [job(1), job(2), job(3), job(4)];
		await ticks(3);
		expect(order).toEqual([1, 2]);
		expect(sem.running).toBe(2);
		(gates.shift() as () => void)();
		await ticks(5);
		expect(order).toEqual([1, 2, 3]);
		expect(sem.running).toBe(2);
		while (gates.length) {
			(gates.shift() as () => void)();
			await ticks(5);
		}
		await Promise.all(all);
		expect(order).toEqual([1, 2, 3, 4]);
		expect(sem.running).toBe(0);
	});
	it("a call that throws still passes its slot on", async () => {
		const sem = new Semaphore(1);
		const failed = sem.run(async () => {
			throw new Error("boom");
		});
		const next = sem.run(async () => "ok");
		await expect(failed).rejects.toThrow("boom");
		await expect(next).resolves.toBe("ok");
		expect(sem.running).toBe(0);
	});
});
