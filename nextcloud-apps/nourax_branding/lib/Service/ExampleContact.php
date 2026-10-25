<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Service;

use OCA\DAV\CardDAV\CardDavBackend;
use OCP\App\IAppManager;
use OCP\Files\AppData\IAppDataFactory;
use OCP\Files\NotFoundException;
use OCP\IAppConfig;
use OCP\IDBConnection;
use Psr\Container\ContainerInterface;
use Sabre\VObject\Component\VCard;
use Sabre\VObject\Reader;

/**
 * The example contact every new account finds in NoContacts.
 *
 * The dav app copies one card into each new address book: the file defaultContact/defaultContact.vcf
 * in its app data, or, while that is missing, its own exampleContact.vcf ("Leon Green", whose website
 * is the upstream's). NoContacts opens it on a person's first visit. install() writes the Nourax copy
 * there: the same card with the website on example.com, the reserved example address its e-mail
 * already uses (UpstreamAssets::exampleCard). The setting hasCustomDefaultContact only tells the
 * Groupware admin page that a card of our own is in place; the dav app reads the file.
 *
 * findExisting() and fixExisting() are for cards made from the upstream card before that, which are
 * people's data: occ nourax_branding:example-contact --existing lists them, and changes them only
 * with --apply.
 */
final class ExampleContact {
	/** The example contact's website. */
	public const URL = 'https://example.com';

	private const FOLDER = 'defaultContact';
	private const FILE = 'defaultContact.vcf';

	private ?CardDavBackend $backend = null;

	public function __construct(
		private IAppDataFactory $appDataFactory,
		private IAppConfig $appConfig,
		private IAppManager $appManager,
		private IDBConnection $db,
		private ContainerInterface $container,
	) {
	}

	/** The dav app's own example card, as installed. */
	public function upstream(): string {
		$path = $this->appManager->getAppPath('dav') . '/lib/ExampleContentFiles/exampleContact.vcf';
		$card = is_file($path) ? file_get_contents($path) : false;
		if (!is_string($card) || $card === '') {
			throw new \RuntimeException('the dav app has no example contact at ' . $path);
		}
		return $card;
	}

	/**
	 * The Nourax example card, checked to be a card the dav app can read.
	 *
	 * @return array{card: string, changed: list<string>}
	 */
	public function build(): array {
		$made = UpstreamAssets::exampleCard($this->upstream(), self::URL);
		$card = Reader::read($made['card'], Reader::OPTION_FORGIVING);
		if (!($card instanceof VCard) || !isset($card->FN)) {
			throw new \RuntimeException('the Nourax example contact is not a card with a name');
		}
		return $made;
	}

	/**
	 * What new accounts get now.
	 *
	 * @return array{enabled: bool, custom: bool, card: string, ours: bool, names_upstream: bool}
	 */
	public function current(): array {
		$file = $this->file();
		$card = $file ?? $this->upstream();
		return [
			'enabled' => $this->appConfig->getValueBool('dav', 'enableDefaultContact', true),
			'custom' => $this->appConfig->getValueBool('dav', 'hasCustomDefaultContact', false),
			'card' => $card,
			'ours' => $file !== null && $file === $this->build()['card'],
			'names_upstream' => UpstreamAssets::exampleCard($card, self::URL)['changed'] !== [],
		];
	}

	/**
	 * Puts the Nourax example card in place. A card an admin chose (the Groupware admin page) that does
	 * not name the upstream is kept.
	 *
	 * @return string "written", "unchanged" or "kept"
	 */
	public function install(): string {
		$card = $this->build()['card'];
		$have = $this->file();
		$custom = $this->appConfig->getValueBool('dav', 'hasCustomDefaultContact', false);
		if ($have === $card && $custom) {
			return 'unchanged';
		}
		if ($have !== null && $have !== $card && $custom && UpstreamAssets::exampleCard($have, self::URL)['changed'] === []) {
			return 'kept';
		}
		if ($have !== $card) {
			$appData = $this->appDataFactory->get('dav');
			try {
				$folder = $appData->getFolder(self::FOLDER);
			} catch (NotFoundException) {
				$folder = $appData->newFolder(self::FOLDER);
			}
			if ($folder->fileExists(self::FILE)) {
				$folder->getFile(self::FILE)->putContent($card);
			} else {
				$folder->newFile(self::FILE, $card);
			}
		}
		$this->appConfig->setValueBool('dav', 'hasCustomDefaultContact', true);
		return 'written';
	}

	/**
	 * Cards in people's address books that were made from the upstream example card: the same name
	 * (FN) as that card, and the upstream in them.
	 *
	 * @param ?list<string> $uids only these accounts; null for everyone
	 * @return list<array{uid: string, addressbook: int, book: string, uri: string, card: string, changed: list<string>}>
	 */
	public function findExisting(?array $uids): array {
		$name = self::fn($this->upstream());
		if ($name === '') {
			return [];
		}
		$qb = $this->db->getQueryBuilder();
		$qb->select('id', 'principaluri', 'uri')
			->from('addressbooks')
			->where($qb->expr()->like('principaluri', $qb->createNamedParameter('principals/users/%')))
			->orderBy('id');
		$books = [];
		$result = $qb->executeQuery();
		while ($row = $result->fetch()) {
			$uid = substr((string)$row['principaluri'], strlen('principals/users/'));
			if ($uids === null || in_array($uid, $uids, true)) {
				$books[] = [(int)$row['id'], $uid, (string)$row['uri']];
			}
		}
		$result->closeCursor();

		$found = [];
		foreach ($books as [$id, $uid, $book]) {
			foreach ($this->backend()->getCards($id) as $row) {
				$data = $row['carddata'] ?? '';
				if (is_resource($data)) {
					$data = (string)stream_get_contents($data);
				}
				if (!is_string($data) || self::fn($data) !== $name) {
					continue;
				}
				$fixed = UpstreamAssets::exampleCard($data, self::URL);
				if ($fixed['changed'] === []) {
					continue;
				}
				$found[] = ['uid' => $uid, 'addressbook' => $id, 'book' => $book, 'uri' => (string)$row['uri'],
					'card' => $fixed['card'], 'changed' => $fixed['changed']];
			}
		}
		return $found;
	}

	/** @param array{addressbook: int, uri: string, card: string} $item one result of findExisting() */
	public function fixExisting(array $item): void {
		$this->backend()->updateCard($item['addressbook'], $item['uri'], $item['card']);
	}

	/** The card in the dav app's data, or null while there is none. */
	private function file(): ?string {
		try {
			$folder = $this->appDataFactory->get('dav')->getFolder(self::FOLDER);
			return $folder->fileExists(self::FILE) ? $folder->getFile(self::FILE)->getContent() : null;
		} catch (NotFoundException) {
			return null;
		}
	}

	/** The FN (full name) of a card's text, or "". */
	private static function fn(string $vcf): string {
		$text = (string)preg_replace('/\r?\n[ \t]/', '', $vcf);
		return preg_match('/^FN(?:;[^:\r\n]*)?:(.*?)\r?$/mi', $text, $m) === 1 ? trim($m[1]) : '';
	}

	private function backend(): CardDavBackend {
		if ($this->backend === null) {
			$this->appManager->loadApp('dav');
			$this->backend = $this->container->get(CardDavBackend::class);
		}
		return $this->backend;
	}
}
