<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Listener;

use OCA\NouraxBranding\AppInfo\Application;
use OCA\NouraxBranding\Service\NomailLink;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\INavigationManager;
use OCP\IURLGenerator;
use OCP\IUserSession;
use OCP\Navigation\Events\LoadAdditionalEntriesEvent;

/**
 * Adds NoMail to the app menu of every signed-in person, right after NoBoard.
 *
 * The app menu sorts by order. Nextcloud 35 gives Deck (NoBoard) -92 and Teams -89 (its
 * NavigationManager::DEFAULT_APP_ORDER), so -91 puts NoMail directly after NoBoard. A person who
 * sorted the menu themselves keeps their order, and NoMail then sits at -91 among it.
 *
 * The entry has no target field, so pages also get js/nomail-link.js, which opens it in a new tab.
 *
 * @template-implements IEventListener<LoadAdditionalEntriesEvent>
 */
final class NavigationListener implements IEventListener {
	public const ENTRY_ID = 'nourax_nomail';
	public const ORDER = -91;

	public function __construct(
		private INavigationManager $navigationManager,
		private IURLGenerator $urlGenerator,
		private IUserSession $userSession,
		private NomailLink $nomailLink,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof LoadAdditionalEntriesEvent) || !$this->userSession->isLoggedIn()) {
			return;
		}

		$this->navigationManager->add([
			'id' => self::ENTRY_ID,
			'app' => Application::APP_ID,
			'type' => INavigationManager::TYPE_APPS,
			'order' => self::ORDER,
			'href' => $this->nomailLink->url(),
			// A product name: the same in every language.
			'name' => 'NoMail',
			'icon' => $this->urlGenerator->imagePath(Application::APP_ID, 'nomail.svg'),
		]);
	}
}
