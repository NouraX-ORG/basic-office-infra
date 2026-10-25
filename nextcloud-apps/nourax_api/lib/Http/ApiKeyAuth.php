<?php

declare(strict_types=1);

/**
 * The NoMail API's key check: "Authorization: Bearer <NODRIVE_API_KEY>".
 * Only the key's SHA-256 is stored, and it is compared in constant time.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Http;

use OCA\NouraxApi\Settings;
use OCP\IRequest;

class ApiKeyAuth {
	/** Keys are at least 32 bytes (secrets.sh makes 48 characters). */
	public const MIN_LENGTH = 32;
	public const MAX_LENGTH = 1024;

	public function __construct(
		private Settings $settings,
	) {
	}

	/** False until `occ nourax_api:secret api_key` has stored a key. */
	public function isConfigured(): bool {
		return preg_match('/^[0-9a-f]{64}$/', $this->settings->apiKeyHash()) === 1;
	}

	public function check(IRequest $request): bool {
		$header = $request->getHeader('Authorization');
		if (strncasecmp($header, 'Bearer ', 7) !== 0) {
			return false;
		}
		return $this->verify(trim(substr($header, 7)));
	}

	public function verify(#[\SensitiveParameter] string $key): bool {
		$stored = $this->settings->apiKeyHash();
		// Hash even a bad key, so a wrong length takes as long as a wrong key.
		$given = hash('sha256', $key);
		if ($stored === '' || !self::acceptable($key)) {
			return false;
		}
		return hash_equals($stored, $given);
	}

	public function store(#[\SensitiveParameter] string $key): void {
		if (!self::acceptable($key)) {
			throw new \InvalidArgumentException('a key must be ' . self::MIN_LENGTH . ' to ' . self::MAX_LENGTH . ' visible characters');
		}
		$this->settings->setApiKeyHash(hash('sha256', $key));
	}

	/** At least 32 bytes, printable ASCII, no spaces (it travels in an HTTP header). */
	public static function acceptable(#[\SensitiveParameter] string $key): bool {
		$length = strlen($key);
		return $length >= self::MIN_LENGTH && $length <= self::MAX_LENGTH && preg_match('/^[\x21-\x7e]+$/', $key) === 1;
	}
}
