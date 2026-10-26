/**
 * Lane B fix round 3, live contacts cases (DESIGN 17.6), as qa-t1-211, against drive.nourax.org:
 * a card made "in another app" (straight over CardDAV as qa-t1-211, into the person's own book)
 * with 30 email addresses, one of them with PREF and a second type, a 3,000-character
 * organisation and a TEL written as a tel: uri.
 * - contacts_get and contacts_search answer within one result, saying what isn't shown;
 * - contacts_update gives no undo after removing an entry it couldn't put back exactly, and an
 *   exact undo (which runs) for a plain one.
 * The card stays in the QA account (there is no delete tool, and nothing else is deleted).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { A, call, cardDav, devToken, ok, RUN } from "../sharing/live";

const RESULT_CHARS = 60_000;
const CARD = `mcp-qa-b-fix3-${RUN}.vcf`;
const ID = `contacts/${CARD}`;
const NAME = `Fix Three ${RUN}`;
const PREF = `pref${RUN}@example.invalid`;
const HOME = `home${RUN}@example.invalid`;

let token = "";

function bounded(r: { content: { text: string }[]; structuredContent: unknown }): void {
	expect(JSON.stringify(r.structuredContent).length).toBeLessThanOrEqual(RESULT_CHARS);
	expect(r.content[0]?.text.length ?? 0).toBeLessThanOrEqual(RESULT_CHARS);
	expect(r.content[0]?.text ?? "").not.toContain("[Cut short");
}

beforeAll(async () => {
	token = await devToken(A);
	const jcard = [
		"vcard",
		[
			["version", {}, "text", "4.0"],
			["uid", {}, "text", `mcp-qa-b-fix3-${RUN}`],
			["fn", {}, "text", NAME],
			["n", {}, "text", ["Three", "Fix", "", "", ""]],
			["org", {}, "text", ["O".repeat(3_000)]],
			["email", { type: ["work", "internet"], pref: "1" }, "text", PREF],
			["email", { type: "home" }, "text", HOME],
			...Array.from({ length: 28 }, (_, i) => ["email", {}, "text", `many${i}-${RUN}@example.invalid`]),
			["tel", { type: "cell" }, "uri", "tel:+44-20-7946-0001"],
		],
	];
	const put = await cardDav(A, "PUT", "contacts", CARD, jcard);
	expect(put.status).toBe(201);
});

describe("live: contacts fix round 3", () => {
	it("contacts_get and contacts_search answer within one result and say what isn't shown", async () => {
		const g = ok(await call(token, "contacts_get", { contact_id: ID }), "get the large card");
		bounded(g);
		const c = g.structuredContent.contact;
		expect(c.emails).toHaveLength(20);
		expect(c.emails_total).toBe(30);
		expect(c.organization).toHaveLength(255);
		expect(c.truncated_fields).toContain("organization");
		expect(g.content[0]?.text.split("\n")[0]).toMatch(/Some of it is longer than shown here/);
		// What the server keeps for the PREF entry and the tel: uri (shapes only, no values).
		const raw = JSON.parse((await cardDav(A, "GET", "contacts", CARD)).body) as [string, unknown[][]];
		const pref = raw[1].find((p) => p[0] === "email" && String(p[3]).startsWith("pref"));
		const tel = raw[1].find((p) => p[0] === "tel");
		console.log(`server shapes: pref email params ${JSON.stringify(pref?.[1])}, tel value type ${String(tel?.[2])}`);

		const s = ok(await call(token, "contacts_search", { query: NAME }), "search it");
		bounded(s);
		const hit = (s.structuredContent.contacts as { contact_id: string; emails: string[]; organization: string }[]).find((h) => h.contact_id === ID);
		expect(hit?.emails).toHaveLength(10);
		expect(hit?.organization).toHaveLength(255);
	});

	it("contacts_update gives no undo for entries it couldn't put back exactly, and an exact one that runs for a plain entry", async () => {
		const p = ok(await call(token, "contacts_update", { contact_id: ID, remove_emails: [PREF] }), "remove the PREF email");
		bounded(p);
		expect(p.structuredContent.undo).toBeNull();
		expect(p.structuredContent.warnings).toContain("This change can't be undone automatically.");
		expect(p.structuredContent.contact.emails_total).toBe(29);

		const t = ok(await call(token, "contacts_update", { contact_id: ID, remove_phones: ["+442079460001"] }), "remove the tel: uri");
		expect(t.structuredContent.contact.phones).toEqual([]);
		expect(t.structuredContent.undo).toBeNull();

		const h = ok(await call(token, "contacts_update", { contact_id: ID, remove_emails: [HOME] }), "remove the plain home email");
		expect(h.structuredContent.undo).toEqual({ tool: "contacts_update", arguments: { contact_id: ID, add_emails: [{ address: HOME, label: "home" }] } });
		const back = ok(await call(token, "contacts_update", h.structuredContent.undo.arguments), "run the undo");
		expect(back.structuredContent.contact.emails_total).toBe(29);
		const raw = JSON.parse((await cardDav(A, "GET", "contacts", CARD)).body) as [string, unknown[][]];
		const home = raw[1].filter((p) => p[0] === "email" && p[3] === HOME);
		expect(home).toHaveLength(1);
		expect(JSON.stringify(home[0]?.[1]).toLowerCase()).toBe('{"type":"home"}');
	});
});
