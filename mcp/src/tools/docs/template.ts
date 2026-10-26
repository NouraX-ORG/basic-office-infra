/**
 * docs_list_template_fields and docs_fill_template (DESIGN 11.4 and 12.3). Templates are Word,
 * Excel or PowerPoint files (also .dotx, .xltx and .potx) of at most 10 MB. Filling always makes a
 * new file; the template itself is never changed.
 */
import { z } from "zod";
import { ToolError } from "../../core/errors";
import { LIMITS } from "../../core/limits";
import { normalizePath, type UserPath } from "../../core/paths";
import { ifExistsArg, pathArg } from "../../core/shapes";
import { defineTool, type ToolCtx } from "../../core/tool";
import { DOC_LIMITS } from "../../docs/limits";
import { fillTemplate, listFields, TEMPLATE_EXTS, validKey } from "../../docs/template";
import { DOCX_MIME } from "../../docs/ooxml/docx";
import { PPTX_MIME } from "../../docs/ooxml/pptx";
import { XLSX_MIME } from "../../docs/ooxml/xlsx";
import { checkTargetFolder, extOf, mustBeFile, renamedNote, savedOutput, sizeText, targetPath, writeNewFile } from "./shared";

const MIME = { docx: DOCX_MIME, xlsx: XLSX_MIME, pptx: PPTX_MIME } as const;
const TEMPLATE_MIME: Record<string, string> = {
	dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
	xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
	potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
};

function templateKind(path: UserPath, field: string) {
	const ext = extOf(path);
	const kind = TEMPLATE_EXTS[ext];
	if (!kind) {
		throw new ToolError("unsupported_type", `Templates must be Word, Excel or PowerPoint files (.docx, .xlsx, .pptx, .dotx, .xltx, .potx); ${path} isn't.`, { field });
	}
	return { ext, ...kind };
}

async function readTemplate(ctx: ToolCtx, path: UserPath): Promise<Uint8Array> {
	const info = await ctx.nc.files.stat(path);
	mustBeFile(info, "template_path");
	if (info.size > LIMITS.templateBytes) {
		throw new ToolError("too_large", `${path} is ${sizeText(info.size)}. Templates can be at most 10 MB.`);
	}
	const r = await ctx.nc.files.read(path, { maxBytes: LIMITS.templateBytes });
	if (r.truncated) throw new ToolError("too_large", `${path} is larger than 10 MB. Templates can be at most 10 MB.`);
	return r.bytes;
}

/** A count for people: "1,234", or "more than 10,000" when the scan stopped counting. */
function countText(n: number, more: boolean): string {
	return `${more ? "more than " : ""}${n.toLocaleString("en-GB")}`;
}

export const listTemplateFields = defineTool({
	name: "docs_list_template_fields",
	title: "List template fields",
	description:
		"Lists the {{placeholders}} in a Word, Excel or PowerPoint template in NoDrive with how often each appears, in document order (500 at most; total_fields counts all). Names use letters, digits, spaces, dots, dashes or underscores. docs_fill_template fills them in.",
	input: z.object({ path: pathArg("The template (.docx, .xlsx, .pptx, .dotx, .xltx or .potx).") }).strict(),
	output: z.object({ path: z.string(), fields: z.array(z.object({ name: z.string(), count: z.number() })), total_fields: z.number(), truncated: z.boolean() }),
	async run(ctx, args) {
		const path = normalizePath(args.path, { allowRoot: false });
		const kind = templateKind(path, "path");
		const bytes = await readTemplate(ctx, path);
		const r = listFields(bytes, kind.family);
		const total = r.fields.length;
		// At most 500, and only as many as fit in one result (DESIGN 10.4).
		const capped = r.fields.slice(0, DOC_LIMITS.fieldsListed);
		const fit = ctx.page.fit(capped, (items) => ({ path, fields: items, total_fields: total, truncated: true }));
		const truncated = r.more || fit.items.length < total;
		const shown = truncated ? ` The first ${fit.items.length.toLocaleString("en-GB")} are listed.` : "";
		return {
			data: { path, fields: fit.items, total_fields: total, truncated },
			summary: total ? `${path} has ${countText(total, r.more)} field${total === 1 && !r.more ? "" : "s"}.${shown}` : `${path} has no {{fields}}.`,
		};
	},
});

