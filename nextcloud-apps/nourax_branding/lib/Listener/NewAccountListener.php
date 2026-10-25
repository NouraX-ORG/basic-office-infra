<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Listener;

use OCA\NouraxBranding\AppInfo\Application;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\IConfig;
use OCP\User\Events\UserCreatedEvent;
use OCP\User\Events\UserFirstTimeLoggedInEvent;
use Psr\Log\LoggerInterface;

/**
 * No upstream welcome board in NoBoard (Deck) for new accounts.
 *
 * On a person's first visit Deck 1.19 makes a "welcome" board. Its title is a translation (the text
 * sweep renames it), but its cards come from a fixed file inside the app and name the upstream
 * many times. Deck makes the board only while the person's Deck setting firstRun is "yes" (unset
 * counts as yes), so this sets it to "no" as soon as an account exists: when it is made (occ, the
 * admin pages and the user API, and "Log in with Nourax", whose user_oidc sends UserCreatedEvent
 * too) and on the first login of an account made before this app could see it. A value that is
 * already there is never changed. Boards that already exist are people's data and stay.
 *
 * @template-implements IEventListener<UserCreatedEvent|UserFirstTimeLoggedInEvent>
 */
final class NewAccountListener implements IEventListener {
	public function __construct(
		private IConfig $config,
		private LoggerInterface $logger,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof UserCreatedEvent) && !($event instanceof UserFirstTimeLoggedInEvent)) {
			return;
		}
		$uid = $event->getUser()->getUID();
		try {
			if ($this->config->getUserValue($uid, 'deck', 'firstRun', '') === '') {
				$this->config->setUserValue($uid, 'deck', 'firstRun', 'no');
			}
		} catch (\Throwable $e) {
			// Never stop an account from being made or signing in.
			$this->logger->warning('Could not switch off the NoBoard welcome board for {uid}', [
				'app' => Application::APP_ID,
				'uid' => $uid,
				'exception' => $e,
			]);
		}
	}
}
