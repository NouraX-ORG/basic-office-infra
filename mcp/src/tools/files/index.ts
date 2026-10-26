/**
 * Lane A (files) owns this module (DESIGN 18.3 and 18.4): the 17 files tools of DESIGN 11.2 (not
 * files_read_text, which is lane C's), listed here in catalogue order.
 */
import type { ToolDef } from "../../core/tool";
import { filesCreateFile, filesCreateFolder, filesOverwriteFile } from "./create";
import { filesListFavorites, filesSetFavorite } from "./favorites";
import { filesGetInfo } from "./get-info";
import { filesListFolder } from "./list-folder";
import { filesCopy, filesMove, filesRename } from "./move-copy";
import { filesListRecent } from "./recent";
import { filesSearch } from "./search";
import { filesListTrash, filesMoveToTrash, filesRestoreFromTrash } from "./trash";
import { filesListVersions, filesRestoreVersion } from "./versions";

export const tools: ToolDef[] = [
	filesListFolder,
	filesSearch,
	filesGetInfo,
	filesCreateFile,
	filesOverwriteFile,
	filesCreateFolder,
	filesMove,
	filesCopy,
	filesRename,
	filesMoveToTrash,
	filesListTrash,
	filesRestoreFromTrash,
	filesListVersions,
	filesRestoreVersion,
	filesListFavorites,
	filesSetFavorite,
	filesListRecent,
];
