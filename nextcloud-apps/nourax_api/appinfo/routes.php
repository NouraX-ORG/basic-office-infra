<?php

declare(strict_types=1);

/**
 * Plain (non-OCS) routes, served at https://drive.nourax.org/apps/nourax_api/v1/...
 * NoMail reads NODRIVE_API_URL as the base and appends /v1/health, /v1/provision and /v1/scan.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

return [
	'routes' => [
		['name' => 'nomail#health', 'url' => '/v1/health', 'verb' => 'GET'],
	],
];