export const fillTemplateTool = defineTool({
	name: "docs_fill_template",
	title: "Fill a template",
	description:
		'Makes a new file from a Word, Excel or PowerPoint template in NoDrive, replacing each {{placeholder}} with its value and keeping the formatting; the template is unchanged. missing: "fail" (default) stops when a field has no value, "keep" leaves it, "blank" empties it. Reports the fields filled, missing (200 at most; missing_total counts all) and unused.',
	input: z
		.object({
			template_path: pathArg("The template (.docx, .xlsx, .pptx, .dotx, .xltx or .potx)."),
			output_path: pathArg("The new file, same kind as the template (.dotx may give .docx)."),
			// maxProperties is published in the JSON Schema (zod's meta); the count is checked in run().
			values: z
				.record(z.string().max(64), z.string().max(LIMITS.templateValueChars))
				.describe('Field name to value (200 at most), e.g. {"client": "Acme Ltd"}. A newline starts a new line.')
				.meta({ maxProperties: LIMITS.templateKeys }),
			missing: z.enum(["fail", "keep", "blank"]).default("fail").describe("What to do with fields that have no value."),
			if_exists: ifExistsArg(),
		})
		.strict(),
	output: savedOutput({ filled: z.array(z.string()), missing: z.array(z.string()), unused: z.array(z.string()), missing_total: z.number(), truncated: z.boolean() }),
	async run(ctx, args) {
		const tpl = normalizePath(args.template_path, { field: "template_path", allowRoot: false });
		const kind = templateKind(tpl, "template_path");
		const keys = Object.keys(args.values);
		if (keys.length > LIMITS.templateKeys) throw new ToolError("invalid_input", "values can have at most 200 fields.", { field: "values" });
		for (const k of keys) {
			if (!validKey(k)) {
				throw new ToolError("invalid_input", `"${k.slice(0, 64)}" isn't a valid field name (letters, digits, spaces, dots, dashes or underscores; 64 at most).`, { field: "values" });
			}
		}
		// The output keeps the template's kind; a template format may become the normal document format.
		const outExt = extOf(args.output_path);
		const allowed = new Set([kind.ext, kind.family]);
		if (!allowed.has(outExt)) {
			const list = [...allowed].map((e) => `.${e}`).join(" or ");
			throw new ToolError("invalid_input", `output_path must end in ${list}, like the template.`, { field: "output_path" });
		}
		const out = targetPath(args.output_path, outExt, "output_path");
		if (out === tpl) throw new ToolError("invalid_input", "output_path must be a new file; the template is never changed.", { field: "output_path" });
		await checkTargetFolder(ctx, out, "output_path");
		const bytes = await readTemplate(ctx, tpl);
		const toDocument = kind.template && outExt === kind.family;
		const r = fillTemplate(bytes, kind.family, args.values, args.missing, toDocument);
		const mime = outExt === kind.family ? MIME[kind.family] : (TEMPLATE_MIME[outExt] ?? MIME[kind.family]);
		const w = await writeNewFile(ctx, out, r.bytes, mime, args.if_exists, "output_path");
		const warnings: string[] = [];
		const nMissing = r.missing.length;
		if (nMissing) {
			const more = nMissing > 20 || r.missingMore ? ", and more" : "";
			const one = nMissing === 1 && !r.missingMore;
			const what = args.missing === "keep" ? (one ? "was left as it was" : "were left as they were") : one ? "was emptied" : "were emptied";
			warnings.push(`${countText(nMissing, r.missingMore)} field${one ? "" : "s"} had no value and ${what}: ${r.missing.slice(0, 20).join(", ")}${more}.`);
		}
		if (r.unused.length) warnings.push(`These values matched no field in the template: ${r.unused.slice(0, 20).join(", ")}${r.unused.length > 20 ? ", and more" : ""}.`);
		// filled and unused hold at most the 200 value names; missing is cut to 200 and to what fits.
		const base = { file: w.file, renamed: w.renamed, filled: r.filled, unused: r.unused, missing_total: nMissing, truncated: true, warnings };
		const fit = ctx.page.fit(r.missing.slice(0, DOC_LIMITS.namesListed), (items) => ({ ...base, missing: items }));
		const truncated = r.missingMore || fit.items.length < nMissing;
		return {
			data: { file: w.file, renamed: w.renamed, filled: r.filled, missing: fit.items, unused: r.unused, missing_total: nMissing, truncated },
			summary: `Filled ${r.filled.length} field${r.filled.length === 1 ? "" : "s"} and saved ${w.path}.${renamedNote(w.renamed, w.path)}`,
			...(warnings.length ? { warnings } : {}),
		};
	},
});
