<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Listener;

use OCA\DAV\Events\SabrePluginAddEvent;
use OCA\NouraxBranding\Dav\BrandedGetPlugin;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\IURLGenerator;
use OCP\L10N\IFactory;

/**
 * Adds Dav\BrandedGetPlugin to every WebDAV server the dav app builds (/remote.php/dav and the old
 * /remote.php/webdav both send SabrePluginAddEvent).
 *
 * @template-implements IEventListener<SabrePluginAddEvent>
 */
final class SabrePluginListener implements IEventListener {
	public function __construct(
		private IFactory $l10nFactory,
		private IURLGenerator $urlGenerator,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof SabrePluginAddEvent)) {
			return;
		}
		$event->getServer()->addPlugin(new BrandedGetPlugin($this->l10nFactory, $this->urlGenerator));
	}
}
