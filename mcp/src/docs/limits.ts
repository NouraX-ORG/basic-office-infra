/**
 * Lane C's own memory limits (fix round 1, after the security review measured what hostile files
 * within the byte caps of DESIGN 14 did to memory). The byte caps in core's LIMITS stay as they
 * are; these limits sit on top of them and bound what the parsers keep, so one request stays far
 * below the Worker's 128 MB isolate limit (other people's requests may share the isolate).
 *
 * Where a limit stops a normal-looking file, files_read_text falls back to the connector's
 * conversion (ONLYOFFICE has its own input limits) instead of failing; a file that unpacks more
 * than 100 times its packed size is refused outright.
 */
export const DOC_LIMITS = {
	/** Compressed input pushed to fflate's Inflate at a time: one callback then holds about 4 MB at most. */
	inflatePushBytes: 4 * 1024,
	/** A part read whole (styles, relationships, the workbook, content types). */
	wholePartBytes: 4 * 1024 * 1024,
	/** Characters of text or of one tag that the XML reader may meet without markup (saxes buffers them). */
	xmlRunChars: 1_000_000,
	/** Characters one paragraph, cell or slide line may collect before the rest of it is dropped. */
	blockChars: 1_000_000,
	/** Shared strings of one spreadsheet: how many, and how many characters in all. */
	sharedStrings: 1_000_000,
	sharedStringChars: 16_000_000,
	/** Characters kept of one shared string (Excel's own cell limit). */
	sharedStringMax: 32_767,
	/** Style, numbering and relationship entries kept from one part. */
	tableEntries: 50_000,
	/**
	 * Template parts are scanned whole (the filler edits by offset): at most this many bytes each.
	 * A bigger part that can't hold a field (no "{", no character reference) is copied unchanged.
	 */
	templatePartBytes: 4 * 1024 * 1024,
	/** Characters of all scanned template parts together. */
	templateTotalBytes: 32 * 1024 * 1024,
	/** Text pieces (w:t, a:t, t) in one paragraph, and in the whole template. */
	templateUnitCarriers: 10_000,
	templateCarriers: 300_000,
	/** Distinct field names counted, and placeholders replaced, in one template. */
	templateFieldNames: 10_000,
	templatePlaceholders: 20_000,
	/**
	 * Characters of one filled part; the finished file is also held to 20 MB. Checked before the XML
	 * is built (fix round 2): what each value adds is counted while it is joined in.
	 */
	templateOutputChars: 12_000_000,
	/**
	 * Characters of one filled paragraph (or string) as XML: the most the filler builds and holds at
	 * a time. Far above a real paragraph (Excel's own cell limit is 32,767 characters).
	 */
	templateUnitOutputChars: 2_000_000,
	/** Fields returned by docs_list_template_fields, and names in docs_fill_template's lists. */
	fieldsListed: 500,
	namesListed: 200,
	/** Sheet names returned in files_read_text's metadata, and their length. */
	sheetNames: 50,
	sheetNameChars: 100,
	/**
	 * What the PDF check (extract/pdfcheck.ts) lets PDF.js unpack: each stream, and all together.
	 * Measured in Node 24 under a capped heap: a stream of 16 MB of text operators needed 32 to 48 MB
	 * of heap plus about 48 MB of buffers (PDF.js doubles its decode buffer); 4 MB needed under 32 MB
	 * of heap. 8 MB keeps a page well inside the 128 MB isolate.
	 */
	pdfStreamBytes: 8 * 1024 * 1024,
	pdfTotalBytes: 64 * 1024 * 1024,
	/** A stream (or all of them) cut at these limits after unpacking more than this many times is a bomb. */
	pdfBombRatio: 200,
} as const;
