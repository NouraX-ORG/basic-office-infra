<?php

declare(strict_types=1);

/**
 * A refused admin request signature: 401 {"error":"<code>"}. $throttle is true when the request
 * did not prove it knows the key (it counts for the brute-force protection).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Http;

class AuthFailed extends \RuntimeException {
	public function __construct(
		public readonly string $errorCode,
		public readonly bool $throttle,
	) {
		parent::__construct($errorCode);
	}
}
