/**
 * docs_create_document, docs_create_spreadsheet and docs_create_presentation (DESIGN 11.4): new
 * Office files built in the Worker by our own writers (12.1) and saved with If-None-Match: *, so an
 * existing file is never replaced.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import { ifExistsArg, pathArg } from "../../core/shapes";
import { defineTool } from "../../core/tool";
import { parseMarkdown } from "../../docs/markdown";
import { buildDocx, DOCX_MIME } from "../../docs/ooxml/docx";
import { buildPptx, PPTX_MIME, type SlideSpec } from "../../docs/ooxml/pptx";
import { buildXlsx, XLSX_MIME } from "../../docs/ooxml/xlsx";
import { buildSheets, checkInputElements, csvSheet, parseCsv, type SheetInput } from "../../docs/sheets";
import { checkTargetFolder, renamedNote, sizeText, targetPath, writeNewFile } from "./shared";

// ------------------------------------------------------------------ docs_create_document

export const createDocument = defineTool({
	name: "docs_create_document",
	title: "Create a Word document",
	description:
		"Creates a new Word document (.docx) in NoDrive from Markdown: headings, bold, italic, links, bullet and numbered lists, tables, quotes, code blocks and page breaks (<!-- pagebreak -->). It opens in ONLYOFFICE. No images. Up to 400,000 characters. An existing file is never replaced.",
	input: z
		.object({
			path: pathArg('Where to save it, ending in ".docx".'),
			markdown: z.string().max(LIMITS.markdownChars).describe("The content as Markdown."),
			title: z.string().max(255).optional().describe("Title property (not printed)."),
			page_size: z.enum(["A4", "Letter"]).default("A4").describe("Paper size."),
			if_exists: ifExistsArg(),
		})
		.strict(),
	async run(ctx, args) {
		const path = targetPath(args.path, "docx");
		await checkTargetFolder(ctx, path);
		const blocks = parseMarkdown(args.markdown);
		const bytes = buildDocx(blocks, { title: args.title ?? null, creator: ctx.displayName, pageSize: args.page_size });
		const w = await writeNewFile(ctx, path, bytes, DOCX_MIME, args.if_exists);
		const counts = { headings: 0, tables: 0, lists: 0 };
		for (const b of blocks) {
			if (b.kind === "heading") counts.headings++;
			else if (b.kind === "table") counts.tables++;
			else if (b.kind === "list") counts.lists++;
		}
		const parts = [`${counts.headings} heading${counts.headings === 1 ? "" : "s"}`, `${counts.tables} table${counts.tables === 1 ? "" : "s"}`, `${counts.lists} list${counts.lists === 1 ? "" : "s"}`];
		return {
			data: { file: w.file, renamed: w.renamed },
			summary: `Created the Word document ${w.path} (${sizeText(bytes.length)}; ${parts.join(", ")}).${renamedNote(w.renamed, w.path)}`,
		};
	},
});

// ------------------------------------------------------------------ docs_create_spreadsheet

const cellValue = z.union([z.string().max(32_767), z.number().min(-1e300).max(1e300), z.boolean(), z.null()]);

const sheetSchema = z
	.object({
		name: z.string().max(100).optional().describe("Sheet name (31 characters at most)."),
		columns: z
			.array(
				z
					.object({
						header: z.string().max(255).describe("Heading."),
						type: z.enum(["text", "number", "date", "currency", "percent", "formula"]).default("text").describe('date: ISO; percent: 0.25 or "25%"; formula: "=SUM(A2:A9)".'),
						width: z.number().min(2).max(100).optional().describe("Width in characters."),
					})
					.strict(),
			)
			.max(200)
			.optional()
			.describe("Typed columns. Without them the first row is the header."),
		rows: z.array(z.array(cellValue).max(1_000)).max(LIMITS.cells).describe("Rows of values (no header row when columns are given)."),
	})
	.strict();

export const createSpreadsheet = defineTool({
	name: "docs_create_spreadsheet",
	title: "Create a spreadsheet",
	description:
		'Creates a new Excel spreadsheet (.xlsx) in NoDrive from rows or CSV, with one or more sheets. Columns can be typed text, number, date, currency, percent or formula; only a formula column holds formulas, so text starting with "=" stays text. Bold, frozen header row. Up to 20 sheets and 50,000 cells; with sheets, each row and column setting also counts.',
	input: z
		.object({
			path: pathArg('Where to save it, ending in ".xlsx".'),
			sheets: z.array(sheetSchema).min(1).max(LIMITS.sheets).optional().describe("The sheets (or give csv)."),
			csv: z.string().max(2_000_000).optional().describe("CSV for one sheet, header first (or give sheets)."),
			if_exists: ifExistsArg(),
		})
		.strict(),
	async run(ctx, args) {
		const path = targetPath(args.path, "xlsx");
		await checkTargetFolder(ctx, path);
		if ((args.sheets === undefined) === (args.csv === undefined)) {
			throw new ToolError("invalid_input", "Give either sheets or csv (exactly one of them).", { field: "sheets" });
		}
		// Given as sheets, the request is counted as the MCP SDK counts it (50,000 elements), so the
		// limit in the description holds and is refused in plain words; CSV counts cells only.
		if (args.sheets) checkInputElements(args);
		const inputs: SheetInput[] = args.sheets ? (args.sheets as SheetInput[]) : [csvSheet(parseCsv(args.csv as string))];
		const built = buildSheets(inputs);
		const bytes = buildXlsx(built.sheets, { creator: ctx.displayName });
		const w = await writeNewFile(ctx, path, bytes, XLSX_MIME, args.if_exists);
		const n = built.summary.length;
		return {
			data: { file: w.file, renamed: w.renamed, sheets: built.summary },
			summary: `Created the spreadsheet ${w.path} (${sizeText(bytes.length)}; ${n} sheet${n === 1 ? "" : "s"}).${renamedNote(w.renamed, w.path)}`,
			...(built.warnings.length ? { warnings: built.warnings.slice(0, 20) } : {}),
		};
	},
});

// ------------------------------------------------------------------ docs_create_presentation

const bullet = z.union([
	z.string().max(1_000),
	z
		.object({
			text: z.string().max(1_000).describe("Text."),
			level: z.number().int().min(1).max(2).default(1).describe("1, or 2 (indented)."),
		})
		.strict(),
]);

export const createPresentation = defineTool({
	name: "docs_create_presentation",
	title: "Create a presentation",
	description:
		"Creates a new PowerPoint presentation (.pptx) in NoDrive from slides, each with a title, bullets on two levels or body text, optional speaker notes and a layout (title, content or section). It opens in ONLYOFFICE. Up to 60 slides; no images. An existing file is never replaced.",
	input: z
		.object({
			path: pathArg('Where to save it, ending in ".pptx".'),
			slides: z
				.array(
					z
						.object({
							title: z.string().max(255).optional().describe("Title."),
							layout: z.enum(["title", "content", "section"]).default("content").describe("title (opening), content or section (divider)."),
							bullets: z.array(bullet).max(30).optional().describe("Strings, or {text, level: 2} for sub-bullets."),
							body: z.string().max(5_000).optional().describe("Body text (the subtitle on title and section slides)."),
							notes: z.string().max(10_000).optional().describe("Speaker notes."),
						})
						.strict(),
				)
				.min(1)
				.max(LIMITS.slides)
				.describe("The slides, in order."),
			if_exists: ifExistsArg(),
		})
		.strict(),
	async run(ctx, args) {
		const path = targetPath(args.path, "pptx");
		await checkTargetFolder(ctx, path);
		const specs: SlideSpec[] = args.slides.map((s) => ({
			title: s.title ?? "",
			layout: s.layout,
			bullets: (s.bullets ?? []).map((b) => (typeof b === "string" ? { text: b, level: 0 as const } : { text: b.text, level: (b.level === 2 ? 1 : 0) as 0 | 1 })),
			body: s.body ?? "",
			notes: s.notes ?? "",
		}));
		const bytes = buildPptx(specs, { title: specs.find((x) => x.title)?.title ?? null, creator: ctx.displayName });
		const w = await writeNewFile(ctx, path, bytes, PPTX_MIME, args.if_exists);
		return {
			data: { file: w.file, renamed: w.renamed, slides: specs.length },
			summary: `Created the presentation ${w.path} (${sizeText(bytes.length)}; ${specs.length} slide${specs.length === 1 ? "" : "s"}).${renamedNote(w.renamed, w.path)}`,
		};
	},
});
