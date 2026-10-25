<?php

declare(strict_types=1);

/**
 * Adds three plugins to the server's DAV endpoint (/remote.php/dav):
 * - ReadOnlyBooksPlugin, so a member's write to a directory or a team address book gets 403, not
 *   the server's 404;
 * - OrgSharePlugin, so a calendar or an address book is shared only within the person's
 *   organisation (while sharing is limited to group members, docs/teams.md);
 * - OrgPeoplePlugin, so a person's name, email address and groups show only within their
 *   organisation, and Photos albums and team folder rules are shared only within it (same rule).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Listener;

use OCA\DAV\Events\SabrePluginAddEvent;
use OCA\NouraxApi\Dav\OrgPeoplePlugin;
use OCA\NouraxApi\Dav\OrgSharePlugin;
use OCA\NouraxApi\Dav\ReadOnlyBooksPlugin;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;

/** @template-implements IEventListener<SabrePluginAddEvent> */
class SabrePluginAddListener implements IEventListener {
	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof SabrePluginAddEvent)) {
			return;
		}
		$server = $event->getServer();
		if ($server->getPlugin(ReadOnlyBooksPlugin::PLUGIN_NAME) === null) {
			$server->addPlugin(new ReadOnlyBooksPlugin());
		}
		if ($server->getPlugin(OrgSharePlugin::PLUGIN_NAME) === null) {
			$server->addPlugin(new OrgSharePlugin());
		}
		if ($server->getPlugin(OrgPeoplePlugin::PLUGIN_NAME) === null) {
			$server->addPlugin(new OrgPeoplePlugin());
		}
	}
}
