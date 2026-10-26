/**
 * Lane F: docs/mcp.md against the code, so the hand-written parts can't drift unnoticed.
 * - The tool table (section 5): every catalogue tool once, in catalogue order, with its "Needs"
 *   (the scope's words without the part in brackets), "App" and "Kind" exactly as the catalogue says.
 * - The tool counts quoted in the text, and ONLYOFFICE's 100-tool limit.
 * - What "Replace and remove" promises, against the tools under it.
 * - The ONLYOFFICE desktop-key setting (section 2.4, Option B) has the shape the pages print.
 * - The redirect URIs NoMail registers (section 6.1, and the owner's step in section 10) include the
 *   connections page's own callback.
 * - The docs claim only what the code enforces about the name "Connections page" (4.1, 7.3).
 * - Every log event the monitoring queries name (9.3) is one the code really writes.
 * - Second review, fix round 2: the 403 table in 6.1 says exactly what blockMessage() tells the
 *   assistant; no sentence claims that nothing is deleted for good; the reading-file sizes (8), the
 *   /healthz body and the Workers Logs plans (9.3), and the consent page's client name (4.1).
 * - Second review, fix round 3: every built "Replace and remove" tool is known to lane F
 *   (REMOVE_TOOL_FATES), with a for-good part exactly when its own description or inputs say so,
 *   and the docs quote each for-good part in sections 3, 5 and 7.4 and the tool's row; 4.1, 7.3 and
 *   6.1 say the page sign-in doesn't check two-step sign-in exactly while no code reads `aal`.
 * The page-flow checks (2.4, 4.1, 4.2 and 7.6 against what production does) are in connections.test.ts.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkClientMetadata, clientLabel } from "../../src/auth/dcr";
import { LIMITS } from "../../src/core/limits";
import { blockMessage, type BlockCode } from "../../src/mail/index";
import { CLIENT_TOOL_CAP } from "../../src/mail/register";
import { ALL_APPS, annotationsFor, APP_WORDS, CATALOG, type CatalogEntry, SCOPE_WORDS } from "../../src/mcp/catalog";
import { SESSION_CALLBACK_PATH } from "../../src/pages/connections/upstream";
import { desktopKeySetting, isReservedLabel, REMOVE_TOOL_FATES, type RemoveFate, SESSION_LABEL } from "../../src/pages/connections/views";
import { TOOLS } from "../../src/tools/registry";
import { VERSION } from "../../src/version";
import { call } from "../helpers/index";

const files = import.meta.glob("../../../docs/mcp.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const DOC = Object.values(files)[0] ?? "";
const designFiles = import.meta.glob("../../DESIGN.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const DESIGN = Object.values(designFiles)[0] ?? "";
const srcFiles = import.meta.glob("../../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** One section, from its heading ("## 7." or "### 7.3 ") to the next heading of that level or above. */
function section(heading: string): string {
	const start = DOC.indexOf(heading);
	expect(start, `docs/mcp.md has "${heading}"`).toBeGreaterThanOrEqual(0);
	const level = heading.startsWith("### ") ? 3 : 2;
	const rest = DOC.slice(start + heading.length);
	const end = rest.search(level === 3 ? /\n#{2,3} / : /\n## /);
	return end < 0 ? rest : rest.slice(0, end);
}

interface Row {
	name: string;
	what: string;
	needs: string;
	app: string;
	kind: string;
}

function toolTable(md: string): Row[] {
	const lines = md.split("\n");
	const start = lines.findIndex((l) => l.startsWith("| Tool | What it does | Needs | App | Kind |"));
	expect(start, "the tool table's header row").toBeGreaterThan(0);
	const rows: Row[] = [];
	for (const line of lines.slice(start + 2)) {
		if (!line.startsWith("|")) break;
		const cells = line.split(" | ").map((c) => c.replace(/^\|\s*|\s*\|$/g, "").trim());
		expect(cells.length, line).toBe(5);
		rows.push({ name: (cells[0] as string).replace(/`/g, ""), what: cells[1] as string, needs: cells[2] as string, app: cells[3] as string, kind: cells[4] as string });
	}
	return rows;
}

/** Words in a tool's own description or inputs that say part of it can't be undone. */
const FOR_GOOD_RE = /for good|can't be undone|cannot be undone|can't be put back|permanent|irreversib/i;

function fateOf(name: string): RemoveFate | null {
	return Object.hasOwn(REMOVE_TOOL_FATES, name) ? (REMOVE_TOOL_FATES[name] as RemoveFate) : null;
}

function norm(s: string): string {
	return s.replace(/\s+/g, " ");
}

/** A source file under src/ with its comments taken out, so only code is searched. */
function codeOf(path: string): string {
	const hit = Object.entries(srcFiles).find(([p]) => p.endsWith(path));
	expect(hit, path).toBeTruthy();
	return (hit?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function needsWords(c: CatalogEntry): string {
	return SCOPE_WORDS[c.scope].replace(/\s*\(.*\)\s*$/, "");
}

function kindWords(c: CatalogEntry): string {
	const a = annotationsFor(c);
	const base = a.readOnlyHint ? "reads" : a.destructiveHint ? "changes or removes; the app asks first" : "adds";
	return a.openWorldHint ? `${base}; anyone with the link can open it` : base;
}

describe("docs/mcp.md", () => {
	it("is found", () => {
		expect(DOC.length).toBeGreaterThan(1000);
		expect(DOC.startsWith("# Nourax Workspace for AI assistants")).toBe(true);
		expect(DESIGN.length).toBeGreaterThan(1000);
		expect(Object.keys(srcFiles).length).toBeGreaterThan(20);
	});

	it("the tool table lists every catalogue tool once, in order, with the right Needs, App and Kind", () => {
		const rows = toolTable(DOC);
		expect(rows.map((r) => r.name)).toEqual(CATALOG.map((c) => c.name));
		const wrong: string[] = [];
		CATALOG.forEach((c, i) => {
			const r = rows[i] as Row;
			const app = c.app ? APP_WORDS[c.app] : "always on";
			if (r.needs !== needsWords(c)) wrong.push(`${c.name}: Needs "${r.needs}", catalogue "${needsWords(c)}"`);
			if (r.app !== app) wrong.push(`${c.name}: App "${r.app}", catalogue "${app}"`);
			if (r.kind !== kindWords(c)) wrong.push(`${c.name}: Kind "${r.kind}", catalogue "${kindWords(c)}"`);
			if (!r.what || r.what.length > 200) wrong.push(`${c.name}: "What it does" is empty or longer than 200 characters`);
		});
		expect(wrong).toEqual([]);
	});

	it("quotes the right number of own tools and ONLYOFFICE's limit, and the app names it lists exist", () => {
		const n = CATALOG.length;
		expect(DOC).toContain(`${n} tools of Nourax Workspace's own`);
		expect(DOC).toContain(`Nourax Workspace has ${n} tools of its own`);
		expect(DOC).toContain(`so it lists at most ${n}`);
		// The server never lists more than ONLYOFFICE's cap (lane E's mailRoom), whatever the counts.
		expect(DOC).toContain(`NoMail adds at most ${LIMITS.mailTools}`);
		expect(DOC).toContain(`lists at most ${Math.min(CLIENT_TOOL_CAP, n + LIMITS.mailTools)} tools`);
		expect(DOC).toContain(`At most ${CLIENT_TOOL_CAP} tools can be switched on`);
		for (const a of ALL_APPS) expect(DOC).toContain(APP_WORDS[a]);
	});

	it("every built \"Replace and remove\" tool is one lane F knows, with a for-good part exactly when its own description or inputs say so", () => {
		const built = TOOLS.filter((t) => t.entry.scope === "workspace.remove");
		expect(built.length).toBeGreaterThan(0);
		for (const t of built) {
			const fate = fateOf(t.name);
			expect(fate, `${t.name} is in REMOVE_TOOL_FATES (src/pages/connections/views.ts)`).not.toBeNull();
			const told = `${t.description}\n${JSON.stringify(z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }))}`;
			const says = FOR_GOOD_RE.test(told);
			expect(Boolean(fate?.forGood), `${t.name}: its description ${says ? "says" : "doesn't say"} that part of it is for good`).toBe(says);
		}
		// The repeating-event case the review found, spelled out: it is for good, not "undone for 30 days".
		const cancel = TOOLS.find((t) => t.name === "calendar_cancel_event");
		if (cancel) {
			expect(cancel.description).toMatch(/single occurrence for good/);
			expect(fateOf("calendar_cancel_event")?.forGood).toBe("removing one occurrence of a repeating event is for good");
		}
		// Every tool lane F knows is still under workspace.remove (a rename or a move would be noticed).
		for (const name of Object.keys(REMOVE_TOOL_FATES)) expect(CATALOG.find((c) => c.name === name)?.scope, name).toBe("workspace.remove");
	});

	it("\"Replace and remove\": the docs quote every part that is for good in sections 3, 5 and 7.4 and in the tool's own row, promise no blanket undo, and name NoGantt deletes only if a tool makes them", () => {
		const remove = CATALOG.filter((c) => c.scope === "workspace.remove");
		const forGood = [...new Set(remove.flatMap((c) => fateOf(c.name)?.forGood ?? []))];
		const unknown = remove.filter((c) => !fateOf(c.name));
		const s3row = section("## 3.").split("\n").find((l) => l.includes("| Replace and remove |")) ?? "";
		expect(s3row).toContain("can be undone for 30 days");
		const places: Record<string, string> = { "section 3": s3row, "section 5": section("## 5."), "section 7.4": section("### 7.4 ") };
		for (const clause of forGood) {
			for (const [where, text] of Object.entries(places)) expect(norm(text).toLowerCase(), `${where} quotes "${clause}"`).toContain(clause.toLowerCase());
		}
		const rows = toolTable(DOC);
		for (const c of remove) {
			const clause = fateOf(c.name)?.forGood;
			if (clause) expect((rows.find((r) => r.name === c.name)?.what ?? "").toLowerCase(), `${c.name}'s row`).toContain(clause.toLowerCase());
		}
		if (forGood.length || unknown.length) {
			// No blanket promise while anything under "Replace and remove" is for good.
			expect(s3row).not.toMatch(/each of these can be undone|None of these tools deletes|all of this can be undone/i);
			expect(norm(DOC)).not.toMatch(/No tool deletes a file, folder, event,/);
		}
		for (const c of unknown) expect(DOC, c.name).toContain(c.name);
		const ganttDeletes = remove.some((c) => c.app === "gantt");
		expect(norm(DOC).includes("No tool deletes a NoGantt task")).toBe(!ganttDeletes);
		if (!ganttDeletes) expect(DOC).not.toMatch(/NoGantt task is for good/);
		// Core's bracketed words ("all can be undone") are never copied into the docs.
		expect(DOC).not.toMatch(/all can be undone/i);
	});

	it("4.1, 7.3 and 6.1 say the page's \"Log in with Nourax\" sign-in doesn't check two-step sign-in exactly while no code reads `aal` (tokens for this client carry aal1)", () => {
		const code = [codeOf("/auth/jwt.ts"), codeOf("/pages/connections/upstream.ts")].join("\n");
		const checksAal = /\baal\b|\bamr\b/.test(code);
		const s41 = norm(section("### 4.1 "));
		const s73 = norm(section("### 7.3 "));
		const s61 = norm(section("### 6.1 "));
		expect(s41.includes("**This sign-in doesn't check two-step sign-in.**")).toBe(!checksAal);
		expect(s73.includes("It adds no check of two-step sign-in")).toBe(!checksAal);
		expect(s61.includes("doesn't check two-step sign-in there either")).toBe(!checksAal);
		if (!checksAal) {
			// What is left, said plainly, and what still holds.
			expect(s41).toContain("the page can't tell whether it was asked");
			expect(s41).toContain("they could see your connections, end them, clear the notes and start a desktop key (which still needs a NoDrive grant from your account)");
			expect(s41).toContain("settle the 2FA question in section 6.1");
		}
	});

	it("section 2.4 Option B shows the same setting the pages print for a desktop key", () => {
		const after = DOC.slice(DOC.indexOf("**Option B, a desktop key"));
		const block = /```json\n([\s\S]*?)\n```/.exec(after)?.[1] ?? "";
		const shown = JSON.parse(block.replace("nxw_ct_…", "nxw_ct_KEY")) as unknown;
		expect(shown).toEqual(JSON.parse(desktopKeySetting("https://mcp.nourax.org", "nxw_ct_KEY")));
	});

	it("section 6.1 gives NoMail both redirect URIs, the connections page's own included, and how to check them", () => {
		const s61 = section("### 6.1 ");
		expect(s61).toContain("`https://mcp.nourax.org/callback`");
		expect(s61).toContain(`\`https://mcp.nourax.org${SESSION_CALLBACK_PATH}\``);
		expect(s61).toContain(`\`http://localhost:8787${SESSION_CALLBACK_PATH}\``);
		expect(s61).toContain("client_secret_basic");
		expect(s61).toContain("**Confidential**");
		expect(s61).toContain("`Nourax Workspace AI (MCP)`");
		expect(s61).toContain("redirect_uri=https%3A%2F%2Fmcp.nourax.org%2Fcallback");
		expect(s61).toContain(`redirect_uri=${encodeURIComponent(`https://mcp.nourax.org${SESSION_CALLBACK_PATH}`)}`);
	});

	it("the owner's step for the Supabase client (section 10, item 3) names both redirect URIs itself", () => {
		const item3 = /\n3\. \*\*The Supabase OAuth client\*\*[\s\S]*?(?=\n\d+\. )/.exec(section("## 10."))?.[0] ?? "";
		expect(item3).toContain("`https://mcp.nourax.org/callback`");
		expect(item3).toContain(`\`https://mcp.nourax.org${SESSION_CALLBACK_PATH}\``);
		expect(item3).toContain("`Nourax Workspace AI (MCP)`");
	});

	it("DESIGN section 20 item 3 names both redirect URIs and the same client name as docs 6.1 (fix round 3)", () => {
		const item3 = DESIGN.slice(DESIGN.indexOf("### Item 3."), DESIGN.indexOf("### Item 4."));
		expect(item3).toContain(`https://mcp.nourax.org${SESSION_CALLBACK_PATH}`);
		expect(item3).toContain(`http://localhost:8787${SESSION_CALLBACK_PATH}`);
		expect(item3).toContain("Nourax Workspace AI (MCP)");
	});

	it("claims that no AI app can take the connections page's name only if registration really prevents it (4.1, 7.3)", () => {
		const name = SESSION_LABEL;
		const loopback = "http://127.0.0.1:33418/callback";
		const refused = checkClientMetadata({ redirect_uris: [loopback], client_name: name }, ["loopback"]) !== null;
		const aiAppCanTakeIt = !refused && isReservedLabel(clientLabel(name, loopback));
		const claims = [section("### 4.1 "), section("### 7.3 ")].join("\n");
		if (aiAppCanTakeIt) {
			expect(claims).not.toMatch(/no AI app can/i);
			expect(claims).not.toMatch(/always comes from this page's own sign-in/);
			expect(claims).toMatch(/an AI app (names itself|that registers itself)/);
		} else {
			// Core's DCR patch landed: the docs may no longer say that an AI app can take the name.
			expect(claims).not.toMatch(/can pick any name, this one included/);
			expect(claims).not.toMatch(/an AI app that registers itself can take that name/);
		}
		// Either way the docs never vouch for the name itself.
		expect(claims).toContain("The name proves nothing");
		expect(claims).not.toMatch(/harmless/i);
	});

	it("7.3 says what a phished sign-in to the connections page allows: seeing, ending and clearing", () => {
		const s73 = section("### 7.3 ");
		expect(s73).toContain("could end any");
		expect(s73).toContain('could clear the "Ended, but not fully removed" notes');
		expect(s73).toContain("could start a desktop key");
	});

	it("every log event named in the monitoring queries (9.3) is one the code writes", () => {
		const s93 = section("### 9.3 ");
		const named = new Set<string>();
		for (const line of s93.split("\n").filter((l) => /`ev`|ev =/.test(l) || /^\s{4}\S/.test(l))) {
			for (const m of line.matchAll(/`([a-z]+_[a-z_]+|[a-z]+)`/g)) if (m[1] !== "ev" && m[1] !== "t") named.add(m[1] as string);
			for (const m of line.matchAll(/`ev = "([a-z_]+)"`/g)) named.add(m[1] as string);
		}
		expect(named.size).toBeGreaterThan(8);
		for (const ev of ["admin_refused", "rate_limited", "daily_cap", "refresh_failed", "setup_fault"]) expect(named, ev).toContain(ev);
		const code = Object.entries(srcFiles)
			.filter(([p]) => !p.endsWith("/core/log.ts"))
			.map(([, s]) => s)
			.join("\n");
		const missing = [...named].filter((ev) => !code.includes(`"${ev}"`));
		expect(missing).toEqual([]);
		// The idle-expiry sentence stays true: no idle event is written, or the docs name it.
		const idleLogged = code.includes('"idle_revoked"');
		expect(s93.includes("have no event of their own")).toBe(!idleLogged);
	});

	it("6.1's 403 table says exactly what blockMessage() tells the assistant, for every code in contract v1, and never sends 2FA people round a sign-in loop", () => {
		const s61 = section("### 6.1 ");
		const lines = s61.split("\n");
		const head = lines.findIndex((l) => l.startsWith("| NoMail's code | What the assistant is told |"));
		expect(head, "the 403 table").toBeGreaterThan(0);
		const told = new Map<string, string>();
		for (const line of lines.slice(head + 2)) {
			if (!line.startsWith("|")) break;
			const cells = line.split(" | ").map((c) => c.replace(/^\|\s*|\s*\|$/g, "").trim());
			told.set((cells[0] as string).replace(/`/g, ""), cells[1] as string);
		}
		// The brief's caller rule 1 lists these four codes (section 5).
		const codes: BlockCode[] = ["TOOLS_KEY_INVALID", "TOKEN_NOT_FOR_MCP", "MFA_REQUIRED", "MAILBOX_NOT_VERIFIED"];
		expect([...told.keys()]).toEqual([...codes, "any other 403"]);
		for (const code of codes) expect(told.get(code), code).toBe(blockMessage(code));
		expect(told.get("any other 403")).toBe(blockMessage(undefined));
		// The gist, so a rewording in code or docs can't hide it: reconnecting is advised only where
		// the code advises it, and the administrator is named exactly where the code names one.
		for (const code of codes) {
			const msg = blockMessage(code);
			const row = told.get(code) as string;
			const wontHelp = /Reconnecting won't/.test(msg);
			expect(/Reconnecting won't/.test(row), code).toBe(wontHelp);
			expect(/administrator/.test(row), code).toBe(/administrator/.test(msg));
			if (wontHelp) expect(row, code).not.toMatch(/reconnect and|Reconnect the assistant/);
		}
		// The open question below the table agrees with the MFA row.
		const after = s61.slice(s61.indexOf("**Open question for the owner (2FA):**")).replace(/\s+/g, " ");
		expect(after).toContain("no reconnect can fix it");
		expect(s61).not.toMatch(/reconnect and finish it/);
	});

	it("no sentence claims that nothing is ever deleted for good; sections 5 and 7.4 name what takes effect at once", () => {
		expect(DOC).not.toMatch(/Nothing is deleted for good/i);
		expect(DOC).not.toMatch(/No tool deletes anything for good/i);
		const s5 = section("## 5.").replace(/\s+/g, " ");
		expect(s5).toContain("No tool deletes a file, folder, whole event, contact, card, task or project for good");
		expect(s5).toContain("**Some changes take effect at once and have no trash:** changing or ending a share or a public link");
		const s74 = section("### 7.4 ").replace(/\s+/g, " ");
		expect(s74).toContain("Changing or ending a share, or clearing a field, takes effect at once.");
		// Those tools exist and change or remove (the app asks first), so the exceptions are real.
		for (const name of ["sharing_delete", "sharing_update", "contacts_update", "calendar_update_event", "boards_assign_card", "gantt_update_task"]) {
			const c = CATALOG.find((x) => x.name === name) as CatalogEntry;
			expect(c, name).toBeTruthy();
			expect(annotationsFor(c).destructiveHint, name).toBe(true);
		}
	});

	it("section 8 gives the reading sizes the code uses", () => {
		const MB = 1024 * 1024;
		const row = section("## 8.").split("\n").find((l) => l.startsWith("| Reading files |")) ?? "";
		expect(row).toContain(`Up to ${LIMITS.readCharsMax.toLocaleString("en-GB")} characters a call`);
		expect(row).toContain(`Text files: the first ${LIMITS.readTextSourceBytes / MB} MB`);
		expect(row).toContain(`OpenDocument files up to ${LIMITS.officeInWorkerBytes / MB} MB and PDFs up to ${LIMITS.pdfInWorkerBytes / MB} MB are read inside the Worker`);
		expect(row).toContain(`bigger ones up to ${LIMITS.serverRouteBytes / MB} MB`);
		expect(row).not.toMatch(/sources up to 25 MB/);
	});

	it("9.3's /healthz example has the fields /healthz really answers, with the release version", async () => {
		const res = await call("/healthz");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		const s93 = section("### 9.3 ");
		const shown = /`(\{"status":"ok"[^`]*\})`/.exec(s93)?.[1] ?? "";
		const example = JSON.parse(shown.replace("<git commit>", "x")) as Record<string, unknown>;
		expect(Object.keys(example).sort()).toEqual(Object.keys(body).sort());
		expect(example.release).toBe(VERSION);
		expect(body.release).toBe(VERSION);
	});

	it("9.3 gives the Workers Logs allowances for both plans, says which plan the account is on, and what happens on Free at the limit", () => {
		const s93 = section("### 9.3 ").replace(/\s+/g, " ");
		expect(s93).toContain("**This account is on Workers Paid:**");
		expect(s93).toContain("| Workers Paid |");
		expect(s93).toContain("| Workers Free | 200,000 log events a day");
		expect(s93).toContain("0.5 GB of ingestion a day");
		expect(s93).toContain("Cloudflare stops taking logs until 00:00 UTC (it costs nothing");
	});

	it("4.1 names the consent page's client as 6.1 registers it", () => {
		const name = /\| Name \| `([^`]+)` \|/.exec(section("### 6.1 "))?.[1] ?? "";
		expect(name).toBe("Nourax Workspace AI (MCP)");
		const s41 = section("### 4.1 ").replace(/\s+/g, " ");
		expect(s41).toContain(`it may ask you to allow "${name}"`);
	});
});
