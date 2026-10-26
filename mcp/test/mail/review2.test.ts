/**
 * Second system review, mail side:
 * - DESIGN 29.4: which mail tools reach NoDrive, and which choices can make a share link, are read
 *   from the whole input schema (nested objects, array items, anyOf, local $ref), so an additive v1
 *   change such as mail_create_draft gaining attachments[].path can't get round the Files app or the
 *   share scope;
 * - DESIGN 29.6: mail_state "reconnect_needed" with a live upstream session doesn't switch mail off;
 *   the request refreshes once, and a refresh that works brings mail back.
 */
import { describe, expect, it } from "vitest";
import { randomBytes } from "../../src/core/bytes";
import type { MailToolDef } from "../../src/core/mail-contract";
import { config } from "../../src/env";
import { driveReach, linkChoices, linkRefusal, type MailGrant, mailDenial, shownDescription } from "../../src/mail/access";
import type { Scope } from "../../src/mcp/catalog";
import { mailContext } from "../../src/mcp/mail-ctx";
import type { OpenOk } from "../../src/vault/schema";
import { env } from "../helpers/index";

const ALL_MAIL: Scope[] = ["workspace.read", "mail.read", "mail.write"];
const grant = (scopes: Scope[], apps: MailGrant["apps"]): MailGrant => ({ scopes, apps });
const tool = (name: string, schema: Record<string, unknown>): MailToolDef => ({
	name,
	title: "T",
	description: "Makes a draft.",
	inputSchema: { type: "object", ...schema },
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
});
const asChoice = { type: "string", enum: ["auto", "file", "link"], default: "auto" };

/** mail_create_draft after an additive v1 change: attachments named by their Drive path, nested. */
const withAttachments = tool("mail_create_draft", {
	properties: {
		to: { type: "array", items: { type: "string" } },
		subject: { type: "string" },
		attachments: { type: "array", items: { type: "object", properties: { path: { type: "string" }, as: asChoice } } },
	},
});

describe("nested inputs count (DESIGN 29.4)", () => {
	it("a Drive path inside attachments[] reaches NoDrive: Files and write are needed, as at the top", () => {
		expect(driveReach(withAttachments)).toBe("write");
		expect(mailDenial(withAttachments, grant(ALL_MAIL, ["mail"]))).toBe("files");
		expect(mailDenial(withAttachments, grant(ALL_MAIL, ["files", "mail"]))).toBe("files_write");
		expect(mailDenial(withAttachments, grant([...ALL_MAIL, "workspace.write"], ["files", "mail"]))).toBeNull();
	});
	it("so does a Drive word only in a nested description, under anyOf, behind a local $ref, or in prefixItems", () => {
		const nestedWords = tool("mail_create_draft", {
			properties: { attachments: { type: "array", items: { type: "object", properties: { source: { type: "string", description: "A file in the person's Nourax Drive" } } } } },
		});
		const underAnyOf = tool("mail_update_draft", { properties: { attachment: { anyOf: [{ type: "null" }, { type: "object", properties: { drive_path: { type: "string" } } }] } } });
		const behindRef = tool("mail_create_draft", {
			properties: { attachments: { type: "array", items: { $ref: "#/$defs/Att" } } },
			$defs: { Att: { type: "object", properties: { source: { type: "string", description: "Where it is in NoDrive" }, as: asChoice } } },
		});
		const tuple = tool("mail_create_draft", { properties: { pair: { type: "array", prefixItems: [{ type: "string" }, { type: "object", properties: { filePath: { type: "string" } } }] } } });
		for (const t of [nestedWords, underAnyOf, behindRef, tuple]) expect(driveReach(t), JSON.stringify(t.inputSchema)).toBe("write");
		expect(linkChoices(behindRef).map((c) => c.label)).toEqual(["attachments[].as"]);
	});
	it("nested inputs without Drive words still don't reach NoDrive", () => {
		const plain = tool("mail_create_draft", {
			properties: { to: { type: "array", items: { type: "object", properties: { address: { type: "string" }, name: { type: "string" } } } }, body: { type: "string" } },
		});
		expect(driveReach(plain)).toBe("none");
		expect(mailDenial(plain, grant(ALL_MAIL, ["mail"]))).toBeNull();
	});
	it("without share, every nested link choice is checked in the arguments; a left-out one takes the default", () => {
		const noShare = grant([...ALL_MAIL, "workspace.write"], ["files", "mail"]);
		expect(linkChoices(withAttachments)).toEqual([{ path: [{ prop: "attachments" }, { item: true }, { prop: "as" }], label: "attachments[].as", safe: ["file"], fallback: "auto" }]);
		// No attachments: no link can be made.
		expect(linkRefusal(withAttachments, noShare, { to: ["a@example.invalid"], subject: "s" })).toBeNull();
		expect(linkRefusal(withAttachments, noShare, { attachments: [{ path: "/a.pdf", as: "file" }, { path: "/b.pdf", as: "file" }] })).toBeNull();
		const leftOut = linkRefusal(withAttachments, noShare, { attachments: [{ path: "/a.pdf", as: "file" }, { path: "/b.pdf" }] });
		expect(leftOut?.code).toBe("not_available");
		expect(leftOut?.field).toBe("attachments[].as");
		expect(leftOut?.message).toBe('This connection can\'t share files or create links. With attachments[].as "auto", the file may be sent as a NoDrive share link. attachments[].as "file" attaches the file itself.');
		expect(linkRefusal(withAttachments, noShare, { attachments: [{ path: "/a.pdf", as: "link" }] })?.message).toContain('With attachments[].as "link"');
		// With share, anything goes.
		const share = grant([...ALL_MAIL, "workspace.share"], ["files", "mail"]);
		expect(linkRefusal(withAttachments, share, { attachments: [{ path: "/a.pdf", as: "link" }] })).toBeNull();
		expect(shownDescription(withAttachments, noShare)).toBe('Makes a draft. On this connection only attachments[].as "file" works: it can\'t create share links.');
		expect(shownDescription(withAttachments, share)).toBe("Makes a draft.");
	});
	it("choices spread over anyOf branches as const values are put together", () => {
		const t = tool("mail_create_draft", {
			properties: { attachments: { type: "array", items: { type: "object", properties: { path: { type: "string" }, as: { anyOf: [{ const: "file" }, { const: "link" }] } } } } },
		});
		expect(linkChoices(t)).toEqual([{ path: [{ prop: "attachments" }, { item: true }, { prop: "as" }], label: "attachments[].as", safe: ["file"], fallback: null }]);
		const noShare = grant([...ALL_MAIL, "workspace.write"], ["files", "mail"]);
		expect(linkRefusal(t, noShare, { attachments: [{ path: "/a", as: "file" }] })).toBeNull();
		// No default is known, so leaving it out may make a link.
		expect(linkRefusal(t, noShare, { attachments: [{ path: "/a" }] })?.message).toContain("Without attachments[].as");
	});
	it("a schema that can't be read whole is held to the cautious side: it reaches NoDrive and, without share, can't be used", () => {
		// A $ref loop that holds a link choice can nest it deeper than any path walked.
		const loop = tool("mail_create_draft", {
			properties: { tree: { $ref: "#/$defs/N" } },
			$defs: { N: { type: "object", properties: { as: asChoice, child: { $ref: "#/$defs/N" } } } },
		});
		expect(driveReach(loop)).toBe("write");
		const noShare = grant([...ALL_MAIL, "workspace.write"], ["files", "mail"]);
		expect(linkRefusal(loop, noShare, {})?.code).toBe("not_available");
		expect(shownDescription(loop, noShare)).toBe("Makes a draft. This connection can't create share links, so this tool can't be used here.");
		// A $ref that points nowhere, too.
		const broken = tool("mail_list_labels", { properties: { x: { $ref: "#/$defs/Missing" } } });
		expect(driveReach(broken)).toBe("read");
		// A loop without a link choice is fine: every name and description was still seen once.
		const harmless = tool("mail_list_threads", { properties: { filter: { $ref: "#/$defs/F" } }, $defs: { F: { type: "object", properties: { and: { type: "array", items: { $ref: "#/$defs/F" } } } } } });
		expect(driveReach(harmless)).toBe("none");
	});
});

