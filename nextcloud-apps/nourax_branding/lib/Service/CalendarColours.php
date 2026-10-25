<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Service;

use OCA\DAV\CalDAV\CalDavBackend;
use OCP\App\IAppManager;
use OCP\Defaults;
use OCP\IDBConnection;
use Psr\Container\ContainerInterface;
use Sabre\DAV\PropPatch;

/**
 * Calendars and task lists in the upstream blue get the site's colour instead.
 *
 * NoTasks (Tasks 0.18.1) makes a person's first task list in OCA.Theming.color, a field Nextcloud 35
 * no longer has (it is primaryColor now), so every new account's list "Tasks" came out in the upstream
 * blue #0082C9, in NoTasks and in NoCalendar. Other programs can do the same. Listener\
 * CalendarColourListener calls recolour() for every calendar the dav app makes; the occ command
 * nourax_branding:calendar-colours uses find() for calendars made before that.
 *
 * Only a colour that is an upstream blue as a whole changes, and only to the site's main colour
 * (theming, Nourax cobalt #2563EB), its alpha kept. Any other colour is left alone.
 */
final class CalendarColours {
	public const PROPERTY = '{http://apple.com/ns/ical/}calendar-color';

	private ?CalDavBackend $backend = null;

	public function __construct(
		private ContainerInterface $container,
		private IAppManager $appManager,
		private IDBConnection $db,
		private Defaults $defaults,
	) {
	}

	/** The site's main colour (#rrggbb), or the Nourax cobalt when that is unset or an upstream blue. */
	public function colour(): string {
		$colour = $this->defaults->getDefaultColorPrimary();
		if (preg_match('/^#[0-9a-f]{6}$/i', $colour) !== 1 || UpstreamAssets::recolourValue($colour) !== null) {
			return UpstreamAssets::COBALT;
		}
		return $colour;
	}

	/**
	 * Gives one calendar the site's colour if its colour is an upstream blue.
	 *
	 * @param array<string, mixed> $calendar as CalDavBackend::getCalendarById() gives it
	 * @return ?string the new colour, or null when nothing changed
	 */
	public function recolour(int $calendarId, array $calendar): ?string {
		$new = UpstreamAssets::recolourValue((string)($calendar[self::PROPERTY] ?? ''), $this->colour());
		if ($new === null) {
			return null;
		}
		$patch = new PropPatch([self::PROPERTY => $new]);
		$this->backend()->updateCalendar($calendarId, $patch);
		$patch->commit();
		return $new;
	}

	/** recolour() for a calendar known only by its id. */
	public function recolourById(int $calendarId): ?string {
		$calendar = $this->backend()->getCalendarById($calendarId);
		return $calendar === null ? null : $this->recolour($calendarId, $calendar);
	}

	/**
	 * Calendars of people (principals/users/...) whose colour is an upstream blue.
	 *
	 * @param ?list<string> $uids only these accounts; null for everyone
	 * @return list<array{id: int, uid: string, uri: string, name: string, colour: string}>
	 */
	public function find(?array $uids): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('id', 'principaluri', 'uri', 'displayname', 'calendarcolor')
			->from('calendars')
			->where($qb->expr()->like('principaluri', $qb->createNamedParameter('principals/users/%')));
		$any = [];
		foreach (UpstreamAssets::UPSTREAM_BLUES as $blue) {
			$any[] = $qb->expr()->iLike('calendarcolor', $qb->createNamedParameter('%' . $blue . '%'));
		}
		$qb->andWhere($qb->expr()->orX(...$any))->orderBy('id');
		$found = [];
		$result = $qb->executeQuery();
		while ($row = $result->fetch()) {
			$uid = substr((string)$row['principaluri'], strlen('principals/users/'));
			if (($uids !== null && !in_array($uid, $uids, true))
				|| UpstreamAssets::recolourValue((string)$row['calendarcolor']) === null) {
				continue;
			}
			$found[] = [
				'id' => (int)$row['id'],
				'uid' => $uid,
				'uri' => (string)$row['uri'],
				'name' => (string)$row['displayname'],
				'colour' => (string)$row['calendarcolor'],
			];
		}
		$result->closeCursor();
		return $found;
	}

	private function backend(): CalDavBackend {
		if ($this->backend === null) {
			$this->appManager->loadApp('dav');
			$this->backend = $this->container->get(CalDavBackend::class);
		}
		return $this->backend;
	}
}
