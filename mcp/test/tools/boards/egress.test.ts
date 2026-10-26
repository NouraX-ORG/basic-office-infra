/**
 * The Deck REST egress rule ("deck-rest", src/core/egress.ts) allows exactly the routes the boards
 * tools build (and lane G's board check), and nothing that could create, rename, archive, delete or
 * share a board (lane E fix round 1: board sharing must never be reachable with workspace.write).
 */
import { describe, expect, it } from "vitest";
import { checkEgress, EgressDenied } from "../../../src/core/egress";
import { config } from "../../../src/env";
import { env } from "../../helpers/index";

const UID = "5224252b-4938-4a86-a276-54bbae5d5b49";
const REST = "https://drive.nourax.org/index.php/apps/deck/api/v1.0";
const OCS = "https://drive.nourax.org/ocs/v2.php/apps/deck/api/v1.0";
const rule = (url: string, method: string) => checkEgress(config(env), url, { method, headers: { authorization: "Basic eA==" } }, UID);
const denied = (url: string, method: string) => {
	try {
		rule(url, method);
		return false;
	} catch (e) {
		return e instanceof EgressDenied;
	}
};

describe("deck-rest egress rule", () => {
	it.each([
		// boards_list; boards_get_board (and gantt_update_project's board check); its stacks and archived cards
		["GET", "/boards"],
		["GET", "/boards/12"],
		["GET", "/boards/12/stacks"],
		["GET", "/boards/12/stacks/archived"],
		// boards_get_card and the read before every card change
		["GET", "/boards/12/stacks/34/cards/56"],
		// boards_create_card
		["POST", "/boards/12/stacks/34/cards"],
		// boards_set_due_date (the full-card update) and boards_assign_card
		["PUT", "/boards/12/stacks/34/cards/56"],
		["PUT", "/boards/12/stacks/34/cards/56/assignUser"],
		["PUT", "/boards/12/stacks/34/cards/56/unassignUser"],
	])("allows %s %s", (method, path) => {
		expect(rule(`${REST}${path}`, method)).toBe("deck-rest");
	});
	it("keeps the OCS routes for moving and comments", () => {
		expect(rule(`${OCS}/cards/56/reorder?format=json`, "PUT")).toBe("deck-ocs");
		expect(rule(`${OCS}/cards/56/comments?format=json`, "POST")).toBe("deck-ocs");
		expect(rule(`${OCS}/cards/56/comments?format=json&limit=20`, "GET")).toBe("deck-ocs");
	});
	it.each([
		// board sharing (ACL), which needs workspace.share, never workspace.write
		["POST", "/boards/12/acl"],
		["PUT", "/boards/12/acl/3"],
		["GET", "/boards/12/acl"],
		// creating, renaming, archiving or deleting a board
		["POST", "/boards"],
		["PUT", "/boards/12"],
		["PUT", "/boards/12/archive"],
		["DELETE", "/boards/12"],
		["POST", "/boards/12/undo_delete"],
		// labels, stacks and card actions no tool uses
		["GET", "/boards/12/labels"],
		["POST", "/boards/12/labels"],
		["POST", "/boards/12/stacks"],
		["PUT", "/boards/12/stacks/34"],
		["PUT", "/boards/12/stacks/34/cards/56/reorder"],
		["PUT", "/boards/12/stacks/34/cards/56/archive"],
		["PUT", "/boards/12/stacks/34/cards/56/assignLabel"],
		["POST", "/boards/12/stacks/34/cards/56/attachments"],
		["DELETE", "/boards/12/stacks/34/cards/56"],
		// the wrong method on an allowed path, odd ids and extras
		["GET", "/boards/12/stacks/34/cards/56/assignUser"],
		["POST", "/boards/12/stacks/34/cards/56"],
		["PUT", "/boards/12/stacks/34/cards"],
		["GET", "/boards/x"],
		["GET", "/boards/12/"],
		["GET", "/boards/1234567890123"],
		["GET", "/boards?details=true"],
	])("refuses %s %s", (method, path) => {
		expect(denied(`${REST}${path}`, method)).toBe(true);
	});
});
