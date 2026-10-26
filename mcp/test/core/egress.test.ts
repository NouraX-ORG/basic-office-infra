import { describe, expect, it } from "vitest";
import { config } from "../../src/env";
import { checkEgress, EgressDenied, RULES } from "../../src/core/egress";
import { taskListBody } from "../../src/tools/tasks/new-list";
import { env } from "../helpers/index";

const UID = "5224252b-4938-4a86-a276-54bbae5d5b49";
const D = "https://drive.nourax.org";
const cfg = () => config(env);
const ok = (url: string, method: string, headers: Record<string, string> = {}, body?: string) =>
	checkEgress(cfg(), url, { method, headers, ...(body !== undefined ? { body } : {}) }, UID);
const denied = (url: string, method: string, headers: Record<string, string> = {}, body?: string, uid: string | undefined = UID) => {
	try {
		checkEgress(cfg(), url, { method, headers, ...(body !== undefined ? { body } : {}) }, uid);
		return false;
	} catch (e) {
		return e instanceof EgressDenied;
	}
};

const search = (href: string) =>
	`<?xml version="1.0"?><d:searchrequest xmlns:d="DAV:"><d:basicsearch><d:select><d:prop><d:getetag/></d:prop></d:select><d:from><d:scope><d:href>${href}</d:href><d:depth>infinity</d:depth></d:scope></d:from><d:where/></d:basicsearch></d:searchrequest>`;

describe("egress allowlist: allowed rows", () => {
	it.each([
		[`${D}/remote.php/dav/files/${UID}/`, "PROPFIND"],
		[`${D}/remote.php/dav/files/${UID}/A/b.txt`, "GET"],
		[`${D}/remote.php/dav/files/${UID}/A/b.txt`, "PUT"],
		[`${D}/remote.php/dav/files/${UID}/A`, "MKCOL"],
		[`${D}/remote.php/dav/files/${UID}/A/b.txt`, "DELETE"],
		[`${D}/remote.php/dav/files/${UID}/A/b.txt`, "PROPPATCH"],
		[`${D}/remote.php/dav/trashbin/${UID}/trash/`, "PROPFIND"],
		[`${D}/remote.php/dav/versions/${UID}/versions/123/`, "PROPFIND"],
		[`${D}/remote.php/dav/calendars/${UID}/`, "PROPFIND"],
		[`${D}/remote.php/dav/calendars/${UID}/personal/`, "REPORT"],
		[`${D}/remote.php/dav/calendars/${UID}/personal/abc.ics`, "PUT"],
		[`${D}/remote.php/dav/calendars/${UID}/personal/abc.ics`, "DELETE"],
		[`${D}/remote.php/dav/addressbooks/users/${UID}/contacts/`, "REPORT"],
		[`${D}/remote.php/dav/addressbooks/users/${UID}/contacts/x.vcf`, "PUT"],
		[`${D}/remote.php/dav/principals/users/${UID}/`, "PROPFIND"],
		[`${D}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`, "GET"],
		[`${D}/ocs/v2.php/apps/files_sharing/api/v1/shares/42?format=json`, "DELETE"],
		[`${D}/ocs/v2.php/apps/files_sharing/api/v1/sharees?search=a&format=json`, "GET"],
		[`${D}/ocs/v2.php/search/providers?format=json`, "GET"],
		[`${D}/ocs/v2.php/search/providers/fulltextsearch/search?term=x&format=json`, "GET"],
		[`${D}/ocs/v2.php/cloud/user?format=json`, "GET"],
		[`${D}/ocs/v2.php/cloud/capabilities?format=json`, "GET"],
		[`${D}/ocs/v2.php/core/navigation/apps?format=json`, "GET"],
		[`${D}/ocs/v2.php/core/apppassword?format=json`, "DELETE"],
		[`${D}/index.php/apps/deck/api/v1.0/boards`, "GET"],
		[`${D}/index.php/apps/deck/api/v1.0/boards/3/stacks/4/cards`, "POST"],
		[`${D}/ocs/v2.php/apps/deck/api/v1.0/cards/9/comments?format=json`, "POST"],
		[`${D}/ocs/v2.php/apps/deck/api/v1.0/cards/9/reorder?format=json`, "PUT"],
		[`${D}/index.php/apps/onlyoffice/downloadas?fileId=5&toExtension=pdf`, "GET"],
		[`${D}/index.php/apps/files/api/v1/recent/`, "GET"],
		[`${D}/index.php/login/v2`, "POST"],
		[`${D}/login/v2/poll`, "POST"],
		[`${D}/status.php`, "GET"],
		["https://tbwrezvhgoryzycjerrl.supabase.co/auth/v1/oauth/token", "POST"],
		["https://tbwrezvhgoryzycjerrl.supabase.co/auth/v1/.well-known/jwks.json", "GET"],
	])("%s %s", (url, method) => {
		expect(typeof ok(url, method)).toBe("string");
	});
	it("MOVE and COPY with a Destination inside the person's files", () => {
		expect(ok(`${D}/remote.php/dav/files/${UID}/a.txt`, "MOVE", { destination: `${D}/remote.php/dav/files/${UID}/B/a.txt` })).toBe("dav-files");
		expect(ok(`${D}/remote.php/dav/files/${UID}/a.txt`, "COPY", { destination: `${D}/remote.php/dav/files/${UID}/a (2).txt` })).toBe("dav-files");
		expect(ok(`${D}/remote.php/dav/trashbin/${UID}/trash/a.txt.d123`, "MOVE", { destination: `${D}/remote.php/dav/trashbin/${UID}/restore/a.txt.d123` })).toBe("dav-trash");
		expect(ok(`${D}/remote.php/dav/versions/${UID}/versions/12/1700000000`, "MOVE", { destination: `${D}/remote.php/dav/versions/${UID}/restore/target` })).toBe("dav-versions");
	});
	it("SEARCH scoped to the person's files", () => {
		expect(ok(`${D}/remote.php/dav/`, "SEARCH", {}, search(`/files/${UID}`))).toBe("dav-search");
		expect(ok(`${D}/remote.php/dav/`, "SEARCH", {}, search(`/files/${UID}/Projects`))).toBe("dav-search");
	});
	it("MKCOL of one plain calendar right under the person's calendar home (tasks_create's first list, fix round 3)", () => {
		expect(ok(`${D}/remote.php/dav/calendars/${UID}/tasks/`, "MKCOL", {}, taskListBody())).toBe("dav-calendars");
		expect(ok(`${D}/remote.php/dav/calendars/${UID}/tasks-2`, "MKCOL", {}, taskListBody())).toBe("dav-calendars");
	});
});

