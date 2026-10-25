<?php

declare(strict_types=1);

/**
 * A person leaves a team. Access ends at once and what they handed out from the team ends too;
 * the files they put in the team folder stay (the Team Folders app owns them).
 *
 * In this order, all in one call:
 * 1. shares   group shares BY the person to the team's group (from any of their files) are
 *             removed: "group_shares_removed";
 *             shares the person made ON files of the team folder (public links, email, user and
 *             group shares) are removed: "team_file_shares_removed";
 * 2. locks    their own locks (files_lock: a lock of their own or a WebDAV lock token) on team
 *             folder files are released: "locks_released";
 * 3. group    they leave the group "team:{team_id}": the folder, calendar, address book and board
 *             are gone for them from the next request on: "removed_from_group";
 * 4. editors  their open ONLYOFFICE sessions on team folder documents are dropped:
 *             "onlyoffice_drop" {sent, codes, not_sent} (OnlyofficeCommand);
 * 5. lead     their right to manage the folder's advanced permissions and their own board share
 *             are removed: "lead_rights_removed";
 * 6. cards    the team address book is rebuilt without them;
 * 7. archive  when nobody is left, the team is archived: the folder becomes "<name> (archived)"
 *             and the board is archived. The group, the folder and its files stay.
 *
 * Shares and locks go first, while the person can still reach the files, so the shares and lock
 * owners can be read the normal way; the group membership ends right after, in the same call.
 * Each part is tried even when an earlier one failed; a failure shows in "errors" and makes the
 * leave "failed", so the caller sends the call again and the leave finishes.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\Files\IRootFolder;
use OCP\Files\Lock\ILock;
use OCP\Files\Lock\ILockManager;
use OCP\Files\Lock\LockContext;
use OCP\IDBConnection;
use OCP\IGroupManager;
use OCP\IUser;
use OCP\IUserManager;
use OCP\IUserSession;
use OCP\Share\IManager as IShareManager;
use OCP\Share\IShare;
use Psr\Log\LoggerInterface;

class LeaveService {
	/** Share types that a person can make on a file: user, group, public link, email. */
	private const FILE_SHARE_TYPES = [IShare::TYPE_USER, IShare::TYPE_GROUP, IShare::TYPE_LINK, IShare::TYPE_EMAIL];

	public function __construct(
		private AdminStore $store,
		private GroupService $groups,
		private IGroupManager $groupManager,
		private IUserManager $userManager,
		private IUserSession $userSession,
		private IShareManager $shares,
		private ILockManager $lockManager,
		private IRootFolder $rootFolder,
		private IDBConnection $db,
		private TeamFolderService $folders,
		private DeckClient $deck,
		private TeamService $teams,
		private OnlyofficeCommand $onlyoffice,
		private LoggerInterface $logger,
	) {
	}

	/**
	 * The person $uid leaves the stored team $team (a row of nourax_api_teams). Safe to run again:
	 * a second run finds nothing more to do and reports zeros.
	 *
	 * @return array{0: string, 1: string, 2: array{team_id: string, counts: array<string, mixed>}} [result, detail, fields]
	 */
	public function leave(array $team, string $uid): array {
		$teamId = (string)$team['team_id'];
		$groupId = (string)$team['group_id'];
		$counts = [
			'group_shares_removed' => 0,
			'team_file_shares_removed' => 0,
			'locks_released' => 0,
			'removed_from_group' => false,
			'onlyoffice_drop' => ['sent' => 0, 'codes' => new \stdClass(), 'not_sent' => 0],
			'lead_rights_removed' => 0,
			'archived' => false,
		];
		$errors = [];
		$user = $this->userManager->get($uid);
		$storageId = null;
		try {
			$storageId = $this->folders->storageId($team['folder_id']);
		} catch (\Throwable $e) {
			$errors['folder'] = Steps::describe($e);
		}

		// 1. Shares, while the person can still reach the files.
		try {
			[$counts['group_shares_removed'], $counts['team_file_shares_removed']] = $this->removeShares($uid, $groupId, $storageId);
		} catch (\Throwable $e) {
			$errors['shares'] = $this->failure('shares', $e);
		}

		// 2. Their own locks on team folder files.
		if ($user !== null && $storageId !== null) {
			try {
				$counts['locks_released'] = $this->releaseLocks($user, $storageId);
			} catch (\Throwable $e) {
				$errors['locks'] = $this->failure('locks', $e);
			}
		}

		// 3. Leave the group: access ends now.
		try {
			$group = $this->groupManager->get($groupId);
			if ($group !== null && $user !== null && $group->inGroup($user)) {
				DriftGuard::run(fn () => $group->removeUser($user));
				$counts['removed_from_group'] = true;
			}
		} catch (\Throwable $e) {
			$errors['group'] = $this->failure('group', $e);
		}

		// 4. Open ONLYOFFICE sessions on team documents.
		if ($storageId !== null) {
			try {
				$drop = $this->onlyoffice->drop($this->documentKeys($storageId), $uid);
				if (isset($drop['codes']['6'])) {
					$errors['onlyoffice'] = 'the document server refused the signature (error 6)';
				}
				// {"0": n} stays an object in JSON, whatever the codes are.
				$counts['onlyoffice_drop'] = ['sent' => $drop['sent'], 'codes' => (object)$drop['codes'], 'not_sent' => $drop['not_sent']];
			} catch (\Throwable $e) {
				$errors['onlyoffice'] = $this->failure('onlyoffice', $e);
			}
		}

		// 5. Lead rights: folder permissions management and their own board share.
		try {
			if ($team['folder_id'] !== null && $this->folders->setLead($team['folder_id'], $uid, false)) {
				$counts['lead_rights_removed']++;
			}
		} catch (\Throwable $e) {
			$errors['lead_folder'] = $this->failure('lead_folder', $e);
		}
		try {
			if ($team['board_id'] !== null && $this->deck->setLead($team['board_id'], $uid, false)) {
				$counts['lead_rights_removed']++;
			}
		} catch (\Throwable $e) {
			$errors['lead_board'] = $this->failure('lead_board', $e);
		}

		// 6. The team address book without them.
		try {
			if ($team['addressbook_id'] !== null) {
				$this->teams->syncCards($teamId);
			}
		} catch (\Throwable $e) {
			$errors['cards'] = $this->failure('cards', $e);
		}

		// 7. Nobody left: archive (nothing is deleted).
		try {
			$group = $this->groupManager->get($groupId);
			if ($group !== null && $group->getUsers() === [] && $team['archived'] !== 1) {
				$this->teams->setArchived($teamId, true);
				$counts['archived'] = true;
			}
		} catch (\Throwable $e) {
			$errors['archive'] = $this->failure('archive', $e);
		}

		$fields = ['team_id' => $teamId, 'counts' => $counts];
		if ($errors !== []) {
			$fields['errors'] = $errors;
			return [Steps::FAILED, 'left team ' . $teamId . ' with errors: ' . implode(', ', array_keys($errors)), $fields];
		}
		$changed = $counts['removed_from_group'] || $counts['group_shares_removed'] > 0 || $counts['team_file_shares_removed'] > 0
			|| $counts['locks_released'] > 0 || $counts['lead_rights_removed'] > 0 || $counts['archived'];
		return [$changed ? Steps::UPDATED : Steps::UNCHANGED, 'left team ' . $teamId . ($counts['archived'] ? ' (now archived: nobody left)' : ''), $fields];
	}

	/**
	 * Removes the group shares by $uid to the team's group, and every share $uid made on a file
	 * of the team folder's storage.
	 *
	 * @return array{0: int, 1: int} [group shares removed, team file shares removed]
	 */
	private function removeShares(string $uid, string $groupId, ?int $storageId): array {
		$groupShares = 0;
		$fileShares = 0;
		$done = [];
		foreach ($this->shares->getSharesBy($uid, IShare::TYPE_GROUP, null, false, -1) as $share) {
			if ($share->getSharedWith() === $groupId) {
				$this->shares->deleteShare($share);
				$done[$share->getFullId()] = true;
				$groupShares++;
			}
		}
		if ($storageId === null) {
			return [$groupShares, $fileShares];
		}
		foreach (self::FILE_SHARE_TYPES as $type) {
			$found = [];
			foreach ($this->shares->getSharesBy($uid, $type, null, true, -1) as $share) {
				if (!isset($done[$share->getFullId()])) {
					$found[$share->getNodeId()][] = $share;
				}
			}
			if ($found === []) {
				continue;
			}
			foreach ($this->inStorage(array_keys($found), $storageId) as $fileId) {
				foreach ($found[$fileId] as $share) {
					$this->shares->deleteShare($share);
					$done[$share->getFullId()] = true;
					$fileShares++;
				}
			}
		}
		return [$groupShares, $fileShares];
	}

	/**
	 * Releases the locks that $user holds on files of the storage: a lock of their own (type user)
	 * or a WebDAV lock token they took. Locks of apps (for example the office editor) stay; the
	 * editor lets go itself once its session is dropped.
	 */
	private function releaseLocks(IUser $user, int $storageId): int {
		$qb = $this->db->getQueryBuilder();
		$qb->select('l.file_id', 'l.type', 'l.token')
			->from('files_lock', 'l')
			->innerJoin('l', 'filecache', 'f', $qb->expr()->eq('f.fileid', 'l.file_id'))
			->where($qb->expr()->eq('l.user_id', $qb->createNamedParameter($user->getUID())))
			->andWhere($qb->expr()->in('l.type', $qb->createNamedParameter([ILock::TYPE_USER, ILock::TYPE_TOKEN], IQueryBuilder::PARAM_INT_ARRAY)))
			->andWhere($qb->expr()->eq('f.storage', $qb->createNamedParameter($storageId, IQueryBuilder::PARAM_INT)));
		$locks = $qb->executeQuery()->fetchAllAssociative();
		if ($locks === []) {
			return 0;
		}

		$released = 0;
		$home = $this->rootFolder->getUserFolder($user->getUID());
		$previous = $this->userSession->getUser();
		// The lock is released as its owner, on the node as the owner sees it.
		$this->userSession->setVolatileActiveUser($user);
		try {
			foreach ($locks as $lock) {
				$node = $home->getFirstNodeById((int)$lock['file_id']);
				if ($node === null) {
					continue;
				}
				$type = (int)$lock['type'];
				$owner = $type === ILock::TYPE_TOKEN ? (string)$lock['token'] : $user->getUID();
				$this->lockManager->unlock(new LockContext($node, $type, $owner));
				$released++;
			}
		} finally {
			$this->userSession->setVolatileActiveUser($previous);
		}
		return $released;
	}

	/** @return list<string> the ONLYOFFICE document keys of the storage's files */
	private function documentKeys(int $storageId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('k.key')
			->from('onlyoffice_filekey', 'k')
			->innerJoin('k', 'filecache', 'f', $qb->expr()->eq('f.fileid', 'k.file_id'))
			->where($qb->expr()->eq('f.storage', $qb->createNamedParameter($storageId, IQueryBuilder::PARAM_INT)))
			->orderBy('k.id', 'DESC')
			->setMaxResults(OnlyofficeCommand::MAX_KEYS);
		try {
			return array_map('strval', $qb->executeQuery()->fetchFirstColumn());
		} catch (\OCP\DB\Exception $e) {
			// No onlyoffice table (the app was never installed): nothing to drop.
			if (!$this->db->tableExists('onlyoffice_filekey')) {
				return [];
			}
			throw $e;
		}
	}

	/**
	 * @param list<int|string> $fileIds
	 * @return list<int> the ids among them whose file lives in the storage
	 */
	private function inStorage(array $fileIds, int $storageId): array {
		$ids = [];
		foreach (array_chunk(array_map('intval', $fileIds), 500) as $chunk) {
			$qb = $this->db->getQueryBuilder();
			$qb->select('fileid')->from('filecache')
				->where($qb->expr()->in('fileid', $qb->createNamedParameter($chunk, IQueryBuilder::PARAM_INT_ARRAY)))
				->andWhere($qb->expr()->eq('storage', $qb->createNamedParameter($storageId, IQueryBuilder::PARAM_INT)));
			foreach ($qb->executeQuery()->fetchFirstColumn() as $id) {
				$ids[] = (int)$id;
			}
		}
		return $ids;
	}

	private function failure(string $part, \Throwable $e): string {
		$this->logger->warning('nourax_api leave: ' . $part . ' failed: ' . get_class($e) . ': ' . $e->getMessage(), ['app' => 'nourax_api']);
		return Steps::describe($e);
	}
}
