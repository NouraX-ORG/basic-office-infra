<?php

declare(strict_types=1);

/**
 * Every 15 minutes: puts the org:* and team:* groups back the way the stored desired state has
 * them (ReconcileService::fixStored). A person added outside the API leaves again, one removed
 * outside the API comes back, a deleted group is made again; the drift rows of groups that match
 * again are closed. This is what makes the groups "locked".
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\BackgroundJob;

use OCA\NouraxApi\Service\ReconcileService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;
use Psr\Log\LoggerInterface;

class DriftReconcile extends TimedJob {
	public function __construct(
		ITimeFactory $time,
		private ReconcileService $reconciler,
		private LoggerInterface $logger,
	) {
		parent::__construct($time);
		$this->setInterval(900);
		$this->setTimeSensitivity(self::TIME_SENSITIVE);
	}

	protected function run($argument): void {
		$report = $this->reconciler->fixStored();
		$fixed = 0;
		$left = 0;
		foreach ($report['orgs'] as $org) {
			$fixed += count($org['fixed'] ?? []);
			$left += count($org['left'] ?? []);
		}
		if ($fixed > 0 || $left > 0) {
			$this->logger->warning('nourax_api drift reconcile: ' . $fixed . ' change(s) put back, ' . $left . ' left, '
				. $report['closed'] . ' drift row(s) closed', ['app' => 'nourax_api']);
		}
	}
}
