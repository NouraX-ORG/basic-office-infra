/**
 * The fake world for lane B's sharing tests: QA a (qa-t1-91) and QA b (qa-t1-92) in organisation
 * "Acme" and team "Sales"; qa-t1-93 in another organisation; an admin group holding QA a too (it
 * must never count). QA a owns /Projects, /Projects/plan.docx and /report.pdf, and can see
 * /Received (shared with them without the right to share it on).
 */
import { vi } from "vitest";
import type { FakeNc } from "../../fake-nc/index";
import { type FakeSharing, installSharing } from "../../fake-nc/sharing";
import { fakeWithQa, QA } from "../../helpers/index";

export const C = "qa-t1-93";

export interface World {
	fake: FakeNc;
	sh: FakeSharing;
}

const REAL_NOW = Date.now();
let dayShift = 0;

/**
 * Each test starts on its own day (two days after the previous one), so the vault's exact
 * per-person limits (share: 10 a minute, 30 a day) start from zero as they would for a person.
 * Only Date is faked; timers stay real.
 */
export function freshDay(): void {
	vi.useFakeTimers({ toFake: ["Date"] });
	dayShift += 2;
	vi.setSystemTime(REAL_NOW + dayShift * 86_400_000);
}

export function world(): World {
	vi.restoreAllMocks();
	freshDay();
	const fake = fakeWithQa();
	fake.addUser({ uid: C, password: "FAKEAPPPASS-qa-t1-93-0123456789abcdef", displayName: "Carol Other", email: "carol@example.invalid" });
	const sh = installSharing(fake);
	sh.addGroup("org:acme", "Acme", [QA.a, QA.b]);
	sh.addGroup("team:sales", "Team: Sales", [QA.a, QA.b]);
	sh.addGroup("org:other", "Other Org", [C]);
	sh.addGroup("admin", "admin", [QA.a, C]);
	sh.addNode(QA.a, "/Projects", "folder");
	sh.addNode(QA.a, "/Projects/plan.docx", "file");
	sh.addNode(QA.a, "/report.pdf", "file");
	sh.addNode(QA.a, "/Received", "folder", "GDNVCK");
	sh.addNode(QA.b, "/Notes", "folder");
	return { fake, sh };
}

/** The drive calls made to one path (with method), for checking exact requests. */
export function callsTo(fake: FakeNc, method: string, path: RegExp) {
	return fake.driveCalls().filter((r) => r.method === method && path.test(r.url.pathname));
}

export function daysFromToday(n: number): string {
	const t = new Date();
	const d = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) + n * 86_400_000;
	return new Date(d).toISOString().slice(0, 10);
}