describe("egress allowlist: MKCOL under the calendar home", () => {
	const url = `${D}/remote.php/dav/calendars/${UID}/tasks/`;
	const mkcol = (types: string, extra = "") =>
		`<?xml version="1.0"?><d:mkcol xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"><d:set><d:prop><d:resourcetype>${types}</d:resourcetype>${extra}</d:prop></d:set></d:mkcol>`;
	it("refuses the trash, inbox and outbox, the home itself, nested paths and other people", () => {
		for (const p of ["trashbin/", "inbox/", "outbox/", "trashbin", "", "personal/sub/", "personal/x.ics/"]) {
			expect(denied(`${D}/remote.php/dav/calendars/${UID}/${p}`, "MKCOL", {}, taskListBody()), p).toBe(true);
		}
		expect(denied(`${D}/remote.php/dav/calendars/someone/tasks/`, "MKCOL", {}, taskListBody())).toBe(true);
	});
	it("refuses a subscription, a body without one plain calendar, and no body at all", () => {
		expect(denied(url, "MKCOL", {}, mkcol("<d:collection/><cs:subscribed/>", "<cs:source><d:href>https://evil.test/x.ics</d:href></cs:source>"))).toBe(true);
		expect(denied(url, "MKCOL", {}, mkcol("<d:collection/><cal:calendar/>", "<cs:source><d:href>https://evil.test/x.ics</d:href></cs:source>"))).toBe(true);
		expect(denied(url, "MKCOL", {}, mkcol("<d:collection/>"))).toBe(true);
		expect(denied(url, "MKCOL", {}, mkcol("<d:collection/><cal:calendar/><cal:schedule-inbox/>"))).toBe(true);
		expect(denied(url, "MKCOL", {}, "<not-xml")).toBe(true);
		expect(denied(url, "MKCOL")).toBe(true);
		expect(ok(url, "MKCOL", {}, mkcol("<d:collection/><cal:calendar/>"))).toBe("dav-calendars");
	});
	it("MKCALENDAR is gone from the table (workerd refuses that method anyway)", () => {
		expect(denied(url, "MKCALENDAR", {}, taskListBody())).toBe(true);
	});
});

