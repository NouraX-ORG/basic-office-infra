<?php

declare(strict_types=1);

/**
 * PUT /v1/admin/orgs/{org_id} {"name","version"}: an organisation, keyed by NoMail's id.
 *
 * Steps (each an "ensure"):
 * 1. record           the nourax_api_orgs row (name, version)
 * 2. group            group "org:{org_id}", display name = the organisation's name
 * 3. directory        the service account's address book "org-{org_id}", "Directory: <name>"
 * 4. directory_share  shared read-only with the organisation's group
 * 5. cards            one card per enabled member of the group
 * 6. team_cards       the cards of the organisation's team address books (they show the
 *                     organisation's name, so a rename reaches them too)
 *
 * A stored version greater than the incoming one changes nothing ("stale_version"); an equal
 * one runs every step again, which finishes a call that stopped half way.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use Psr\Log\LoggerInterface;

class OrgService {
	public function __construct(
		private AdminStore $store,
		private ObjectLock $locks,
		private GroupService $groups,
		private AddressBookService $books,
		private LoggerInterface $logger,
	) {
	}

	public static function directoryUri(string $orgId): string {
		return 'org-' . $orgId;
	}

	public static function directoryName(string $name): string {
		return 'Directory: ' . $name;
	}

	/** @throws ApiException 423 busy */
	public function put(string $orgId, AdminRequest $request): array {
		return $this->locks->with('org/' . $orgId, function () use ($orgId, $request): array {
			$row = $this->store->org($orgId);
			if ($row !== null && $row['version'] > $request->version) {
				return Steps::stale($request->version, $row['version'], ['org_id' => $orgId]);
			}

			$steps = new Steps($this->logger, 'org ' . $orgId);
			$groupId = AdminStore::orgGroup($orgId);
			$recorded = $steps->run('record', fn (): array => [
				$this->store->saveOrg($orgId, $request->name, $request->version, $row), 'version ' . $request->version,
			]);
			if (!$recorded) {
				foreach (['group', 'directory', 'directory_share', 'cards', 'team_cards'] as $step) {
					$steps->skip($step, 'not run: the record could not be saved');
				}
				return $steps->answer($request->version, ['org_id' => $orgId]);
			}

			$groupReady = $steps->run('group', fn (): array => $this->groups->ensure($groupId, $request->name));

			$bookId = null;
			$steps->run('directory', function () use ($orgId, $request, $row, &$bookId): array {
				[$bookId, $result, $detail] = $this->books->ensureBook(self::directoryUri($orgId), self::directoryName($request->name));
				if (($row['addressbook_id'] ?? null) !== $bookId) {
					$this->store->setOrgAddressBook($orgId, $bookId);
				}
				return [$result, $detail];
			});

			if ($bookId !== null && $groupReady) {
				$steps->run('directory_share', fn (): array => $this->books->ensureReadOnlyShare($bookId, $groupId));
				$steps->run('cards', fn (): array => $this->books->syncCards($bookId, $this->groups->activeMembers($groupId), $request->name));
			} else {
				$steps->skip('directory_share', 'not run: needs the group and the directory');
				$steps->skip('cards', 'not run: needs the group and the directory');
			}
			$steps->run('team_cards', fn (): array => $this->syncTeamCards($orgId, $request->name));

			return $steps->answer($request->version, ['org_id' => $orgId]);
		});
	}

	/**
	 * Rebuilds the directory's cards from the organisation group's members (for membership
	 * changes, e.g. by the people API).
	 *
	 * @return array{0: string, 1: string} [result, detail]
	 */
	public function syncDirectoryCards(string $orgId): array {
		$row = $this->store->org($orgId);
		if ($row === null || $row['addressbook_id'] === null) {
			throw new StepFailed('the organisation has no directory yet');
		}
		// One rebuild of a book at a time: two people's calls may change the same directory.
		return $this->locks->waitFor('cards/' . $row['addressbook_id'], 15,
			fn (): array => $this->books->syncCards($row['addressbook_id'], $this->groups->activeMembers($row['group_id']), $row['name']));
	}

	/**
	 * Rebuilds the cards of every team address book of the organisation.
	 *
	 * @return array{0: string, 1: string} [result, detail]
	 */
	public function syncTeamCards(string $orgId, string $orgName): array {
		$teams = 0;
		$updated = 0;
		foreach ($this->store->teamsOf($orgId) as $team) {
			if ($team['addressbook_id'] === null) {
				continue;
			}
			$teams++;
			[$result] = $this->books->syncCards($team['addressbook_id'], $this->groups->activeMembers($team['group_id']), $orgName);
			if ($result !== Steps::UNCHANGED) {
				$updated++;
			}
		}
		return [$updated === 0 ? Steps::UNCHANGED : Steps::UPDATED, $updated . ' of ' . $teams . ' team address book(s) changed'];
	}

	/**
	 * GET /v1/admin/orgs/{org_id}: the stored state next to what is really there.
	 *
	 * @throws ApiException 404 not_found
	 */
	public function status(string $orgId): array {
		$row = $this->store->org($orgId);
		if ($row === null) {
			throw new ApiException('not_found', 404);
		}
		$groupId = $row['group_id'];
		$group = $this->groups->get($groupId);
		$teams = array_map(static fn (array $team): array => [
			'team_id' => $team['team_id'],
			'name' => $team['name'],
			'version' => $team['version'],
			'archived' => $team['archived'] === 1,
		], $this->store->teamsOf($orgId));

		return ['ok' => true, 'org' => [
			'org_id' => $orgId,
			'name' => $row['name'],
			'version' => $row['version'],
			'created_at' => gmdate('c', $row['created_at']),
			'updated_at' => gmdate('c', $row['updated_at']),
			'group' => [
				'id' => $groupId,
				'exists' => $group !== null,
				'display_name' => $group?->getDisplayName(),
				'members' => count($this->groups->activeMembers($groupId)),
			],
			'directory' => self::section(fn (): array => $this->books->describe($row['addressbook_id'], $groupId), $row['addressbook_id']),
			'teams' => $teams,
			// Changes to the organisation's group made outside this API and not put back yet; [] when none.
			'drift' => $this->store->openDrift($groupId),
		]];
	}

	/** Runs a status section; a failure shows as {"id","error"} instead of failing the call. */
	public static function section(callable $describe, ?int $id): array {
		try {
			return $describe();
		} catch (\Throwable $e) {
			return ['id' => $id, 'error' => Steps::describe($e)];
		}
	}
}
