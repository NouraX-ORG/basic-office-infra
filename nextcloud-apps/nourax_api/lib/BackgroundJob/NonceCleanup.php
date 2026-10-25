<?php

declare(strict_types=1);

/**
 * Hourly: forgets admin API nonces whose 10 minutes are over (a replay is refused by the
 * timestamp check by then anyway).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\BackgroundJob;

use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

class NonceCleanup extends TimedJob {
	public function __construct(
		ITimeFactory $time,
		private IDBConnection $db,
	) {
		parent::__construct($time);
		$this->setInterval(3600);
		$this->setTimeSensitivity(self::TIME_INSENSITIVE);
	}

	protected function run($argument): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete('nourax_api_nonces')
			->where($qb->expr()->lt('expires_at', $qb->createNamedParameter($this->time->getTime(), IQueryBuilder::PARAM_INT)))
			->executeStatement();
	}
}
