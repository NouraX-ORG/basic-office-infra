<?php

declare(strict_types=1);

/**
 * Input rules of the admin API.
 *
 * - org_id and team_id are NoMail's ids: a lowercase UUID, a QA id ^qa-[a-z0-9-]{1,40}$ for the
 *   tests, or a demo id ^demo-[a-z0-9-]{1,40}$ for the owner's kept demo data
 *   (tests/demo-accounts.sh). They are the keys; names are only labels and can change.
 * - Demo data never mixes with other data: a demo- team belongs only to a demo- organisation, and
 *   a demo- person only to a demo- organisation (sameKind). A Supabase id is always a UUID, so a
 *   demo- id can never be a real person or one of NoMail's organisations.
 * - The body of PUT .../orgs/{org_id} and PUT .../teams/{team_id} is {"name","version"}:
 *   name 1-255 characters (control characters become spaces), version an integer of at least 1.
 * - A person's body is checked by PersonRequest, a reconcile body by ReconcileService.
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
	private const DEMO_ID = '/^demo-[a-z0-9-]{1,40}$/D';

	private function __construct(
		public readonly string $name,
		public readonly int $version,
	) {
	}

	public static function validId(string $id): bool {
		return preg_match(self::UUID, $id) === 1 || preg_match(self::QA_ID, $id) === 1 || self::isDemoId($id);
	}

	/** An id of the owner's kept demo data, ^demo-[a-z0-9-]{1,40}$: an organisation, a team or a person. */
	public static function isDemoId(string $id): bool {
		return preg_match(self::DEMO_ID, $id) === 1;
	}

	/**
	 * Whether two ids may go together: both demo- ids, or neither. Checked for a team and its
	 * organisation and for a person and their organisation.
	 */
	public static function sameKind(string $a, string $b): bool {
		return self::isDemoId($a) === self::isDemoId($b);
	}

	/**
	 * The organisation and team ids of a team call.
	 *
	 * @return array{0: string, 1: string}
	 * @throws ApiException 400 invalid_request, also for a demo- team in another organisation or the other way round
	 */
	public static function teamIds(string $orgId, string $teamId): array {
		$orgId = self::id($orgId);
		$teamId = self::id($teamId);
		if (!self::sameKind($orgId, $teamId)) {
			throw new ApiException('invalid_request', 400);
		}
		return [$orgId, $teamId];
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
		return self::fromArray(self::object($body));
	}

	/**
	 * The same rules for {"name","version"} given as an array (a team of a reconcile call).
	 *
	 * @throws ApiException 400 invalid_request
	 */
	public static function fromArray(mixed $data): self {
		if (!is_array($data)) {
			throw new ApiException('invalid_request', 400);
		}
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

	/** The stored name and version, to run an organisation's or team's steps again (drift repair). */
	public static function stored(string $name, int $version): self {
		return new self($name, $version);
	}

	/**
	 * @return array<string, mixed> a JSON object
	 * @throws ApiException 400 invalid_request
	 */
	public static function object(string $body): array {
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
