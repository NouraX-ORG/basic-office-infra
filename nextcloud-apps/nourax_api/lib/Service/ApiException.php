<?php

declare(strict_types=1);

/**
 * A refusal the caller should see as {"error":"<code>"} with this HTTP status, e.g.
 * 400 invalid_request or 409 account_disabled. Anything else that is thrown becomes a 500.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

class ApiException extends \RuntimeException {
	public function __construct(
		public readonly string $errorCode,
		public readonly int $httpStatus,
	) {
		parent::__construct($errorCode);
	}
}
