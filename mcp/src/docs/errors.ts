/** Errors shared by lane C's readers and writers. */
import { ToolError } from "../core/errors";

/**
 * A normal-looking file that is too big to read in the Worker's memory (DOC_LIMITS). It is a
 * too_large ToolError, so every reader passes it through unchanged; files_read_text catches it and
 * reads the file through the connector's conversion instead, where that is possible.
 */
export class TooBigHere extends ToolError {
	constructor(message = "This file is too big to read here.") {
		super("too_large", message);
		this.name = "TooBigHere";
	}
}
