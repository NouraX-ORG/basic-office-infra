<?php

declare(strict_types=1);

/**
 * Privacy between organisations for calendars and address books (docs/teams.md).
 *
 * NoCalendar and NoContacts share a calendar or an address book with a DAV POST of an
 * <oc:share> document to /remote.php/dav. The server's sharing backend accepts any account named
 * as principal:principals/users/<uid>, and any group named as principal:principals/groups/<gid>,
 * even when sharing is limited to group members. This plugin reads the document first and answers
 * 403 when one of the new sharees is outside the person's organisation (OrgPrivacy), so nothing is
 * shared. A new sharee the server would not share with anyway (an id that does not exist, a
 * mailto: address, an address written another way) gets the same 403, so the answer never tells
 * whether an account exists. Removing a share (<oc:remove>) is always allowed.
 *
 * - Only while sharing is limited to group members (the org privacy step is on); otherwise it does
 *   nothing.
 * - Runs on method:POST at priority 90, before the server's sharing plugin (100). It reads the
 *   body and puts it back, so the sharing plugin reads the same bytes.
 * - Calendars and address books that the admin API shares (as the service account, in PHP, not
 *   over HTTP) are not affected.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Dav;

use OCA\DAV\DAV\Sharing\IShareable;
use OCA\DAV\DAV\Sharing\Xml\ShareRequest;
use OCA\NouraxApi\Service\OrgPrivacy;
use OCP\IUserSession;
use OCP\Server as ServerContainer;
use Sabre\DAV\Exception\Forbidden;
use Sabre\DAV\Server;
use Sabre\DAV\ServerPlugin;
use Sabre\HTTP\RequestInterface;
use Sabre\HTTP\ResponseInterface;

class OrgSharePlugin extends ServerPlugin {
	public const PLUGIN_NAME = 'nourax-org-share';

	/** Before the server's sharing plugin (OCA\DAV\DAV\Sharing\Plugin, default priority 100). */
	private const PRIORITY = 90;
	private const SHARE_DOCUMENT = '{http://owncloud.org/ns}share';

	private ?Server $server = null;

	#[\Override]
	public function initialize(Server $server): void {
		$this->server = $server;
		$server->on('method:POST', [$this, 'httpPost'], self::PRIORITY);
	}

	#[\Override]
	public function getPluginName(): string {
		return self::PLUGIN_NAME;
	}

	/**
	 * @throws Forbidden when a new sharee is outside the person's organisation
	 */
	public function httpPost(RequestInterface $request, ResponseInterface $response): void {
		if ($this->server === null) {
			return;
		}
		$contentType = (string)$request->getHeader('Content-Type');
		if (!str_contains($contentType, 'application/xml') && !str_contains($contentType, 'text/xml')) {
			return;
		}
		$privacy = ServerContainer::get(OrgPrivacy::class);
		if (!$privacy->isOn()) {
			return;
		}
		$user = ServerContainer::get(IUserSession::class)->getUser();
		if ($user === null) {
			return;
		}

		// A body can be read once; put it back for the sharing plugin.
		$body = $request->getBodyAsString();
		$request->setBody($body);
		if (!str_contains($body, 'share')) {
			return;
		}
		try {
			$message = $this->server->xml->parse($body, $request->getUrl(), $documentType);
		} catch (\Throwable) {
			// Not a document we can read: the sharing plugin gives its own answer.
			return;
		}
		if ($documentType !== self::SHARE_DOCUMENT || !($message instanceof ShareRequest)) {
			return;
		}
		try {
			$node = $this->server->tree->getNodeForPath($request->getPath());
		} catch (\Exception) {
			return;
		}
		if (!($node instanceof IShareable)) {
			return;
		}

		foreach ($message->set as $sharee) {
			$refusal = $privacy->checkDavHref($user, (string)($sharee['href'] ?? ''));
			if ($refusal !== null) {
				throw new Forbidden($refusal);
			}
		}
	}
}
