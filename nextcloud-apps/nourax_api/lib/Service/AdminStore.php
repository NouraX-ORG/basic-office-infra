<?php

declare(strict_types=1);

/**
 * The stored desired state of organisations and teams (tables nourax_api_orgs and
 * nourax_api_teams), keyed by NoMail's ids. Ids of the things made for them (address book,
 * Team Folder, calendar, board) are kept here too, so a rename never loses track of them. The
 * open drift rows of their groups (nourax_api_drift) are read here for the status answers.
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

	private const ORG_INTS = ['addressbook_id', 'version', 'created_at', 'updated_at'];
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
