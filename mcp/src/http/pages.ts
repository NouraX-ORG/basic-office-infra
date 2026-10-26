/**
 * Our pages, reached through the OAuth provider's defaultHandler (so env.OAUTH_PROVIDER, the
 * library's helpers, is set): /, /authorize, /callback, /connect, /connect/cancel, /connections and,
 * in dev only, /dev/*.
 *
 * /dev/* answers only callers that aren't a web page on another site (fix round 3): a browser sends
 * Sec-Fetch-Site, and anything but "same-origin" or "none" is refused, so a site open in the dev PC's
 * browser can't seed a vault or end the test runner's connection. The test runner and the Worker's
 * own mock-NoMail calls send no Sec-Fetch-Site. /dev/token also takes JSON only (415 otherwise), which
 * a cross-site page can't send without a preflight that /dev never answers.
 */
import { authorizeGet, authorizePost } from "../auth/consent";
import { connectCancel, connectPage } from "../auth/connect";
import { devMockNomail, devToken } from "../auth/dev";
import { devActive } from "../auth/dev-guard";
import { providerFor } from "../auth/provider";
import { upstreamCallback } from "../auth/upstream";
import { config, type NxEnv } from "../env";
import { connectionsRoute } from "../pages/connections/index";
import { errorPage, esc, page } from "./html";
import { ridOf } from "./rid";

function landing(env: NxEnv): Response {
	const cfg = config(env);
	return page({
		title: "AI connector",
		https: cfg.env !== "dev",
		body: `<h1>Nourax Workspace for AI assistants</h1>
<p>This connects AI assistants such as Claude, ChatGPT and ONLYOFFICE to your Nourax Workspace: NoDrive files, documents, NoCalendar, NoTasks, NoContacts, NoBoard and NoGantt. The assistant acts only as you and sees only what you can see.</p>
<h2>Add it to your assistant</h2>
<p>Use this address as a custom connector:</p>
<p><code class="key">${esc(`${cfg.publicOrigin}/mcp`)}</code></p>
<p>Sign-in happens in your browser. Sharing and sending mail stay off unless you allow them.</p>
<p><a href="/connections">See and end your connections</a></p>`,
	});
}

export const pagesHandler = {
	async fetch(request: Request, env: NxEnv, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const rid = ridOf(request);
		const p = url.pathname;
		const m = request.method;

		if (__NX_DEV_AUTH__) {
			if (p.startsWith("/dev/")) {
				if (!devActive(env, request)) return errorPage("Not found", "There's nothing here.", 404);
				const site = request.headers.get("sec-fetch-site");
				if (site !== null && site !== "same-origin" && site !== "none") return errorPage("Not allowed", "Dev routes don't answer other web pages.", 403);
				if (p === "/dev/token" && m === "POST") return devToken(request, env, ctx, (r) => providerFor(env).fetch(r, env, ctx));
				if (p.startsWith("/dev/mock-nomail")) return devMockNomail(request);
				return errorPage("Not found", "There's nothing here.", 404);
			}
		}

		if (p === "/" && (m === "GET" || m === "HEAD")) return landing(env);
		if (p === "/authorize") {
			if (m === "GET") return authorizeGet(request, env, rid);
			if (m === "POST") return authorizePost(request, env, rid);
		}
		if (p === "/callback" && m === "GET") return upstreamCallback(request, env, rid);
		if (p === "/connect" && m === "GET") return connectPage(request, env, rid);
		if (p === "/connect/cancel" && m === "GET") return connectCancel(request, env);
		if (p === "/connections" || p.startsWith("/connections/")) return connectionsRoute(request, env, ctx);
		return errorPage("Not found", "There's nothing here.", 404);
	},
};