describe("a live upstream session behind an earlier reconnect_needed (DESIGN 29.6)", () => {
	const nowSec = () => Math.floor(Date.now() / 1000);
	const e = { ...env, NOMAIL_TOOLS_URL: "https://mail-tools.nomail.test/functions/v1/mcp-tools", NOMAIL_TOOLS_KEY: "k".repeat(43) } as typeof env;
	function build(open: OpenOk, answer: { accessToken: string; expiresAt: number } | { dead: true }) {
		const calls: unknown[][] = [];
		const vault = {
			refreshUpstream: async (...args: unknown[]) => {
				calls.push(args);
				return answer;
			},
		};
		const key = randomBytes(32);
		const ctx = mailContext({ env: e, cfg: config(e), rid: "r", open, scopes: ["workspace.read", "mail.read"], apps: ["mail"], vault: vault as never, connectionId: "conn-1", useKey: key });
		return { ctx, calls, key };
	}
	it("mail stays on, and the first token comes from one forced refresh that passes the token it holds", async () => {
		const open = { upstream: { state: "ok", accessToken: "held-token", expiresAt: nowSec() + 3600 }, mailState: "reconnect_needed" } as unknown as OpenOk;
		const { ctx, calls, key } = build(open, { accessToken: "fresh-token", expiresAt: nowSec() + 3600 });
		expect(ctx.state).toBe("on");
		expect(ctx.active).toBe(true);
		expect(await ctx.upstreamToken()).toBe("fresh-token");
		expect(calls).toEqual([["conn-1", key, true, "held-token"]]);
		// Only once per request.
		expect(await ctx.upstreamToken()).toBe("fresh-token");
		expect(calls).toHaveLength(1);
	});
	it("when the vault calls that session dead, mail is ended as before", async () => {
		const open = { upstream: { state: "ok", accessToken: "held-token", expiresAt: nowSec() + 3600 }, mailState: "reconnect_needed" } as unknown as OpenOk;
		const { ctx } = build(open, { dead: true });
		expect(await ctx.upstreamToken()).toBeNull();
	});
	it("mail_state ok: the held token is used, nothing refreshed; a dead upstream session: reconnect_needed", async () => {
		const ok = build({ upstream: { state: "ok", accessToken: "held-token", expiresAt: nowSec() + 3600 }, mailState: "ok" } as unknown as OpenOk, { dead: true });
		expect(await ok.ctx.upstreamToken()).toBe("held-token");
		expect(ok.calls).toHaveLength(0);
		const dead = build({ upstream: { state: "dead" }, mailState: "reconnect_needed" } as unknown as OpenOk, { dead: true });
		expect(dead.ctx.state).toBe("reconnect_needed");
		expect(dead.ctx.active).toBe(false);
	});
});
