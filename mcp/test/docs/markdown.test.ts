/** The Markdown subset parser (DESIGN 12.2): blocks, inlines, safe links, and linear time. */
import { describe, expect, it } from "vitest";
import { type Block, type Inline, parseInline, parseMarkdown, plainText, safeHref, scan } from "../../src/docs/markdown";

const kinds = (bs: Block[]) => bs.map((b) => b.kind);

describe("markdown blocks", () => {
	it("reads headings, paragraphs, rules, page breaks and code", () => {
		const bs = parseMarkdown("# One #\n\nText\nmore text\n\n---\n<!-- pagebreak -->\n```ts\nlet a = 1;\n  b();\n```\n###### Six\n####### seven");
		expect(kinds(bs)).toEqual(["heading", "paragraph", "hr", "pagebreak", "code", "heading", "paragraph"]);
		expect(bs[0]).toMatchObject({ kind: "heading", level: 1 });
		expect(plainText((bs[0] as { inlines: Inline[] }).inlines)).toBe("One");
		expect(plainText((bs[1] as { inlines: Inline[] }).inlines)).toBe("Text more text");
		expect(bs[4]).toEqual({ kind: "code", lines: ["let a = 1;", "  b();"], lang: "ts" });
		expect(bs[5]).toMatchObject({ level: 6 });
	});
	it("reads setext headings", () => {
		const bs = parseMarkdown("Title\n=====\n\nSub\n---");
		expect(bs.map((b) => (b.kind === "heading" ? b.level : 0))).toEqual([1, 2]);
	});
	it("nests lists by indentation, three levels at most, and keeps ordered starts", () => {
		const bs = parseMarkdown("- a\n  - b\n    - c\n      - d\n- e\n\n3. three\n4. four\n");
		// Numbers after bullets start a second list (fix round 2), as in CommonMark.
		expect(kinds(bs)).toEqual(["list", "list"]);
		const items = (bs[0] as Extract<Block, { kind: "list" }>).items;
		expect(items.map((x) => x.level)).toEqual([0, 1, 2, 2, 0]);
		const numbered = (bs[1] as Extract<Block, { kind: "list" }>).items;
		expect(numbered.map((x) => x.level)).toEqual([0, 0]);
		expect(numbered[0]).toMatchObject({ ordered: true, start: 3 });
		expect(numbered[1]?.start).toBeUndefined();
	});
	it("fix round 2: a top-level item of the other kind starts a new list; nested items of either kind stay in", () => {
		const lists = (md: string) => parseMarkdown(md).map((b) => (b.kind === "list" ? `list:${b.items.length}` : b.kind));
		expect(lists("- a\n- b\n\n1. first\n2. second")).toEqual(["list:2", "list:2"]);
		expect(lists("1. one\n- two\n3. three")).toEqual(["list:1", "list:1", "list:1"]);
		// Bullets under a numbered item (and the reverse) belong to the same list.
		expect(lists("1. one\n   - sub\n2. two\n   1. subsub")).toEqual(["list:4"]);
		expect(lists("- a\n\n- b")).toEqual(["list:2"]);
	});
	it("continues list items lazily and after an indented blank line", () => {
		const bs = parseMarkdown("- first\ncontinued\n\n  again\n- second");
		const items = (bs[0] as Extract<Block, { kind: "list" }>).items;
		expect(items).toHaveLength(2);
		expect(plainText(items[0]?.inlines ?? [])).toBe("first continued again");
	});
	it("reads GFM tables with alignment and escaped pipes", () => {
		const bs = parseMarkdown("| Name | Qty |\n|:---|---:|\n| a \\| b | 2 |\n| c |\n\nafter");
		const t = bs[0] as Extract<Block, { kind: "table" }>;
		expect(t.kind).toBe("table");
		expect(t.align).toEqual(["left", "right"]);
		expect(t.rows.map((r) => r.map(plainText))).toEqual([
			["a | b", "2"],
			["c", ""],
		]);
		expect(kinds(bs)).toEqual(["table", "paragraph"]);
	});
	it("a table can follow a paragraph without a blank line", () => {
		expect(kinds(parseMarkdown("Intro\n| a | b |\n|---|---|\n| 1 | 2 |"))).toEqual(["paragraph", "table"]);
	});
	it("reads quotes, flattening nested ones", () => {
		const bs = parseMarkdown("> one\n> > two\n>\n> three");
		expect(bs[0]).toMatchObject({ kind: "quote" });
		expect((bs[0] as Extract<Block, { kind: "quote" }>).paragraphs.map(plainText)).toEqual(["one two", "three"]);
	});
	it("keeps raw HTML as literal text", () => {
		const bs = parseMarkdown('<script>alert("x")</script>');
		expect(plainText((bs[0] as { inlines: Inline[] }).inlines)).toBe('<script>alert("x")</script>');
	});
	it("an empty document has no blocks", () => {
		expect(parseMarkdown("")).toEqual([]);
		expect(parseMarkdown("\n  \n\t\n")).toEqual([]);
	});
});

