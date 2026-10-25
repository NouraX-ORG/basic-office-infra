<?php

declare(strict_types=1);

/**
 * Input rules of the admin API.
 *
 * - org_id and team_id are NoMail's ids: a lowercase UUID, or a QA id ^qa-[a-z0-9-]{1,40}$ for
 *   the tests. They are the keys; names are only labels and can change.
 * - The body of PUT .../orgs/{org_id} and PUT .../teams/{team_id} is {"name","version"}:
 *   name 1-255 characters (control characters become spaces), version an integer of at least 1.
 *
 * A bad id or body is 400 {"error":"invalid_request"}.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

final class AdminRequest {
	public const MAX_NAME = 255;

	private const UUID = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/D';
	private const QA_ID = '/^qa-[a-z0-9-]{1,40}$/D';

	private function __construct(
		public readonly string $name,
		public readonly int $version,
	) {
	}

	public static function validId(string $id): bool {
		return preg_match(self::UUID, $id) === 1 || preg_match(self::QA_ID, $id) === 1;
	}

	/** @throws ApiException 400 invalid_request */
	public static function id(string $id): string {
		if (!self::validId($id)) {
			throw new ApiException('invalid_request', 400);
		}
		return $id;
	}

	/**
	 * {"name","version"} for an organisation or a team.
	 *
	 * @throws ApiException 400 invalid_request
	 */
	public static function nameAndVersion(string $body): self {
		$data = self::object($body);
		$name = $data['name'] ?? null;
		$version = $data['version'] ?? null;
		if (!is_string($name) || !is_int($version) || $version < 1) {
			throw new ApiException('invalid_request', 400);
		}
		$name = trim((string)preg_replace('/[\p{Cc}\p{Zl}\p{Zp}]/u', ' ', $name));
		if ($name === '' || mb_strlen($name) > self::MAX_NAME || preg_match('//u', $name) !== 1) {
			throw new ApiException('invalid_request', 400);
		}
		return new self($name, $version);
	}

	/** @return array<string, mixed> a JSON object */
	private static function object(string $body): array {
		try {
			$data = json_decode($body, true, 16, JSON_THROW_ON_ERROR);
		} catch (\JsonException) {
			throw new ApiException('invalid_request', 400);
		}
		if (!is_array($data) || $data === [] || array_is_list($data)) {
			throw new ApiException('invalid_request', 400);
		}
		return $data;
	}
}
