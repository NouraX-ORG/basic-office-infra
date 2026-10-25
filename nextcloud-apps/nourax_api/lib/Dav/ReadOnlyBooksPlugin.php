<?php

declare(strict_types=1);

/**
 * Answers 403 to a member who tries to change one of the shared address books of the service
 * account (the organisation directories and the team address books, docs/teams.md).
 *
 * The server's own permission check (DavAclPlugin in the dav app) refuses those writes too, but
 * with 404 "Addressbook with name '...' could not be found": it gives 403 only to a book's owner.
 * A member can read the book, so 404 is wrong for them and sync clients read it as "the book is
 * gone". This plugin refuses first, with 403, and the book stays as it was.
 *
 * - It looks only at books the service account owns, and only at someone who may read the book
 *   (a member of the group it is shared with). Anyone else still gets the server's own 404, so it
 *   shows no book one cannot see.
 * - Allowed: reading (GET, HEAD, OPTIONS, PROPFIND, REPORT) and a COPY out of the book.
 * - Refused with 403: every other method on the book or on a card in it (PUT, DELETE, PROPPATCH,
 *   MOVE, MKCOL, POST, ACL, LOCK and the rest), and a COPY or MOVE into the book. The server
 *   refuses all of these already (with 404), so no member loses anything they could do before,
 *   not even a view setting of their own: a PROPPATCH of a read-only shared book needs the
 *   write-properties right, which a member does not have.
 * - Runs on beforeMethod:* at priority 15: after the sign-in (Sabre's auth plugin, 10), before
 *   the permission check (20).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Dav;

use OCA\DAV\CardDAV\AddressBook;
use OCA\NouraxApi\Service\ServiceAccountService;
use Sabre\DAV\Auth\Plugin as AuthPlugin;
use Sabre\DAV\Exception\Forbidden;
use Sabre\DAV\Server;
use Sabre\DAV\ServerPlugin;
use Sabre\DAVACL\Plugin as AclPlugin;
use Sabre\HTTP\RequestInterface;
use Sabre\HTTP\ResponseInterface;

class ReadOnlyBooksPlugin extends ServerPlugin {
	public const PLUGIN_NAME = 'nourax-read-only-books';
	public const MESSAGE = 'This address book is read-only. Your organisation keeps it up to date.';

	/** After the auth plugin (10), before the ACL plugin (20). */
	private const PRIORITY = 15;
	/** COPY only reads its source; a COPY into a book is checked by its Destination below. */
	private const READ_METHODS = ['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'REPORT', 'COPY'];

	private ?Server $server = null;

	#[\Override]
	public function initialize(Server $server): void {
		$this->server = $server;
		$server->on('beforeMethod:*', [$this, 'beforeMethod'], self::PRIORITY);
	}

	#[\Override]
	public function getPluginName(): string {
		return self::PLUGIN_NAME;
	}

	/**
	 * @throws Forbidden for a write to a book of the service account by someone who can read it
	 */
	public function beforeMethod(RequestInterface $request, ResponseInterface $response): void {
		$method = strtoupper($request->getMethod());
		$path = $request->getPath();

		$book = self::bookPath($path);
		if ($book !== null && !in_array($method, self::READ_METHODS, true) && $this->isTeamsBook($book)) {
			throw new Forbidden(self::MESSAGE);
		}

		if ($method === 'COPY' || $method === 'MOVE') {
			$destination = $this->destinationPath($request);
			$book = $destination === null ? null : self::bookPath($destination);
			if ($book !== null && $this->isTeamsBook($book)) {
				throw new Forbidden(self::MESSAGE);
			}
		}
	}

	/**
	 * "addressbooks/users/<uid>/<book>" for a path at or below an address book, else null.
	 */
	public static function bookPath(string $path): ?string {
		$parts = explode('/', trim($path, '/'));
		if (count($parts) < 4 || $parts[0] !== 'addressbooks' || $parts[1] !== 'users'
			|| $parts[2] === '' || $parts[3] === '') {
			return null;
		}
		return implode('/', array_slice($parts, 0, 4));
	}

	/**
	 * True when the book belongs to the service account and the signed-in person, who is not the
	 * service account, may read it.
	 */
	private function isTeamsBook(string $bookPath): bool {
		if ($this->server === null) {
			return false;
		}
		$owner = ServiceAccountService::principal();
		$auth = $this->server->getPlugin('auth');
		$current = $auth instanceof AuthPlugin ? $auth->getCurrentPrincipal() : null;
		if ($current === null || $current === $owner) {
			return false;
		}

		try {
			$node = $this->server->tree->getNodeForPath($bookPath);
		} catch (\Exception) {
			// Not there (or not reachable): the server's own answer follows.
			return false;
		}
		if (!($node instanceof AddressBook) || $node->getOwner() !== $owner) {
			return false;
		}

		// Only someone who can read the book learns that it is there.
		$acl = $this->server->getPlugin('acl');
		return $acl instanceof AclPlugin
			&& $acl->checkPrivileges($bookPath, '{DAV:}read', AclPlugin::R_PARENT, false) === true;
	}

	private function destinationPath(RequestInterface $request): ?string {
		$destination = $request->getHeader('Destination');
		if ($destination === null || $destination === '' || $this->server === null) {
			return null;
		}
		try {
			return $this->server->calculateUri($destination);
		} catch (\Sabre\DAV\Exception) {
			// Outside this server: Sabre's COPY and MOVE refuse it on their own.
			return null;
		}
	}
}
