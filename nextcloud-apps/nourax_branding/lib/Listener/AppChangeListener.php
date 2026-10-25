<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Listener;

use OCA\NouraxBranding\AppInfo\Application;
use OCA\NouraxBranding\Service\SweepRunner;
use OCP\App\Events\AppEnableEvent;
use OCP\App\Events\AppUpdateEvent;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use Psr\Log\LoggerInterface;

/**
 * When an app is switched on or updated (occ app:enable, app:install, app:update, occ upgrade or the
 * Apps page), its translations are swept right away, so its texts never show the upstream name.
 * A failure is only logged: switching an app on must never fail because of the sweep, and the
 * RefreshSweep background job tries again within 15 minutes.
 *
 * @template-implements IEventListener<AppEnableEvent|AppUpdateEvent>
 */
final class AppChangeListener implements IEventListener {
	public function __construct(
		private SweepRunner $runner,
		private LoggerInterface $logger,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof AppEnableEvent) && !($event instanceof AppUpdateEvent)) {
			return;
		}
		$app = $event->getAppId();
		try {
			if ($this->runner->theme() === '') {
				return;
			}
			$this->runner->run([$app]);
		} catch (\Throwable $e) {
			$this->logger->warning('Branding sweep of {swept} failed; the background job tries again', [
				'app' => Application::APP_ID,
				'swept' => $app,
				'exception' => $e,
			]);
		}
	}
}
