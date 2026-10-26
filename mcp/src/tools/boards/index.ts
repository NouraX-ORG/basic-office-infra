/**
 * Lane E: the NoBoard (Deck) tools of DESIGN 11.8, in catalogue order. Deck 1.19.1's API was read
 * on the server (routes, CardService, AssignmentService, CommentService, DefaultBoardService).
 */
import type { ToolDef } from "../../core/tool";
import { boardsGetBoard, boardsGetCard, boardsList } from "./read";
import { boardsAddComment, boardsAssignCard, boardsCreateCard, boardsMoveCard, boardsSetDueDate } from "./write";

export const tools: ToolDef[] = [boardsList, boardsGetBoard, boardsGetCard, boardsCreateCard, boardsMoveCard, boardsSetDueDate, boardsAssignCard, boardsAddComment];
