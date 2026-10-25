<?php

declare(strict_types=1);

/**
 * The body of POST /v1/provision: {"user_id","email","display_name"} as JSON, at most 16 KB.
 *
 * - user_id is the person's Supabase user id: a lowercase UUID. QA ids like qa-t6-1 are allowed
 *   for the contract tests. Anything else (nodrive, admin, an uppercase UUID) is refused, so this
 *   API can never touch the emergency admin or another local account by name.
 * - email is trimmed, at most 320 characters, and may be empty (then it is left as it is).
 * - display_name is at most 255 characters; control characters become spaces.
 *
 * A bad body is 400 {"error":"invalid_request"}; a body over 16 KB is 413 {"error":"too_large"}.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

final class ProvisionRequest {
	public const MAX_BODY = 16384;
	public const MAX_EMAIL = 320;
	public const MAX_DISPLAY_NAME = 255;

	// D: "$" must not match before a trailing newline.
	private const UUID = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/D';
	private const QA_ID = '/^qa-t[0-9]{1,2}-[0-9]{1,3}$/D';

	private function __construct(
		public readonly string $userId,
		public readonly string $email,
		public readonly string $displayName,
	) {
	}

	/** @throws ApiException */
	public static function fromJson(string $body): self {
		if (strlen($body) > self::MAX_BODY) {
			throw new ApiException('too_large', 413);
		}
		try {
			$data = json_decode($body, true, 4, JSON_THROW_ON_ERROR);
		} catch (\JsonException) {
			throw self::invalid();
		}
		if (!is_array($data) || $data === [] || array_is_list($data)) {
			throw self::invalid();
		}

		$userId = $data['user_id'] ?? null;
		$email = $data['email'] ?? null;
		$displayName = $data['display_name'] ?? null;
		if (!is_string($userId) || !self::validUserId($userId) || !is_string($email) || !is_string($displayName)) {
			throw self::invalid();
		}

		$email = trim($email);
		if (mb_strlen($email) > self::MAX_EMAIL || preg_match('/\p{Cc}/u', $email) === 1) {
			throw self::invalid();
		}
		return new self($userId, $email, self::cleanDisplayName($displayName));
	}

	/** A Supabase user id (lowercase UUID) or a QA id (qa-t<task>-<n>). */
	public static function validUserId(string $userId): bool {
		return preg_match(self::UUID, $userId) === 1 || preg_match(self::QA_ID, $userId) === 1;
	}

	public static function cleanDisplayName(string $name): string {
		$name = trim((string)preg_replace('/[\p{Cc}\p{Zl}\p{Zp}]/u', ' ', $name));
		return mb_substr($name, 0, self::MAX_DISPLAY_NAME);
	}

	private static function invalid(): ApiException {
		return new ApiException('invalid_request', 400);
	}
}
