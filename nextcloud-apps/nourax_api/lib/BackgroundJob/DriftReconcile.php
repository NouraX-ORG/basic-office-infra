<?php

declare(strict_types=1);

/**
 * Every 15 minutes: puts org:* and team:* groups back the way the stored desired state has them
 * (rows in nourax_api_drift, plus a full compare). The admin API feature fills in the work; until
 * then no org or team exists, so there is nothing to do.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\BackgroundJob;

use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;

class DriftReconcile extends TimedJob {
	public function __construct(
		ITimeFactory $time,
	) {
		parent::__construct($time);
		$this->setInterval(900);
		$this->setTimeSensitivity(self::TIME_SENSITIVE);
	}

	protected function run($argument): void {
	}
}
