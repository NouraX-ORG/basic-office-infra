/**
 * An in-memory NoDrive emulator for contract tests (DESIGN 17.3). It answers the requests our
 * egress module sends (installed as a spy on globalThis.fetch) and records every one of them, so a
 * test can check the exact method, URL, headers and body.
 *
 * Core provides the router and the core endpoints (test/fake-nc/core.ts). Each lane adds its own
 * domain in its own file (files.ts, sharing.ts, caldav.ts, carddav.ts, deck.ts, office.ts) with
 * fake.on(method, pathRegex, handler).
 */
import { vi } from "vitest";
import { installCore } from "./core";

export const DRIVE = "https://drive.nourax.org";
export const SUPABASE = "https://tbwrezvhgoryzycjerrl.supabase.co";

export interface FakeUser {
	uid: string;
	displayName: string;
	email: string | null;
	groups: string[];
	passwords: Set<string>;
	quota: { used: number; free: number; total: number; relative: number; quota: number };
	timezone?: string;
	language?: string;
}

export interface Recorded {
	method: string;
	url: URL;
	headers: Headers;
	body: string;
	/** The uid whose Basic credential was valid, if any. */
	auth: string | null;
}

export type Handler = (req: Recorded, fake: FakeNc, match: RegExpExecArray) => Response | Promise<Response>;

interface Route {
	method: string;
	host: string;
	path: RegExp;
	handler: Handler;
}

export function ocs(data: unknown, status = 200, message = "OK"): Response {
	return new Response(JSON.stringify({ ocs: { meta: { status: status < 300 ? "ok" : "failure", statuscode: status, message }, data } }), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

export class FakeNc {
	users = new Map<string, FakeUser>();
	requests: Recorded[] = [];
	routes: Route[] = [];
	/** Login Flow v2: poll token to flow. */
	flows = new Map<string, { loginToken: string; userAgent: string; granted?: { uid: string; appPassword: string }; done?: boolean }>();
	capabilities: Record<string, unknown> = {
		core: { webdav: "remote.php/webdav" },
		files: { undelete: true, versioning: true, file_conversions: [] },
		files_sharing: { api_enabled: true, public: { enabled: true } },
		deck: { version: "1.19.1", canCreateBoards: true, apiVersions: ["1.0", "1.1"] },
	};
	providers: { id: string; name: string }[] = [
		{ id: "files", name: "Files" },
		{ id: "fulltextsearch", name: "Search inside files" },
	];
	navigation: { id: string; name: string }[] = [
		{ id: "files", name: "Files" },
		{ id: "calendar", name: "Calendar" },
		{ id: "contacts", name: "Contacts" },
		{ id: "deck", name: "Deck" },
	];
	private counter = 0;

	constructor() {
		installCore(this);
	}

	addUser(u: Partial<FakeUser> & { uid: string; password: string }): FakeUser {
		const user: FakeUser = {
			uid: u.uid,
			displayName: u.displayName ?? `Person ${u.uid.slice(0, 6)}`,
			email: u.email ?? null,
			groups: u.groups ?? [],
			passwords: new Set([u.password]),
			quota: u.quota ?? { used: 1024, free: 1024 * 1024 * 1024, total: 1024 * 1024 * 1024 + 1024, relative: 0, quota: 1024 * 1024 * 1024 + 1024 },
			...(u.timezone ? { timezone: u.timezone } : {}),
			...(u.language ? { language: u.language } : {}),
		};
		this.users.set(user.uid, user);
		return user;
	}

	/** Lanes add routes for their domain. Host defaults to the drive host. */
	on(method: string, path: RegExp, handler: Handler, host = new URL(DRIVE).host): void {
		this.routes.unshift({ method: method.toUpperCase(), host, path, handler });
	}

	newSecret(prefix: string): string {
		this.counter++;
		return `${prefix}${this.counter.toString().padStart(4, "0")}${"x".repeat(60)}`.slice(0, 72);
	}

	/** Simulates the person clicking "Grant access" for a Login Flow v2 login token. */
	grantFlow(loginToken: string, uid: string): string {
		for (const f of this.flows.values()) {
			if (f.loginToken === loginToken) {
				const pass = this.newSecret("APPPASS");
				this.users.get(uid)?.passwords.add(pass);
				f.granted = { uid, appPassword: pass };
				return pass;
			}
		}
		throw new Error("no such flow");
	}

	authOf(headers: Headers): string | null {
		const a = headers.get("authorization");
		if (!a?.startsWith("Basic ")) return null;
		const dec = atob(a.slice(6));
		const i = dec.indexOf(":");
		const uid = dec.slice(0, i);
		const pass = dec.slice(i + 1);
		const u = this.users.get(uid);
		return u?.passwords.has(pass) ? uid : null;
	}

	revokePassword(headers: Headers): boolean {
		const a = headers.get("authorization");
		if (!a?.startsWith("Basic ")) return false;
		const dec = atob(a.slice(6));
		const i = dec.indexOf(":");
		return this.users.get(dec.slice(0, i))?.passwords.delete(dec.slice(i + 1)) ?? false;
	}

	fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const req = new Request(input as RequestInfo, init);
		const url = new URL(req.url);
		const body = req.body ? new TextDecoder().decode(await req.arrayBuffer()) : "";
		const rec: Recorded = { method: req.method.toUpperCase(), url, headers: req.headers, body, auth: this.authOf(req.headers) };
		this.requests.push(rec);
		for (const r of this.routes) {
			if (r.method !== rec.method || r.host !== url.host) continue;
			const m = r.path.exec(url.pathname);
			if (m) return this.abortable(Promise.resolve(r.handler(rec, this, m)), init?.signal ?? null);
		}
		return new Response(`fake-nc: no route for ${rec.method} ${url.host}${url.pathname}`, { status: 501 });
	};

	/**
	 * A handler's answer, or the abort of the caller's signal, whichever comes first, as a real fetch
	 * does (fix round 4: a handler that hangs shows the caller's own timeout).
	 */
	private abortable(answer: Promise<Response>, signal: AbortSignal | null): Promise<Response> {
		if (!signal) return answer;
		if (signal.aborted) return Promise.reject(signal.reason);
		return new Promise<Response>((resolve, reject) => {
			const onAbort = () => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			answer.then(
				(r) => {
					signal.removeEventListener("abort", onAbort);
					resolve(r);
				},
				(e) => {
					signal.removeEventListener("abort", onAbort);
					reject(e);
				},
			);
		});
	}

	install(): ReturnType<typeof vi.spyOn> {
		return vi.spyOn(globalThis, "fetch").mockImplementation(this.fetch as typeof fetch);
	}

	/** Requests to the drive host only, without the Login Flow and status calls. */
	driveCalls(): Recorded[] {
		return this.requests.filter((r) => r.url.host === new URL(DRIVE).host);
	}
}
