<?php

declare(strict_types=1);

/**
 * The groups of organisations ("org:{org_id}") and teams ("team:{team_id}"). They are "locked":
 * only this API changes them. Changes made elsewhere are noted by GroupDriftListener, and the
 * changes made here run inside DriftGuard so they are not noted.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OCP\IGroup;
use OCP\IGroupManager;
use OCP\IUser;

class GroupService {
	public function __construct(
		private IGroupManager $groupManager,
	) {
	}

	/**
	 * Makes sure the group exists with this display name.
	 *
	 * @return array{0: string, 1: string} [result, detail]
	 */
	public function ensure(string $groupId, string $displayName): array {
		$displayName = mb_substr($displayName, 0, 255);
		$group = $this->groupManager->get($groupId);
		if ($group === null) {
			$group = DriftGuard::run(fn (): ?IGroup => $this->groupManager->createGroup($groupId));
			if ($group === null) {
				throw new StepFailed('the group ' . $groupId . ' could not be made');
			}
			DriftGuard::run(fn () => $group->setDisplayName($displayName));
			return [Steps::CREATED, $groupId];
		}
		if ($group->getDisplayName() !== $displayName) {
			if (!DriftGuard::run(fn (): bool => $group->setDisplayName($displayName))) {
				throw new StepFailed('the name of ' . $groupId . ' could not be changed');
			}
			return [Steps::UPDATED, $groupId];
		}
		return [Steps::UNCHANGED, $groupId];
	}

	public function get(string $groupId): ?IGroup {
		return $this->groupManager->get($groupId);
	}

	/**
	 * The group's members whose accounts are enabled, by uid.
	 *
	 * @return array<string, IUser>
	 */
	public function activeMembers(string $groupId): array {
		$group = $this->groupManager->get($groupId);
		if ($group === null) {
			return [];
		}
		$members = [];
		foreach ($group->getUsers() as $user) {
			if ($user->isEnabled()) {
				$members[$user->getUID()] = $user;
			}
		}
		ksort($members, SORT_STRING);
		return $members;
	}
}
