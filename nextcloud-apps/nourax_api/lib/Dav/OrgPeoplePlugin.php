<?php

declare(strict_types=1);

/**
 * Privacy between organisations on the server's DAV endpoint (/remote.php/dav), for what
 * OrgSharePlugin (calendar and address book shares) does not cover (docs/teams.md):
 *
 * - **Who a person is.** A PROPFIND (or an expand-property REPORT) of the address of any account,
 *   principals/users/<uid>, answers its name, email address, groups and language, and
 *   principals/groups/<gid> answers a group's name, to anyone who knows the id. For an account
 *   outside the person's organisation, and a group the person is not in, every property but
 *   the resource type is answered "not found". (Search and listing are already limited by the
 *   server; this is the address itself.) The service account nourax-teams stays visible: it
 *   owns the team calendars and address books.
 * - **Comments.** A comment that mentions "@<id>" answers that account's name with the comment
 *   (to everyone who can read the file). For an account outside the reader's organisation the
 *   id is shown instead of the name.
 * - **Photos albums.** A PROPPATCH of an album's {http://nextcloud.org/ns}collaborators adds any
 *   account or group (Photos' AlbumMapper checks only that it exists). A new collaborator outside
 *   the organisation gets 403 and nothing is changed. Public links stay possible.
 * - **Team folder rules.** A PROPPATCH of {http://nextcloud.org/ns}acl-list (a team lead's
 *   advanced permissions) takes a rule for any account or group, and the folder then shows that
 *   person's name. A rule for someone outside the organisation, or for a group the lead is not
 *   in, gets 403.
 * - **Avatars.** avatars/<uid>/<size>.png answers any account's picture, drawn from its name
 *   when none was uploaded. For an account outside the organisation it answers 404, as for an
 *   account that does not exist (the server's /avatar/<uid>/<size> is OrgShareMiddleware's).
 *
 * Only while sharing is limited to group members (the org privacy step is on), and only for a
 * signed-in person: the server's own work (no session) and the service account are not limited.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Dav;

use OCA\NouraxApi\Service\OrgPrivacy;
use OCP\IUser;
use OCP\IUserManager;
use OCP\IUserSession;
use OCP\Server as ServerContainer;
use Sabre\DAV\Exception\Forbidden;
use Sabre\DAV\Exception\NotFound;
use Sabre\DAV\INode;
use Sabre\DAV\PropFind;
use Sabre\DAV\PropPatch;
use Sabre\DAV\Server;
use Sabre\DAV\ServerPlugin;
use Sabre\DAV\Xml\Property\Complex;
use Sabre\HTTP\RequestInterface;

class OrgPeoplePlugin extends ServerPlugin {
	public const PLUGIN_NAME = 'nourax-org-people';

	/** After every plugin that fills a principal's properties (they run at 100-150). */
	private const PROPFIND_PRIORITY = 1000;
	/** Before Photos' and the team folders' own PROPPATCH handlers (default priority 100). */
	private const PROPPATCH_PRIORITY = 50;
	/** Before the server looks up the node (default priority 100). */
	private const BEFORE_METHOD_PRIORITY = 50;
	/** The avatars collection (OCA\DAV\Avatars\RootCollection). */
	private const AVATARS = 'avatars';
	private const RESOURCETYPE = '{DAV:}resourcetype';
	private const ALBUM_COLLABORATORS = '{http://nextcloud.org/ns}collaborators';
	private const TEAM_FOLDER_RULES = '{http://nextcloud.org/ns}acl-list';
	/** A comment's mentions (OCA\DAV\Comments\CommentNode::PROPERTY_NAME_MENTION*). */
	private const COMMENT_MENTIONS = '{http://owncloud.org/ns}mentions';
	private const COMMENT_MENTION = '{http://owncloud.org/ns}mention';
	private const MENTION_TYPE = '{http://owncloud.org/ns}mentionType';
	private const MENTION_ID = '{http://owncloud.org/ns}mentionId';
	private const MENTION_DISPLAYNAME = '{http://owncloud.org/ns}mentionDisplayName';
	/** Photos' collaborator types (OCA\Photos\Album\AlbumMapper::TYPE_USER, TYPE_GROUP). */
	private const ALBUM_USER = 0;
	private const ALBUM_GROUP = 1;

	private ?Server $server = null;

	#[\Override]
	public function initialize(Server $server): void {
		$this->server = $server;
		$server->on('propFind', [$this, 'propFind'], self::PROPFIND_PRIORITY);
		$server->on('propPatch', [$this, 'propPatch'], self::PROPPATCH_PRIORITY);
		$server->on('beforeMethod:*', [$this, 'beforeMethod'], self::BEFORE_METHOD_PRIORITY);
	}

	#[\Override]
	public function getPluginName(): string {
		return self::PLUGIN_NAME;
	}

	/**
	 * An avatar of an account the person may not see: the server's own answer for an account
	 * that does not exist (AbstractPrincipalCollection::getChild).
	 *
	 * @throws NotFound
	 */
	public function beforeMethod(RequestInterface $request): void {
		// The path is url-decoded already (Sabre\HTTP\Request::getPath).
		$parts = explode('/', trim($request->getPath(), '/'));
		if ($parts[0] !== self::AVATARS || ($parts[1] ?? '') === '') {
			return;
		}
		[$privacy, $user] = $this->context();
		if ($user !== null && !$privacy->canSeeUser($user, $parts[1])
			&& ServerContainer::get(IUserManager::class)->get($parts[1]) !== null) {
			throw new NotFound('Principal with name ' . $parts[1] . ' not found');
		}
	}

	/** Hides the properties of a principal the person may not see, and their name in comments. */
	public function propFind(PropFind $propFind, INode $node): void {
		$parts = explode('/', trim($propFind->getPath(), '/'));
		if ($parts[0] === 'comments' && $propFind->getStatus(self::COMMENT_MENTIONS) === 200) {
			$this->hideMentionNames($propFind);
			return;
		}
		if (count($parts) < 3 || $parts[0] !== 'principals' || !in_array($parts[1], ['users', 'groups'], true)) {
			return;
		}
		[$privacy, $user] = $this->context();
		if ($user === null) {
			return;
		}
		// The principal backends write group ids url-encoded (and read them decoded).
		$name = urldecode($parts[2]);
		if ($parts[1] === 'users' ? $privacy->canSeeUser($user, $name) : $privacy->canSeeGroup($user, $name)) {
			return;
		}
		$names = array_merge($propFind->getRequestedProperties(), array_keys($propFind->getResultForMultiStatus()[200] ?? []));
		foreach (array_unique($names) as $property) {
			if ($property !== self::RESOURCETYPE) {
				$propFind->set($property, null, 404);
			}
		}
	}

	/**
	 * A comment's mentions carry the display name of each account named in it (CommentNode,
	 * resolveDisplayName), whoever wrote it. For an account outside the reader's organisation the
	 * name is replaced by the id, which is what the comment's author typed.
	 */
	private function hideMentionNames(PropFind $propFind): void {
		$mentions = $propFind->get(self::COMMENT_MENTIONS);
		[$privacy, $user] = $this->context();
		if (!is_array($mentions) || $user === null) {
			return;
		}
		$changed = false;
		foreach ($mentions as $i => $mention) {
			$fields = is_array($mention) ? ($mention[self::COMMENT_MENTION] ?? null) : null;
			if (!is_array($fields) || ($fields[self::MENTION_TYPE] ?? '') !== 'user') {
				continue;
			}
			$id = (string)($fields[self::MENTION_ID] ?? '');
			if (!$privacy->canSeeUser($user, $id)) {
				$mentions[$i][self::COMMENT_MENTION][self::MENTION_DISPLAYNAME] = $id;
				$changed = true;
			}
		}
		if ($changed) {
			$propFind->set(self::COMMENT_MENTIONS, $mentions, 200);
		}
	}

	/**
	 * @throws Forbidden when a new album collaborator or team folder rule is outside the person's
	 *                   organisation
	 */
	public function propPatch(string $path, PropPatch $propPatch): void {
		$mutations = $propPatch->getMutations();
		$collaborators = $mutations[self::ALBUM_COLLABORATORS] ?? null;
		$rules = $mutations[self::TEAM_FOLDER_RULES] ?? null;
		if ($collaborators === null && !is_array($rules)) {
			return;
		}
		[$privacy, $user] = $this->context();
		if ($user === null) {
			return;
		}
		$refusal = null;
		if ($collaborators !== null) {
			$refusal = $this->checkCollaborators($privacy, $user, $path, $collaborators);
		}
		if ($refusal === null && is_array($rules)) {
			$refusal = $this->checkRules($privacy, $user, $path, $rules);
		}
		if ($refusal !== null) {
			throw new Forbidden($refusal);
		}
	}

	/** Photos sends the whole list as JSON; only the collaborators it does not have yet are checked. */
	private function checkCollaborators(OrgPrivacy $privacy, IUser $user, string $path, mixed $value): ?string {
		if ($value instanceof Complex) {
			$value = $value->getXml();
		}
		$list = is_string($value) ? json_decode($value, true) : null;
		if (!is_array($list)) {
			return null;
		}
		$known = [];
		try {
			$node = $this->server?->tree->getNodeForPath($path);
			if ($node !== null && method_exists($node, 'getCollaborators')) {
				// Photos' AlbumRoot::getCollaborators: [['nc:collaborator' => [id, label, type]], ...]
				foreach ((array)$node->getCollaborators() as $existing) {
					$existing = is_array($existing) ? ($existing['nc:collaborator'] ?? $existing) : null;
					if (is_array($existing)) {
						$known[($existing['type'] ?? '') . ':' . ($existing['id'] ?? '')] = true;
					}
				}
			}
		} catch (\Throwable) {
			// Not an album; Photos gives its own answer.
			return null;
		}
		foreach ($list as $collaborator) {
			if (!is_array($collaborator) || !isset($collaborator['id']) || !is_scalar($collaborator['id'])) {
				// A public link has no id yet (Photos makes one).
				continue;
			}
			// Photos compares the type loosely (switch): a missing type counts as a person.
			$type = is_scalar($collaborator['type'] ?? null) ? (int)$collaborator['type'] : self::ALBUM_USER;
			if (isset($known[$type . ':' . $collaborator['id']])) {
				continue;
			}
			$refusal = match ($type) {
				self::ALBUM_USER => $privacy->checkReach($user, (string)$collaborator['id']),
				self::ALBUM_GROUP => $privacy->checkGroup($user, (string)$collaborator['id']),
				default => null,
			};
			if ($refusal !== null) {
				return $refusal;
			}
		}
		return null;
	}

	/**
	 * The team folders' rules (OCA\GroupFolders\ACL\Rule), each for a user, a group or a team. The
	 * lead sends the folder's whole list; only the rules it does not have yet are checked, so a rule
	 * made before (for someone who has since left) never blocks the lead's other changes.
	 */
	private function checkRules(OrgPrivacy $privacy, IUser $user, string $path, array $rules): ?string {
		$known = [];
		try {
			$existing = $this->server?->getProperties($path, [self::TEAM_FOLDER_RULES])[self::TEAM_FOLDER_RULES] ?? [];
		} catch (\Throwable) {
			$existing = [];
		}
		foreach (is_array($existing) ? $existing : [] as $rule) {
			if (is_object($rule) && method_exists($rule, 'getUserMapping')) {
				$known[$rule->getUserMapping()->getType() . ':' . $rule->getUserMapping()->getId()] = true;
			}
		}
		foreach ($rules as $rule) {
			if (!is_object($rule) || !method_exists($rule, 'getUserMapping')) {
				continue;
			}
			$mapping = $rule->getUserMapping();
			if (isset($known[$mapping->getType() . ':' . $mapping->getId()])) {
				continue;
			}
			$refusal = match ($mapping->getType()) {
				'user' => $privacy->checkReach($user, $mapping->getId()),
				'group' => $privacy->checkGroup($user, $mapping->getId()),
				default => $privacy->checkOther($user),
			};
			if ($refusal !== null) {
				return $refusal;
			}
		}
		return null;
	}

	/** @return array{0: OrgPrivacy, 1: ?IUser} the rule, and the signed-in person while it is on */
	private function context(): array {
		$privacy = ServerContainer::get(OrgPrivacy::class);
		$user = $privacy->isOn() ? ServerContainer::get(IUserSession::class)->getUser() : null;
		return [$privacy, $user];
	}
}
