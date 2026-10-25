<?php

declare(strict_types=1);

/**
 * Every 5 minutes (each cron run): enters new version, trash, editor and upload entries as not
 * for the stored-file virus scan, so neither the app's own cron job nor a capped
 * "occ files_antivirus:background-scan --max N" gets stuck on them. See Service\InternalFiles.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxAntivirus\BackgroundJob;

use OCA\NouraxAntivirus\Service\InternalFiles;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;

class SkipInternalFiles extends TimedJob {
	public function __construct(
		ITimeFactory $time,
		private readonly InternalFiles $internalFiles,
	) {
		parent::__construct($time);
		$this->setInterval(300);
		$this->setAllowParallelRuns(false);
	}

	protected function run($argument): void {
		$this->internalFiles->skipInternal();
	}
}
