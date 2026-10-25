<?php

declare(strict_types=1);

/**
 * Plain (non-OCS) routes, served at https://drive.nourax.org/apps/nourax_api/v1/...
 * NoMail reads NODRIVE_API_URL as the base and appends /v1/health, /v1/provision and /v1/scan.
 * The admin API (/v1/admin/...) is signed with a separate key and never offered as an MCP tool.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

return [
	'routes' => [
		['name' => 'nomail#health', 'url' => '/v1/health', 'verb' => 'GET'],
		['name' => 'nomail#provision', 'url' => '/v1/provision', 'verb' => 'POST'],

		// The admin-only organisations and teams API (docs/teams.md). Signed with the admin key;
		// the controller reads the ids from the signed path, not from these parameters.
		['name' => 'admin#putOrg', 'url' => '/v1/admin/orgs/{orgId}', 'verb' => 'PUT'],
		['name' => 'admin#getOrg', 'url' => '/v1/admin/orgs/{orgId}', 'verb' => 'GET'],
		['name' => 'admin#putTeam', 'url' => '/v1/admin/orgs/{orgId}/teams/{teamId}', 'verb' => 'PUT'],
		['name' => 'admin#getTeam', 'url' => '/v1/admin/orgs/{orgId}/teams/{teamId}', 'verb' => 'GET'],
		['name' => 'admin#audit', 'url' => '/v1/admin/audit', 'verb' => 'GET'],
	],
];
