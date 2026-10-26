/**
 * Lane B (contacts) owns this module (DESIGN 18.3 and 18.4): the four NoContacts tools, in
 * catalogue order.
 */
import type { ToolDef } from "../../core/tool";
import { contactsAdd } from "./add";
import { contactsGet } from "./get";
import { contactsSearch } from "./search";
import { contactsUpdate } from "./update";

export const tools: ToolDef[] = [contactsSearch, contactsGet, contactsAdd, contactsUpdate];
