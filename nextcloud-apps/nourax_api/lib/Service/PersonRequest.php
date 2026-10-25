<?php

declare(strict_types=1);

/**
 * The body of PUT /v1/admin/people/{user_id}: a person's whole desired state.
 *
 *   {"email","display_name","org_id","teams":[{"team_id","role"}],"active","version"}
 *
 * - email: a string, trimmed, at most 320 characters ("" leaves the account's email as it is).
 * - display_name: a string, at most 255 characters ("" leaves the name as it is).
 * - The uid in the path: a Supabase user id, a QA id qa-t<task>-<n>, or a demo id demo-...
 *   (ProvisionRequest::validPersonId).
 * - org_id: the organisation's id (a lowercase UUID, a QA id qa-... or a demo id demo-...). A
 *   demo- person belongs only to a demo- organisation and the other way round
 *   (AdminRequest::sameKind), so demo data never mixes with real organisations.
 * - teams: at most 100 teams of that organisation, each once; role is "member" or "lead".
 *   [] means: in no team.
 * - active: true, or false when the person has left the organisation.
 * - version: NoMail's counter for this person, an integer of at least 1.
 *
 * Anything else is 400 {"error":"invalid_request"}. Unknown fields are ignored. The same rules
 * check each person of a reconcile call (fromArray).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

final class PersonRequest {
	public const MAX_TEAMS = 100;
	public const ROLES = [AdminStore::ROLE_MEMBER, AdminStore::ROLE_LEAD];

	/**
	 * @param array<string, string> $teams role by team id, sorted by team id
	 */
	private function __construct(
		public readonly string $userId,
		public readonly string $email,
		public readonly string $displayName,
		public readonly string $orgId,
		public readonly array $teams,
		public readonly bool $active,
		public readonly int $version,
	) {
	}

	/** @throws ApiException 400 invalid_request */
	public static function fromJson(string $userId, string $body): self {
		try {
			$data = json_decode($body, true, 16, JSON_THROW_ON_ERROR);
		} catch (\JsonException) {
			throw self::invalid();
		}
		return self::fromArray($userId, $data);
	}

	/** @throws ApiException 400 invalid_request */
	public static function fromArray(string $userId, mixed $data): self {
		if (!ProvisionRequest::validPersonId($userId) || !is_array($data) || $data === [] || array_is_list($data)) {
			throw self::invalid();
		}
		$email = $data['email'] ?? null;
		$displayName = $data['display_name'] ?? null;
		$orgId = $data['org_id'] ?? null;
		$teams = $data['teams'] ?? null;
		$active = $data['active'] ?? null;
		$version = $data['version'] ?? null;
		if (!is_string($email) || !is_string($displayName) || !is_string($orgId) || !AdminRequest::validId($orgId)
			|| !is_array($teams) || !array_is_list($teams) || count($teams) > self::MAX_TEAMS
			|| !is_bool($active) || !is_int($version) || $version < 1 || !AdminRequest::sameKind($userId, $orgId)) {
			throw self::invalid();
		}

		$email = trim($email);
		if (mb_strlen($email) > ProvisionRequest::MAX_EMAIL || preg_match('/\p{Cc}/u', $email) === 1 || preg_match('//u', $email) !== 1) {
			throw self::invalid();
		}
		if (preg_match('//u', $displayName) !== 1) {
			throw self::invalid();
		}

		$wanted = [];
		foreach ($teams as $team) {
			$teamId = is_array($team) ? ($team['team_id'] ?? null) : null;
			$role = is_array($team) ? ($team['role'] ?? AdminStore::ROLE_MEMBER) : null;
			if (!is_string($teamId) || !AdminRequest::validId($teamId) || !in_array($role, self::ROLES, true)
				|| isset($wanted[$teamId])) {
				throw self::invalid();
			}
			$wanted[$teamId] = $role;
		}
		ksort($wanted, SORT_STRING);

		return new self($userId, $email, ProvisionRequest::cleanDisplayName($displayName), $orgId, $wanted, $active, $version);
	}

	/** @return list<array{team_id: string, role: string}> */
	public function teamList(): array {
		$list = [];
		foreach ($this->teams as $teamId => $role) {
			$list[] = ['team_id' => (string)$teamId, 'role' => $role];
		}
		return $list;
	}

	private static function invalid(): ApiException {
		return new ApiException('invalid_request', 400);
	}
}