describe("egress allowlist: denials", () => {
	it("refuses other hosts, plain http and userinfo", () => {
		expect(denied("https://office.nourax.org/converter", "POST")).toBe(true);
		expect(denied("https://mcp.nourax.org/mcp", "POST")).toBe(true);
		expect(denied(`http://drive.nourax.org/status.php`, "GET")).toBe(true);
		expect(denied(`https://user:pw@drive.nourax.org/status.php`, "GET")).toBe(true);
		expect(denied("https://evil.test/", "GET")).toBe(true);
		expect(denied("https://drive.nourax.org.evil.test/status.php", "GET")).toBe(true);
	});
	it("refuses the locked and admin paths", () => {
		for (const p of ["/login", "/index.php/login", "/settings/admin", "/index.php/settings/users", "/ocs/v2.php/cloud/users", "/ocs/v1.php/cloud/users/x", "/ocs/v2.php/cloud/groups", "/ocs/v2.php/apps/nourax_api/v1/provision", "/login/v2/flow/abc", "/login/v2/grant"]) {
			expect(denied(`${D}${p}`, "GET"), p).toBe(true);
			expect(denied(`${D}${p}`, "POST"), p).toBe(true);
		}
	});
	it("refuses another person's DAV root and path tricks", () => {
		expect(denied(`${D}/remote.php/dav/files/someone/`, "PROPFIND")).toBe(true);
		expect(denied(`${D}/remote.php/dav/files/${UID}/%2e%2e/someone/`, "PROPFIND")).toBe(true);
		expect(denied(`${D}/remote.php/dav/files/${UID}/a%2fb`, "GET")).toBe(true);
		expect(denied(`${D}/remote.php/dav/files/${UID}/a%5cb`, "GET")).toBe(true);
		expect(() => checkEgress(cfg(), `${D}/remote.php/dav/files/${UID}/`, { method: "PROPFIND" }, undefined)).toThrow(EgressDenied);
		expect(denied(`${D}/remote.php/dav/files/${UID}/`, "PROPFIND", {}, undefined, "a/b")).toBe(true);
		expect(denied(`${D}/remote.php/dav/files/${UID}/x?a=1`, "GET")).toBe(true);
	});
	it("never deletes in the trash, versions, whole calendars or the calendar trash", () => {
		expect(denied(`${D}/remote.php/dav/trashbin/${UID}/trash/a.d1`, "DELETE")).toBe(true);
		expect(denied(`${D}/remote.php/dav/versions/${UID}/versions/1/2`, "DELETE")).toBe(true);
		expect(denied(`${D}/remote.php/dav/calendars/${UID}/personal/`, "DELETE")).toBe(true);
		expect(denied(`${D}/remote.php/dav/calendars/${UID}/trashbin/x.ics`, "DELETE")).toBe(true);
		expect(denied(`${D}/remote.php/dav/addressbooks/users/${UID}/contacts/x.vcf`, "DELETE")).toBe(true);
		expect(denied(`${D}/index.php/apps/deck/api/v1.0/boards/1`, "DELETE")).toBe(true);
	});
	it("refuses bad Destination headers", () => {
		const src = `${D}/remote.php/dav/files/${UID}/a.txt`;
		expect(denied(src, "MOVE")).toBe(true);
		expect(denied(src, "MOVE", { destination: `${D}/remote.php/dav/files/someone/a.txt` })).toBe(true);
		expect(denied(src, "MOVE", { destination: `https://evil.test/remote.php/dav/files/${UID}/a.txt` })).toBe(true);
		expect(denied(src, "COPY", { destination: `${D}/remote.php/dav/files/${UID}/%2e%2e/x` })).toBe(true);
		expect(denied(`${D}/remote.php/dav/trashbin/${UID}/trash/a`, "MOVE", { destination: `${D}/remote.php/dav/files/${UID}/a` })).toBe(true);
	});
	it("refuses SEARCH outside the person's files", () => {
		expect(denied(`${D}/remote.php/dav/`, "SEARCH", {}, search("/files/someone"))).toBe(true);
		expect(denied(`${D}/remote.php/dav/`, "SEARCH", {}, search(`/files/${UID}x`))).toBe(true);
		expect(denied(`${D}/remote.php/dav/`, "SEARCH", {}, search(`/files/${UID}/../someone`))).toBe(true);
		expect(denied(`${D}/remote.php/dav/`, "SEARCH", {}, "<not xml")).toBe(true);
		expect(denied(`${D}/remote.php/dav/`, "SEARCH", {}, '<?xml version="1.0"?><d:searchrequest xmlns:d="DAV:"/>')).toBe(true);
	});
	it("refuses credentials on Login Flow v2, and cookies everywhere", () => {
		expect(denied(`${D}/index.php/login/v2`, "POST", { authorization: "Basic eDp5" })).toBe(true);
		expect(denied(`${D}/status.php`, "GET", { cookie: "a=b" })).toBe(true);
	});
	it("refuses mail hosts while NOMAIL_TOOLS_URL is not set", () => {
		expect(denied("https://tbwrezvhgoryzycjerrl.supabase.co/functions/v1/mcp-tools/v1/tools", "GET")).toBe(true);
	});
	it("every rule id is unique", () => {
		expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
	});
});

