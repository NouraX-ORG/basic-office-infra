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
use OCP\User\Events\PostLoginEvent;
use OCP\User\Events\UserCreatedEvent;
use OCP\User\Events\UserFirstTimeLoggedInEvent;
use Psr\Log\LoggerInterface;

/**
 * No upstream welcome board in NoBoard (Deck) for new accounts.
 *
 * On a person's first visit Deck 1.19 makes a "welcome" board. Its title is a translation (the text
 * sweep renames it), but its cards come from a fixed file inside the app and name the upstream
 * many times. Deck makes the board only while the person's Deck setting firstRun is "yes" (unset
 * counts as yes), in a middleware of its own that runs before this app's middleware could (apps are
 * set up in name order). So this sets it to "no" before a person can reach NoBoard at all:
 * - when an account is made through occ, the admin pages, the user API, or a first "Log in with
 *   Nourax" (user_oidc's login page sends UserCreatedEvent);
 * - on every sign-in (PostLoginEvent): the login form, "Log in with Nourax" and app passwords alike.
 *   This covers accounts made without UserCreatedEvent, such as those the nourax_api app makes
 *   (user_oidc's UserMapper::getOrCreate sends none) and whose first sign-in is an app password
 *   (which sends no UserFirstTimeLoggedInEvent either). Every request of a signed-in person comes
 *   after a sign-in, so Deck never sees an unset value. The cost is one read of a setting Nextcloud
 *   has already loaded for the person;
 * - on the first login of an account made before this app could see it (UserFirstTimeLoggedInEvent).
 * A value that is already there is never changed. Boards that already exist are people's data and stay.
 *
 * @template-implements IEventListener<UserCreatedEvent|UserFirstTimeLoggedInEvent|PostLoginEvent>
 */
final class NewAccountListener implements IEventListener {
	public function __construct(
		private IConfig $config,
		private LoggerInterface $logger,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof UserCreatedEvent) && !($event instanceof UserFirstTimeLoggedInEvent)
			&& !($event instanceof PostLoginEvent)) {
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
