/** Unit tests for src/pim/vcard.ts: reading the server's jCard, writing new cards, edits and undo. */
import { describe, expect, it } from "vitest";
import { ToolError } from "../../../src/core/errors";
import { cleanAddresses } from "../../../src/tools/contacts/shapes";
import { contactsUpdate, undoReplayable } from "../../../src/tools/contacts/update";
import { addressInput, checkBirthday, checkEmail, checkPhone, checkWebsite, cleanText, editCard, fromJCard, newCard, parseJCard, phoneKey, readCard, serializeCard } from "../../../src/pim/vcard";

/** What the live server sent for a directory card (REPORT, 2026-10-25), plus more fields. */
const SERVER = [
	"vcard",
	[
		["version", {}, "text", "4.0"],
		["uid", {}, "text", "nourax-qa-t1-211"],
		["fn", {}, "text", "Ana Diaz"],
		["n", {}, "text", ["Diaz", ["Ana", "Maria"], "", "Dr.", ""]],
		["email", { type: "work" }, "text", "ana@acme.example"],
		["email", { type: ["HOME", "pref"] }, "text", "ana@home.example"],
		["tel", { type: ["CELL", "VOICE"] }, "uri", "tel:+44 20 7946 0958"],
		["tel", { type: "fax" }, "text", "+44 20 7946 0000"],
		["org", {}, "text", ["Acme", "Sales"]],
		["title", {}, "text", "Lead"],
		["adr", { type: "work" }, "text", ["", "Floor 2", "1 High St", "London", "", "N1 1AA", "UK"]],
		["bday", {}, "date", "19900531"],
		["url", {}, "uri", "https://acme.example/ana"],
		["url", {}, "uri", "https://ana.example"],
		["note", {}, "text", "Met at the fair."],
		["x-custom", {}, "unknown", "keep me"],
		["photo", {}, "uri", "data:image/png;base64,AAAA"],
	],
];

describe("reading jCard", () => {
	it("reads every field we show, from the server's shapes", () => {
		const f = readCard(fromJCard(structuredClone(SERVER)));
		expect(f).toEqual({
			uid: "nourax-qa-t1-211",
			full_name: "Ana Diaz",
			given_name: "Ana Maria",
			family_name: "Diaz",
			emails: [
				{ address: "ana@acme.example", label: "work" },
				{ address: "ana@home.example", label: "home" },
			],
			phones: [
				{ number: "+44 20 7946 0958", label: "mobile" },
				{ number: "+44 20 7946 0000", label: "fax" },
			],
			organization: "Acme, Sales",
			job_title: "Lead",
			addresses: [{ street: "Floor 2, 1 High St", city: "London", region: null, postal_code: "N1 1AA", country: "UK", label: "work" }],
			birthday: "1990-05-31",
			websites: ["https://acme.example/ana", "https://ana.example"],
			notes: "Met at the fair.",
		});
	});
	it("accepts the server's two-element jCard and refuses anything else", () => {
		expect(readCard(parseJCard('["vcard",[["version",{},"text","4.0"],["fn",{},"text","X"]]]')).full_name).toBe("X");
		for (const bad of ["", "{}", '["vcalendar",[]]', '["vcard",[["fn","x"]]]', "[1,2", '["vcard",{}]']) {
			expect(() => parseJCard(bad), bad).toThrow(ToolError);
		}
	});
});

