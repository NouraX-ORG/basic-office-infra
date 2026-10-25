<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Listener;

use OCA\NouraxBranding\AppInfo\Application;
use OCA\NouraxBranding\Service\LanguageList;
use OCP\AppFramework\Http\Events\BeforeTemplateRenderedEvent;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\IInitialStateService;
use Psr\Log\LoggerInterface;

/**
 * Shows every language once in the language menus: Personal settings > Personal info and the
 * Accounts page of admins (see Service\LanguageList for why a language would show twice).
 *
 * The settings app hands the lists to the page as initial state while its controller runs; this
 * event comes after that and before the page is drawn. Nextcloud has no API to read an initial
 * state back, so this reads the service's own list. If that ever changes, it does nothing.
 *
 * @template-implements IEventListener<BeforeTemplateRenderedEvent>
 */
final class LanguageListListener implements IEventListener {
	/** app, initial-state key, member with the lists */
	private const STATES = [
		['settings', 'personalInfoParameters', 'languageMap'],
		['settings', 'usersSettings', 'languages'],
	];

	public function __construct(
		private IInitialStateService $initialState,
		private LoggerInterface $logger,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof BeforeTemplateRenderedEvent) || !$event->isLoggedIn()
			|| !($this->initialState instanceof \OC\InitialStateService)) {
			return;
		}
		try {
			$property = new \ReflectionProperty(\OC\InitialStateService::class, 'states');
			$states = $property->getValue($this->initialState);
			if (!is_array($states)) {
				return;
			}
			$changed = false;
			foreach (self::STATES as [$app, $key, $field]) {
				$json = $states[$app][$key] ?? null;
				if (!is_string($json)) {
					continue;
				}
				$fixed = LanguageList::fix($json, $field);
				if ($fixed !== null) {
					$states[$app][$key] = $fixed;
					$changed = true;
				}
			}
			if ($changed) {
				$property->setValue($this->initialState, $states);
			}
		} catch (\Throwable $e) {
			$this->logger->debug('Language list left as it is', ['app' => Application::APP_ID, 'exception' => $e]);
		}
	}
}
