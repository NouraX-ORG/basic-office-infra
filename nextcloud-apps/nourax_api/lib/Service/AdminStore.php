<?php

declare(strict_types=1);

/**
 * The stored desired state of organisations, teams and people (tables nourax_api_orgs,
 * nourax_api_teams, nourax_api_people and nourax_api_members), keyed by NoMail's ids. Ids of the
 * things made for a team (address book, Team Folder, calendar, board) are kept here too, so a
 * rename never loses track of them. The drift rows of the groups (nourax_api_drift) are read and
 * closed here.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OCP\AppFramework\Utility\ITimeFactory;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

class AdminStore {
	/** Team columns that hold the id of something made for the team. */
	public const TEAM_RESOURCES = ['folder_id', 'addressbook_id', 'calendar_id', 'board_id'];
	/** Most open drift rows one status answer lists. */
	public const MAX_DRIFT_ROWS = 100;

	/** Seconds a person who left the organisation is kept before the (switched-off) deletion. */
	public const KEEP_LEAVERS = 30 * 86400;
	public const ROLE_MEMBER = 'member';
	public const ROLE_LEAD = 'lead';

	private const ORG_INTS = ['addressbook_id', 'version', 'created_at', 'updated_at'];
	private const PERSON_INTS = ['active', 'version', 'disabled_at', 'delete_after', 'hold', 'created_at', 'updated_at'];
	private const TEAM_INTS = ['folder_id', 'addressbook_id', 'calendar_id', 'board_id', 'archived', 'version', 'created_at', 'updated_at'];

	public function __construct(
		private IDBConnection $db,
		private ITimeFactory $time,
	) {
	}

	public static function orgGroup(string $orgId): string {
		return 'org:' . $orgId;
	}

	public static function teamGroup(string $teamId): string {
		return 'team:' . $teamId;
	}

	/** @return ?array{org_id: string, name: string, group_id: string, addressbook_id: ?int, version: int, created_at: int, updated_at: int} */
	public function org(string $orgId): ?array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from('nourax_api_orgs')
			->where($qb->expr()->eq('org_id', $qb->createNamedParameter($orgId)));
		$row = $qb->executeQuery()->fetchAssociative();
		return $row === false ? null : self::ints($row, self::ORG_INTS);
	}

	/**
	 * Creates or updates the organisation's row.
	 *
	 * @return string created | updated | unchanged
	 */
	public function saveOrg(string $orgId, string $name, int $version, ?array $existing): string {
		$now = $this->time->getTime();
		if ($existing === null) {
			$qb = $this->db->getQueryBuilder();
			$qb->insert('nourax_api_orgs')->values([
				'org_id' => $qb->createNamedParameter($orgId),
				'name' => $qb->createNamedParameter($name),
				'group_id' => $qb->createNamedParameter(self::orgGroup($orgId)),
				'version' => $qb->createNamedParameter($version, IQueryBuilder::PARAM_INT),
				'created_at' => $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT),
				'updated_at' => $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT),
			])->executeStatement();
			return Steps::CREATED;
		}
		if ($existing['name'] === $name && $existing['version'] === $version) {
			return Steps::UNCHANGED;
		}
		$qb = $this->db->getQueryBuilder();
		$qb->update('nourax_api_orgs')
			->set('name', $qb->createNamedParameter($name))
			->set('version', $qb->createNamedParameter($version, IQueryBuilder::PARAM_INT))
			->set('updated_at', $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('org_id', $qb->createNamedParameter($orgId)))
			->executeStatement();
		return Steps::UPDATED;
	}

	public function setOrgAddressBook(string $orgId, ?int $addressBookId): void {
		$qb = $this->db->getQueryBuilder();
		$qb->update('nourax_api_orgs')
			->set('addressbook_id', $qb->createNamedParameter($addressBookId, $addressBookId === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('org_id', $qb->createNamedParameter($orgId)))
			->executeStatement();
	}

	/** @return ?array{team_id: string, org_id: string, name: string, group_id: string, folder_id: ?int, addressbook_id: ?int, calendar_id: ?int, board_id: ?int, archived: int, version: int, created_at: int, updated_at: int} */
	public function team(string $teamId): ?array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from('nourax_api_teams')
			->where($qb->expr()->eq('team_id', $qb->createNamedParameter($teamId)));
		$row = $qb->executeQuery()->fetchAssociative();
		return $row === false ? null : self::ints($row, self::TEAM_INTS);
	}

	/** @return list<array> the organisation's teams, by name */
	public function teamsOf(string $orgId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from('nourax_api_teams')
			->where($qb->expr()->eq('org_id', $qb->createNamedParameter($orgId)))
			->orderBy('name')->addOrderBy('team_id');
		$rows = [];
		$result = $qb->executeQuery();
		while (($row = $result->fetchAssociative()) !== false) {
			$rows[] = self::ints($row, self::TEAM_INTS);
		}
		$result->closeCursor();
		return $rows;
	}

	/**
	 * Creates or updates the team's row. The org of an existing team never changes here.
	 *
	 * @return string created | updated | unchanged
	 */
	public function saveTeam(string $teamId, string $orgId, string $name, int $version, ?array $existing): string {
		$now = $this->time->getTime();
		if ($existing === null) {
			$qb = $this->db->getQueryBuilder();
			$qb->insert('nourax_api_teams')->values([
				'team_id' => $qb->createNamedParameter($teamId),
				'org_id' => $qb->createNamedParameter($orgId),
				'name' => $qb->createNamedParameter($name),
				'group_id' => $qb->createNamedParameter(self::teamGroup($teamId)),
				'archived' => $qb->createNamedParameter(0, IQueryBuilder::PARAM_INT),
				'version' => $qb->createNamedParameter($version, IQueryBuilder::PARAM_INT),
				'created_at' => $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT),
				'updated_at' => $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT),
			])->executeStatement();
			return Steps::CREATED;
		}
		if ($existing['name'] === $name && $existing['version'] === $version) {
			return Steps::UNCHANGED;
		}
		$qb = $this->db->getQueryBuilder();
		$qb->update('nourax_api_teams')
			->set('name', $qb->createNamedParameter($name))
			->set('version', $qb->createNamedParameter($version, IQueryBuilder::PARAM_INT))
			->set('updated_at', $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('team_id', $qb->createNamedParameter($teamId)))
			->executeStatement();
		return Steps::UPDATED;
	}

	/** Stores the id of something made for the team (one of TEAM_RESOURCES). */
	public function setTeamResource(string $teamId, string $column, ?int $id): void {
		if (!in_array($column, self::TEAM_RESOURCES, true)) {
			throw new \InvalidArgumentException('not a team resource column: ' . $column);
		}
		$qb = $this->db->getQueryBuilder();
		$qb->update('nourax_api_teams')
			->set($column, $qb->createNamedParameter($id, $id === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('team_id', $qb->createNamedParameter($teamId)))
			->executeStatement();
	}

	/**
	 * The group's open drift rows (nourax_api_drift, written by GroupDriftListener): changes made
	 * outside this API that have not been put back yet. Newest first, at most $limit rows.
	 *
	 * @return list<array{id: int, at: string, kind: string, user_id: ?string}>
	 */
	public function openDrift(string $groupId, int $limit = self::MAX_DRIFT_ROWS): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('id', 'at', 'kind', 'user_id')->from('nourax_api_drift')
			->where($qb->expr()->eq('group_id', $qb->createNamedParameter($groupId)))
			->andWhere($qb->expr()->isNull('fixed_at'))
			->orderBy('id', 'DESC')
			->setMaxResults(max(1, $limit));
		$rows = [];
		$result = $qb->executeQuery();
		while (($row = $result->fetchAssociative()) !== false) {
			$rows[] = [
				'id' => (int)$row['id'],
				'at' => gmdate('c', (int)$row['at']),
				'kind' => (string)$row['kind'],
				'user_id' => $row['user_id'] === null ? null : (string)$row['user_id'],
			];
		}
		$result->closeCursor();
		return $rows;
	}

	public function setTeamArchived(string $teamId, bool $archived): void {
		$qb = $this->db->getQueryBuilder();
		$qb->update('nourax_api_teams')
			->set('archived', $qb->createNamedParameter($archived ? 1 : 0, IQueryBuilder::PARAM_INT))
			->set('updated_at', $qb->createNamedParameter($this->time->getTime(), IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('team_id', $qb->createNamedParameter($teamId)))
			->executeStatement();
	}

	/** @return list<string> every stored organisation id, sorted */
	public function orgIds(): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('org_id')->from('nourax_api_orgs')->orderBy('org_id');
		return array_map('strval', $qb->executeQuery()->fetchFirstColumn());
	}

	// --- People ----------------------------------------------------------------------------------

	/** @return ?array{user_id: string, org_id: ?string, email: ?string, display_name: ?string, active: int, version: int, disabled_at: ?int, delete_after: ?int, hold: int, created_at: int, updated_at: int} */
	public function person(string $userId): ?array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from('nourax_api_people')
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
		$row = $qb->executeQuery()->fetchAssociative();
		return $row === false ? null : self::ints($row, self::PERSON_INTS);
	}

	/**
	 * Creates or updates a person's desired state (not disabled_at, delete_after or hold).
	 *
	 * @return string created | updated | unchanged
	 */
	public function savePerson(string $userId, ?string $orgId, string $email, string $displayName, bool $active, int $version, ?array $existing): string {
		$now = $this->time->getTime();
		$values = [
			'org_id' => $orgId,
			'email' => $email,
			'display_name' => $displayName,
			'active' => $active ? 1 : 0,
			'version' => $version,
		];
		if ($existing === null) {
			$qb = $this->db->getQueryBuilder();
			$qb->insert('nourax_api_people')->values([
				'user_id' => $qb->createNamedParameter($userId),
				'org_id' => $qb->createNamedParameter($orgId),
				'email' => $qb->createNamedParameter($email),
				'display_name' => $qb->createNamedParameter($displayName),
				'active' => $qb->createNamedParameter($values['active'], IQueryBuilder::PARAM_INT),
				'version' => $qb->createNamedParameter($version, IQueryBuilder::PARAM_INT),
				'hold' => $qb->createNamedParameter(0, IQueryBuilder::PARAM_INT),
				'created_at' => $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT),
				'updated_at' => $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT),
			])->executeStatement();
			return Steps::CREATED;
		}
		$same = true;
		foreach ($values as $column => $value) {
			if ($existing[$column] !== $value) {
				$same = false;
			}
		}
		if ($same) {
			return Steps::UNCHANGED;
		}
		$qb = $this->db->getQueryBuilder();
		$qb->update('nourax_api_people')
			->set('org_id', $qb->createNamedParameter($orgId))
			->set('email', $qb->createNamedParameter($email))
			->set('display_name', $qb->createNamedParameter($displayName))
			->set('active', $qb->createNamedParameter($values['active'], IQueryBuilder::PARAM_INT))
			->set('version', $qb->createNamedParameter($version, IQueryBuilder::PARAM_INT))
			->set('updated_at', $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->executeStatement();
		return Steps::UPDATED;
	}

	/** When the account was disabled by this API and when it may be deleted; null clears both. */
	public function setPersonDisabled(string $userId, ?int $disabledAt, ?int $deleteAfter): void {
		$qb = $this->db->getQueryBuilder();
		$qb->update('nourax_api_people')
			->set('disabled_at', $qb->createNamedParameter($disabledAt, $disabledAt === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_INT))
			->set('delete_after', $qb->createNamedParameter($deleteAfter, $deleteAfter === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->executeStatement();
	}

	/**
	 * A person the organisation's reconcile no longer lists: no organisation and no teams in the
	 * desired state any more. The account itself stays as it is.
	 */
	public function detachPerson(string $userId): void {
		$qb = $this->db->getQueryBuilder();
		$qb->update('nourax_api_people')
			->set('org_id', $qb->createNamedParameter(null, IQueryBuilder::PARAM_NULL))
			->set('updated_at', $qb->createNamedParameter($this->time->getTime(), IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->executeStatement();
		$this->setMemberships($userId, []);
	}

	/**
	 * People whose stored state puts them in the organisation.
	 *
	 * @return array<string, array> rows by uid
	 */
	public function peopleOf(string $orgId, bool $activeOnly = true): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from('nourax_api_people')
			->where($qb->expr()->eq('org_id', $qb->createNamedParameter($orgId)));
		if ($activeOnly) {
			$qb->andWhere($qb->expr()->eq('active', $qb->createNamedParameter(1, IQueryBuilder::PARAM_INT)));
		}
		$rows = [];
		$result = $qb->executeQuery();
		while (($row = $result->fetchAssociative()) !== false) {
			$rows[(string)$row['user_id']] = self::ints($row, self::PERSON_INTS);
		}
		$result->closeCursor();
		ksort($rows, SORT_STRING);
		return $rows;
	}

	/**
	 * People who left (active 0), whose delete_after has passed and who are not on hold.
	 *
	 * @return list<array> rows
	 */
	public function leaversDue(int $now): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from('nourax_api_people')
			->where($qb->expr()->eq('active', $qb->createNamedParameter(0, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('hold', $qb->createNamedParameter(0, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->isNotNull('delete_after'))
			->andWhere($qb->expr()->lt('delete_after', $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT)))
			->orderBy('user_id');
		$rows = [];
		$result = $qb->executeQuery();
		while (($row = $result->fetchAssociative()) !== false) {
			$rows[] = self::ints($row, self::PERSON_INTS);
		}
		$result->closeCursor();
		return $rows;
	}

	// --- Team membership (the desired state) -----------------------------------------------------

	/** @return array<string, string> role by team id */
	public function teamsOfPerson(string $userId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('team_id', 'role')->from('nourax_api_members')
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->orderBy('team_id');
		$teams = [];
		$result = $qb->executeQuery();
		while (($row = $result->fetchAssociative()) !== false) {
			$teams[(string)$row['team_id']] = (string)$row['role'];
		}
		$result->closeCursor();
		return $teams;
	}

	/** @return array<string, string> role by uid */
	public function membersOfTeam(string $teamId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('user_id', 'role')->from('nourax_api_members')
			->where($qb->expr()->eq('team_id', $qb->createNamedParameter($teamId)))
			->orderBy('user_id');
		$members = [];
		$result = $qb->executeQuery();
		while (($row = $result->fetchAssociative()) !== false) {
			$members[(string)$row['user_id']] = (string)$row['role'];
		}
		$result->closeCursor();
		return $members;
	}

	/**
	 * Makes the person's stored teams exactly $teams (role by team id). Only this person's rows
	 * change. These rows are the desired state, not anybody's data.
	 *
	 * @param array<string, string> $teams
	 */
	public function setMemberships(string $userId, array $teams): void {
		$current = $this->teamsOfPerson($userId);
		$now = $this->time->getTime();
		foreach (array_keys($current) as $teamId) {
			if (!isset($teams[$teamId])) {
				$this->removeMembership((string)$teamId, $userId);
			}
		}
		foreach ($teams as $teamId => $role) {
			$qb = $this->db->getQueryBuilder();
			if (!isset($current[$teamId])) {
				$qb->insert('nourax_api_members')->values([
					'team_id' => $qb->createNamedParameter((string)$teamId),
					'user_id' => $qb->createNamedParameter($userId),
					'role' => $qb->createNamedParameter($role),
					'joined_at' => $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT),
				])->executeStatement();
			} elseif ($current[$teamId] !== $role) {
				$qb->update('nourax_api_members')
					->set('role', $qb->createNamedParameter($role))
					->where($qb->expr()->eq('team_id', $qb->createNamedParameter((string)$teamId)))
					->andWhere($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
					->executeStatement();
			}
		}
	}

	/** Takes one team out of one person's stored teams. */
	public function removeMembership(string $teamId, string $userId): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete('nourax_api_members')
			->where($qb->expr()->eq('team_id', $qb->createNamedParameter($teamId)))
			->andWhere($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->executeStatement();
	}

	// --- Drift -----------------------------------------------------------------------------------

	/**
	 * Open drift rows about one person, in any org:* or team:* group, newest first.
	 *
	 * @return list<array{id: int, at: string, kind: string, group_id: string}>
	 */
	public function openDriftOfUser(string $userId, int $limit = self::MAX_DRIFT_ROWS): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('id', 'at', 'kind', 'group_id')->from('nourax_api_drift')
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->isNull('fixed_at'))
			->orderBy('id', 'DESC')
			->setMaxResults(max(1, $limit));
		$rows = [];
		$result = $qb->executeQuery();
		while (($row = $result->fetchAssociative()) !== false) {
			$rows[] = [
				'id' => (int)$row['id'],
				'at' => gmdate('c', (int)$row['at']),
				'kind' => (string)$row['kind'],
				'group_id' => (string)$row['group_id'],
			];
		}
		$result->closeCursor();
		return $rows;
	}

	/** @return list<string> the groups that have open drift rows */
	public function openDriftGroups(): array {
		$qb = $this->db->getQueryBuilder();
		$qb->selectDistinct('group_id')->from('nourax_api_drift')
			->where($qb->expr()->isNull('fixed_at'))
			->orderBy('group_id');
		return array_map('strval', $qb->executeQuery()->fetchFirstColumn());
	}

	/**
	 * Closes the group's open drift rows, once the group matches the desired state again.
	 *
	 * @return int the rows closed
	 */
	public function markDriftFixed(string $groupId): int {
		$qb = $this->db->getQueryBuilder();
		$qb->update('nourax_api_drift')
			->set('fixed_at', $qb->createNamedParameter($this->time->getTime(), IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('group_id', $qb->createNamedParameter($groupId)))
			->andWhere($qb->expr()->isNull('fixed_at'));
		return $qb->executeStatement();
	}

	/** @param list<string> $columns */
	private static function ints(array $row, array $columns): array {
		foreach ($columns as $column) {
			if (array_key_exists($column, $row)) {
				$row[$column] = $row[$column] === null ? null : (int)$row[$column];
			}
		}
		return $row;
	}
}
