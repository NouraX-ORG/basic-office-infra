<?php

declare(strict_types=1);

/**
 * Keeps the org:* and team:* groups the way NoMail has them. Two ways in:
 *
 * 1. POST /v1/admin/orgs/{org_id}/reconcile {"teams":[{"team_id","name","version"}],
 *    "people":[{"user_id", ...the body of a person PUT}], "dry_run"?}: NoMail's full state of one
 *    organisation (at most 500 people, 413 otherwise). Every listed team and person is applied as
 *    by its own PUT; then
 *    - members of the organisation's groups who are not in that state leave (LeaveService);
 *    - people stored for the organisation but not listed leave its teams and its group (they are
 *      not disabled: only "active": false disables);
 *    - stored teams that are not listed are archived (nothing is deleted).
 *    "dry_run": true only reports. The answer lists drift_found (before), drift_fixed and
 *    drift_left (after), each {"kind","group","user_id"}.
 *
 * 2. fixStored(): the DriftReconcile job (every 15 minutes) and `occ nourax_api:reconcile` put
 *    the groups back the way the STORED desired state has them: a person added outside the API
 *    is taken out again, one removed is put back, a deleted group is made again. This is what
 *    makes the groups "locked". The drift rows of a group that matches again are closed.
 *
 * Kinds of drift: extra_member (in the group, not wanted), missing_member (wanted, not in the
 * group), group_missing (the group is gone), team_unlisted (a stored team the reconcile call did
 * not list), person_unlisted (a stored person of the organisation the call did not list).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OCP\IGroupManager;
use OCP\IUser;
use OCP\IUserManager;
use Psr\Log\LoggerInterface;

class ReconcileService {
	public const MAX_PEOPLE = 500;
	public const MAX_TEAMS = 500;
	/** Seconds a reconcile of one organisation may hold its lock. */
	public const LOCK_TTL = 900;

	public function __construct(
		private AdminStore $store,
		private ObjectLock $locks,
		private IGroupManager $groupManager,
		private IUserManager $userManager,
		private PeopleService $people,
		private TeamService $teams,
		private OrgService $orgs,
		private LeaveService $leaver,
		private LoggerInterface $logger,
	) {
	}

	/**
	 * The reconcile call.
	 *
	 * @throws ApiException 400 invalid_request, 409 org_missing | team_in_other_org |
	 *                      team_not_listed | person_in_other_org, 413 too_large, 423 busy
	 */
	public function reconcile(string $orgId, string $body): array {
		[$teamRequests, $personRequests, $dryRun] = $this->parse($orgId, $body);
		if ($this->store->org($orgId) === null) {
			throw new ApiException('org_missing', 409);
		}
		return $this->locks->with('reconcile/' . $orgId, function () use ($orgId, $teamRequests, $personRequests, $dryRun): array {
			$desired = $this->desiredFromRequest($orgId, $teamRequests, $personRequests);
			$found = $this->compare($orgId, $desired, false);
			if ($dryRun) {
				return ['ok' => true, 'dry_run' => true, 'org_id' => $orgId,
					'drift_found' => $found, 'drift_fixed' => [], 'drift_left' => $found, 'teams' => [], 'people' => []];
			}

			$ok = true;
			$teamResults = [];
			foreach ($teamRequests as $teamId => $request) {
				$teamResults[] = $this->outcome(['team_id' => $teamId], fn (): array => $this->teams->put($orgId, $teamId, $request));
			}
			$peopleResults = [];
			foreach ($personRequests as $request) {
				$peopleResults[] = $this->outcome(['user_id' => $request->userId], fn (): array => $this->people->put($request));
			}
			foreach (array_merge($teamResults, $peopleResults) as $result) {
				$ok = $ok && $result['ok'];
			}

			// Active people stored for this organisation whom NoMail no longer lists.
			foreach (array_keys($this->store->peopleOf($orgId)) as $uid) {
				if (!isset($personRequests[$uid])) {
					$this->store->detachPerson((string)$uid);
				}
			}

			$errors = $this->fix($orgId, $this->compare($orgId, $desired, false));
			$left = $this->compare($orgId, $desired, false);
			$this->closeDrift($orgId, $left);
			$fixed = self::minus($found, $left);
			return ['ok' => $ok && $errors === [] && $left === [], 'dry_run' => false, 'org_id' => $orgId,
				'drift_found' => $found, 'drift_fixed' => $fixed, 'drift_left' => $left]
				+ ($errors === [] ? [] : ['errors' => $errors])
				+ ['teams' => $teamResults, 'people' => $peopleResults];
		}, self::LOCK_TTL);
	}

	/**
	 * Puts every stored organisation (or one) back the way the stored desired state has it.
	 *
	 * @return array{orgs: array<string, array>, closed: int} per organisation: drift found, fixed, left
	 */
	public function fixStored(?string $onlyOrg = null, bool $dryRun = false): array {
		$report = [];
		$closed = 0;
		foreach ($this->store->orgIds() as $orgId) {
			if ($onlyOrg !== null && $orgId !== $onlyOrg) {
				continue;
			}
			try {
				$report[$orgId] = $this->locks->with('reconcile/' . $orgId, function () use ($orgId, $dryRun, &$closed): array {
					$desired = $this->desiredFromStore($orgId);
					$found = $this->compare($orgId, $desired, true);
					if ($dryRun || $found === []) {
						$closed += $dryRun ? 0 : $this->closeDrift($orgId, []);
						return ['found' => $found, 'fixed' => [], 'left' => $found];
					}
					$errors = $this->fix($orgId, $found);
					$left = $this->compare($orgId, $desired, true);
					$closed += $this->closeDrift($orgId, $left);
					return ['found' => $found, 'fixed' => self::minus($found, $left), 'left' => $left] + ($errors === [] ? [] : ['errors' => $errors]);
				}, self::LOCK_TTL);
			} catch (ApiException $e) {
				// A reconcile call is working on this organisation right now; the next run checks it.
				$report[$orgId] = ['skipped' => $e->errorCode];
			}
		}
		if ($onlyOrg === null && !$dryRun) {
			// Drift rows of org:* or team:* groups this API never made: nothing to put back.
			foreach ($this->store->openDriftGroups() as $groupId) {
				if (!$this->isStoredGroup($groupId)) {
					$closed += $this->store->markDriftFixed($groupId);
				}
			}
		}
		return ['orgs' => $report, 'closed' => $closed];
	}

	/**
	 * What should be: the organisation's members and each team's members (role by uid).
	 *
	 * @return array{org: array<string, true>, teams: array<string, array<string, string>>, listed_teams: ?array<string, true>, inactive: array<string, true>}
	 */
	private function desiredFromStore(string $orgId): array {
		$people = $this->store->peopleOf($orgId);
		$teams = [];
		foreach ($this->store->teamsOf($orgId) as $team) {
			$members = array_intersect_key($this->store->membersOfTeam($team['team_id']), $people);
			$teams[(string)$team['team_id']] = $members;
		}
		return ['org' => array_fill_keys(array_map('strval', array_keys($people)), true), 'teams' => $teams, 'listed_teams' => null, 'inactive' => []];
	}

	/**
	 * @param array<string, AdminRequest> $teamRequests
	 * @param array<string, PersonRequest> $personRequests
	 */
	private function desiredFromRequest(string $orgId, array $teamRequests, array $personRequests): array {
		$teams = [];
		foreach ($this->store->teamsOf($orgId) as $team) {
			$teams[(string)$team['team_id']] = [];
		}
		foreach (array_keys($teamRequests) as $teamId) {
			$teams[(string)$teamId] = [];
		}
		$org = [];
		$inactive = [];
		foreach ($personRequests as $request) {
			if (!$request->active) {
				$inactive[$request->userId] = true;
				continue;
			}
			$org[$request->userId] = true;
			foreach ($request->teams as $teamId => $role) {
				$teams[(string)$teamId][$request->userId] = $role;
			}
		}
		return ['org' => $org, 'teams' => $teams, 'listed_teams' => array_fill_keys(array_map('strval', array_keys($teamRequests)), true),
			'inactive' => $inactive];
	}

	/**
	 * The differences between what should be and what is.
	 *
	 * @param bool $fixableOnly leave out wanted members whose account is missing or disabled
	 *                          (nothing the drift job can do about them)
	 * @return list<array{kind: string, group: string, user_id: ?string}>
	 */
	private function compare(string $orgId, array $desired, bool $fixableOnly): array {
		$drift = [];
		$this->compareGroup(AdminStore::orgGroup($orgId), $desired['org'], $fixableOnly, $drift);
		foreach ($desired['teams'] as $teamId => $members) {
			$teamId = (string)$teamId;
			$row = $this->store->team($teamId);
			if ($row === null) {
				// A new team of the call: its PUT makes it; nothing to compare yet.
				continue;
			}
			$this->compareGroup(AdminStore::teamGroup($teamId), $members, $fixableOnly, $drift);
			if ($desired['listed_teams'] !== null && !isset($desired['listed_teams'][$teamId]) && $row['archived'] !== 1) {
				$drift[] = ['kind' => 'team_unlisted', 'group' => AdminStore::teamGroup($teamId), 'user_id' => null];
			}
		}
		if ($desired['listed_teams'] !== null) {
			foreach (array_keys($this->store->peopleOf($orgId)) as $uid) {
				if (!isset($desired['org'][$uid]) && !isset($desired['inactive'][$uid])) {
					$drift[] = ['kind' => 'person_unlisted', 'group' => AdminStore::orgGroup($orgId), 'user_id' => (string)$uid];
				}
			}
		}
		return $drift;
	}

	/** @param array<string, mixed> $wanted uids as keys */
	private function compareGroup(string $groupId, array $wanted, bool $fixableOnly, array &$drift): void {
		$group = $this->groupManager->get($groupId);
		if ($group === null) {
			$drift[] = ['kind' => 'group_missing', 'group' => $groupId, 'user_id' => null];
			return;
		}
		$actual = [];
		foreach ($group->getUsers() as $user) {
			$actual[$user->getUID()] = true;
		}
		ksort($actual, SORT_STRING);
		foreach (array_keys($actual) as $uid) {
			if (!isset($wanted[$uid])) {
				$drift[] = ['kind' => 'extra_member', 'group' => $groupId, 'user_id' => (string)$uid];
			}
		}
		$wantedUids = array_map('strval', array_keys($wanted));
		sort($wantedUids, SORT_STRING);
		foreach ($wantedUids as $uid) {
			if (isset($actual[$uid])) {
				continue;
			}
			if ($fixableOnly) {
				$user = $this->userManager->get($uid);
				if ($user === null || !$user->isEnabled()) {
					continue;
				}
			}
			$drift[] = ['kind' => 'missing_member', 'group' => $groupId, 'user_id' => $uid];
		}
	}

	/**
	 * Puts the found drift right. Every change of a person happens under that person's lock; a
	 * person whose lock is taken is left for the next run.
	 *
	 * @param list<array{kind: string, group: string, user_id: ?string}> $drift
	 * @return list<string> what could not be fixed, and why
	 */
	private function fix(string $orgId, array $drift): array {
		$errors = [];
		// Missing groups first: their organisation or team is made again from the stored state.
		$remade = false;
		foreach ($drift as $item) {
			if ($item['kind'] !== 'group_missing') {
				continue;
			}
			try {
				$this->remakeGroup($item['group']);
				$remade = true;
			} catch (\Throwable $e) {
				$errors[] = $item['group'] . ': ' . Steps::describe($e);
			}
		}
		if ($remade) {
			$drift = $this->compare($orgId, $this->desiredFromStore($orgId), true);
		}

		$touchedTeams = [];
		$touchedOrg = false;
		foreach ($drift as $item) {
			$uid = $item['user_id'];
			if ($uid === null || ($item['kind'] !== 'extra_member' && $item['kind'] !== 'missing_member')) {
				continue;
			}
			$isOrg = str_starts_with($item['group'], 'org:');
			$team = $isOrg ? null : $this->store->team(substr($item['group'], 5));
			try {
				$this->locks->with('person/' . $uid, function () use ($item, $uid, $isOrg, $team, $orgId, &$touchedTeams, &$touchedOrg): void {
					$user = $this->userManager->get($uid);
					if ($user === null) {
						return;
					}
					if ($item['kind'] === 'extra_member') {
						if ($isOrg) {
							$this->leaveOrg($orgId, $user);
							$touchedOrg = true;
						} elseif ($team !== null) {
							[$result, $detail] = $this->leaver->leave($team, $uid);
							$this->store->removeMembership((string)$team['team_id'], $uid);
							if ($result === Steps::FAILED) {
								throw new StepFailed($detail);
							}
						}
						return;
					}
					// missing_member: only for an enabled account the stored state wants there.
					if (!$user->isEnabled()) {
						return;
					}
					if ($isOrg) {
						$group = $this->groupManager->get($item['group']);
						if ($group !== null && !$group->inGroup($user)) {
							DriftGuard::run(fn () => $group->addUser($user));
						}
						$touchedOrg = true;
					} elseif ($team !== null) {
						$role = $this->store->membersOfTeam((string)$team['team_id'])[$uid] ?? AdminStore::ROLE_MEMBER;
						$this->people->joinTeam($team, $user, $role);
						$touchedTeams[(string)$team['team_id']] = true;
					}
				});
			} catch (\Throwable $e) {
				$errors[] = $item['kind'] . ' ' . $item['group'] . ' ' . $uid . ': ' . Steps::describe($e);
			}
		}

		// Teams nobody may be in any more: archived (LeaveService already archives a team when
		// its last member leaves; this covers the ones that were empty already).
		foreach ($drift as $item) {
			if ($item['kind'] !== 'team_unlisted') {
				continue;
			}
			try {
				$this->teams->setArchived(substr($item['group'], 5), true);
			} catch (\Throwable $e) {
				$errors[] = 'archive ' . $item['group'] . ': ' . Steps::describe($e);
			}
		}

		foreach (array_keys($touchedTeams) as $teamId) {
			try {
				$this->teams->syncCards((string)$teamId);
			} catch (\Throwable $e) {
				$errors[] = 'cards of team ' . $teamId . ': ' . Steps::describe($e);
			}
		}
		if ($touchedOrg) {
			try {
				$this->orgs->syncDirectoryCards($orgId);
			} catch (\Throwable $e) {
				$errors[] = 'directory: ' . Steps::describe($e);
			}
		}
		if ($errors !== []) {
			$this->logger->warning('nourax_api reconcile ' . $orgId . ': ' . count($errors) . ' change(s) not made: ' . implode(' | ', $errors), ['app' => 'nourax_api']);
		}
		return $errors;
	}

	/** A person who is not wanted in the organisation leaves its teams and its group. */
	private function leaveOrg(string $orgId, IUser $user): void {
		$uid = $user->getUID();
		foreach ($this->store->teamsOf($orgId) as $team) {
			$group = $this->groupManager->get($team['group_id']);
			if ($group !== null && $group->inGroup($user)) {
				$this->leaver->leave($team, $uid);
			}
			$this->store->removeMembership((string)$team['team_id'], $uid);
		}
		$group = $this->groupManager->get(AdminStore::orgGroup($orgId));
		if ($group !== null && $group->inGroup($user)) {
			DriftGuard::run(fn () => $group->removeUser($user));
		}
	}

	/** Makes a deleted org:* or team:* group again by running its stored PUT once more. */
	private function remakeGroup(string $groupId): void {
		if (str_starts_with($groupId, 'org:')) {
			$org = $this->store->org(substr($groupId, 4));
			if ($org !== null) {
				$this->orgs->put($org['org_id'], AdminRequest::stored($org['name'], $org['version']));
			}
			return;
		}
		$team = $this->store->team(substr($groupId, 5));
		if ($team !== null) {
			$this->teams->put($team['org_id'], $team['team_id'], AdminRequest::stored($team['name'], $team['version']));
		}
	}

	/**
	 * Closes the drift rows of the organisation's groups that have no drift left.
	 *
	 * @param list<array{kind: string, group: string, user_id: ?string}> $left
	 */
	private function closeDrift(string $orgId, array $left): int {
		$dirty = [];
		foreach ($left as $item) {
			$dirty[$item['group']] = true;
		}
		$closed = 0;
		$groups = [AdminStore::orgGroup($orgId)];
		foreach ($this->store->teamsOf($orgId) as $team) {
			$groups[] = $team['group_id'];
		}
		foreach ($groups as $groupId) {
			if (!isset($dirty[$groupId])) {
				$closed += $this->store->markDriftFixed($groupId);
			}
		}
		return $closed;
	}

	private function isStoredGroup(string $groupId): bool {
		if (str_starts_with($groupId, 'org:')) {
			return $this->store->org(substr($groupId, 4)) !== null;
		}
		if (str_starts_with($groupId, 'team:')) {
			return $this->store->team(substr($groupId, 5)) !== null;
		}
		return false;
	}

	/**
	 * Runs one team or person PUT and keeps a short result: ok, applied, the failed steps, or
	 * the error code of a refusal.
	 */
	private function outcome(array $ids, callable $put): array {
		try {
			$answer = $put();
		} catch (ApiException $e) {
			return $ids + ['ok' => false, 'error' => $e->errorCode];
		} catch (\Throwable $e) {
			return $ids + ['ok' => false, 'error' => 'internal_error', 'detail' => Steps::describe($e)];
		}
		$failed = [];
		foreach ($answer['steps'] ?? [] as $step) {
			if (($step['result'] ?? null) === Steps::FAILED) {
				$failed[] = $step['step'];
			}
		}
		return $ids + ['ok' => ($answer['ok'] ?? false) === true, 'applied' => $answer['applied'] ?? false]
			+ (isset($answer['reason']) ? ['reason' => $answer['reason']] : [])
			+ ($failed === [] ? [] : ['failed_steps' => $failed]);
	}

	/**
	 * Drift items of $a that are not in $b.
	 *
	 * @param list<array{kind: string, group: string, user_id: ?string}> $a
	 * @param list<array{kind: string, group: string, user_id: ?string}> $b
	 */
	private static function minus(array $a, array $b): array {
		$keys = [];
		foreach ($b as $item) {
			$keys[$item['kind'] . '|' . $item['group'] . '|' . $item['user_id']] = true;
		}
		return array_values(array_filter($a, static fn (array $item): bool => !isset($keys[$item['kind'] . '|' . $item['group'] . '|' . $item['user_id']])));
	}

	/**
	 * Reads and checks the body.
	 *
	 * @return array{0: array<string, AdminRequest>, 1: array<string, PersonRequest>, 2: bool}
	 * @throws ApiException
	 */
	private function parse(string $orgId, string $body): array {
		$data = AdminRequest::object($body);
		$teams = $data['teams'] ?? [];
		$people = $data['people'] ?? [];
		$dryRun = $data['dry_run'] ?? false;
		if (!is_array($teams) || !array_is_list($teams) || !is_array($people) || !array_is_list($people) || !is_bool($dryRun)) {
			throw new ApiException('invalid_request', 400);
		}
		if (count($people) > self::MAX_PEOPLE || count($teams) > self::MAX_TEAMS) {
			throw new ApiException('too_large', 413);
		}

		$teamRequests = [];
		foreach ($teams as $team) {
			$teamId = is_array($team) ? ($team['team_id'] ?? null) : null;
			if (!is_string($teamId) || !AdminRequest::validId($teamId) || isset($teamRequests[$teamId])) {
				throw new ApiException('invalid_request', 400);
			}
			$stored = $this->store->team($teamId);
			if ($stored !== null && $stored['org_id'] !== $orgId) {
				throw new ApiException('team_in_other_org', 409);
			}
			$teamRequests[$teamId] = AdminRequest::fromArray($team);
		}

		$personRequests = [];
		foreach ($people as $person) {
			$uid = is_array($person) ? ($person['user_id'] ?? null) : null;
			if (!is_string($uid) || isset($personRequests[$uid])) {
				throw new ApiException('invalid_request', 400);
			}
			$request = PersonRequest::fromArray($uid, $person);
			if ($request->orgId !== $orgId) {
				throw new ApiException('person_in_other_org', 409);
			}
			foreach (array_keys($request->teams) as $teamId) {
				if (!isset($teamRequests[(string)$teamId])) {
					throw new ApiException('team_not_listed', 409);
				}
			}
			$personRequests[$uid] = $request;
		}
		return [$teamRequests, $personRequests, $dryRun];
	}
}
