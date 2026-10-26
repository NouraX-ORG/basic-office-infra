# Lane C test fixtures

Files made by real producers, stored as base64 text (`*.b64`, 76-character lines) because the test
bundler can't inline binary Office files. `test/docs/helpers.ts` decodes them.

| File | Made with | Holds |
|---|---|---|
| `word-python-docx.docx` | python-docx 1.1.2 | Heading styles, bold/italic runs, a placeholder split across two runs, bullet and numbered lists set on the paragraph style, a table, a header with a placeholder |
| `excel-openpyxl.xlsx` | openpyxl 3.1.5 | Shared strings, dates and date-times with number formats, a percent, booleans, formulas with no saved result, a hidden sheet, an empty sheet |
| `excel-xlsxwriter.xlsx` | xlsxwriter 3.3.0 | A rich string with placeholders split across runs, a dd/mm/yyyy date |
| `pptx-python-pptx.pptx` | python-pptx 1.0.2 | Title and content layouts, bullet levels, speaker notes, slide order changed in `sldIdLst` |
| `onlyoffice-plan.odt` | ONLYOFFICE Docs 10.0.0 through the connector's `downloadas`, from a .docx our writer made | Headings as styled paragraphs, numbered and bullet lists through list styles, a table, a link |
| `onlyoffice-budget.ods` | the same, from our .xlsx | Two sheets, dates and date-times, a percent, formulas with no saved result, 1,024 repeated empty columns per row |
| `onlyoffice-deck.odp` | the same, from our .pptx | Title, outline and notes frames, nested lists |
| `onlyoffice-budget.pdf` | the same, from our .xlsx | A real converter PDF (embedded fonts, one page) |

The python fixtures came from a one-off script (kept outside the repo) on 2026-10-25. The ONLYOFFICE
fixtures were saved the same day by the live run (`NX_LIVE_SAVE_DIR`, see test/live/docs) from the QA
account's own test folder. Small PDFs for edge cases (encrypted, blank, several pages) are built in
the tests themselves (`textPdf` in `helpers.ts`).