describe("writing new cards", () => {
	it("builds a vCard 4.0 jCard with TEL as text and labels as TYPE", () => {
		const j = newCard(
			{
				given_name: "Ana",
				family_name: "Diaz",
				emails: [{ address: "a@b.example", label: "work" }],
				phones: [
					{ number: "+44 1", label: "mobile" },
					{ number: "+44 2", label: "home" },
					{ number: "+44 3", label: "other" },
				],
				organization: "Acme",
				addresses: [{ street: "1 High St", city: "London", region: null, postal_code: null, country: "UK", label: "home" }],
				birthday: "--05-31",
				website: "https://a.example/",
				notes: "line 1\nline 2",
			},
			"uid-1",
		);
		expect(j).toEqual([
			"vcard",
			[
				["version", {}, "text", "4.0"],
				["prodid", {}, "text", "-//Nourax//Nourax Workspace AI connector//EN"],
				["uid", {}, "text", "uid-1"],
				["fn", {}, "text", "Ana Diaz"],
				["n", {}, "text", ["Diaz", "Ana", "", "", ""]],
				["email", { type: "work" }, "text", "a@b.example"],
				["tel", { type: "cell" }, "text", "+44 1"],
				["tel", { type: ["home", "voice"] }, "text", "+44 2"],
				["tel", { type: "voice" }, "text", "+44 3"],
				["org", {}, "text", ["Acme"]],
				["adr", { type: "home" }, "text", ["", "", "1 High St", "London", "", "", "UK"]],
				["bday", {}, "date", "--05-31"],
				["url", {}, "uri", "https://a.example/"],
				["note", {}, "text", "line 1\nline 2"],
			],
			[],
		]);
		const back = readCard(fromJCard(j));
		expect(back.phones.map((p) => p.label)).toEqual(["mobile", "home", "other"]);
		expect(back.birthday).toBe("--05-31");
	});
	it("keeps text that looks like vCard syntax as plain data (the server escapes it)", () => {
		const evil = "x\nEND:VCARD\nBEGIN:VCARD\nFN:Mallory";
		const j = newCard({ full_name: "Ok", notes: evil }, "u");
		const card = fromJCard(JSON.parse(JSON.stringify(j)));
		expect(readCard(card).notes).toBe(evil);
		expect(card.getAllProperties("fn")).toHaveLength(1);
	});
});

