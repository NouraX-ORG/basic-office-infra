<?php

declare(strict_types=1);

/**
 * Daily: deletes the accounts of people who left their organisation more than 30 days ago,
 * unless they are on hold. SWITCHED OFF: it does nothing until the owner says yes and someone
 * runs `occ config:app:set nourax_api leaver_deletion_enabled --value=yes`. The deletion itself
 * comes with the admin API feature; this version never deletes anything.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\BackgroundJob;

use OCA\NouraxApi\Settings;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;

class LeaverDeletion extends TimedJob {
	public function __construct(
		ITimeFactory $time,
		private Settings $settings,
	) {
		parent::__construct($time);
		$this->setInterval(86400);
		$this->setTimeSensitivity(self::TIME_INSENSITIVE);
	}

	protected function run($argument): void {
		if (!$this->settings->leaverDeletionEnabled()) {
			return;
		}
	}
}
