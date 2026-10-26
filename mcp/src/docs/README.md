# Documents (lane C)

Office writers, the Markdown subset, template fields, text extraction and conversion for the
Nourax Workspace MCP server (DESIGN sections 11.4 and 12). The tools live in `src/tools/docs/`:
`files_read_text`, `docs_create_document`, `docs_create_spreadsheet`, `docs_create_presentation`,
`docs_convert`, `docs_list_template_fields` and `docs_fill_template`.

## Layout

| Path | What |
|---|---|
| `limits.ts` | Lane C's memory limits (`DOC_LIMITS`), on top of core's byte limits; each says what it bounds and why |
| `errors.ts` | `TooBigHere`: a normal-looking file too big to read in the Worker (`files_read_text` then uses the conversion) |
| `zip.ts` | Zip reading (our own central-directory parser plus fflate's streaming `Inflate` with output counters), writing (`zipSync`), and `ZipBuilder` for filled templates (unchanged parts copied still packed, edited parts deflated as they are written) |
| `sax.ts` | Guarded streaming XML on saxes: namespaces on, DOCTYPE refused, depth at most 64, runs of text or markup at most 1,000,000 characters; strict-OOXML namespaces mapped to transitional ones |
| `xmlscan.ts` | A raw-offset tag scanner for in-place edits (template filling), namespace-aware, linear |
| `markdown.ts` | The Markdown subset parser (block pass and inline pass, both linear) |
| `ooxml/` | The docx, xlsx and pptx writers and their shared parts |
| `sheets.ts` | Spreadsheet input: typed columns, CSV parsing, sheet-name cleaning, the formula guard, the cell limit |
| `template.ts` | `{{field}}` listing and filling for docx, xlsx and pptx (and dotx, xltx, potx) |
| `formats.ts` | The ONLYOFFICE connector's own conversion table (copied from the installed app, 10.2.1) and `TOOL_SOURCES`, the narrower list of sources our tools send to it |
| `sniff.ts` | Content checks before the converter runs (fix round 3): refusing a file that is really HTML or an MHT archive whatever its extension, and a package that links an image or other file by URL |
| `extract/` | Text extraction: classification, docx, xlsx, pptx, odt/ods/odp, PDF (unpdf, imported on first use), the PDF check (`pdfcheck.ts`), paging |

## Decisions and how they were checked

- **Our own writers, no Office libraries.** Each package is a fixed minimal template plus generated
  body parts. Every part is listed in `[Content_Types].xml` and every internal relationship resolves
  (`checkPackage` in `test/docs/helpers.ts`). python-docx, openpyxl and python-pptx open the output
  (heading and list styles, dates with their formats, the frozen header, the autofilter, layouts and
  notes were all recognised), and ONLYOFFICE Docs 10.0.0 converted every docx, xlsx and pptx we made
  to PDF in the live run.
- **Limits on memory, not only on bytes** (fix round 1, after the security review measured 120 to
  830 MB for hostile files that met every byte cap). The isolate has 128 MB, shared by every request
  it runs; past that, Cloudflare lets the running requests finish and starts a new isolate, and may
  cancel some requests under high load (Workers limits page). `DOC_LIMITS` bounds what the parsers
  hold:
  - **Zips.** The sizes a zip declares are never trusted. At most 2,000 entries, 30 MB out per part,
    60 MB out in all, and a part that inflates more than 100 times its packed size, **once it is also
    past 4 MB** (fix round 3; the floor was 1 MB, which refused our own highly repetitive writer
    output — a table of identical rows or many short paragraphs packs 100x+ but is a megabyte or two
    unpacked, well under the absolute caps that bound memory), is refused. Packed input goes to
    `Inflate` **4 KB at a time**, so one output piece is at most
    about 4 MB (deflate expands at most about 1,032 times) and the counters run before memory piles
    up; 64 KB pushes made single 64 MB pieces. Only the parts a reader needs are inflated.
    Encrypted entries, duplicate names and damaged data give plain errors. A part read whole
    (styles, relationships, the workbook) is at most 4 MB; everything else is streamed.
  - **XML.** saxes with a DOCTYPE refused (no entities beyond the five built-in ones), depth at most
    64. saxes holds a whole text node, attribute, comment or CDATA section until it ends, so a run of
    more than 1,000,000 characters without markup is refused (`RunGuard`).
  - **Readers.** One paragraph, cell or slide line keeps at most 1,000,000 characters; style,
    numbering and relationship tables at most 50,000 entries; spreadsheets at most 1,000,000 shared
    strings and 16,000,000 characters of them (kept as joined blocks, not one string each); a table
    or slide that would pass the 5,000,000-character text cap is written as far as it got.
  - **The text cap holds for deflated parts.** The reader's early stop (`StopRead`) used to be
    turned into "damaged" inside the inflater; it now passes through, so a long file is cut with a
    note instead.
- **XML.** Big parts are streamed into the parser in chunks, never held whole.
- **Linear time everywhere a person's text is scanned.** The Markdown parser, the placeholder finder
  and the readers use no regular expression that can backtrack on long runs (for example
  `/[ \t]+$/gm` was replaced by splitting lines). Links are checked with a strict pattern instead of
  the URL constructor, because in workerd every URL it throws on is expensive and hostile input could
  repeat that thousands of times. `test/docs/markdown.test.ts` runs 14 hostile inputs of 200,000 to
  400,000 characters. Template filling walks a paragraph's text pieces with one pointer (it was
  pieces times fields). **Fix round 3:** the Markdown inline tokenizer used to read the end of one
  growing buffer on every `"\n"` (`buf.endsWith("  ")`, `trimSpacesEnd(buf)`), which flattens a V8
  rope each time — quadratic on a paragraph (or lazy list item, or quote) of many short lines: in
  Node a 200,000-line paragraph took about 11.5 s, and through the dev Worker a 400,000-character
  Markdown of `"a\n"` took 13,335 ms. It now collects text pieces in an array, joined once, with a
  running count of the trailing spaces, so the work is linear (200,000 lines: about 57 ms in Node).
  `test/docs/markdown.test.ts` counts the work (it stays O(n), not O(n²)) because workerd's clock is
  frozen; `test/docs/perf/markdown-linear.mjs` times the wall clock in Node.