describe("editing", () => {
	it("changes only the named properties, keeps unknown ones, and gives an exact undo", () => {
		const card = fromJCard(structuredClone(SERVER));
		const r = editCard(card, {
			family_name: "Lopez",
			job_title: null,
			add_emails: [{ address: "new@acme.example", label: "work" }],
			remove_emails: ["ANA@ACME.EXAMPLE", "missing@x.example"],
			remove_phones: ["+44 (20) 7946-0000"],
			birthday: "1990-06-01",
		});
		expect(r.changed).toEqual(["family_name", "job_title", "birthday", "emails", "phones"]);
		expect(r.warnings).toEqual(["full_name was left as it is; give full_name to change it as well.", "missing@x.example wasn't on the contact."]);
		const after = readCard(card);
		expect(after.family_name).toBe("Lopez");
		expect(after.full_name).toBe("Ana Diaz");
		expect(after.job_title).toBeNull();
		expect(after.emails.map((e) => e.address)).toEqual(["ana@home.example", "new@acme.example"]);
		expect(after.phones.map((p) => p.label)).toEqual(["mobile"]);
		const json = JSON.parse(serializeCard(card)) as unknown[][];
		const names = (json[1] as unknown[][]).map((p) => p[0]);
		expect(names).toContain("x-custom");
		expect(names).toContain("photo");
		// N keeps its other parts.
		expect((json[1] as unknown[][]).find((p) => p[0] === "n")?.[3]).toEqual(["Lopez", "Ana Maria", "", "Dr.", ""]);
		expect(r.inverse).toEqual({
			family_name: "Diaz",
			job_title: "Lead",
			birthday: "1990-05-31",
			remove_emails: ["new@acme.example"],
			add_emails: [{ address: "ana@acme.example", label: "work" }],
			add_phones: [{ number: "+44 20 7946 0000", label: "fax" }],
		});
		// Applying the inverse gives the same view back.
		editCard(card, r.inverse as never);
		const restored = readCard(card);
		const original = readCard(fromJCard(structuredClone(SERVER)));
		expect({ ...restored, emails: [...restored.emails].sort((a, b) => a.address.localeCompare(b.address)), phones: [...restored.phones].sort((a, b) => a.label.localeCompare(b.label)) }).toEqual({
			...original,
			emails: [...original.emails].sort((a, b) => a.address.localeCompare(b.address)),
			phones: [...original.phones].sort((a, b) => a.label.localeCompare(b.label)),
		});
	});
	it("gives no undo when a removed entry holds more than the undo would write back (fix round 3)", () => {
		const base = (extra: unknown[][]) => fromJCard(["vcard", [["fn", {}, "text", "Ana Diaz"], ...extra]]);
		// PREF and a second type, as the finding saw: the undo would bring it back as "work" only.
		const pref = base([["email", { type: ["work", "internet"], pref: "1" }, "text", "ana@acme.example"]]);
		expect(editCard(pref, { remove_emails: ["ana@acme.example"] }).inverse).toBeNull();
		// A TEL written as a tel: uri, or with a type our writer doesn't give that label.
		const uri = base([["tel", { type: "cell" }, "uri", "tel:+44 20 7946 0958"]]);
		expect(editCard(uri, { remove_phones: ["+442079460958"] }).inverse).toBeNull();
		const workOnly = base([["tel", { type: "work" }, "text", "+44 1"]]);
		expect(editCard(workOnly, { remove_phones: ["+44 1"] }).inverse).toBeNull();
		// Two numbers with the same digits are both removed, and the undo could add back only one.
		const twice = base([
			["tel", { type: "cell" }, "text", "+44 20 7946 0958"],
			["tel", { type: "cell" }, "text", "+442079460958"],
		]);
		const t = editCard(twice, { remove_phones: ["+44 20 7946 0958"] });
		expect(readCard(twice).phones).toEqual([]);
		expect(t.inverse).toBeNull();
		// The same address twice, in two cases.
		const dup = base([
			["email", {}, "text", "a@b.example"],
			["email", { type: "home" }, "text", "A@B.example"],
		]);
		expect(editCard(dup, { remove_emails: ["a@b.example"] }).inverse).toBeNull();
		// A property group (an Apple-style label) would be lost too.
		const grouped = base([["email", { group: "item1" }, "text", "g@b.example"]]);
		expect(editCard(grouped, { remove_emails: ["g@b.example"] }).inverse).toBeNull();
		// Plain entries, in the server's upper case, stay exact, and replaying the undo gives them back.
		const plain = base([
			["email", { type: "WORK" }, "text", "w@b.example"],
			["tel", { type: ["HOME", "VOICE"] }, "text", "+44 2"],
			["tel", { type: "CELL" }, "text", "+44 3"],
		]);
		const p = editCard(plain, { remove_emails: ["w@b.example"], remove_phones: ["+44 2", "+44 3"] });
		expect(p.inverse).toEqual({
			add_emails: [{ address: "w@b.example", label: "work" }],
			add_phones: [
				{ number: "+44 2", label: "home" },
				{ number: "+44 3", label: "mobile" },
			],
		});
		editCard(plain, p.inverse as never);
		expect(readCard(plain)).toMatchObject({ emails: [{ address: "w@b.example", label: "work" }], phones: [{ label: "home" }, { label: "mobile" }] });
	});
	it("gives no undo for single fields that held more than one plain value (fix round 3)", () => {
		const base = (extra: unknown[][]) => fromJCard(["vcard", [["fn", {}, "text", "Ana Diaz"], ...extra]]);
		// A given name in two parts (Ana Maria) would come back as one text.
		const n = fromJCard(["vcard", [["fn", {}, "text", "X"], ["n", {}, "text", ["Diaz", ["Ana", "Maria"], "", "", ""]]]]);
		expect(editCard(n, { given_name: "Bo" }).inverse).toBeNull();
		// A job title with a language parameter, or a note with outer spaces.
		expect(editCard(base([["title", { language: "en" }, "text", "Lead"]]), { job_title: "Boss" }).inverse).toBeNull();
		expect(editCard(base([["note", {}, "text", " spaced "]]), { notes: "x" }).inverse).toBeNull();
		// A birthday with a time is cut to the date; the date in basic form is the same date.
		expect(editCard(base([["bday", {}, "date-and-or-time", "19900531T1000"]]), { birthday: "1990-01-01" }).inverse).toBeNull();
		expect(editCard(base([["bday", {}, "date", "19900531"]]), { birthday: "1990-01-01" }).inverse).toEqual({ birthday: "1990-05-31" });
		// A full name with a parameter, or a web address with a type.
		expect(editCard(base([]), { full_name: "Bo" }).inverse).toEqual({ full_name: "Ana Diaz" });
		expect(editCard(fromJCard(["vcard", [["fn", { pref: "1" }, "text", "Ana"]]]), { full_name: "Bo" }).inverse).toBeNull();
		expect(editCard(base([["url", { type: "work" }, "uri", "https://a.example/"]]), { website: "https://b.example/" }).inverse).toBeNull();
		expect(editCard(base([["url", {}, "uri", "https://a.example/"]]), { website: "https://b.example/" }).inverse).toEqual({ website: "https://a.example/" });
		// An address with a parameter beyond its type.
		const adr = base([["adr", { type: "home", pref: "1" }, "text", ["", "", "1 High St", "York", "", "", ""]]]);
		expect(editCard(adr, { addresses: [] }).inverse).toBeNull();
	});
	it("recomposes the full name when it was the given and family name", () => {
		const card = fromJCard(["vcard", [["fn", {}, "text", "Ana Diaz"], ["n", {}, "text", ["Diaz", "Ana", "", "", ""]]]]);
		const r = editCard(card, { family_name: "Lopez" });
		expect(readCard(card).full_name).toBe("Ana Lopez");
		expect(r.inverse).toEqual({ family_name: "Diaz", full_name: "Ana Diaz" });
	});
	it("says when an edit can't be undone exactly", () => {
		const card = fromJCard(structuredClone(SERVER));
		expect(editCard(card, { organization: "Other" }).inverse).toBeNull();
		const card2 = fromJCard(structuredClone(SERVER));
		expect(editCard(card2, { website: null }).inverse).toBeNull();
		const card3 = fromJCard(structuredClone(SERVER));
		expect(editCard(card3, { addresses: [] }).inverse).toBeNull();
	});
	it("does nothing when the values are already there", () => {
		const card = fromJCard(structuredClone(SERVER));
		const r = editCard(card, { full_name: "Ana Diaz", add_emails: [{ address: "ANA@acme.example", label: "work" }], add_phones: [{ number: "+442079460958", label: "mobile" }] });
		expect(r.changed).toEqual([]);
		expect(r.inverse).toBeNull();
		expect(r.warnings).toHaveLength(2);
	});
	it("gives addresses back in contacts_update's own input shape, and the undo puts them back (fix round 1)", () => {
		const york = ["adr", { type: "home" }, "text", ["", "", "1 High St", "York", "", "", ""]];
		const leeds = ["adr", {}, "text", ["", "", "", "Leeds", "", "LS1 1AA", "UK"]];
		const card = fromJCard(["vcard", [["fn", {}, "text", "Ana Diaz"], york, leeds]]);
		const original = readCard(card).addresses;
		const r = editCard(card, { addresses: cleanAddresses([{ street: "2 Low Rd", city: "Hull", label: "work" }]) });
		expect(r.changed).toEqual(["addresses"]);
		// No nulls: the input of contacts_update takes optional strings, not null.
		expect(r.inverse).toEqual({
			addresses: [
				{ street: "1 High St", city: "York", label: "home" },
				{ city: "Leeds", postal_code: "LS1 1AA", country: "UK", label: "other" },
			],
		});
		const undoArgs = { contact_id: "contacts/ana.vcf", ...r.inverse };
		expect(contactsUpdate.input.safeParse(undoArgs).success).toBe(true);
		expect(undoReplayable(undoArgs)).toBe(true);
		// Applying it the way contacts_update does gives the earlier addresses back.
		const parsed = contactsUpdate.input.parse(undoArgs) as { addresses: Parameters<typeof cleanAddresses>[0] };
		editCard(card, { addresses: cleanAddresses(parsed.addresses) });
		expect(readCard(card).addresses).toEqual(original);
	});
	it("addressInput leaves out empty parts and keeps the label", () => {
		expect(addressInput({ street: null, city: "York", region: "", postal_code: null, country: "UK", label: "work" })).toEqual({ city: "York", country: "UK", label: "work" });
	});
	it("an undo with values the tool's input refuses is not offered (contacts_update checks it)", () => {
		const long = fromJCard(["vcard", [["fn", {}, "text", "X"], ["adr", {}, "text", ["", "", "S".repeat(300), "York", "", "", ""]]]]);
		const a = editCard(long, { addresses: [] });
		expect(a.inverse).not.toBeNull();
		expect(undoReplayable({ contact_id: "contacts/x.vcf", ...a.inverse })).toBe(false);
		const odd = fromJCard(["vcard", [["fn", {}, "text", "X"], ["email", {}, "text", "x@localhost"], ["bday", {}, "date", "1700-01-01"]]]);
		const b = editCard(odd, { remove_emails: ["x@localhost"] });
		expect(b.inverse).toEqual({ add_emails: [{ address: "x@localhost", label: "other" }] });
		expect(undoReplayable({ contact_id: "contacts/x.vcf", ...b.inverse })).toBe(false);
		const c = editCard(odd, { birthday: "1990-01-01" });
		expect(c.inverse).toEqual({ birthday: "1700-01-01" });
		expect(undoReplayable({ contact_id: "contacts/x.vcf", ...c.inverse })).toBe(false);
		expect(undoReplayable({ contact_id: "contacts/x.vcf", birthday: "1990-01-01" })).toBe(true);
	});
	it("an undo the tool's own clean-up would change is not offered either (fix round 3)", () => {
		const id = { contact_id: "contacts/x.vcf" };
		// The web address comes back in its normal form, so "https://a.example" would return with a "/".
		expect(undoReplayable({ ...id, website: "https://a.example" })).toBe(false);
		expect(undoReplayable({ ...id, website: "https://a.example/" })).toBe(true);
		// Notes and names are cleaned: tabs, outer spaces, line breaks in a name.
		expect(undoReplayable({ ...id, notes: "a\tb" })).toBe(false);
		expect(undoReplayable({ ...id, notes: "line one\nline two" })).toBe(true);
		expect(undoReplayable({ ...id, given_name: "Ana\nMaria" })).toBe(false);
		expect(undoReplayable({ ...id, full_name: " Ana" })).toBe(false);
		// Entries and addresses the same way.
		expect(undoReplayable({ ...id, add_emails: [{ address: " a@b.example", label: "work" }] })).toBe(false);
		expect(undoReplayable({ ...id, add_phones: [{ number: "+44 1", label: "home" }] })).toBe(true);
		expect(undoReplayable({ ...id, addresses: [{ street: "1  High St\u0007", label: "home" }] })).toBe(false);
		expect(undoReplayable({ ...id, addresses: [{ street: "1 High St", city: "York", label: "home" }] })).toBe(true);
		expect(undoReplayable({ ...id, addresses: [] })).toBe(true);
	});
});

