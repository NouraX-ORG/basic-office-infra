<?php

declare(strict_types=1);

/**
 * PUT /v1/admin/orgs/{org_id}/teams/{team_id} {"name","version"}: a team of an organisation,
 * keyed by NoMail's ids. The organisation must exist (409 org_missing), and a team never moves
 * to another organisation (409 team_in_other_org).
 *
 * Steps (each an "ensure"; "Team: <name>" is the display name everywhere):
 * 1. record              the nourax_api_teams row (name, version)
 * 2. group               the locked group "team:{team_id}"
 * 3. team_folder         a Team Folder for the group only (TeamFolderService)
 * 4. addressbook         the service account's address book "team-{team_id}"
 * 5. addressbook_share   shared read-only with the group
 * 6. cards               one card per enabled member of the group
 * 7. calendar            the service account's calendar "team-{team_id}"
 * 8. calendar_share      shared read-write with the group
 * 9. board               a Deck board
 * 10. board_share        shared with the group (edit, no share, no manage)
 *
 * A rename keeps every id and renames the group, folder, address book, calendar and board.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use Psr\Log\LoggerInterface;

class TeamService {
	private const STEPS = ['group', 'team_folder', 'addressbook', 'addressbook_share', 'cards', 'calendar',
		'calendar_share', 'board', 'board_share'];

	public function __construct(
		private AdminStore $store,
		private ObjectLock $locks,
		private GroupService $groups,
		private TeamFolderService $folders,
		private AddressBookService $books,
		private TeamCalendarService $calendars,
		private DeckClient $deck,
		private LoggerInterface $logger,
	) {
	}

	public static function displayName(string $name): string {
		return 'Team: ' . $name;
	}

	public static function resourceUri(string $teamId): string {
		return 'team-' . $teamId;
	}

	/** @throws ApiException 409 org_missing | team_in_other_org, 423 busy */
	public function put(string $orgId, string $teamId, AdminRequest $request): array {
		$org = $this->store->org($orgId);
		if ($org === null) {
			throw new ApiException('org_missing', 409);
		}

		return $this->locks->with('team/' . $teamId, function () use ($org, $orgId, $teamId, $request): array {
			$row = $this->store->team($teamId);
			if ($row !== null && $row['org_id'] !== $orgId) {
				throw new ApiException('team_in_other_org', 409);
			}
			$ids = ['org_id' => $orgId, 'team_id' => $teamId];
			if ($row !== null && $row['version'] > $request->version) {
				return Steps::stale($request->version, $row['version'], $ids);
			}

			$steps = new Steps($this->logger, 'team ' . $teamId);
			$groupId = AdminStore::teamGroup($teamId);
			$title = self::displayName($request->name);
			$archived = $row !== null && $row['archived'] === 1;

			$recorded = $steps->run('record', fn (): array => [
				$this->store->saveTeam($teamId, $orgId, $request->name, $request->version, $row), 'version ' . $request->version,
			]);
			if (!$recorded) {
				foreach (self::STEPS as $step) {
					$steps->skip($step, 'not run: the record could not be saved');
				}
				return $steps->answer($request->version, $ids);
			}

			$groupReady = $steps->run('group', fn (): array => $this->groups->ensure($groupId, $title));
			if (!$groupReady) {
				foreach (array_slice(self::STEPS, 1) as $step) {
					$steps->skip($step, 'not run: needs the group');
				}
				return $steps->answer($request->version, $ids);
			}

			// One team folder name choice at a time per organisation, so two new teams with the
			// same name cannot both take "Sales".
			$steps->run('team_folder', fn (): array => $this->locks->waitFor('org-folders/' . $orgId, 15,
				function () use ($row, $groupId, $teamId, $orgId, $request, $archived): array {
					[$folderId, $result, $detail] = $this->folders->ensure($row['folder_id'] ?? null, $groupId, $teamId, $orgId, $request->name, $archived);
					$this->remember($teamId, $row, 'folder_id', $folderId);
					return [$result, $detail];
				}));

			$bookId = null;
			$steps->run('addressbook', function () use ($row, $teamId, $title, &$bookId): array {
				[$bookId, $result, $detail] = $this->books->ensureBook(self::resourceUri($teamId), $title);
				$this->remember($teamId, $row, 'addressbook_id', $bookId);
				return [$result, $detail];
			});
			if ($bookId !== null) {
				$steps->run('addressbook_share', fn (): array => $this->books->ensureReadOnlyShare($bookId, $groupId));
				$steps->run('cards', fn (): array => $this->books->syncCards($bookId, $this->groups->activeMembers($groupId), $org['name']));
			} else {
				$steps->skip('addressbook_share', 'not run: needs the address book');
				$steps->skip('cards', 'not run: needs the address book');
			}

			$calendarId = null;
			$steps->run('calendar', function () use ($row, $teamId, $title, &$calendarId): array {
				[$calendarId, $result, $detail] = $this->calendars->ensureCalendar(self::resourceUri($teamId), $title);
				$this->remember($teamId, $row, 'calendar_id', $calendarId);
				return [$result, $detail];
			});
			if ($calendarId !== null) {
				$steps->run('calendar_share', fn (): array => $this->calendars->ensureShare($calendarId, $groupId));
			} else {
				$steps->skip('calendar_share', 'not run: needs the calendar');
			}

			$board = null;
			$steps->run('board', function () use ($row, $teamId, $title, $archived, &$board): array {
				[$boardId, $result, $detail, $board] = $this->deck->ensureBoard($row['board_id'] ?? null, $title, $archived);
				$this->remember($teamId, $row, 'board_id', $boardId);
				return [$result, $detail];
			});
			if ($board !== null) {
				$steps->run('board_share', fn (): array => $this->deck->ensureGroupAcl($board, $groupId));
			} else {
				$steps->skip('board_share', 'not run: needs the board');
			}

			return $steps->answer($request->version, $ids);
		});
	}

	/**
	 * Rebuilds the team address book's cards from the group's members (for membership changes,
	 * e.g. by the people API).
	 *
	 * @return array{0: string, 1: string} [result, detail]
	 */
	public function syncCards(string $teamId): array {
		$row = $this->store->team($teamId);
		$org = $row === null ? null : $this->store->org($row['org_id']);
		if ($row === null || $org === null || $row['addressbook_id'] === null) {
			throw new StepFailed('the team has no address book yet');
		}
		// One rebuild of a book at a time: two people's calls may change the same team book.
		return $this->locks->waitFor('cards/' . $row['addressbook_id'], 15,
			fn (): array => $this->books->syncCards($row['addressbook_id'], $this->groups->activeMembers($row['group_id']), $org['name']));
	}

	/**
	 * Archives a team whose last member left, or brings it back when someone joins again. The
	 * folder is renamed "<name> (archived)" (and back) and the board is archived (and back). The
	 * group, the folder and its files, the address book and the calendar all stay: nothing is
	 * deleted.
	 *
	 * @return array{0: string, 1: string} [result, detail]
	 */
	public function setArchived(string $teamId, bool $archived): array {
		return $this->locks->waitFor('team/' . $teamId, 15, function () use ($teamId, $archived): array {
			$row = $this->store->team($teamId);
			if ($row === null) {
				throw new StepFailed('team ' . $teamId . ' is not stored');
			}
			$changes = [];
			if (($row['archived'] === 1) !== $archived) {
				$this->store->setTeamArchived($teamId, $archived);
				$changes[] = $archived ? 'archived' : 'unarchived';
			}
			$folderName = null;
			if ($row['folder_id'] !== null) {
				$this->locks->waitFor('org-folders/' . $row['org_id'], 15, function () use ($row, $teamId, $archived, &$changes, &$folderName): void {
					[$folderId, $result, $detail] = $this->folders->ensure($row['folder_id'], $row['group_id'], $teamId, $row['org_id'], $row['name'], $archived);
					$this->remember($teamId, $row, 'folder_id', $folderId);
					$folderName = $detail;
					if ($result !== Steps::UNCHANGED) {
						$changes[] = 'folder';
					}
				});
			}
			if ($row['board_id'] !== null) {
				[$boardId, $result] = $this->deck->ensureBoard($row['board_id'], self::displayName($row['name']), $archived);
				$this->remember($teamId, $row, 'board_id', $boardId);
				if ($result !== Steps::UNCHANGED) {
					$changes[] = 'board';
				}
			}
			$detail = ($archived ? 'archived' : 'active') . ($folderName === null ? '' : ', ' . $folderName);
			return [$changes === [] ? Steps::UNCHANGED : Steps::UPDATED, $detail];
		});
	}

	/**
	 * GET /v1/admin/orgs/{org_id}/teams/{team_id}: the stored state next to what is really there.
	 *
	 * @throws ApiException 404 not_found
	 */
	public function status(string $orgId, string $teamId): array {
		$row = $this->store->team($teamId);
		if ($row === null || $row['org_id'] !== $orgId) {
			throw new ApiException('not_found', 404);
		}
		$groupId = $row['group_id'];
		$group = $this->groups->get($groupId);
		return ['ok' => true, 'team' => [
			'org_id' => $orgId,
			'team_id' => $teamId,
			'name' => $row['name'],
			'version' => $row['version'],
			'archived' => $row['archived'] === 1,
			'created_at' => gmdate('c', $row['created_at']),
			'updated_at' => gmdate('c', $row['updated_at']),
			'group' => [
				'id' => $groupId,
				'exists' => $group !== null,
				'display_name' => $group?->getDisplayName(),
				'members' => count($this->groups->activeMembers($groupId)),
			],
			'folder' => OrgService::section(fn (): array => $this->folders->describe($row['folder_id']), $row['folder_id']),
			'addressbook' => OrgService::section(fn (): array => $this->books->describe($row['addressbook_id'], $groupId), $row['addressbook_id']),
			'calendar' => OrgService::section(fn (): array => $this->calendars->describe($row['calendar_id'], $groupId), $row['calendar_id']),
			'board' => OrgService::section(fn (): array => $this->deck->describe($row['board_id'], $groupId), $row['board_id']),
			// Changes to the team's group made outside this API and not put back yet; [] when none.
			'drift' => $this->store->openDrift($groupId),
		]];
	}

	/** Stores a resource id when it is new or changed. */
	private function remember(string $teamId, ?array $row, string $column, int $id): void {
		if (($row[$column] ?? null) !== $id) {
			$this->store->setTeamResource($teamId, $column, $id);
		}
	}
}
