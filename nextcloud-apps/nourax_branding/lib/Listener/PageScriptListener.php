<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Listener;

use OCA\NouraxBranding\AppInfo\Application;
use OCA\NouraxBranding\Service\NomailLink;
use OCP\AppFramework\Http\Events\BeforeTemplateRenderedEvent;
use OCP\AppFramework\Services\IInitialState;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Util;

/**
 * On every page of a signed-in person: the NoMail address and js/nomail-link.js, so the NoMail
 * entry of the app menu opens in a new tab. The login page fires a different event
 * (BeforeLoginTemplateRenderedEvent), so it gets neither.
 *
 * @template-implements IEventListener<BeforeTemplateRenderedEvent>
 */
final class PageScriptListener implements IEventListener {
	public function __construct(
		private IInitialState $initialState,
		private NomailLink $nomailLink,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof BeforeTemplateRenderedEvent) || !$event->isLoggedIn()) {
			return;
		}

		$this->initialState->provideInitialState('nomail_url', $this->nomailLink->url());
		Util::addScript(Application::APP_ID, 'nomail-link');
	}
}