describe("egress allowlist: a NoMail provider on the Supabase host (an Edge Function)", () => {
	const SB = "https://tbwrezvhgoryzycjerrl.supabase.co";
	const mailCfg = () => config({ ...env, NOMAIL_TOOLS_URL: `${SB}/functions/v1/mcp-tools` });
	const check = (url: string, method: string, headers: Record<string, string> = {}) => checkEgress(mailCfg(), url, { method, headers });
	it("allows exactly /v1/tools and /v1/call under the base, with the person's bearer token", () => {
		expect(check(`${SB}/functions/v1/mcp-tools/v1/tools`, "GET", { authorization: "Bearer t", "x-nourax-tools-key": "k" })).toBe("nomail");
		expect(check(`${SB}/functions/v1/mcp-tools/v1/call`, "POST", { authorization: "Bearer t" })).toBe("nomail");
	});
	it("keeps the Supabase rows working on the same host", () => {
		expect(check(`${SB}/auth/v1/oauth/token`, "POST", { authorization: "Basic eDp5" })).toBe("supabase-token");
		expect(check(`${SB}/auth/v1/.well-known/jwks.json`, "GET")).toBe("supabase-jwks");
	});
	it("refuses everything else on that host", () => {
		for (const [url, method] of [
			[`${SB}/functions/v1/mcp-tools/v1/other`, "GET"],
			[`${SB}/functions/v1/other-function/v1/tools`, "GET"],
			[`${SB}/functions/v1/mcp-tools/v1/tools`, "DELETE"],
			[`${SB}/rest/v1/messages`, "GET"],
			[`${SB}/auth/v1/admin/users`, "GET"],
			[`${SB}/functions/v1/mcp-tools/v1/tools?x=1`, "GET"],
		] as const) {
			expect(() => check(url, method), `${method} ${url}`).toThrow(EgressDenied);
		}
	});
});

describe("no other module calls fetch or console.log", () => {
	const sources = import.meta.glob("../../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
	it("finds the sources", () => {
		expect(Object.keys(sources).length).toBeGreaterThan(30);
	});
	it("fetch( only in src/core/egress.ts", () => {
		const offenders = Object.entries(sources)
			.filter(([f]) => !f.endsWith("/core/egress.ts"))
			.filter(([, s]) => /(?<![\w.]|async\s|function\s)fetch\s*\(/.test(s) ||/globalThis\s*\.\s*fetch/.test(s) || /\bself\s*\.\s*fetch/.test(s))
			.map(([f]) => f);
		expect(offenders).toEqual([]);
	});
	it("console.log only in src/core/log.ts", () => {
		const offenders = Object.entries(sources)
			.filter(([f]) => !f.endsWith("/core/log.ts"))
			.filter(([, s]) => /console\s*\.\s*(log|info|warn|error|debug)\s*\(/.test(s))
			.map(([f]) => f);
		expect(offenders).toEqual([]);
	});
});
