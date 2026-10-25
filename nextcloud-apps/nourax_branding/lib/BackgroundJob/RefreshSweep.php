<?php

declare(strict_types=1);

/**
 * Every 15 minutes: compares sweep-state.json in the theme folder with the installed server version,
 * the enabled apps and their versions, and the sweep rules. When anything differs (a new image, an
 * app added or updated without the app event reaching this app, new rules after a git pull) it
 * sweeps what changed. Otherwise it only reads one small file.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\BackgroundJob;

use OCA\NouraxBranding\AppInfo\Application;
use OCA\NouraxBranding\Service\SweepRunner;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;
use Psr\Log\LoggerInterface;

class RefreshSweep extends TimedJob {
	public function __construct(
		ITimeFactory $time,
		private readonly SweepRunner $runner,
		private readonly LoggerInterface $logger,
	) {
		parent::__construct($time);
		$this->setInterval(900);
		$this->setTimeSensitivity(self::TIME_SENSITIVE);
		$this->setAllowParallelRuns(false);
	}

	protected function run($argument): void {
		if ($this->runner->theme() === '') {
			return;
		}
		$need = $this->runner->needed();
		if ($need === null) {
			return;
		}
		$r = $this->runner->run($need['full'] ? null : $need['apps']);
		$this->logger->info('Branding sweep: {folders} folders, {written} files written', [
			'app' => Application::APP_ID,
			'folders' => count($r['folders']),
			'written' => $r['written'],
		]);
	}
}
