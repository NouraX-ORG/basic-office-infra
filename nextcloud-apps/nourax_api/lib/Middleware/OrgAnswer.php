<?php

declare(strict_types=1);

/**
 * Thrown by OrgShareMiddleware before a controller runs, with the answer to give instead: the
 * app's own answer for an account that does not exist, for a person the asker may not see. The
 * same middleware returns it.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Middleware;

use OCP\AppFramework\Http\Response;

class OrgAnswer extends \Exception {
	public function __construct(
		public readonly Response $response,
	) {
		parent::__construct('answered as for an account that does not exist');
	}
}
