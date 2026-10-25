<?php

declare(strict_types=1);

/**
 * The team's Team Folder (the groupfolders app), shared with the team's group only, with every
 * permission (31: read, change, create, delete, share) and advanced permissions switched on.
 *
 * The folder is named after the team: the characters / \ : * ? " < > | become spaces, at most
 * 100 characters. Two teams of the same organisation with the same name get "Sales" and
 * "Sales 2"; teams of different organisations never see each other's folders, so they may share a
 * name. A rename keeps the folder (same id, same files) and only changes its name.
 *
 * A team lead may also manage the folder's advanced permissions (setLead, a "user" entry in the
 * folder's manage list); ordinary members may not.
 *
 * Uses groupfolders' own FolderManager, the same calls its admin page makes.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OCA\GroupFolders\Folder\FolderManager;
use OCP\App\IAppManager;
use OCP\Constants;
use Psr\Container\ContainerInterface;

class TeamFolderService {
	public const MAX_NAME = 100;
	public const PERMISSIONS = Constants::PERMISSION_ALL;
	public const ARCHIVED_SUFFIX = ' (archived)';

	private const APP = 'groupfolders';

	private ?FolderManager $folders = null;

	public function __construct(
		private ContainerInterface $container,
		private IAppManager $appManager,
		private AdminStore $store,
	) {
	}

	/** A team name made safe as a folder name (without the " 2" suffix). */
	public static function safeName(string $name): string {
		$name = str_replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], ' ', $name);
		$name = (string)preg_replace('/\s+/u', ' ', $name);
		// No "..", and no leading dot (a hidden folder).
		$name = (string)preg_replace('/\.{2,}/', '.', $name);
		$name = ltrim(trim($name), '.');
		$name = trim(mb_substr(trim($name), 0, self::MAX_NAME));
		return $name === '' ? 'Team' : $name;
	}

	/**
	 * The folder name for a team: its safe name, plus " 2", " 3"... when another team of the same
	 * organisation already uses it. A folder that already has one of these names keeps it, so
	 * folders are not renamed back and forth.
	 */
	public function mountPointFor(string $teamId, string $orgId, string $name, bool $archived, ?string $current): string {
		$base = self::safeName($name);
		$suffix = $archived ? self::ARCHIVED_SUFFIX : '';
		$taken = [];
		foreach ($this->store->teamsOf($orgId) as $team) {
			if ($team['team_id'] === $teamId || $team['folder_id'] === null) {
				continue;
			}
			$folder = $this->manager()->getFolder($team['folder_id']);
			if ($folder !== null) {
				$taken[mb_strtolower($folder->mountPoint)] = true;
			}
		}

		$candidate = static function (int $n) use ($base, $suffix): string {
			$number = $n === 1 ? '' : ' ' . $n;
			return trim(mb_substr($base, 0, self::MAX_NAME - mb_strlen($number . $suffix))) . $number . $suffix;
		};

		$first = null;
		for ($n = 1; $n <= 1000; $n++) {
			$name = $candidate($n);
			if (isset($taken[mb_strtolower($name)])) {
				continue;
			}
			if ($current === null || $name === $current) {
				return $name;
			}
			$first ??= $name;
		}
		if ($first === null) {
			throw new StepFailed('no free folder name for ' . $base);
		}
		return $first;
	}

	/**
	 * Makes sure the folder exists with this name, for this group, with all permissions and
	 * advanced permissions on. A folder that was removed outside the API is made again (empty).
	 *
	 * @return array{0: int, 1: string, 2: string} [folder id, result, detail]
	 */
	public function ensure(?int $folderId, string $groupId, string $teamId, string $orgId, string $name, bool $archived): array {
		$manager = $this->manager();
		$folder = $folderId === null ? null : $manager->getFolder($folderId);
		$mountPoint = $this->mountPointFor($teamId, $orgId, $name, $archived, $folder?->mountPoint);
		$changes = [];

		if ($folder === null) {
			$folderId = $manager->createFolder($mountPoint);
			$folder = $manager->getFolder($folderId);
			if ($folder === null) {
				throw new StepFailed('the team folder could not be made');
			}
			$result = Steps::CREATED;
		} else {
			$result = Steps::UNCHANGED;
			if ($folder->mountPoint !== $mountPoint) {
				$manager->renameFolder($folderId, $mountPoint);
				$changes[] = 'renamed';
			}
		}

		if (!isset($folder->groups[$groupId])) {
			$manager->addApplicableGroup($folderId, $groupId);
			$manager->setGroupPermissions($folderId, $groupId, self::PERMISSIONS);
			$changes[] = 'group added';
		} elseif ((int)$folder->groups[$groupId]['permissions'] !== self::PERMISSIONS) {
			$manager->setGroupPermissions($folderId, $groupId, self::PERMISSIONS);
			$changes[] = 'permissions';
		}
		if (!$folder->acl) {
			$manager->setFolderACL($folderId, true);
			$changes[] = 'advanced permissions on';
		}

		if ($result === Steps::UNCHANGED && $changes !== []) {
			$result = Steps::UPDATED;
		}
		$detail = 'folder ' . $folderId . ' "' . $mountPoint . '"';
		if ($result === Steps::UPDATED) {
			$detail .= ' (' . implode(', ', $changes) . ')';
		}
		return [$folderId, $result, $detail];
	}

	/**
	 * Gives or takes away a person's right to manage the folder's advanced permissions.
	 *
	 * @return bool whether anything changed
	 */
	public function setLead(int $folderId, string $uid, bool $lead): bool {
		$isLead = in_array($uid, $this->leads($folderId), true);
		if ($isLead === $lead) {
			return false;
		}
		$this->manager()->setManageACL($folderId, 'user', $uid, $lead);
		return true;
	}

	/** @return list<string> the uids that may manage the folder's advanced permissions */
	public function leads(int $folderId): array {
		$folder = $this->manager()->getFolder($folderId);
		if ($folder === null) {
			throw new StepFailed('team folder ' . $folderId . ' is missing');
		}
		$uids = [];
		foreach ($folder->manage as $entry) {
			if (($entry['type'] ?? null) === 'user') {
				$uids[] = (string)$entry['id'];
			}
		}
		sort($uids, SORT_STRING);
		return $uids;
	}

	/** The folder's own storage id (the filecache "storage" of its files), or null when it is gone. */
	public function storageId(?int $folderId): ?int {
		$folder = $folderId === null ? null : $this->manager()->getFolder($folderId);
		return $folder === null ? null : (int)$folder->storageId;
	}

	/** @return array{id: ?int, exists: bool, mount_point?: string, storage_id?: int, root_id?: int, acl?: bool, groups?: array<string, int>, leads?: list<string>} */
	public function describe(?int $folderId): array {
		$folder = $folderId === null ? null : $this->manager()->getFolder($folderId);
		if ($folder === null) {
			return ['id' => $folderId, 'exists' => false];
		}
		return [
			'id' => $folderId,
			'exists' => true,
			'mount_point' => $folder->mountPoint,
			'storage_id' => $folder->storageId,
			'root_id' => $folder->rootId,
			'acl' => $folder->acl,
			'groups' => array_map(fn (array $applicable): int => (int)$applicable['permissions'], $folder->groups),
			'leads' => $this->leads($folderId),
		];
	}

	private function manager(): FolderManager {
		if ($this->folders === null) {
			if (!$this->appManager->isEnabledForAnyone(self::APP)) {
				throw new StepFailed('the Team Folders app (groupfolders) is not enabled');
			}
			$this->appManager->loadApp(self::APP);
			$this->folders = $this->container->get(FolderManager::class);
		}
		return $this->folders;
	}
}
