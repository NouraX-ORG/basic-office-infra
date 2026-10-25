<?php

declare(strict_types=1);

/**
 * The shared address books: one directory per organisation ("org-{org_id}", "Directory: <name>")
 * and one per team ("team-{team_id}", "Team: <name>"). Both belong to the service account and
 * are shared read-only with the organisation's or the team's group, so members see them in
 * NoContacts and cannot change them.
 *
 * Cards are rebuilt from the group's enabled members: one vCard 4.0 each (FN, EMAIL, ORG,
 * UID nourax-<uid>, file <uid>.vcf), compared with what is there and written only when it
 * differs. Deleting only ever touches cards this API made (UID nourax-...) in these books.
 *
 * Uses the dav app's own backend (CardDavBackend), the same calls its CardDAV server makes.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OCA\DAV\CardDAV\AddressBook;
use OCA\DAV\CardDAV\CardDavBackend;
use OCP\App\IAppManager;
use OCP\IUser;
use OCP\IUserSession;
use OCP\L10N\IFactory;
use Psr\Container\ContainerInterface;
use Sabre\DAV\PropPatch;
use Sabre\VObject\Component\VCard;

class AddressBookService {
	private const DISPLAY_NAME = '{DAV:}displayname';
	private const PRODID = '-//Nourax//Nourax Workspace//EN';
	private const UID_PREFIX = 'nourax-';

	private ?CardDavBackend $backend = null;

	public function __construct(
		private ContainerInterface $container,
		private IAppManager $appManager,
		private IFactory $l10nFactory,
		private IUserSession $userSession,
		private ServiceAccountService $account,
	) {
	}

	/**
	 * Makes sure the service account's address book $uri exists with this display name.
	 *
	 * @return array{0: int, 1: string, 2: string} [address book id, result, detail]
	 */
	public function ensureBook(string $uri, string $displayName): array {
		$principal = ServiceAccountService::principal();
		$this->account->user();
		$book = $this->backend()->getAddressBooksByUri($principal, $uri);
		if ($book === null) {
			$id = (int)$this->backend()->createAddressBook($principal, $uri, [self::DISPLAY_NAME => $displayName]);
			return [$id, Steps::CREATED, 'address book ' . $id];
		}
		$id = (int)$book['id'];
		if ((string)($book[self::DISPLAY_NAME] ?? '') !== $displayName) {
			$patch = new PropPatch([self::DISPLAY_NAME => $displayName]);
			$this->backend()->updateAddressBook($id, $patch);
			$patch->commit();
			return [$id, Steps::UPDATED, 'address book ' . $id . ' renamed'];
		}
		return [$id, Steps::UNCHANGED, 'address book ' . $id];
	}

	/**
	 * Makes sure the address book is shared read-only with the group.
	 *
	 * @return array{0: string, 1: string} [result, detail]
	 */
	public function ensureReadOnlyShare(int $bookId, string $groupId): array {
		$href = self::groupHref($groupId);
		$current = $this->share($bookId, $href);
		if ($current !== null && $current['readOnly'] === true) {
			return [Steps::UNCHANGED, 'read-only for ' . $groupId];
		}

		$book = $this->bookById($bookId);
		$shareable = new AddressBook($this->backend(), $book, $this->l10nFactory->get('dav'));
		$this->asServiceAccount(fn () => $shareable->updateShares([['href' => $href, 'commonName' => '', 'readOnly' => true]], []));

		$after = $this->share($bookId, $href);
		if ($after === null || $after['readOnly'] !== true) {
			throw new StepFailed('the address book could not be shared with ' . $groupId);
		}
		return [$current === null ? Steps::CREATED : Steps::UPDATED, 'read-only for ' . $groupId];
	}

	/**
	 * Rebuilds the cards: one per member, nothing else.
	 *
	 * @param array<string, IUser> $members by uid
	 * @return array{0: string, 1: string} [result, detail]
	 */
	public function syncCards(int $bookId, array $members, string $orgName): array {
		$wanted = [];
		foreach ($members as $user) {
			$wanted[$user->getUID() . '.vcf'] = self::vcard($user, $orgName);
		}

		$added = $changed = $removed = 0;
		$existing = [];
		foreach ($this->backend()->getCards($bookId) as $card) {
			$existing[(string)$card['uri']] = $card;
		}
		foreach ($wanted as $uri => $data) {
			if (!isset($existing[$uri])) {
				$this->backend()->createCard($bookId, $uri, $data);
				$added++;
			} elseif ((string)$existing[$uri]['carddata'] !== $data) {
				$this->backend()->updateCard($bookId, $uri, $data);
				$changed++;
			}
		}
		foreach ($existing as $uri => $card) {
			if (!isset($wanted[$uri]) && str_starts_with((string)($card['uid'] ?? ''), self::UID_PREFIX)) {
				$this->backend()->deleteCard($bookId, $uri);
				$removed++;
			}
		}

		$detail = count($wanted) . ' card(s)';
		if ($added + $changed + $removed === 0) {
			return [Steps::UNCHANGED, $detail];
		}
		return [Steps::UPDATED, $detail . sprintf(' (+%d ~%d -%d)', $added, $changed, $removed)];
	}

	/**
	 * What a status call shows about an address book.
	 *
	 * @return array{id: ?int, exists: bool, display_name?: string, cards?: int, shared_read_only?: bool}
	 */
	public function describe(?int $bookId, string $groupId): array {
		$book = $bookId === null ? null : $this->backend()->getAddressBookById($bookId);
		if ($book === null) {
			return ['id' => $bookId, 'exists' => false];
		}
		$share = $this->share($bookId, self::groupHref($groupId));
		return [
			'id' => $bookId,
			'exists' => true,
			'display_name' => (string)($book[self::DISPLAY_NAME] ?? ''),
			'cards' => count($this->backend()->getCards($bookId)),
			'shared_read_only' => $share !== null && $share['readOnly'] === true,
		];
	}

	/** The DAV principal of a group, as the sharing backend stores it. */
	public static function groupHref(string $groupId): string {
		return 'principal:principals/groups/' . urlencode($groupId);
	}

	/** One person's card. Built the same way every time, so an unchanged person is not rewritten. */
	public static function vcard(IUser $user, string $orgName): string {
		$card = new VCard([], false);
		$card->add('VERSION', '4.0');
		$card->add('PRODID', self::PRODID);
		$card->add('UID', self::UID_PREFIX . $user->getUID());
		$card->add('KIND', 'individual');
		$name = trim($user->getDisplayName());
		$card->add('FN', $name === '' ? $user->getUID() : $name);
		$email = (string)$user->getSystemEMailAddress();
		if ($email !== '') {
			$card->add('EMAIL', $email, ['TYPE' => 'work']);
		}
		if ($orgName !== '') {
			$card->add('ORG', [$orgName]);
		}
		return $card->serialize();
	}

	/** @return ?array{href: string, readOnly: bool} the address book's share with $href */
	private function share(int $bookId, string $href): ?array {
		foreach ($this->backend()->getShares($bookId) as $share) {
			if (($share['href'] ?? null) === $href) {
				return ['href' => $href, 'readOnly' => (bool)($share['readOnly'] ?? false)];
			}
		}
		return null;
	}

	private function bookById(int $bookId): array {
		$book = $this->backend()->getAddressBookById($bookId);
		if ($book === null) {
			throw new StepFailed('address book ' . $bookId . ' is missing');
		}
		return $book;
	}

	/**
	 * The dav sharing backend only accepts a principal when someone is signed in (when sharing is
	 * limited to group members), so the share is made as the service account, its owner.
	 *
	 * @template T
	 * @param callable(): T $work
	 * @return T
	 */
	private function asServiceAccount(callable $work): mixed {
		$previous = $this->userSession->getUser();
		$this->userSession->setVolatileActiveUser($this->account->user());
		try {
			return $work();
		} finally {
			$this->userSession->setVolatileActiveUser($previous);
		}
	}

	private function backend(): CardDavBackend {
		if ($this->backend === null) {
			$this->appManager->loadApp('dav');
			$this->backend = $this->container->get(CardDavBackend::class);
		}
		return $this->backend;
	}
}