describe("input checks", () => {
	it("accepts real values and refuses bad ones with the field named", () => {
		expect(checkEmail(" a.b@c.example ", "e")).toBe("a.b@c.example");
		expect(checkPhone("+44 (20) 7946-0958 ext 12", "p")).toBe("+44 (20) 7946-0958 ext 12");
		expect(phoneKey("tel:+44 (20) 79")).toBe("+442079");
		expect(checkWebsite("https://a.example/x?y=1", "w")).toBe("https://a.example/x?y=1");
		expect(checkBirthday("2000-02-29", "b")).toBe("2000-02-29");
		expect(checkBirthday("--02-29", "b")).toBe("--02-29");
		for (const [fn, v] of [
			[checkEmail, "not-an-email"],
			[checkEmail, "a@b"],
			[checkEmail, "a b@c.example"],
			[checkPhone, "call me"],
			[checkPhone, "+44;20"],
			[checkWebsite, "javascript:alert(1)"],
			[checkWebsite, "ftp://a.example"],
			[checkWebsite, "https://u:p@a.example"],
			[checkBirthday, "2001-02-29"],
			[checkBirthday, "31/05/1990"],
		] as const) {
			try {
				(fn as (a: string, b: string) => string)(v, "field_x");
				throw new Error(`accepted ${v}`);
			} catch (e) {
				expect(e).toBeInstanceOf(ToolError);
				expect((e as ToolError).code).toBe("invalid_input");
				expect((e as ToolError).field).toBe("field_x");
			}
		}
	});
	it("cleans control characters and keeps newlines only where asked", () => {
		expect(cleanText(" a\u0000b\u0007\r\nc d﻿ ")).toBe("ab c" + "d");
		expect(cleanText("a\r\nb\tc", true)).toBe("a\nb c");
	});
});
