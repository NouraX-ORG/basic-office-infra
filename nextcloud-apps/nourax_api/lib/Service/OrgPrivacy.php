<?php

declare(strict_types=1);

/**
 * Privacy between organisations (docs/teams.md): one rule for the shares that the server's own
 * "share only with group members" setting does not cover.
 *
 * When that setting is on (core shareapi_only_share_with_group_members, set by
 * scripts/configure.d/60-org-privacy.sh), file shares already follow it. Calendars and address
 * books shared over CalDAV/CardDAV, and Deck boards, do not: they accept any account id. Dav/
 * OrgSharePlugin and Middleware/OrgShareMiddleware ask this class instead. While the setting is
 * off, nothing here refuses anything.
 *
 * The rule is the server's own (core's RestrictInteractionListener for file shares):
 * - a person: allowed when the two have a group in common, not counting the excluded groups
 *   (shareapi_only_share_with_group_members_exclude_group_list, here ["admin"]). People of one
 *   organisation share its group org:{org_id};
 * - a group: allowed when the sharer is a member and it is not an excluded group;
 * - a team of the Teams app (circles) or a person on another server: refused.
 * The service account nourax-teams owns the team calendars, address books and boards and shares
 * them with their team groups; it is never limited.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OCP\IGroupManager;
use OCP\IUser;
use OCP\IUserManager;
use OCP\Share\IManager as IShareManager;

class OrgPrivacy {
	public const REFUSED_PERSON = 'Sharing is only allowed with people of your organisation.';
	public const REFUSED_GROUP = 'Sharing is only allowed with your own organisation and teams.';
	public const REFUSED_OTHER = 'Sharing with Teams-app teams or other servers is not allowed.';

	/** Deck's ACL types (OCA\Deck\Db\Acl::PERMISSION_TYPE_*). */
	public const DECK_USER = 0;
	public const DECK_GROUP = 1;
	public const DECK_REMOTE = 6;
	public const DECK_CIRCLE = 7;

	public function __construct(
		private IShareManager $shareManager,
		private IGroupManager $groupManager,
		private IUserManager $userManager,
	) {
	}

	/** True while sharing is limited to group members, which is when this class refuses. */
	public function isOn(): bool {
		return $this->shareManager->shareWithGroupMembersOnly();
	}

	/** @return ?string why $sharer may not share with account $uid, or null when allowed */
	public function checkPerson(IUser $sharer, string $uid): ?string {
		if (!$this->isOn() || $this->exempt($sharer) || $uid === '' || $uid === $sharer->getUID()) {
			return null;
		}
		$target = $this->userManager->get($uid);
		if ($target === null) {
			// Nobody to share with; the app refuses or ignores it on its own.
			return null;
		}
		$common = array_diff(
			array_intersect($this->groupManager->getUserGroupIds($sharer), $this->groupManager->getUserGroupIds($target)),
			$this->excludedGroups(),
		);
		return $common === [] ? self::REFUSED_PERSON : null;
	}

	/** @return ?string why $sharer may not share with group $gid, or null when allowed */
	public function checkGroup(IUser $sharer, string $gid): ?string {
		if (!$this->isOn() || $this->exempt($sharer)) {
			return null;
		}
		$group = $this->groupManager->get($gid);
		if ($group === null) {
			return null;
		}
		if (in_array($group->getGID(), $this->excludedGroups(), true)
			|| !$group->inGroup($sharer)) {
			return self::REFUSED_GROUP;
		}
		return null;
	}

	/** @return ?string the refusal of a share with a Teams-app team or another server */
	public function checkOther(IUser $sharer): ?string {
		return !$this->isOn() || $this->exempt($sharer) ? null : self::REFUSED_OTHER;
	}

	/**
	 * A CalDAV or CardDAV share target, as the sharing request names it:
	 * principal:principals/users/<uid>, principal:principals/groups/<gid>, mailto:<address>,
	 * principal:principals/circles/... or principal:principals/remote-users/...
	 *
	 * @return ?string why $sharer may not share with it, or null when allowed (or not a target the
	 *                 server would accept anyway)
	 */
	public function checkDavHref(IUser $sharer, string $href): ?string {
		if (!$this->isOn()) {
			return null;
		}
		$href = trim($href);
		if (strncasecmp($href, 'mailto:', 7) === 0) {
			// The dav server shares with the one account that has this address, if there is one.
			$users = $this->userManager->getByEmail(substr($href, 7));
			return count($users) === 1 ? $this->checkPerson($sharer, $users[0]->getUID()) : null;
		}
		if (str_starts_with($href, 'principal:')) {
			$href = substr($href, strlen('principal:'));
		}
		// Split the way the dav server's principal backend does (Sabre\Uri\split: extra and
		// trailing slashes are allowed), so a target is read here exactly as it will be shared.
		[$prefix, $name] = \Sabre\Uri\split(ltrim($href, '/'));
		if ($prefix === null || $name === null || $name === '') {
			return null;
		}
		// The dav server reads the name url-decoded (and tries it as it is for groups).
		$decoded = urldecode($name);
		return match ($prefix) {
			'principals/users' => $this->checkPerson($sharer, $decoded),
			'principals/groups' => $this->checkGroup($sharer, $this->groupManager->groupExists($decoded) ? $decoded : $name),
			'principals/circles', 'principals/remote-users' => $this->checkOther($sharer),
			default => null,
		};
	}

	/**
	 * A new Deck board share (BoardService::addAcl).
	 *
	 * @return ?string why $sharer may not add it, or null when allowed
	 */
	public function checkDeckAcl(IUser $sharer, int $type, string $participant): ?string {
		return match ($type) {
			self::DECK_USER => $this->checkPerson($sharer, $participant),
			self::DECK_GROUP => $this->checkGroup($sharer, $participant),
			self::DECK_REMOTE, self::DECK_CIRCLE => $this->checkOther($sharer),
			default => null,
		};
	}

	/** The groups that never count as "in common" (protected for tests/org-privacy-rules.php). */
	protected function excludedGroups(): array {
		return $this->shareManager->shareWithGroupMembersOnlyExcludeGroupsList();
	}

	private function exempt(IUser $sharer): bool {
		return $sharer->getUID() === ServiceAccountService::UID;
	}
}
