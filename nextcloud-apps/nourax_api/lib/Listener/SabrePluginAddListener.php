<?php

declare(strict_types=1);

/**
 * Adds ReadOnlyBooksPlugin to the server's DAV endpoint (/remote.php/dav), so a member's write to
 * a directory or a team address book gets 403, not the server's 404.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Listener;

use OCA\DAV\Events\SabrePluginAddEvent;
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
	}
}
