<?php

declare(strict_types=1);

/**
 * Plain (non-OCS) routes, served at https://drive.nourax.org/apps/nourax_api/v1/...
 * NoMail reads NODRIVE_API_URL as the base and appends /v1/health, /v1/provision and /v1/scan.
 * The admin API (/v1/admin/...) is signed with a separate key and never offered as an MCP tool.
 * /admin/org-privacy is the admin settings page's privacy switch (PrivacySettingsController).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

return [
	'routes' => [
		['name' => 'nomail#health', 'url' => '/v1/health', 'verb' => 'GET'],
		['name' => 'nomail#provision', 'url' => '/v1/provision', 'verb' => 'POST'],
		['name' => 'nomail#scan', 'url' => '/v1/scan', 'verb' => 'POST'],

		// The admin-only organisations and teams API (docs/teams.md). Signed with the admin key;
		// the controller reads the ids from the signed path, not from these parameters.
		['name' => 'admin#putOrg', 'url' => '/v1/admin/orgs/{orgId}', 'verb' => 'PUT'],
		['name' => 'admin#getOrg', 'url' => '/v1/admin/orgs/{orgId}', 'verb' => 'GET'],
		['name' => 'admin#putTeam', 'url' => '/v1/admin/orgs/{orgId}/teams/{teamId}', 'verb' => 'PUT'],
		['name' => 'admin#getTeam', 'url' => '/v1/admin/orgs/{orgId}/teams/{teamId}', 'verb' => 'GET'],
		['name' => 'admin#reconcile', 'url' => '/v1/admin/orgs/{orgId}/reconcile', 'verb' => 'POST'],
		['name' => 'admin#putPerson', 'url' => '/v1/admin/people/{userId}', 'verb' => 'PUT'],
		['name' => 'admin#getPerson', 'url' => '/v1/admin/people/{userId}', 'verb' => 'GET'],
		['name' => 'admin#audit', 'url' => '/v1/admin/audit', 'verb' => 'GET'],

		// The privacy switch of the admin page "Nourax Workspace" (docs/teams.md): a signed-in
		// admin's session with the page's CSRF token, never a key, and outside /v1/.
		['name' => 'privacy_settings#status', 'url' => '/admin/org-privacy', 'verb' => 'GET'],
		['name' => 'privacy_settings#setState', 'url' => '/admin/org-privacy', 'verb' => 'POST'],

		// Anything else under /v1/ (a trailing slash, dot segments, an unknown path or method):
		// a JSON 404 instead of the web server's HTML page. KEEP THESE LAST: the first route
		// that matches wins, so a route added below them would never be reached.
		['name' => 'fallback#notFound', 'url' => '/v1/{rest}', 'verb' => 'GET', 'postfix' => '_get', 'requirements' => ['rest' => '.+']],
		['name' => 'fallback#notFound', 'url' => '/v1/{rest}', 'verb' => 'POST', 'postfix' => '_post', 'requirements' => ['rest' => '.+']],
		['name' => 'fallback#notFound', 'url' => '/v1/{rest}', 'verb' => 'PUT', 'postfix' => '_put', 'requirements' => ['rest' => '.+']],
		['name' => 'fallback#notFound', 'url' => '/v1/{rest}', 'verb' => 'PATCH', 'postfix' => '_patch', 'requirements' => ['rest' => '.+']],
		['name' => 'fallback#notFound', 'url' => '/v1/{rest}', 'verb' => 'DELETE', 'postfix' => '_delete', 'requirements' => ['rest' => '.+']],
	],
];