describe("markdown inlines", () => {
	it("emphasis, strong, strike and code", () => {
		const r = parseInline("a *b* **c** ***d*** ~~e~~ `f*g*` _h_ __i__");
		const find = (t: string) => r.find((x) => x.text === t);
		expect(find("b")).toMatchObject({ i: true });
		expect(find("c")).toMatchObject({ b: true });
		expect(find("d")).toMatchObject({ b: true, i: true });
		expect(find("e")).toMatchObject({ s: true });
		expect(find("f*g*")).toMatchObject({ code: true });
		expect(find("h")).toMatchObject({ i: true });
		expect(find("i")).toMatchObject({ b: true });
	});
	it("snake_case words are not italic, and unmatched markers stay text", () => {
		expect(plainText(parseInline("file_name_here and *open"))).toBe("file_name_here and *open");
		expect(parseInline("file_name_here").every((x) => !x.i)).toBe(true);
	});
	it("only https: and mailto: become links", () => {
		const r = parseInline("[ok](https://example.org/a_(b)) [bad](javascript:alert(1)) [plain](http://x.org) <mailto:a@b.org> see https://nourax.org/x.");
		const links = r.filter((x) => x.href).map((x) => x.href);
		expect(links).toEqual(["https://example.org/a_(b)", "mailto:a@b.org", "https://nourax.org/x"]);
		expect(plainText(r)).toContain("bad (javascript:alert(1))");
		expect(plainText(r)).toContain("plain (http://x.org)");
		expect(plainText(r).endsWith("https://nourax.org/x.")).toBe(true);
	});
	it("hard breaks from two spaces or a backslash", () => {
		const r = parseInline("one  \ntwo\\\nthree\nfour");
		expect(r.filter((x) => x.br)).toHaveLength(2);
		expect(plainText(r)).toBe("one\ntwo\nthree four");
	});
	it("escapes", () => {
		expect(plainText(parseInline("\\*not\\* \\[x\\]"))).toBe("*not* [x]");
	});
	it("safeHref refuses control characters, spaces and other schemes", () => {
		expect(safeHref("https://a.org")).toBe("https://a.org");
		expect(safeHref("HTTPS://a.org")).toBe("HTTPS://a.org");
		expect(safeHref("https://a.org/\nx")).toBeNull();
		expect(safeHref("data:text/html,x")).toBeNull();
		expect(safeHref("https://")).toBeNull();
		expect(safeHref("mailto:")).toBeNull();
	});
});