- **Formula guard.** Only a column typed `formula` writes `<f>`; every other value is a number, a
  boolean or an inline string, so text starting with `=`, `+`, `-` or `@` stays text. Formulas that
  reach outside the file are refused: web, import and online functions (WEBSERVICE, FILTERXML,
  IMPORT…, IMAGE, TRANSLATE, DETECTLANGUAGE, STOCKHISTORY, PY, COPILOT and similar), HYPERLINK,
  CALL, REGISTER, EXEC, RTD, DDE, INFO, CELL, EVALUATE, **INDIRECT** (it can build a link to another
  workbook out of CHAR(91) and the like), `|` (DDE) and `[` (other workbooks, also inside a quoted
  sheet name). Names are matched as whole names whatever follows, so a function passed as a value
  (`=MAP(A2:A3,WEBSERVICE)`, Excel 365's eta lambdas) is refused too, with or without the file
  format's prefixes: any chain of `_xl…` prefixes (fix round 2), because the file format stacks them
  (`_xlfn._xlws.FILTER`, `_xlfn._xlws.PY`), and `=_xlfn._xlws.WEBSERVICE(…)` once got through.
  Words inside "text in quotes" don't count; cell and column references that look like names
  (`RTD1`, `$DDE$2`, `DDE:DDE`) are allowed, but a call such as `A1:WEBSERVICE(B1)` is not. **Fix
  round 3:** a single-quoted sheet reference (`'Sheet name'!A1`) is now copied verbatim rather than
  parsed as text, so a `"` inside a sheet name (Excel allows it) can't open a fake text literal that
  hides `WEBSERVICE`/`HYPERLINK`/DDE placed after it, and a `[` inside it is still seen; and
  `cleanSheetNames` strips `"` from a sheet name as it does `[]:*?/\`, so a sheet can't carry one.
- **Spreadsheet size.** At most 20 sheets and 50,000 cells. Given as `sheets`, each row and column
  setting counts toward the 50,000 too, because the MCP SDK counts every element of the request
  (core sets `maxToolInputElements: 50_000` in `src/mcp/factory.ts`); the description says so. Fix
  round 2: the tool counts its arguments exactly as the SDK's `toolInputElementCount` does (every
  array item and object key, the top-level keys included), so the stated limit is the one that
  holds; the defaults the schema fills in only add to that count, never take from it. A request
  past the SDK's own count is still refused by the SDK before the tool runs, in its own words (core
  could map that to plain words; noted for the integrator).
- **Templates.** Run texts are joined per paragraph (`w:p`, `a:p`) or string (`si`, `is`), so a
  placeholder split across runs is found; the value goes into the first run (keeping its
  formatting) and the other runs are emptied. Memory (fix round 1):
  - a scanned part is held whole only up to **4 MB** (the filler edits by offset); a bigger part
    with no `{` and no character reference can't hold a field and is copied as it is, otherwise the
    template is refused as too big;
  - paragraphs are handled one at a time as the scan closes them; a paragraph keeps at most 10,000
    text pieces and 1,000,000 characters, a template at most 300,000 pieces and 32,000,000
    characters of scanned parts;
  - the filled file is streamed (`ZipBuilder`): unchanged parts are copied still packed, never
    unpacked, and an edited part is deflated piece by piece while a fresh XML reader checks it, so a
    broken part is never written; at most 20,000 replacements, 12,000,000 characters per edited part
    and a 20 MB file;
  - **sized before anything is built** (fix round 2; the security review filled a 2.7 KB template
    of 20,000 `{{a}}` with 10,000 `&` and ran the isolate out of memory, because the 12,000,000
    check came after every replacement had been built): what each value adds once escaped is
    counted while it is joined in, against 2,000,000 characters per paragraph and the part's
    12,000,000; the exact XML length of every changed piece (a PowerPoint run split repeats the
    whole run for every line of a value) is worked out before that XML is made; and edits are
    written out, deflated, as soon as the outermost paragraph holding them closes, so one
    paragraph's edits are the most that is held;
  - at most 10,000 distinct field names are counted. `docs_list_template_fields` returns at most
    500, fitted to one result, with `total_fields` and `truncated`; `docs_fill_template` returns at
    most 200 `missing` names with `missing_total` and `truncated`.
  A `.dotx`, `.xltx` or `.potx` may become a `.docx`, `.xlsx` or `.pptx` (the content type is
  switched).
- **Document text stays inside the data frame.** Errors are plain text outside the frame, so they
  never quote what a document says: `missing "fail"` reports how many fields have no value and
  points to `docs_list_template_fields`; a sheet that isn't there gets a count, not the file's sheet
  names. `files_read_text` puts sheet names in `structuredContent` (its text block holds the file
  text), so they are cleaned of control characters and limited to 50 names of 100 characters.
- **Conversion** goes through the connector's `downloadas` route as the person, with the file id
  from our own PROPFIND. Allowed pairs are the connector's table, and only from `TOOL_SOURCES`:
  Word, Excel, PowerPoint, OpenDocument, RTF, text, CSV and PDF. HTML, MHT, XML, EPUB and FB2 are
  left out (on import the converter may fetch what they link to), and so are rare formats whose
  import code is the least tried. **Markdown is left out too** (fix round 2, security review): the
  converter turns it into HTML and imports that with the same HTML reader, which downloads linked
  images (`libHtmlFile2.so` holds both `Md::ConvertMdFileToHtml` and the network downloader), and
  the converter sits on the compose network next to app, db and redis. A `.md` file becomes a
  `.docx` in the Worker instead, with our own writer (no images; only `https:` and `mailto:`
  links), and that `.docx` can then be converted like any other; `docs_convert` from `.md` to any
  other target says so. Also fix round 2: the folder of `output_path` is checked before the
  conversion is spent (a missing folder is named as the folder, with `files_create_folder` as the
  way on), and a workbook made into a PDF or CSV keeps only its first sheet (seen live with two
  workbooks): the result warns, with the number of sheets left out when the file can be counted
  here. Before converting, `docs_convert` checks that a zip-based
  source is a sound zip from its last 64 KB (one ranged read; an old binary Office file under a new
  name also passes), because the converter reads a damaged zip as plain text and "converts" that;
  and with `if_exists` "fail" it looks for the target first, so a taken name doesn't spend a
  conversion. Core's `officeConvert` checks the answer (an unknown or unreadable file comes back as
  HTTP 200 with an HTML page) and holds the per-person lease (one at a time, 20 an hour).
- **Content checks before the converter (fix round 3; `sniff.ts`).** The converter decides a file's
  format from its content, not from the extension our tools pass it, and its importers fetch what a
  file links to (an SSRF from the converter's own Docker network), so narrowing the sources by
  extension alone is not enough. A text-based source (doc, txt, rtf, csv, tsv, xls) whose bytes are
  really HTML or an MHT archive is refused, using the same first-bytes signatures the connector's own
  detector uses (`OfficeFileFormatChecker2.cpp`, read on the server). A package (Office Open XML or
  OpenDocument) that links an image, media, audio or video file by an http(s)/ftp URL — an `External`
  relationship of a fetched type, or an OpenDocument `draw:image` with an http href — is refused;
  ordinary web hyperlinks, which the converter does not fetch, are left alone. A package small enough
  to read here (up to 10 MB) is read once in the Worker, and that one read serves the soundness check,
  the external-reference check and the sheet count; a larger package keeps the ranged-tail soundness
  check only, so an external reference in a 10–25 MB package is a documented residual. The vector was
  probed live: a docx/odt with an external image relationship did make the connector fetch the URL.
  The same HTML/MHT check guards the server (conversion) route of `files_read_text` for the legacy
  kinds (doc, xls, ppt, rtf).
- **Reading routes.** Text formats: the first 10 MB, by Range; bytes that aren't UTF-8 are read as
  Windows-1252, with a note (a character cut short by the 10 MB Range doesn't count). Office files
  up to 10 MB and PDFs up to 15 MB are read in the Worker. Bigger ones (up to 25 MB), legacy formats
  (doc, xls, ppt, rtf and similar) and PDFs the check sends on go through the conversion to txt or
  csv, but only for pairs in the table from `TOOL_SOURCES`; other formats the connector knows (djvu,
  epub, pages, flat OpenDocument, Visio and similar) answer "can't be turned into text here" without
  a download. An Office file that isn't a zip is read through the conversion when it is an old binary
  file under a new name, read as text (with a note) when it is text, and refused as damaged
  otherwise. RTF read through the conversion carries a note: ONLYOFFICE drops accented letters
  written as RTF escapes. Extracted text is capped at 5,000,000 characters and paged with `offset`
  and `max_chars`.
- **PDF check before PDF.js** (`extract/pdfcheck.ts`, fix round 1; the review measured +341 MB for
  a 154 KB PDF whose content inflated to 150 MB). PDF.js inflates a Flate stream only when its data
  starts with a zlib header right after a `stream` keyword, so every such place in the file is
  inflated with counters first, whatever the file's structure. A stream cut at 8 MB, or all of them
  at 64 MB, after unpacking more than 200 times its packed size is a bomb and the file is refused;
  past those sizes otherwise, or past 20,000 such streams, the file goes to the conversion. Filters
  the check can't count send it there too: LZW, RunLength, ASCII85, ASCIIHex, Brotli, encryption
  (`/Encrypt`), a filter given as an indirect object, and any chain of two filters (names found
  with `#xx` escapes decoded). PDF.js then hands over a page's text in batches (`streamTextContent`)
  and is stopped once enough is collected: `getTextContent` holds every text item of a page, and
  16 MB of text operators then took +327 MB. PDF.js runs with `verbosity: 0`, so its warnings (which
  can quote font names or text) stay out of the logs.
- **What is left (PDF).** A crafted PDF can name an image filter (DCT, JPX, JBIG2, CCITT) on a page's
  content stream; PDF.js decodes it then, and telling that apart from a real image needs a full parse.
  Images themselves are never decoded for text. The complete fix is to run PDF.js in an isolate of
  its own: a second Worker behind a service binding (Cloudflare's pricing page: such a call adds no
  request fee, only the CPU both Workers use). That is a core and wrangler change, noted for the
  integrator.
- **Output schemas.** `files_read_text`, `docs_list_template_fields` and `docs_fill_template`
  publish output schemas (the template tools with their new totals). `docs_create_document`,
  `docs_create_spreadsheet`, `docs_create_presentation` and `docs_convert` publish none (fix round
  1; recorded in DESIGN 12.7): their result is the saved file, named in the summary line and
  returned in `structuredContent` (`file`, `renamed` and their own fields, the Out shapes of DESIGN
  11.4), and the whole tools/list has a 60 KB budget. `docs_fill_template` publishes the 200-key
  limit of `values` as `maxProperties` and in its description (fix round 2).
- **`truncated` is set from what the readers did** (fix round 2): `extractText` returns `cut`, set
  by the 5,000,000-character text cap, the PDF page cap (300 a call), the 5,000-row and
  1,000-column caps of a sheet and a monstrous paragraph or cell cut short. `files_read_text` used
  to guess it from the wording of a note, so a PDF stopped at page 300 came back as whole. The note
  says what was left out and, for PDFs, which `pages` continue.
- **Smaller fixes in round 2.** OpenDocument booleans written `1` and `0` (as ONLYOFFICE saves them)
  read as TRUE and FALSE (every TRUE once read as FALSE); a taken name gets the document tools' own
  hint (`Use if_exists "rename", or another path.`; core's points to `files_overwrite_file`, which
  writes text and can't replace an Office file); a top-level list item of the other kind (numbers
  after bullets) starts a new list, as in CommonMark, so the summary counts two lists. Lane C's
  seven tools take 12,548 bytes of tools/list (14,650 before; `test/tools/docs/list-size.test.ts`
  holds them to 12,800). The 60 KB total across all lanes needs a decision for the integrator
  (raise the cap, or trim per app).

## What the build verified (DESIGN 23, lane C)

| Item | Finding (2026-10-25) |
|---|---|
| `downloadas` targets | The installed connector is 10.2.1; its table is `formats.ts`. docx can become pdf, odt, txt (and others we don't offer); xlsx: pdf, ods, csv; pptx: pdf, odp, txt; txt: pdf. Markdown is never sent (fix round 2): it becomes .docx in the Worker. The route returns the file itself when the target is its own extension, so `docs_convert` refuses that. |
| xlsx to pdf | Only the first sheet is in the PDF (seen live with two workbooks, fix round 2); `docs_convert` warns, with the count. |
| xlsx to csv | Only the first sheet is kept (live run). Formulas with no saved result come out as their formula text, and ONLYOFFICE's CSV export truncates date-times (09:30 shows as 09:29) although its PDF export and our own reader show 09:30. `files_read_text` says the CSV route may hold only the first sheet. |
| unpdf on workerd without `nodejs_compat` | Works: the unit tests run PDF.js inside workerd with no compatibility flags (hand-built PDFs and an ONLYOFFICE PDF). This PDF.js build has no `isEvalSupported` option and destroys a document through `loadingTask`; `streamTextContent` needs a reason to cancel. |
| Real producers | python-docx puts list numbering on the paragraph style (resolved through `basedOn`); openpyxl and our own writer store formulas without a saved result (shown as `=formula`); ONLYOFFICE writes headings in .odt as paragraphs whose style's parent is "heading N", lists through list styles, and leaves formulas uncalculated in .ods (shown in A1 form, `=C2*2` for `of:=[.C2]*2`). All are handled and pinned by fixtures. |

## CPU and memory

Measured in Node 24 (the V8 family workerd uses) on the build PC, per call, warm. The Paid plan
allows 30 s of CPU per request (`cpu_ms` 30,000) and 128 MB of memory per isolate.

| Work | CPU | Heap growth |
|---|---|---|
| docx write, 20 pages (headings, lists, tables, page breaks) | 4.2 ms | 2.3 MB |
| docx write from 400,000 characters of Markdown, ordinary prose | 72 ms | 31 MB peak, nothing kept |
| docx write from 400,000 characters of Markdown that is nearly all short lines (`"a\n"` x 200,000) | 57 ms (was ~11,500 ms before fix round 3; the parser is now linear) | 31 MB peak, nothing kept |
| xlsx write, 10,000 cells (typed columns) | 27 ms | 10 MB |
| pptx write, 30 slides with notes | 17 ms | 5 MB |
| docx read, the 20-page file | 7.6 ms | 8 MB |
| xlsx read, 10,000 cells | 47 ms | 17 MB |
| xlsx read, 10,000 rows (5,000 shown) | 139 ms | 32 MB peak, nothing kept |
| pptx read, 30 slides | 23 ms | 5 MB |
| PDF read, 30 pages made by ONLYOFFICE (60 KB) | 43 ms | 27 MB |
| docx template fill, 501 fields | 3.5 ms | 2.5 MB |

**Hostile files** (fix round 1; the security review's own inputs, rebuilt from `src/` with esbuild
and run in Node 24 with the V8 heap capped, `--max-old-space-size`; "heap" is the smallest cap it
completed under, RSS growth is at a 100 MB cap and includes buffers and garbage not yet collected):

| Input | Before | After |
|---|---|---|
| template list, 1.7 MB docx with 30.4 MB of document.xml | +543 MB, 5.5 s | refused at once (part over 4 MB), 0 ms |
| template fill, same file | +830 MB, 9.7 s | refused at once |
| template fill, 3.9 MB of document.xml (8,235 contract paragraphs, the largest allowed) | (8 MB version: +121 MB) | ok, heap under 32 MB, +21 MB RSS, 0.9 s |
| template fill (fix round 2), 2.7 KB docx of 20,000 `{{a}}` paragraphs, value 10,000 `&` | out of memory at a 128 MB and a 512 MB heap | refused (part over 12,000,000), +20 MB RSS, 0.44 s, also under a 64 MB heap |
| template fill (fix round 2), one paragraph of 20,000 `{{a}}`, value 10,000 `x` | +194 MB RSS, 198 MB heap, then refused | refused (paragraph over 2,000,000), +4 MB RSS, 21 ms |
| template fill (fix round 2), PowerPoint run with a 1.2 MB format, value of 10,000 newlines | (about 12 GB of XML to build) | refused before anything is built, +13 MB RSS, 0.14 s |
| template fill (fix round 2), 1,000 paragraphs, value 10,000 `y` (control) | +24 MB | ok, +7 MB RSS, 0.22 s |
| files_read_text, 3.9 MB xlsx with 1.5 million shared strings (29 MB) | +221 MB | over the shared-string limits: conversion route, +41 MB, 1.3 s |
| files_read_text, 205 KB docx whose document.xml is 200 MB of spaces | refused after +128 MB | refused, +20 MB |
| files_read_text, docx with 6,000,000 characters | "damaged" | first 5,000,000 characters with a note, +53 MB, 0.5 s |
| files_read_text, 1.7 MB docx, 30 MB of XML, cut at 5,000,000 characters | n/a | ok, heap 32 to 48 MB, 1.1 s |
| files_read_text, 154 KB PDF inflating to 150 MB | +341 MB | refused by the PDF check, +42 MB, 0.2 s |
| PDF with 8 MB of text operators on one page (the largest stream let through) | n/a | ok, heap under 32 MB, 2.3 s |
| PDF with 16 MB of text operators (now refused by the check) | +327 MB | refused, +7 MB |

Live, through local wrangler dev against drive.nourax.org (network included; final run 2026-10-25):
creating a docx 0.9 to 1.9 s, converting a docx, xlsx or pptx to PDF 3.5 to 3.8 s, a 30-page docx to
PDF 4.8 s, reading that 30-page PDF back 0.7 s.

The live cases are in `test/live/docs/` with their own runner (port 8820 by default). Because lanes
share one folder and wrangler dev restarts on every source change, the runner can serve a dev bundle
built beforehand (`NX_LIVE_SCRIPT`); see the comments in `global-setup.ts`.

The production bundle is 3.16 MB (932 KB gzipped) with PDF.js inside; PDF.js is evaluated only on
the first PDF read. Local startup profile: 110 ms of CPU (the limit is 1 s).
