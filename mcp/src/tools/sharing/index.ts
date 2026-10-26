/**
 * Lane B (sharing) owns this module (DESIGN 18.3 and 18.4): the six sharing tools, in catalogue
 * order.
 */
import type { ToolDef } from "../../core/tool";
import { sharingCreateLink } from "./create-link";
import { sharingDelete } from "./delete";
import { sharingFindPeople } from "./find-people";
import { sharingList } from "./list";
import { sharingShareWith } from "./share-with";
import { sharingUpdate } from "./update";

export const tools: ToolDef[] = [sharingFindPeople, sharingCreateLink, sharingShareWith, sharingList, sharingUpdate, sharingDelete];
