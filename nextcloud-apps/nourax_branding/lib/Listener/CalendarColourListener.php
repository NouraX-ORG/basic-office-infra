<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Listener;

use OCA\DAV\Events\CalendarCreatedEvent;
use OCA\NouraxBranding\AppInfo\Application;
use OCA\NouraxBranding\Service\CalendarColours;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use Psr\Log\LoggerInterface;

/**
 * A new calendar or task list in the upstream blue gets the site's colour at once (see
 * Service\CalendarColours). The dav app sends the event right after it stores the calendar and before
 * it answers, and NoTasks reads the new list back from the server, so the list shows the site's
 * colour from the first moment.
 *
 * @template-implements IEventListener<CalendarCreatedEvent>
 */
final class CalendarColourListener implements IEventListener {
	public function __construct(
		private CalendarColours $colours,
		private LoggerInterface $logger,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof CalendarCreatedEvent)) {
			return;
		}
		try {
			$this->colours->recolour($event->getCalendarId(), $event->getCalendarData());
		} catch (\Throwable $e) {
			// Never stop a calendar from being made.
			$this->logger->warning('Could not give calendar {id} the site colour', [
				'app' => Application::APP_ID,
				'id' => $event->getCalendarId(),
				'exception' => $e,
			]);
		}
	}
}
