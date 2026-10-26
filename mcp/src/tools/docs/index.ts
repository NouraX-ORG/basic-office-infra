/**
 * Lane C (documents) owns this module (DESIGN 18.3 and 18.4): the six docs_* tools and
 * files_read_text. The registry orders tools by the catalogue.
 */
import type { ToolDef } from "../../core/tool";
import { convert } from "./convert";
import { createDocument, createPresentation, createSpreadsheet } from "./create";
import { readText } from "./read-text";
import { fillTemplateTool, listTemplateFields } from "./template";

export const tools: ToolDef[] = [readText, createDocument, createSpreadsheet, createPresentation, convert, listTemplateFields, fillTemplateTool];