describe("markdown stays linear on hostile input", () => {
	const cases: [string, string][] = [
		["stars", "*".repeat(200_000)],
		["star words", "*a ".repeat(100_000)],
		["underscores", "_a".repeat(100_000)],
		["brackets", "[".repeat(150_000)],
		["bracket pairs", "[a](".repeat(80_000)],
		["backticks", "` ``".repeat(80_000)],
		["autolinks", "<https://".repeat(40_000)],
		["urls", "https://".repeat(40_000)],
		["spaces then newline", `${"a ".repeat(100_000)}\n${" ".repeat(100_000)}x`],
		["tildes", "~~a".repeat(100_000)],
		["list markers", "- \n".repeat(100_000)],
		["table pipes", `|${"a|".repeat(60)}\n|${"-|".repeat(60)}\n${"|x".repeat(100_000)}`],
		["quote markers", ">".repeat(200_000)],
		["hashes", `#${"#".repeat(200_000)} x`],
	];
	for (const [name, input] of cases) {
		it(`${name} (${input.length.toLocaleString("en-GB")} characters)`, () => {
			const t = performance.now();
			parseMarkdown(input);
			// workerd's clock only moves across I/O, so this mainly guards against a hang; the
			// limit is generous for slow CI machines.
			expect(performance.now() - t).toBeLessThan(5000);
		});
	}
});

describe("fix round 3: many short lines stay linear (the clock is frozen in workerd, so count the work)", () => {
	// Before the fix, tokenize read the end of one growing buffer on every "\n" (buf.endsWith("  "),
	// trimSpacesEnd), which flattens a V8 rope each time: quadratic on a paragraph of many short
	// lines (a 200,000-line paragraph took ~11.5 s in Node). None of the hostile cases above has a
	// paragraph of short lines, and workerd's clock can't measure it. These count the trailing-space
	// bookkeeping: it must stay linear in the input length. The committed Node harness
	// test/docs/perf/markdown-linear.ts measures wall-clock scaling as well.
	const count = (input: string): number => {
		scan.on = true;
		scan.ops = 0;
		try {
			parseMarkdown(input);
			return scan.ops;
		} finally {
			scan.on = false;
		}
	};
	const cases: [string, (n: number) => string][] = [
		["a paragraph of short lines", (n) => "a\n".repeat(n)],
		["a lazy list item", (n) => `- a\n${"b\n".repeat(n - 1)}`],
		["a block quote", (n) => "> a\n".repeat(n)],
		["CRLF line endings", (n) => "a\r\n".repeat(n)],
	];
	for (const [name, make] of cases) {
		it(`${name}: work is O(n), not O(n squared)`, () => {
			const small = make(50_000);
			const big = make(100_000);
			const opsSmall = count(small);
			const opsBig = count(big);
			// Linear: the work per character is bounded (a quadratic version would be ~n, i.e. tens of
			// thousands, per character here).
			expect(opsSmall).toBeLessThan(small.length * 10);
			expect(opsBig).toBeLessThan(big.length * 10);
			// Doubling the input about doubles the work (never squares it).
			expect(opsBig / Math.max(1, opsSmall)).toBeLessThan(3);
		});
	}
	it("the many-short-line cases still parse to the right blocks", () => {
		const para = parseMarkdown("a\n".repeat(200_000));
		expect(para).toHaveLength(1);
		expect(para[0]?.kind).toBe("paragraph");
		expect(plainText((para[0] as { inlines: Inline[] }).inlines)).toHaveLength(200_000 + 199_999);

		const list = parseMarkdown(`- a\n${"b\n".repeat(199_998)}`);
		expect(list).toHaveLength(1);
		const items = (list[0] as Extract<Block, { kind: "list" }>).items;
		expect(items).toHaveLength(1);
		expect(plainText(items[0]?.inlines ?? [])).toMatch(/^a b b /);

		const quote = parseMarkdown("> a\n".repeat(100_000));
		expect(quote[0]?.kind).toBe("quote");
		expect((quote[0] as Extract<Block, { kind: "quote" }>).paragraphs).toHaveLength(1);

		// CRLF folds to one paragraph, like LF.
		const crlf = parseMarkdown("one\r\ntwo\r\nthree");
		expect(crlf.map((b) => b.kind)).toEqual(["paragraph"]);
		expect(plainText((crlf[0] as { inlines: Inline[] }).inlines)).toBe("one two three");
	});
	it("hard breaks from trailing spaces still work after the rewrite", () => {
		const r = parseInline("one  \ntwo   \nthree\nfour");
		expect(r.filter((x) => x.br)).toHaveLength(2);
		expect(plainText(r)).toBe("one\ntwo\nthree four");
	});
});
