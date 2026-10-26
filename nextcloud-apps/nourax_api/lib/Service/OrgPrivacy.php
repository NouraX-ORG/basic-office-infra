<?php

declare(strict_types=1);

/**
 * Privacy between organisations (docs/teams.md): one rule for the shares that the server's own
 * "share only with group members" setting does not cover.
 *
 * When that setting is on (core shareapi_only_share_with_group_members, set by
 * scripts/configure.d/60-org-privacy.sh), file shares already follow it. Calendars and address
 * books shared over CalDAV/CardDAV, Deck boards, and the other apps' own shares and hand-overs
 * (NoGantt, NoForms, Photos albums, team folder rules, file ownership transfers, board imports)
 * do not: they accept any account id. Dav/OrgSharePlugin and Middleware/OrgShareMiddleware ask
 * this class instead; they also ask it who may see a person's name (DAV principals, the
 * ONLYOFFICE editor's names). While the setting is off, nothing here refuses or hides anything.
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

	/**
	 * The stricter rule for handing something to one named account in the apps that check no more
	 * than that the account exists (NoGantt project shares and people, NoForms shares and new
	 * owners, NoBoard new owners, file ownership transfers, team folder rules, album
	 * collaborators): allowed only for oneself or someone who shares a group. An account that
	 * does not exist gets the same answer as one of another organisation, so the answer never
	 * tells whether an id exists.
	 *
	 * @return ?string why $actor may not reach account $uid, or null when allowed
	 */
	public function checkReach(IUser $actor, string $uid): ?string {
		if (!$this->isOn() || $this->exempt($actor) || $uid === $actor->getUID()) {
			return null;
		}
		return $this->userManager->get($uid) === null ? self::REFUSED_PERSON : $this->checkPerson($actor, $uid);
	}

	/**
	 * Whether $viewer may see the name, email address and groups of account $uid: oneself, someone
	 * who shares a group, and the service account (it owns the team calendars, address books and
	 * boards, so their owner is always shown). Always true while privacy is off.
	 */
	public function canSeeUser(IUser $viewer, string $uid): bool {
		if (!$this->isOn() || $this->exempt($viewer) || $uid === $viewer->getUID() || $uid === ServiceAccountService::UID) {
			return true;
		}
		return $this->userManager->get($uid) !== null && $this->checkPerson($viewer, $uid) === null;
	}

	/** Whether $viewer may see group $gid (its name): only the groups one is a member of. */
	public function canSeeGroup(IUser $viewer, string $gid): bool {
		if (!$this->isOn() || $this->exempt($viewer)) {
			return true;
		}
		$group = $this->groupManager->get($gid);
		return $group === null || $group->inGroup($viewer);
	}

	/**
	 * A NoBoard (Deck) board import: the uidRelation of any import ("their account id" => an account
	 * here) and, for a "Deck JSON" export, every account and group it names. Deck writes these
	 * straight into its tables, checking at most that the account exists (BoardImportService and
	 * DeckJsonService of Deck 1.19.1). Each is read here exactly as Deck reads it:
	 * - a share (acl): participant.primaryKey, or participant itself; for a person, mapped (below);
	 * - a card's people (assignedUsers): participant.uid, or participant itself, mapped;
	 * - an attachment's author (createdBy, else the export's owner), mapped;
	 * - a comment's author (actorId, when actorType is "users") and a card's last editor
	 *   (lastEditor): as they are, never mapped.
	 * Mapped is Deck's mapMember: the export's owner (owner.primaryKey, or owner itself) becomes the
	 * importing person, an id in uidRelation becomes the account it names (checked first), and any
	 * other id stays itself when such an account exists.
	 * Every account must be oneself or share a group, every group must be one's own, and no Teams-app
	 * team or other server. An account that does not exist here is skipped by Deck and here alike.
	 * A share whose type is not a number (Deck would cast it, "abc" to a person share) is refused.
	 *
	 * @param mixed $config the import config (decoded JSON objects), or null for the web upload
	 * @param mixed $data the export (decoded JSON objects), or null when it is not a Deck JSON export
	 * @return ?string why $importer may not import it, or null when allowed
	 */
	public function checkDeckImport(IUser $importer, mixed $config, mixed $data): ?string {
		if (!$this->isOn() || $this->exempt($importer)) {
			return null;
		}
		$relation = is_object($config) ? ($config->uidRelation ?? null) : null;
		$mapped = [];
		if (is_object($relation) || is_array($relation)) {
			foreach ((array)$relation as $from => $to) {
				if (!is_scalar($to)) {
					// Deck refuses the whole import ("uidRelation is invalid").
					continue;
				}
				$mapped[(string)$from] = true;
				if (($refusal = $this->checkPerson($importer, (string)$to)) !== null) {
					return $refusal;
				}
			}
		}
		if (!is_object($data) && !is_array($data)) {
			return null;
		}
		// The boards as Deck reads them (DeckJsonService::getBoards): {"boards": {...}}, or the old
		// format's map of boards.
		$boards = is_object($data) && isset($data->boards) ? $data->boards : $data;
		foreach ((array)$boards as $board) {
			if (is_object($board) && ($refusal = $this->checkDeckImportBoard($importer, $board, $mapped)) !== null) {
				return $refusal;
			}
		}
		return null;
	}

	/** One board of a Deck JSON export (see checkDeckImport). */
	private function checkDeckImportBoard(IUser $importer, object $board, array $mapped): ?string {
		$owner = $board->owner ?? null;
		$sourceId = is_object($owner) ? ($owner->primaryKey ?? $owner) : $owner;
		// DeckJsonService::mapMember (Deck cannot import an id that is not a string or a number).
		$member = function (mixed $id) use ($importer, $sourceId, $mapped): ?string {
			if ($id === null || $id === $sourceId || !is_scalar($id) || isset($mapped[(string)$id])) {
				return null;
			}
			return $this->checkPerson($importer, (string)$id);
		};
		$asIs = fn (mixed $id): ?string => is_string($id) && $id !== '' ? $this->checkPerson($importer, $id) : null;

		foreach ((array)($board->acl ?? []) as $acl) {
			if (!is_object($acl) || !isset($acl->type)) {
				// Without a type Deck cannot save the share.
				continue;
			}
			if (!is_numeric($acl->type)) {
				return self::REFUSED_PERSON;
			}
			$participant = $acl->participant ?? null;
			$id = is_object($participant) ? ($participant->primaryKey ?? null) : $participant;
			$refusal = match ((int)$acl->type) {
				self::DECK_USER => $member($id),
				self::DECK_GROUP => is_scalar($id) ? $this->checkGroup($importer, (string)$id) : null,
				self::DECK_REMOTE, self::DECK_CIRCLE => $this->checkOther($importer),
				default => null,
			};
			if ($refusal !== null) {
				return $refusal;
			}
		}
		foreach ((array)($board->stacks ?? []) as $stack) {
			foreach (is_object($stack) ? (array)($stack->cards ?? []) : [] as $card) {
				if (!is_object($card)) {
					continue;
				}
				$refusal = $asIs($card->lastEditor ?? null);
				foreach ((array)($card->assignedUsers ?? []) as $assigned) {
					$participant = is_object($assigned) ? ($assigned->participant ?? null) : null;
					$refusal ??= $member(is_object($participant) ? ($participant->uid ?? null) : $participant);
				}
				foreach ((array)($card->comments ?? []) as $comment) {
					if (is_object($comment) && is_scalar($comment->actorType ?? 'users') && (string)($comment->actorType ?? 'users') === 'users') {
						$refusal ??= $asIs($comment->actorId ?? null);
					}
				}
				foreach ((array)($card->attachments ?? []) as $attachment) {
					if (is_object($attachment) && ($attachment->type ?? null) === 'file' && isset($attachment->data, $attachment->contentBase64)) {
						$refusal ??= $member($attachment->createdBy ?? $owner);
					}
				}
				if ($refusal !== null) {
					return $refusal;
				}
			}
		}
		return null;
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
	 * A CalDAV or CardDAV share target, as the sharing request names it. It is read exactly as the
	 * dav server's sharing backend reads it (OCA\DAV\DAV\Sharing\Backend::updateShares, through
	 * Principal::findByUri and RemoteUserPrincipalBackend::findByUri of server 35): only
	 * "principal:" followed by principals/users/<uid>, principals/groups/<gid>,
	 * principals/circles/<id> or principals/remote-users/<id>, split with Sabre\Uri\split (a trailing
	 * slash is allowed, an extra or leading one is not) and the name url-decoded. A mailto: target
	 * or any other text shares with nobody there.
	 *
	 * While privacy is on, a target is allowed only when it is a person who shares a group with the
	 * sharer (or the sharer), or a group the sharer is in. Everything else gets a refusal: another
	 * organisation, an account or group that does not exist, a team, another server, and every
	 * target the server would not share with anyway. So the answer is the same 403 for all of them,
	 * and never tells whether an id exists.
	 *
	 * @return ?string why $sharer may not share with it, or null when allowed
	 */
	public function checkDavHref(IUser $sharer, string $href): ?string {
		if (!$this->isOn() || $this->exempt($sharer)) {
			return null;
		}
		if (!str_starts_with($href, 'principal:')) {
			return self::REFUSED_PERSON;
		}
		[$prefix, $name] = \Sabre\Uri\split(substr($href, strlen('principal:')));
		if ($name === null || $name === '') {
			return self::REFUSED_PERSON;
		}
		// The dav server reads the name url-decoded (and tries it as it is for groups).
		$decoded = urldecode($name);
		return match ($prefix) {
			'principals/users' => $this->checkReach($sharer, $decoded),
			'principals/groups' => $this->checkDavGroup($sharer, $decoded, $name),
			'principals/circles', 'principals/remote-users' => $this->checkOther($sharer),
			default => self::REFUSED_PERSON,
		};
	}

	/** A group share target: a group the sharer is in; one that does not exist is refused too. */
	private function checkDavGroup(IUser $sharer, string $decoded, string $name): ?string {
		$gid = $this->groupManager->groupExists($decoded) ? $decoded : $name;
		return $this->groupManager->groupExists($gid) ? $this->checkGroup($sharer, $gid) : self::REFUSED_GROUP;
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
