<?php

declare(strict_types=1);

/**
 * PUT /v1/admin/people/{user_id}: a person's whole desired state (PersonRequest), keyed by the
 * account's uid (the Supabase user id). NoMail is the source of truth; every step is an
 * "ensure", so sending the same call again finishes one that stopped half way.
 *
 * Refused before anything changes: 409 org_missing (the organisation is not stored),
 * team_missing, team_in_other_org (every team must belong to the person's organisation),
 * uid_not_oidc (a local account of that name), account_disabled (active, but the account was
 * disabled on the server by someone else: an administrator must enable it, the API never does);
 * 423 busy (another call works on the same person). An older version changes nothing.
 *
 * Steps while active (true):
 *   record       the desired state: nourax_api_people and the team rows in nourax_api_members
 *   account      the "Log in with Nourax" account and its /NoMail folders, as /v1/provision makes
 *                them (no app password); an account this API disabled is enabled again (its
 *                app passwords were revoked: NoMail and sync clients sign in again)
 *   profile      display name and email (the email may change, the uid never does)
 *   leave        one per team left, also when moving to another organisation (LeaveService)
 *   org          member of org:{org_id}, and of no other organisation group
 *   teams        joins (an archived team is brought back), lead rights for leads (folder
 *                permissions management and a managing board share), taken away for members
 *   directories  the organisation directory and the team address books rebuilt
 *
 * Steps when the person left the organisation (active false):
 *   record, account, profile, leave (every team), org (out of every organisation group),
 *   disable      the account is disabled at once: no sign-in (form or "Log in with Nourax"),
 *                no sync client, and NoMail's next /v1/provision gets 409 account_disabled;
 *                open browser sessions end and every app password is revoked, so WebDAV and
 *                OCS answer 401 (with only the account disabled, WebDAV would answer 503,
 *                which clients read as a server fault and retry); it is kept for 30 days
 *                (delete_after). Deleting is switched off (LeaverDeletion).
 *   directories
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OC\Authentication\Token\IProvider as TokenProvider;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Authentication\Token\IToken;
use OCP\IGroupManager;
use OCP\IUser;
use OCP\IUserManager;
use Psr\Log\LoggerInterface;

class PeopleService {
	private const OIDC_BACKEND = 'user_oidc';

	public function __construct(
		private AdminStore $store,
		private ObjectLock $locks,
		private GroupService $groups,
		private IGroupManager $groupManager,
		private IUserManager $userManager,
		private ProvisionService $provisioner,
		private LeaveService $leaver,
		private TeamService $teams,
		private OrgService $orgs,
		private TeamFolderService $folders,
		private DeckClient $deck,
		private TokenProvider $tokens,
		private ITimeFactory $time,
		private LoggerInterface $logger,
	) {
	}

	/** @throws ApiException 409, 423 busy */
	public function put(PersonRequest $request): array {
		$uid = $request->userId;
		return $this->locks->with('person/' . $uid, fn (): array => $this->apply($request));
	}

	/**
	 * The work of put(), for a caller that already holds the person's lock (the reconcile).
	 *
	 * @throws ApiException 409
	 */
	public function apply(PersonRequest $request): array {
		$uid = $request->userId;
		$ids = ['user_id' => $uid];
		$row = $this->store->person($uid);
		if ($row !== null && $row['version'] > $request->version) {
			return Steps::stale($request->version, $row['version'], $ids);
		}

		$org = $this->store->org($request->orgId);
		if ($org === null) {
			throw new ApiException('org_missing', 409);
		}
		$wanted = [];
		foreach ($request->teams as $teamId => $role) {
			$team = $this->store->team((string)$teamId);
			if ($team === null) {
				throw new ApiException('team_missing', 409);
			}
			if ($team['org_id'] !== $request->orgId) {
				throw new ApiException('team_in_other_org', 409);
			}
			$wanted[(string)$teamId] = ['row' => $team, 'role' => $role];
		}
		$user = $this->userManager->get($uid);
		if ($user !== null && $user->getBackendClassName() !== self::OIDC_BACKEND) {
			throw new ApiException('uid_not_oidc', 409);
		}
		$disabledByApi = $row !== null && $row['disabled_at'] !== null;
		if ($user !== null && !$user->isEnabled() && $request->active && !$disabledByApi) {
			throw new ApiException('account_disabled', 409);
		}

		$steps = new Steps($this->logger, 'person ' . $uid);
		$recorded = $steps->run('record', function () use ($request, $row): array {
			$result = $this->store->savePerson($request->userId, $request->orgId, $request->email, $request->displayName,
				$request->active, $request->version, $row);
			$this->store->setMemberships($request->userId, $request->active ? $request->teams : []);
			return [$result, 'version ' . $request->version];
		});
		if (!$recorded) {
			$steps->skip('account', 'not run: the record could not be saved');
			return $steps->answer($request->version, $ids);
		}

		if ($request->active) {
			$this->applyActive($steps, $request, $org, $wanted, $user, $row);
		} else {
			$this->applyLeaver($steps, $request, $user, $row);
		}
		return $steps->answer($request->version, $ids);
	}

	/**
	 * @param array<string, array{row: array, role: string}> $wanted
	 */
	private function applyActive(Steps $steps, PersonRequest $request, array $org, array $wanted, ?IUser $user, ?array $row): void {
		$uid = $request->userId;
		$enabledAgain = false;
		$accountReady = $steps->run('account', function () use ($uid, &$user, &$enabledAgain, $row): array {
			if ($user !== null && !$user->isEnabled()) {
				// Only an account this API disabled (checked above) is enabled again.
				$user->setEnabled(true);
				$enabledAgain = true;
			}
			[$user, $created] = $this->provisioner->ensureAccount($uid);
			if ($row !== null && $row['disabled_at'] !== null) {
				$this->store->setPersonDisabled($uid, null, null);
			}
			if ($created) {
				return [Steps::CREATED, 'account ' . $uid . ' made, with its /NoMail folders'];
			}
			return $enabledAgain ? [Steps::UPDATED, 'account ' . $uid . ' enabled again'] : [Steps::UNCHANGED, 'account ' . $uid];
		});
		if (!$accountReady || $user === null) {
			foreach (['profile', 'org', 'teams', 'directories'] as $step) {
				$steps->skip($step, 'not run: needs the account');
			}
			return;
		}

		$steps->run('profile', fn (): array => $this->profile($user, $request));

		// Teams the person is in that are not wanted any more: those of another organisation (a
		// move) and those of this one that NoMail no longer lists.
		$oldOrgs = [];
		foreach ($this->actualTeams($user) as $teamId => $team) {
			if (!isset($wanted[$teamId])) {
				if ($team['org_id'] !== $request->orgId) {
					$oldOrgs[$team['org_id']] = true;
				}
				$steps->run('leave', fn (): array => $this->leaver->leave($team, $uid), ['team_id' => $teamId]);
			}
		}

		$steps->run('org', function () use ($user, $request, &$oldOrgs): array {
			$orgGroup = AdminStore::orgGroup($request->orgId);
			$left = [];
			foreach ($this->groupManager->getUserGroupIds($user) as $groupId) {
				if (str_starts_with($groupId, 'org:') && $groupId !== $orgGroup) {
					$group = $this->groupManager->get($groupId);
					if ($group !== null) {
						DriftGuard::run(fn () => $group->removeUser($user));
						$left[] = $groupId;
						$oldOrgs[substr($groupId, 4)] = true;
					}
				}
			}
			$joined = $this->addToGroup($orgGroup, $user);
			$detail = 'member of ' . $orgGroup . ($left === [] ? '' : '; left ' . implode(', ', $left));
			return [$joined || $left !== [] ? Steps::UPDATED : Steps::UNCHANGED, $detail];
		});

		$steps->run('teams', function () use ($user, $wanted): array {
			$joined = [];
			$changes = [];
			$errors = [];
			foreach ($wanted as $teamId => $team) {
				try {
					$change = $this->joinTeam($team['row'], $user, $team['role']);
					if ($change['joined']) {
						$joined[] = $teamId;
					}
					if ($change['changes'] !== []) {
						$changes[$teamId] = $change['changes'];
					}
				} catch (\Throwable $e) {
					$errors[$teamId] = Steps::describe($e);
				}
			}
			$fields = ['joined' => $joined, 'changes' => (object)$changes];
			$detail = 'member of ' . count($wanted) . ' team(s)' . ($joined === [] ? '' : '; joined ' . implode(', ', $joined));
			if ($errors !== []) {
				return [Steps::FAILED, $detail . '; failed: ' . implode(', ', array_keys($errors)), $fields + ['errors' => $errors]];
			}
			return [$changes === [] ? Steps::UNCHANGED : Steps::UPDATED, $detail, $fields];
		});

		$steps->run('directories', fn (): array => $this->directories(
			array_merge([$request->orgId], array_map('strval', array_keys($oldOrgs))),
			array_map('strval', array_keys($wanted)),
		));
	}

	private function applyLeaver(Steps $steps, PersonRequest $request, ?IUser $user, ?array $row): void {
		$uid = $request->userId;
		$steps->run('account', fn (): array => $user === null
			? [Steps::UNCHANGED, 'no account ' . $uid . ': nothing to disable']
			: [Steps::UNCHANGED, 'account ' . $uid]);
		if ($user === null) {
			return;
		}
		$steps->run('profile', fn (): array => $this->profile($user, $request));

		$orgs = [$request->orgId => true];
		foreach ($this->actualTeams($user) as $teamId => $team) {
			$orgs[$team['org_id']] = true;
			$steps->run('leave', fn (): array => $this->leaver->leave($team, $uid), ['team_id' => $teamId]);
		}

		$steps->run('org', function () use ($user, &$orgs): array {
			$left = [];
			foreach ($this->groupManager->getUserGroupIds($user) as $groupId) {
				if (str_starts_with($groupId, 'org:')) {
					$group = $this->groupManager->get($groupId);
					if ($group !== null) {
						DriftGuard::run(fn () => $group->removeUser($user));
						$left[] = $groupId;
						$orgs[substr($groupId, 4)] = true;
					}
				}
			}
			return $left === [] ? [Steps::UNCHANGED, 'in no organisation group'] : [Steps::UPDATED, 'left ' . implode(', ', $left)];
		});

		$steps->run('disable', function () use ($user, $uid, $row): array {
			$changes = [];
			if ($user->isEnabled()) {
				$user->setEnabled(false);
				$changes[] = 'disabled';
			}
			[$ended, $revoked] = $this->endLogins($uid);
			if ($ended > 0) {
				$changes[] = $ended . ' session(s) ended';
			}
			if ($revoked > 0) {
				$changes[] = $revoked . ' app password(s) revoked';
			}
			$disabledAt = $row['disabled_at'] ?? null;
			if ($disabledAt === null) {
				$disabledAt = $this->time->getTime();
				$this->store->setPersonDisabled($uid, $disabledAt, $disabledAt + AdminStore::KEEP_LEAVERS);
				$changes[] = 'kept until ' . gmdate('Y-m-d', $disabledAt + AdminStore::KEEP_LEAVERS);
			}
			$fields = [
				'disabled_at' => gmdate('c', $disabledAt),
				'delete_after' => gmdate('c', $disabledAt + AdminStore::KEEP_LEAVERS),
				'sessions_ended' => $ended,
				'app_passwords_revoked' => $revoked,
			];
			return [$changes === [] ? Steps::UNCHANGED : Steps::UPDATED, $changes === [] ? 'already disabled' : implode('; ', $changes), $fields];
		});

		$steps->run('directories', fn (): array => $this->directories(array_map('strval', array_keys($orgs)), []));
	}

	/**
	 * Puts a person into a team the way a join does: the group, the team out of the archive,
	 * and lead rights for a lead (taken away for a member).
	 *
	 * @return array{joined: bool, changes: list<string>}
	 */
	public function joinTeam(array $team, IUser $user, string $role): array {
		$changes = [];
		$joined = $this->addToGroup((string)$team['group_id'], $user);
		if ($joined) {
			$changes[] = 'joined';
		}
		if ($team['archived'] === 1) {
			$this->teams->setArchived((string)$team['team_id'], false);
			$changes[] = 'team brought back from the archive';
		}
		$lead = $role === AdminStore::ROLE_LEAD;
		if ($team['folder_id'] !== null && $this->folders->setLead($team['folder_id'], $user->getUID(), $lead)) {
			$changes[] = $lead ? 'may manage folder permissions' : 'folder permissions management removed';
		}
		if ($team['board_id'] !== null && $this->deck->setLead($team['board_id'], $user->getUID(), $lead)) {
			$changes[] = $lead ? 'may manage the board' : 'board management removed';
		}
		return ['joined' => $joined, 'changes' => $changes];
	}

	/**
	 * GET /v1/admin/people/{user_id}: the desired state next to what is really there.
	 *
	 * @throws ApiException 404 not_found
	 */
	public function status(string $uid): array {
		$row = $this->store->person($uid);
		if ($row === null) {
			throw new ApiException('not_found', 404);
		}
		$user = $this->userManager->get($uid);
		$desiredTeams = $this->store->teamsOfPerson($uid);
		$groups = [];
		if ($user !== null) {
			foreach ($this->groupManager->getUserGroupIds($user) as $groupId) {
				if (str_starts_with($groupId, 'org:') || str_starts_with($groupId, 'team:')) {
					$groups[] = $groupId;
				}
			}
			sort($groups, SORT_STRING);
		}
		$wantedGroups = [];
		if ($row['active'] === 1 && $row['org_id'] !== null) {
			$wantedGroups[] = AdminStore::orgGroup($row['org_id']);
		}
		foreach (array_keys($desiredTeams) as $teamId) {
			$wantedGroups[] = AdminStore::teamGroup((string)$teamId);
		}
		sort($wantedGroups, SORT_STRING);
		$teams = [];
		foreach ($desiredTeams as $teamId => $role) {
			$teams[] = ['team_id' => (string)$teamId, 'role' => $role];
		}
		$time = static fn (?int $at): ?string => $at === null ? null : gmdate('c', $at);

		return ['ok' => true, 'person' => [
			'user_id' => $uid,
			'org_id' => $row['org_id'],
			'email' => $row['email'],
			'display_name' => $row['display_name'],
			'active' => $row['active'] === 1,
			'version' => $row['version'],
			'teams' => $teams,
			'disabled_at' => $time($row['disabled_at']),
			'delete_after' => $time($row['delete_after']),
			'hold' => $row['hold'] === 1,
			'created_at' => gmdate('c', $row['created_at']),
			'updated_at' => gmdate('c', $row['updated_at']),
			'account' => $user === null ? ['exists' => false] : [
				'exists' => true,
				'enabled' => $user->isEnabled(),
				'backend' => $user->getBackendClassName(),
				'display_name' => $user->getDisplayName(),
				'email' => $user->getSystemEMailAddress(),
			],
			'groups' => $groups,
			'groups_wanted' => $wantedGroups,
			'in_sync' => $groups === $wantedGroups,
			// Changes to this person's org:* and team:* groups made outside this API, not put back yet.
			'drift' => $this->store->openDriftOfUser($uid),
		]];
	}

	/** @return array{0: string, 1: string} */
	private function profile(IUser $user, PersonRequest $request): array {
		$changed = $this->provisioner->updateProfile($user, $request->displayName, $request->email);
		return $changed === []
			? [Steps::UNCHANGED, 'display name and email as wanted']
			: [Steps::UPDATED, implode(' and ', $changed) . ' changed; the uid stays ' . $user->getUID()];
	}

	/**
	 * The stored teams whose group the person is in, by team id.
	 *
	 * @return array<string, array> team rows
	 */
	private function actualTeams(IUser $user): array {
		$teams = [];
		foreach ($this->groupManager->getUserGroupIds($user) as $groupId) {
			if (str_starts_with($groupId, 'team:')) {
				$team = $this->store->team(substr($groupId, 5));
				if ($team !== null) {
					$teams[(string)$team['team_id']] = $team;
				}
			}
		}
		ksort($teams, SORT_STRING);
		return $teams;
	}

	/** Adds the person to the group (inside the drift guard). @return bool whether they joined now */
	private function addToGroup(string $groupId, IUser $user): bool {
		$group = $this->groupManager->get($groupId);
		if ($group === null) {
			throw new StepFailed('the group ' . $groupId . ' is missing (send its organisation or team again)');
		}
		if ($group->inGroup($user)) {
			return false;
		}
		DriftGuard::run(fn () => $group->addUser($user));
		return true;
	}

	/**
	 * Ends every login of a person who left the organisation: browser sessions (temporary
	 * tokens, also "remember me") and app passwords (NoMail's, sync clients', one-time login
	 * tokens). With the account disabled but an app password still there, the server's WebDAV
	 * answers 503 (DisabledUserException) instead of 401; once the password is gone it answers
	 * 401, which NoMail reads as "ask /v1/provision for a new one" (409 while disabled). A
	 * remote-wipe token is kept, so a device marked for wiping is still wiped. Run on every
	 * leaver PUT, so it also catches a token made while the account was disabled.
	 *
	 * @return array{0: int, 1: int} sessions ended, app passwords revoked
	 */
	private function endLogins(string $uid): array {
		$ended = 0;
		$revoked = 0;
		foreach ($this->tokens->getTokenByUser($uid) as $token) {
			$type = $token->getType();
			if ($type === IToken::WIPE_TOKEN) {
				continue;
			}
			$this->tokens->invalidateTokenById($uid, $token->getId());
			if ($type === IToken::TEMPORARY_TOKEN) {
				$ended++;
			} else {
				$revoked++;
			}
		}
		return [$ended, $revoked];
	}

	/**
	 * Rebuilds the directories of these organisations and the address books of these teams.
	 *
	 * @param list<string> $orgIds
	 * @param list<string> $teamIds
	 * @return array{0: string, 1: string}
	 */
	private function directories(array $orgIds, array $teamIds): array {
		$updated = 0;
		$total = 0;
		$errors = [];
		foreach (array_unique($orgIds) as $orgId) {
			$org = $this->store->org($orgId);
			if ($org === null || $org['addressbook_id'] === null) {
				continue;
			}
			$total++;
			try {
				[$result] = $this->orgs->syncDirectoryCards($orgId);
				$updated += $result === Steps::UNCHANGED ? 0 : 1;
			} catch (\Throwable $e) {
				$errors[] = 'org ' . $orgId . ': ' . Steps::describe($e);
			}
		}
		foreach (array_unique($teamIds) as $teamId) {
			$team = $this->store->team($teamId);
			if ($team === null || $team['addressbook_id'] === null) {
				continue;
			}
			$total++;
			try {
				[$result] = $this->teams->syncCards($teamId);
				$updated += $result === Steps::UNCHANGED ? 0 : 1;
			} catch (\Throwable $e) {
				$errors[] = 'team ' . $teamId . ': ' . Steps::describe($e);
			}
		}
		if ($errors !== []) {
			throw new StepFailed(implode('; ', $errors));
		}
		return [$updated === 0 ? Steps::UNCHANGED : Steps::UPDATED, $updated . ' of ' . $total . ' address book(s) changed'];
	}
}
