/**
 * Core endpoints of the fake: cloud/user, capabilities, navigation, search providers, apppassword,
 * Login Flow v2 (init and poll), status.php and the principal (for the time zone). Response shapes
 * follow what the research recorded on NC 35.0.2.
 */
import { DRIVE, type FakeNc, ocs } from "./index";

const unauthorized = () =>
	new Response(JSON.stringify({ ocs: { meta: { status: "failure", statuscode: 997, message: "Current user is not logged in" }, data: [] } }), {
		status: 401,
		headers: { "content-type": "application/json" },
	});

export function installCore(fake: FakeNc): void {
	fake.on("GET", /^\/ocs\/v2\.php\/cloud\/user$/, (req) => {
		if (!req.auth) return unauthorized();
		const u = fake.users.get(req.auth);
		if (!u) return unauthorized();
		return ocs({
			enabled: true,
			storageLocation: `/var/www/html/data/${u.uid}`,
			id: u.uid,
			lastLogin: 1761300000000,
			backend: u.uid.length === 36 ? "OIDC" : "Database",
			subadmin: [],
			quota: u.quota,
			email: u.email,
			"additional_mail": [],
			displayname: u.displayName,
			"display-name": u.displayName,
			phone: "",
			address: "",
			website: "",
			twitter: "",
			groups: u.groups,
			language: u.language ?? "en",
			locale: "",
			...(u.timezone ? { timezone: u.timezone } : {}),
			backendCapabilities: { setDisplayName: false, setPassword: false },
		});
	});
	fake.on("GET", /^\/ocs\/v2\.php\/cloud\/capabilities$/, (req) => (req.auth ? ocs({ version: { major: 35, minor: 0, micro: 2 }, capabilities: fake.capabilities }) : unauthorized()));
	fake.on("GET", /^\/ocs\/v2\.php\/core\/navigation\/apps$/, (req) => (req.auth ? ocs(fake.navigation) : unauthorized()));
	fake.on("GET", /^\/ocs\/v2\.php\/search\/providers$/, (req) => (req.auth ? ocs(fake.providers.map((p, i) => ({ ...p, appId: p.id, order: i, triggers: [] }))) : unauthorized()));
	fake.on("DELETE", /^\/ocs\/v2\.php\/core\/apppassword$/, (req) => {
		if (!req.auth) return unauthorized();
		fake.revokePassword(req.headers);
		return ocs([]);
	});
	fake.on("POST", /^\/(?:index\.php\/)?login\/v2$/, (req) => {
		const pollToken = fake.newSecret("POLL").replace(/[^A-Za-z0-9]/g, "a");
		const loginToken = fake.newSecret("LOGIN").replace(/[^A-Za-z0-9]/g, "b");
		fake.flows.set(pollToken, { loginToken, userAgent: req.headers.get("user-agent") ?? "" });
		return Response.json({ poll: { token: pollToken, endpoint: `${DRIVE}/login/v2/poll` }, login: `${DRIVE}/login/v2/flow/${loginToken}` });
	});
	fake.on("POST", /^\/(?:index\.php\/)?login\/v2\/poll$/, (req) => {
		const token = new URLSearchParams(req.body).get("token") ?? "";
		const f = fake.flows.get(token);
		if (!f || !f.granted || f.done) return new Response("[]", { status: 404 });
		f.done = true;
		return Response.json({ server: DRIVE, loginName: f.granted.uid, appPassword: f.granted.appPassword });
	});
	fake.on("GET", /^\/status\.php$/, () => Response.json({ installed: true, maintenance: false, needsDbUpgrade: false, productname: "Nourax Workspace" }));
	fake.on("PROPFIND", /^\/remote\.php\/dav\/principals\/users\/([^/]+)\/$/, (req) => {
		if (!req.auth) return new Response("", { status: 401 });
		return new Response(
			`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/remote.php/dav/principals/users/${req.auth}/</d:href><d:propstat><d:prop><cal:schedule-default-calendar-URL/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>`,
			{ status: 207, headers: { "content-type": "application/xml; charset=utf-8" } },
		);
	});
}
