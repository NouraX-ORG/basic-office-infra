/**
 * docs/mcp.md section 6 (mail) against lane E's code, run on NoMail's 18 published tools: which tools
 * need "Read mail" and which "Write and send mail", which ones the app asks about first, and which
 * ones also need the Files app (DESIGN 26.1, 26.4). The 403 table in 6.1 is lane F's test.
 */
import { describe, expect, it } from "vitest";
import { driveReach, linkChoice } from "../../src/mail/access";
import { MAIL_TOOL_ERROR } from "../../src/mail/index";
import { validateProviderTools } from "../../src/mail/validate";
import { NOMAIL_18 } from "./nomail18";

const files = import.meta.glob("../../../docs/mcp.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const DOC = Object.values(files)[0] ?? "";

/** Section 6 up to its first subsection (6.1). */
function mailSection(): string {
	const start = DOC.indexOf("## 6. Mail from NoMail");
	expect(start, "docs/mcp.md has section 6").toBeGreaterThanOrEqual(0);
	const rest = DOC.slice(start);
	const end = rest.search(/\n#{2,3} 6\.1 /);
	return end < 0 ? rest : rest.slice(0, end);
}

/** The tool names in the bullet that starts with `lead`. */
function bulletNames(md: string, lead: string): string[] {
	const at = md.indexOf(`- **${lead}`);
	expect(at, `section 6 has the bullet "${lead}"`).toBeGreaterThanOrEqual(0);
	const rest = md.slice(at + 2);
	const end = rest.search(/\n- \*\*|\n\n/);
	const text = end < 0 ? rest : rest.slice(0, end);
	return [...text.matchAll(/`(mail_[a-z0-9_]+)`/g)].map((m) => m[1] as string);
}

const sorted = (xs: string[]) => [...new Set(xs)].sort();

describe("docs/mcp.md section 6 says what the code does with NoMail's tools", () => {
	const tools = validateProviderTools(NOMAIL_18).tools;
	it("names every one of NoMail's tools under the scope it needs", () => {
		const md = mailSection();
		expect(sorted(bulletNames(md, "Read (need"))).toEqual(sorted(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)));
		expect(sorted(bulletNames(md, "Write (need"))).toEqual(sorted(tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name)));
	});
	it("names exactly the tools the app asks about first", () => {
		const md = mailSection();
		const asks = tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name);
		expect(asks).toHaveLength(6);
		expect(sorted(bulletNames(md, "The app asks you first for"))).toEqual(sorted(asks));
		expect(md).toContain("The app asks you first for 6 of them");
	});
	it("lists the tools that use NoDrive, each with what it also needs, and the link rule", () => {
		const md = mailSection();
		const reach = Object.fromEntries(tools.filter((t) => driveReach(t) !== "none").map((t) => [t.name, driveReach(t)]));
		expect(reach).toEqual({ mail_attach_drive_file: "read", mail_save_attachment_to_drive: "write" });
		const rows = md.split("\n").filter((l) => l.startsWith("| `mail_"));
		expect(rows.map((r) => /`(mail_[a-z0-9_]+)`/.exec(r)?.[1])).toEqual(Object.keys(reach));
		const attach = rows.find((r) => r.includes("mail_attach_drive_file")) ?? "";
		const save = rows.find((r) => r.includes("mail_save_attachment_to_drive")) ?? "";
		for (const row of [attach, save]) expect(row).toContain('"Files and sharing (NoDrive)"');
		expect(attach).toContain('"Read"');
		expect(save).toContain('"Create and edit"');
		const link = linkChoice(tools.find((t) => t.name === "mail_attach_drive_file") as (typeof tools)[number]);
		expect(link).toEqual({ prop: "as", safe: ["file"], fallback: "auto" });
		expect(attach).toContain('"Share and invite"');
		expect(attach).toContain('only `as` "file"');
		expect(md).toContain(`\`${MAIL_TOOL_ERROR}\``);
	});
});
