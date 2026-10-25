<?php

declare(strict_types=1);

/**
 * The team calendar: "team-{team_id}", named "Team: <name>", Nourax cobalt, owned by the service
 * account and shared with the team's group so members can read and add events (NoCalendar).
 *
 * Uses the dav app's own backend (CalDavBackend), the same calls its CalDAV server makes.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OCA\DAV\CalDAV\CalDavBackend;
use OCA\DAV\CalDAV\Calendar;
use OCP\App\IAppManager;
use OCP\IConfig;
use OCP\IUserSession;
use OCP\L10N\IFactory;
use Psr\Container\ContainerInterface;
use Psr\Log\LoggerInterface;
use Sabre\DAV\PropPatch;

class TeamCalendarService {
	public const COLOR = '#2563EB';

	private const DISPLAY_NAME = '{DAV:}displayname';
	private const CALENDAR_COLOR = '{http://apple.com/ns/ical/}calendar-color';

	private ?CalDavBackend $backend = null;

	public function __construct(
		private ContainerInterface $container,
		private IAppManager $appManager,
		private IFactory $l10nFactory,
		private IConfig $config,
		private LoggerInterface $logger,
		private IUserSession $userSession,
		private ServiceAccountService $account,
	) {
	}

	/**
	 * Makes sure the service account's calendar $uri exists with this name and colour.
	 *
	 * @return array{0: int, 1: string, 2: string} [calendar id, result, detail]
	 */
	public function ensureCalendar(string $uri, string $displayName): array {
		$principal = ServiceAccountService::principal();
		$this->account->user();
		$calendar = $this->backend()->getCalendarByUri($principal, $uri);
		if ($calendar === null) {
			$id = (int)$this->backend()->createCalendar($principal, $uri, [
				self::DISPLAY_NAME => $displayName,
				self::CALENDAR_COLOR => self::COLOR,
			]);
			return [$id, Steps::CREATED, 'calendar ' . $id];
		}
		$id = (int)$calendar['id'];
		$changes = [];
		if ((string)($calendar[self::DISPLAY_NAME] ?? '') !== $displayName) {
			$changes[self::DISPLAY_NAME] = $displayName;
		}
		if (strcasecmp((string)($calendar[self::CALENDAR_COLOR] ?? ''), self::COLOR) !== 0) {
			$changes[self::CALENDAR_COLOR] = self::COLOR;
		}
		if ($changes === []) {
			return [$id, Steps::UNCHANGED, 'calendar ' . $id];
		}
		$patch = new PropPatch($changes);
		$this->backend()->updateCalendar($id, $patch);
		$patch->commit();
		return [$id, Steps::UPDATED, 'calendar ' . $id . ' renamed'];
	}

	/**
	 * Makes sure the calendar is shared with the group, read and write.
	 *
	 * @return array{0: string, 1: string} [result, detail]
	 */
	public function ensureShare(int $calendarId, string $groupId): array {
		$href = AddressBookService::groupHref($groupId);
		$current = $this->share($calendarId, $href);
		if ($current !== null && $current['readOnly'] === false) {
			return [Steps::UNCHANGED, 'read-write for ' . $groupId];
		}

		$info = $this->backend()->getCalendarById($calendarId);
		if ($info === null) {
			throw new StepFailed('calendar ' . $calendarId . ' is missing');
		}
		$calendar = new Calendar($this->backend(), $info, $this->l10nFactory->get('dav'), $this->config, $this->logger);
		$previous = $this->userSession->getUser();
		$this->userSession->setVolatileActiveUser($this->account->user());
		try {
			$calendar->updateShares([['href' => $href, 'commonName' => '', 'readOnly' => false]], []);
		} finally {
			$this->userSession->setVolatileActiveUser($previous);
		}

		$after = $this->share($calendarId, $href);
		if ($after === null || $after['readOnly'] !== false) {
			throw new StepFailed('the calendar could not be shared with ' . $groupId);
		}
		return [$current === null ? Steps::CREATED : Steps::UPDATED, 'read-write for ' . $groupId];
	}

	/** @return array{id: ?int, exists: bool, display_name?: string, color?: string, shared_read_write?: bool} */
	public function describe(?int $calendarId, string $groupId): array {
		$info = $calendarId === null ? null : $this->backend()->getCalendarById($calendarId);
		if ($info === null) {
			return ['id' => $calendarId, 'exists' => false];
		}
		$share = $this->share($calendarId, AddressBookService::groupHref($groupId));
		return [
			'id' => $calendarId,
			'exists' => true,
			'display_name' => (string)($info[self::DISPLAY_NAME] ?? ''),
			'color' => (string)($info[self::CALENDAR_COLOR] ?? ''),
			'shared_read_write' => $share !== null && $share['readOnly'] === false,
		];
	}

	/** @return ?array{readOnly: bool} */
	private function share(int $calendarId, string $href): ?array {
		foreach ($this->backend()->getShares($calendarId) as $share) {
			if (($share['href'] ?? null) === $href) {
				return ['readOnly' => (bool)($share['readOnly'] ?? false)];
			}
		}
		return null;
	}

	private function backend(): CalDavBackend {
		if ($this->backend === null) {
			$this->appManager->loadApp('dav');
			$this->backend = $this->container->get(CalDavBackend::class);
		}
		return $this->backend;
	}
}
