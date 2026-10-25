<?php

declare(strict_types=1);

/**
 * Notes in nourax_api_drift when someone outside this API adds a person to, or removes them
 * from, an org:* or team:* group, or deletes such a group. NoMail is the source of truth, so the
 * DriftReconcile job puts it back and marks the row fixed.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Listener;

use OCA\NouraxApi\Service\DriftGuard;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Group\Events\GroupDeletedEvent;
use OCP\Group\Events\UserAddedEvent;
use OCP\Group\Events\UserRemovedEvent;
use OCP\IDBConnection;
use Psr\Log\LoggerInterface;

/**
 * @template-implements IEventListener<UserAddedEvent|UserRemovedEvent|GroupDeletedEvent>
 */
class GroupDriftListener implements IEventListener {
	public function __construct(
		private IDBConnection $db,
		private ITimeFactory $time,
		private LoggerInterface $logger,
	) {
	}

	public static function managed(string $groupId): bool {
		return str_starts_with($groupId, 'org:') || str_starts_with($groupId, 'team:');
	}

	public function handle(Event $event): void {
		if (DriftGuard::active()) {
			return;
		}
		if ($event instanceof UserAddedEvent) {
			$kind = 'member_added';
			$userId = $event->getUser()->getUID();
		} elseif ($event instanceof UserRemovedEvent) {
			$kind = 'member_removed';
			$userId = $event->getUser()->getUID();
		} elseif ($event instanceof GroupDeletedEvent) {
			$kind = 'group_deleted';
			$userId = null;
		} else {
			return;
		}
		$groupId = $event->getGroup()->getGID();
		if (!self::managed($groupId)) {
			return;
		}

		try {
			$qb = $this->db->getQueryBuilder();
			$qb->insert('nourax_api_drift')
				->values([
					'at' => $qb->createNamedParameter($this->time->getTime(), IQueryBuilder::PARAM_INT),
					'kind' => $qb->createNamedParameter($kind),
					'group_id' => $qb->createNamedParameter($groupId),
					'user_id' => $qb->createNamedParameter($userId),
				])
				->executeStatement();
		} catch (\Throwable $e) {
			// Never break the group change itself; the 15-minute reconcile also compares full state.
			$this->logger->warning('nourax_api: drift not recorded: ' . get_class($e) . ': ' . $e->getMessage(), ['app' => 'nourax_api']);
		}
	}
}
